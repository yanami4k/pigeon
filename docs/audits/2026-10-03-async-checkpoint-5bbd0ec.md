# 交互会话的代码快照移出关键路径 审计

- 基线：5bbd0ec
- 分支：async-checkpoint
- 范围：决策 350（性能调优第一波 1d）；快照本身的来历见决策 078。一组代码提交 6ccfdde。

## 现状

- `src/application/checkpoints.ts` 订阅 Adapter 的归一化事件：写档或命令档工具提议（`tool.proposed`）时同步调用 `beforeChange` 记基线，落定（`tool.settled`）时在事件分派内同步调用 `afterChange`，有改动即写代码快照条目。条目落在发起调用的助手消息之后、该调用的工具结果消息之前，`storeSessionView` 按位置把它归到下一条消息（`afterRunSeq = 已有消息条数 + 1`）。
- `src/orchestration/checkpoint.ts` 全部用 `execFileSync`。每次 `afterChange` 都复制一份用户索引作临时索引，然后依次跑 `rev-parse --git-path index`、`add -A`、`rm --cached`（摘出治理目录）、`write-tree`，没有改动时就此返回；有改动再跑 `commit-tree`、`update-ref`；首个快照另跑 `rev-parse HEAD` 和改前基线的 `commit-tree`。"文件没变不提交"要在 `add` 与 `write-tree` 之后才判断，所以 run_command 即使报告文件没变，也照样起 4 个 git 进程。
- 终端界面主会话、命令行对话与续跑（`session-runtime.ts`）以及分支会话（`headless-core.ts` 带分支来历时）挂快照；`pigeon run` 不挂。分叉（`fork.ts` 的 `prepareFork`）用 `storeCheckpointBefore` 找分叉点之前最近的快照，找不到就退到改前基线，再找不到就打现状快照。

## 改法

### 一、没改动不拍

`evidenceShowsNoChange(tier, result)`（`checkpoints.ts`）只看工具自己的证据：写档工具 `isError` 即不拍（编辑失败）；工具结果 details 带完整（`truncated === false`）且新增、删除、修改都为空的 `fileChanges`（run_command 的文件变化报告）即不拍。其余情况都拍：命令出错没有报告、报告不完整、别的命令档工具，以及被审批拦下的调用（拦下的调用没有文件变化报告）。

### 二、后台拍与等待

- 是否开拍在工具结果交回时判断：订阅 `subscribeToolResults`，Adapter 在工具结果消息写进会话存储之后、同一次分派里调用它，这时的 `adapter.entrySeq()` 就是该工具结果消息的条目号。需要拍时先写"拍摄中"标记，再把 `afterChange` 排成后台任务；任务先让出一轮事件循环（`setImmediate`），使下一次模型请求先发出。拍完写代码快照条目（带工具调用号与条目号），树没变写 `unchanged` 标记，出错写 `failed` 标记并告警。
- 基线：写档或命令档工具第一次提议时排一个 `beforeChange` 后台任务，之后就不再排。快照器自己知道基线是已记下还是已丢失，与改前逐次调用的效果相同。
- 等待：`settle()` 等所有未完成的任务（基线与快照）。调用的地方有三处：
  - 下一次工具执行之前：Adapter 新增 `addToolGate`，在包装后的 `execute` 里、审批之后、真正执行之前逐个等待。
  - 分叉之前：`ForkRequest.settleCheckpoints`，`prepareFork` 在落盘、读来源会话之前调用；`runForkCommand` 传入运行面挂载的 `settle`。
  - 退出会话之前：`session-runtime.ts` 与 `headless-core.ts` 的释放动作由 `stop` 改为 `close`，即先 `settle`、再退订、再删临时索引。释放动作排在会话存储关闭之前。
- 上限：`CHECKPOINT_WAIT_MS = 30_000`，同一次 `settle` 共用一个截止时间。超时的任务立即标为已有下文，中止它的 git 进程（`AbortSignal` 传进 `execFile`），写 `failed` 标记并记 `CheckpointWaitTimeoutError`；之后即使拍完也不再写快照条目。另外，单条 git 命令有 `GIT_TIMEOUT_MS = 60_000` 的上限，到点杀掉，排在后面的操作不会被永远堵住。等待方不抛错，Adapter 侧再兜一层：等待口抛错只进内部错误清单，不挡工具执行。
- 告警后果文案改为"该时点的快照没有拍成，从这里分叉会明确报错，不退回更早的快照"，仍按故障类别只说一次。
- `run()` 返回时不等快照；run 返回之后再读会话文件的读者要先 `settle`。分叉入口已经自带等待。

### 三、按编号找快照、拍摄中标记

- 代码快照条目（`CheckpointDataSchema`）加可选的 `runSeq`，即对应工具结果消息的条目号。新增条目类型 `pigeon.checkpoint-mark`（`CheckpointMarkDataSchema`：`runId`、`toolCallId`、`runSeq`、`state ∈ shooting | unchanged | failed`、可选 `reason`），已登记进 `SESSION_ENTRY_SCHEMAS`。不认识这种条目的读者照旧跳过（`session-view.ts` 的时间线不显示它）。
- `storeSessionView`：快照条目的归属条目号取 `runSeq`；没有 `runSeq` 的旧记录照旧按位置取，所以旧会话照旧可用。拍摄标记按 Run 收进 `StoreRun.marks`。
- `storeCheckpointBefore` 的候选是拍成的快照（按归属条目号）和没拍成的拍摄标记。"没拍成"指同一调用既没有快照条目、也没有 `unchanged` 标记，也就是只有 `shooting`（进程在拍完之前退出）或者标了 `failed`。取分叉点之前条目号最大的那个候选：是没拍成的，就返回 `{ unfinished: 标记 }`；`unchanged` 不算候选。都没有时，照旧退到首个快照的改前基线。返回类型改为 `StoreCheckpointAt`（两种形状都能读 `commit`）。
- `prepareFork` 拿到 `unfinished` 即抛 `ForkError`，写明分叉点、对应的工具结果条目号，以及是拍摄中断还是拍摄失败（含原因），不退回更早的快照。这一步在写分叉条目、建工作树之前，所以不留任何记录。冷会话分叉时由这里新建的快照器用完即关。
- 残余窗口：工具结果消息与"拍摄中"标记在同一次同步分派里先后排进会话写入队列，前后紧挨着，但是两次写盘。如果进程恰好在两次写盘之间退出，会留下有工具结果、没有标记的记录，从这一点分叉会按前一个快照处理。

### 四、少起 git 进程

- 快照器的 git 一律改为异步 `execFile`，同一实例的操作经串行队列逐个执行（临时索引、序号与快照链是实例内的共享状态）。`isGitWorkspace` 与构造时的判定仍同步（非 git 工作区构造即报错，行为不变）。
- 会话内复用同一个临时索引：第一次用时从用户索引复制，之后 `add -A` 只处理增量。任何一条命令失败或被中止，都删掉临时索引及其锁文件，下次重新复制；`close()` 与进程退出时也删。
- 已有快照编号（`for-each-ref`）、链尾的树和用户索引的路径（`rev-parse --git-path index`）只在第一次操作时取一次；HEAD 只在生成改前基线提交时取一次。
- `rm --cached` 保留：治理目录不能用排除路径写法（已被 .gitignore 忽略时 git add 报错，实测确认）。忽略规则会话内可能被改，不能假定治理目录始终被忽略。
- racy-git 保护：git 只在条目的文件修改时间不早于索引文件的修改时间时才比内容，所以索引文件的修改时间不能晚于其中条目最后一次入索引的时间。复制用户索引时，先取用户索引的 atime/mtime，再复制，再用 `utimesSync` 把副本的时间设回去。先取再复制：中间用户索引若被改写，副本内容只会比取到的时间新，设回的时间只会偏早，偏早只是多比几次内容；`Date` 精度到毫秒、向下取整，也不会晚于原值。此后临时索引只由 git 自己写（`add -A`、`rm --cached`、`write-tree`），git 写索引时会把处在临界时刻的条目长度抹成 0，下次必比内容，所以复用不破坏这一保护。
- 进程数（每次工具调用）：有改动的快照从 6 个降到 5 个（省掉每次的 `rev-parse --git-path index`）；工具证据显示没改动的从 4 个降到 0 个；每个会话另有一次初始化的 `for-each-ref` 与 `rev-parse`。

### 界面上的可分叉点

终端界面与命令行对话的 `/fork` 只接受参数（`--at <条目号>` 或 `--at <Run 号前缀>:<条目号>`），没有列出可分叉点供选择的列表；两处都经 `runForkCommand` 进入 `prepareFork`，会先等未完成的快照。会话树（`tui/session-tree.ts`）里的分支与分叉节点，列的是已建成的分支会话，来自分叉条目，而分叉条目要等完快照之后才写。`pigeon trace` 与 `replay` 只显示快照信息，不用来选分叉点。所以没有"快照拍完之前读、少列一项"的地方，没有改动。

## 现有测试的改动（五处）

1. `checkpoints.test.ts` 第一项：原来断言快照条目夹在发起调用的助手消息与其工具结果消息之间，这是决策 350 取消的位置依赖。改为断言：工具调用号对应发起 edit_file 的调用；记录写明的条目号等于该调用的工具结果消息的序号；视图里归属条目号相同；按这个编号取到的快照就是这条记录，其内容是 edit_file 之后的工作区状态（`a.txt` 为 `new`）。其余断言不变。
2. `orchestration/checkpoint.test.ts` 全部用例，以及 `closeout-fixes.test.ts` 的旧值守卫用例：快照器接口改为异步，只加 `await`（同步的 `assert.throws` 对应改为 `assert.rejects`），断言不变。
3. `closeout-fixes.test.ts` 的快照故障告警用例：原来逐字比对旧的后果说法"回退到更早的快照"，而且断言时第二次故障可能还在后台。改为先 `settle`，再断言故障确实发生（内部错误清单恰为 3 条：记基线一次、两次改动的快照各一次，都是 git 失败，不是等待超时），然后断言告警只说一次，后果只取"明确报错""不退回"两个关键词。
4. `fork.test.ts` 的"分叉续跑"用例：run 返回后马上读会话文件，断言已有 1 个快照，改动后实测得 0。在读之前加一行 `await opened.checkpoints?.settle()`，其余不动。
5. `session-store.test.ts` 的"手动分叉时来源写者在本进程"用例：不经命令层直接调 `runForkBranch`，没传等待函数，分叉时快照还在拍，于是按新规则报"没有拍成"。加一行同样的 `settle`，其余不动。

## 新增测试

- `src/state/checkpoint-marks.test.ts`（1 项，纯函数）：一个 Run 里依次有拍成的快照，但它的条目落在下一次调用的工具结果之后；有 `unchanged`、有 `failed`、有只有 `shooting` 的，下一个 Run 再起一条。断言：首次改动之前取改前基线；拍成的快照按条目号归属；`unchanged` 不算，不报错；`failed` 与只有 `shooting` 的分叉点返回它的标记，不退回更早的快照；更早 Run 的最后一次没拍成，后一个 Run 的分叉点同样报出。
- `src/application/checkpoints-async.test.ts`（6 项）：
  - 判定表：编辑失败、命令报告为空且完整的不拍；编辑成功、命令改了文件、报告不完整、命令出错没有报告的要拍。
  - 假运行面加由测试放行的快照器：没改动的两种不调 `afterChange`、不写条目；有改动时先写 `shooting`（工具调用号、条目号）；快照放行之前等待口不放行；放行后写带条目号的快照条目。
  - 等待上限 50 毫秒：卡住的快照到点放行，写 `failed`，中止信号已发，错误为 `CheckpointWaitTimeoutError`；之后放行的结果不再写。
  - 真实运行面：等待口在工具执行之前被等待（等待口里延时写下的文件，随后执行的 read_file 读得到）。
  - 真实运行面：换上比运行收尾慢的快照器，run 返回后立即分叉，分叉点取到刚拍完的快照，分支工作树里 `a.txt` 为 `new`。
  - 真实运行面：快照永不完成、退订后再分叉（只读得到会话文件），抛 `ForkError` 且不留分叉记录。
- 测试量：两个新测试文件共 445 行；产品代码新增 662 行、删除 183 行。

## 变异

在服务器上逐个改回旧行为或去掉判定，跑相关测试文件，看哪些文件变红；每个变异做完都还原，还原后工作区干净。

| 变异 | 变红的测试文件 |
|---|---|
| 编辑失败也拍 | checkpoints-async、checkpoints |
| 命令报告为空也拍 | checkpoints-async |
| 等待口不等 | checkpoints-async、checkpoints、closeout-fixes、fork、session-store |
| Adapter 不调等待口 | checkpoints-async、checkpoints、closeout-fixes |
| 分叉前不等 | checkpoints-async |
| 等待无上限 | checkpoints-async（超时） |
| 不写"拍摄中"标记 | checkpoints-async |
| 分叉遇到没拍成的不报错 | checkpoints-async |
| 没拍成的不当候选（退回更早的快照） | checkpoint-marks、checkpoints-async |
| 按位置找快照（第 1 处改动的反向） | checkpoint-marks、checkpoints-async、checkpoints |
| 快照条目不写条目号（第 1 处改动的反向） | checkpoints-async、checkpoints |
| 去掉测试里的 `await`（第 2 处改动的反向） | orchestration/checkpoint |
| update-ref 不带旧值守卫（第 2 处改动的守卫用例） | closeout-fixes |
| 治理目录不从临时索引摘出（第 2 处改动的 checkpoint 用例） | orchestration/checkpoint |
| 告警后果改回"回退到更早的快照"（第 3 处改动的反向） | closeout-fixes |

第 4、5 处改动：未加 `settle` 那一行时，两项都实测变红（见上文）；加上后通过；"等待口不等"的变异下两项又变红。

## 前后测量

- 测量脚本：在约 740 个文件的克隆工作区上开主会话运行面（与终端界面同一条 `openSessionRuntime`），假模型，交替发 15 次改文件的 edit_file 和 15 次不改文件的 run_command（`node --version`）。计时订阅排在快照订阅之前，量每次工具落定（`tool.settled`）到下一次模型请求发出的间隔；包住 `child_process` 的入口，按调用栈数快照模块起的 git 进程。挂载时同步执行的判定不计入，所以改前构造时的 `for-each-ref` 没算，改后初始化的 `for-each-ref` 与 `rev-parse` 算在内。
- 改前用基线 5bbd0ec 的代码，改后用树与 6ccfdde 相同的代码，同一台服务器（pigeon-verify）、同一份工作区来源，每种组合跑两遍：

| 指标 | 改前（两遍） | 改后（两遍） |
|---|---|---|
| edit_file 工具结束到下一次请求，中位 | 25.9 / 23.6 ms | 0.2 / 0.2 ms |
| edit_file 同上，最大 | 39.6 / 105.9 ms | 0.9 / 1.1 ms |
| run_command（没改文件）工具结束到下一次请求，中位 | 17.6 / 16.9 ms | 0.3 / 0.3 ms |
| 快照起的 git 进程（30 次工具调用） | 156 / 156 | 82 / 82 |
| 整个运行，假模型零延迟 | 1,116 / 1,226 ms | 945 / 932 ms |
| 整个运行，假模型每次请求延迟 300 ms | 10,396 / 10,529 ms | 9,763 / 9,883 ms |

- 进程明细：改前 `rev-parse` 32、`add` 31、`rm` 31、`write-tree` 31、`commit-tree` 16、`update-ref` 15；改后 `for-each-ref` 1、`rev-parse` 2、`add` 16、`rm` 16、`write-tree` 16、`commit-tree` 16、`update-ref` 15。两边都是 15 个快照 ref，没有内部故障。
- 假模型零延迟时，后台快照与下一次请求重叠不到多少，下一次工具执行仍要在等待口等它；整个运行的缩短主要来自没改动的命令不再拍和每次少起的进程。请求有延迟时，快照耗时被请求盖住。

## verify 的实际运行情况

- 机器：服务器 pigeon-verify，8 vCPU、31 GB 内存，Node v24.12.0；按服务器负载取测试并发 2。
- 树与 6ccfdde 相同的提交上：`npm run lint`（545 个文件，无问题）、`npm run check`、`npm run deps`（574 个模块，无违规）通过。测试按目录分四批，每批一条前台命令，用 `node --test --test-concurrency=2`：application 376 项，tui 与 cli 201 项，eval 与 tools 424 项（跳过 2 项），其余目录 633 项。合计 1,634 项，通过 1,632，失败 0，跳过 2。application 这一批第一次跑出 `session-store.test.ts` 的那 1 项（第 5 处改动），改后单独重跑该文件通过。
- 含本审计的提交上另跑一次 verify，结果追加在下一节。

## 含本审计的提交上的 verify

- 提交 d2dcd59（在 6ccfdde 之上只加本审计文件），同一台服务器：`npm run lint`（545 个文件，无问题）、`npm run check`、`npm run deps`（574 个模块，无违规）通过。测试用 `node --test --test-concurrency=2` 分两批前台运行：application、tui、cli 577 项全过；其余目录 1,057 项，通过 1,055，跳过 2。合计 1,634 项，通过 1,632，失败 0，跳过 2。

## 第二轮修复

代码提交 3598273（在 23a3ccd 之上）。下文的"上文"指本审计前面各节；与上文不一致处以本节为准。

### 一、run_command 之后一律拍

- 问题：上文第一节"没改动不拍"以 run_command 的文件变化报告为证据。该报告由目录遍历比大小与修改时间得来：不列符号链接，跳过各层 node_modules 与根下整个 .pigeon，所以改权限、符号链接的增删改、仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills`、保留修改时间的同长度覆盖、PostToolUse 钩子改的文件，都会被判成没改动。结果是既不拍，也不留标记，分叉时退回更早的快照。
- 改法：`evidenceShowsNoChange(result, failureHooks)` 只在以下条件同时成立时返回真：edit_file 出错，并且确定没有写入（工具结果的审批标记为拦下，或出错归类为域错误——原文不匹配、路径不对、写前复核拒写，都在写入之前抛出）；同时会话没有配置 PostToolUseFailure 钩子。其余一律拍，包括 run_command（不看文件变化报告）、编辑的环境类错误（可能写了一半）、其他写档工具。要不要新提交仍由快照比对文件树决定（"树没变不提交"照旧，写 unchanged 标记）。
- 时序：是否开拍在工具结果消息落定时判断，上游的 afterToolCall（PostToolUse / PostToolUseFailure 钩子）先于工具结果消息，所以快照总在这些钩子跑完之后才开始。
- 上文"工具证据显示没改动的从 4 个降到 0 个"不再成立：不改文件的命令每次起 3 个 git（`add`、`rm`、`write-tree`），写 unchanged 标记。

### 二、基线没拍成时首次改动之前的分叉点明确报错

- 问题：基线拍摄超时或失败时没有标记；或者会话里只有没拍成的标记。这两种情况下，首次改动之前的分叉点查不到快照与改前基线，`prepareFork` 会拍一张现状快照，得到的是改后的状态。
- 改法：`storeCheckpointBefore` 在找不到候选、也没有改前基线时，若会话里有过快照条目或没拍成的标记，返回 `{ baseMissing: true }`；`prepareFork` 据此抛 `ForkError`，在写分叉条目、建工作树之前，不留记录。整个会话没有改过文件（没有快照、只有 unchanged 标记或没有标记）时照旧打现状快照。

### 三、补齐等待点、退出顺序

- 钩子：`SessionHooks.addGate`，`runEvent` 在有钩子命中时先依次等待登记的等待口，再运行钩子；快照挂载登记 `settle`。覆盖所有经 `runEvent` 运行的钩子，包括终端界面与无头运行里的 UserPromptSubmit、Stop、SessionEnd，以及治理里的 PreToolUse 和工具结束后的 PostToolUse。没有钩子命中时不等。
- 终端界面换绑会话（`/resume`）与重建运行面：当前格记下快照挂载，换走旧运行面之前先 `settle`，再跑旧会话的 SessionEnd 与释放。新运行面在同一工作区上接着改文件，旧快照必须先拍完。
- 退出顺序：`RuntimeBundle` 新增 `closers`，`disposeRuntime` 在 `adapter.dispose()`（中止在途 Run 并等它收尾）之后、MCP 与会话存储关闭之前执行。快照挂载的 `close`（等待、退订、删临时索引）由 `disposers` 移到 `closers`：在途工具被中止时，它的工具结果照样先写"拍摄中"、开拍，快照在会话存储关闭之前拍完落盘。原来快照挂载在 `disposers` 里，在运行面停下之前就退订了，被中止的最后一个工具结果既不拍也不留标记。

### 四、快照器的 git 调用

- 所有 git 调用都接上中止信号：`headCommit`，以及 `snapshotNow`、`pin` 新增的可选信号参数。`headCommit` 在中止时上抛，其余失败仍按"没有 HEAD"处理。
- 异步 git 改为 `spawn`，以独立进程组拉起（非 Windows）。超时、中止或输出超过上限时用现有的 `killProcessTree` 杀整个进程树（Windows 为 `taskkill /T /F`），不再只杀 git 进程本身。
- `dropIndex`：先清掉记下的临时索引路径（下次必定重新复制），再尽力删除文件；删除抛错不另上抛，调用方原来的错误照旧上抛。删不掉的文件留给进程退出时的清理再试一次。
- 上文第四节"git 写索引时会把处在临界时刻的条目长度抹成 0"的说法不准确，更正为：git 写索引时按读入时的索引修改时间认出临界条目，只对其中内容已变的抹掉长度；内容没变的条目此刻确实干净，之后再改，文件修改时间必然变化，所以复用临时索引仍不破坏这一保护。代码注释同步更正。

### 五、trace 与 replay 显示没拍成的快照

- `session-view.ts`：新增 `checkpoint-mark` 时间线条目，原来这类条目被当作未知条目静默跳过；新增 `unfinishedCheckpointMarks`（标了 failed 的，与只有 shooting、同一调用既没有快照条目也没有别的标记的）与一行说明文字。
- `pigeon trace`：没拍成的快照在对应工具调用下各占一行（"代码快照：快照没有拍成（原因）……"或"快照拍摄中断……"）。
- `replay`：时间线上没拍成的标记各占一行；拍成的与文件没变的标记不占行，回放头部的条目数按显示的条目计。没有标记的旧会话输出不变。

### 测试

现有测试的改动：
- `checkpoints.test.ts` 第一项：断言"快照器没有内部故障"之前先 `settle`，后台快照拍完再看。

新增与改写的测试（`checkpoints-async.test.ts` 为本分支新增文件，本轮改写）：
- 判定表改为新规则：编辑被拦下、编辑在写入之前出错时不拍；编辑写入时出错（环境异常）、编辑出错但配置了失败后的钩子、编辑成功、文件变化报告为空的命令、其他写档工具出错时都拍。
- 文件变化报告为空的命令照拍，并写带条目号的快照条目。
- 钩子运行之前先等：快照卡住时 Stop 钩子不运行，放行后才运行。
- 遍历报告漏掉的七种改动，每种一项：改权限、新增符号链接、改符号链接的指向、删除符号链接、改仓库已跟踪的 `.pigeon/settings.json`、改 `.pigeon/skills` 下的文件、保留修改时间的同长度覆盖。真实 git 仓库加真实快照器，命令的文件变化报告为空，断言都拍到快照，并逐项核对快照里的权限、符号链接与内容。前四项只在非 Windows 上运行。
- PostToolUse 钩子改的文件进快照：真实运行面，钩子在命令之后写一个文件，命令本身不改文件，快照里有这个文件。
- 分叉之前先等：去掉了上文的固定延时，改为由测试手动放行的阻塞。运行收尾后先断言会话文件里只有"拍摄中"标记，再发起分叉，断言快照放行之前分叉不往下走，放行后分叉点取到刚拍完的快照。
- 进程在拍完之前退出：除原有的"该分叉点报没拍成"外，首次改动之前的分叉点报"早于首次改动"（基线缺失），两次都不留分叉记录。
- 退出时先停运行面再等快照：命令执行中释放运行面，命令被中止，会话文件里该工具结果有"拍摄中"与 unchanged 两条标记。
- `src/state/checkpoint-marks.test.ts` 加一项：只有没拍成的标记、快照不带改前基线时报 baseMissing；只有文件没变的标记即从未改过文件。
- `src/orchestration/checkpoint-index.test.ts`（新增，2 项）：
  - racy-git 回归：关掉 ctime，所有时间显式设定。用户索引里一个条目与索引文件处在同一秒，文件在这一秒里被原地改成同样长度；断言基线与快照都是改后的内容。去掉复制后设回修改时间那一行，这一项变红。
  - 临时索引弄坏后，这一次失败；下一次从用户索引重新复制，快照与改前基线都正确；关闭后临时索引删掉。
- `src/cli/checkpoint-marks-display.test.ts`（新增，1 项）：拍成的、失败的、拍摄中断的各一次调用；trace 与 replay 各只多出两行，分别对应失败的与中断的。

### 变异

在服务器上逐个改回旧行为或去掉判定，跑八个相关测试文件；每个变异做完都还原，还原后工作区干净。

| 变异 | 变红的测试文件 |
|---|---|
| 文件变化报告为空的命令不拍（旧规则） | checkpoints-async、checkpoints |
| 编辑失败一律不拍 | checkpoints-async |
| 不看失败后的钩子 | checkpoints-async |
| 基线缺失不报 baseMissing | checkpoint-marks、checkpoints-async |
| 分叉遇到基线缺失不报错 | checkpoints-async |
| 钩子运行前不等 | checkpoints-async |
| 快照收尾挂回 disposers（运行面停下之前退订） | checkpoints-async |
| 临时索引出错后不丢弃 | checkpoint-index |
| 复制索引后不设回修改时间 | checkpoint-index |
| trace 不显示没拍成的快照 | checkpoint-marks-display |
| replay 显示全部拍摄标记 | checkpoint-marks-display |
| 分叉前不等 | checkpoints-async、closeout-fixes |
| 工具执行前不等 | checkpoints-async、checkpoints、closeout-fixes、fork |

终端界面换绑会话前的等待没有自动化测试（在终端界面装配根里），以代码审读为准。

### 重新测量

脚本与上文相同，只把替换快照收尾的位置改到 `closers`。同一台服务器，基线 5bbd0ec 与 3598273 交替运行，假模型零延迟，各两遍：

| 指标 | 基线（两遍） | 3598273（两遍） |
|---|---|---|
| edit_file 工具结束到下一次请求，中位 | 39.7 / 39.2 ms | 0.3 / 0.3 ms |
| run_command（没改文件）工具结束到下一次请求，中位 | 26.6 / 27.8 ms | 0.4 / 0.4 ms |
| 快照起的 git 进程（30 次工具调用） | 156 / 156 | 127 / 127 |
| 整个运行 | 1,714 / 1,767 ms | 1,379 / 1,203 ms |

- 进程明细（3598273）：`for-each-ref` 1、`rev-parse` 2、`add` 31、`rm` 31、`write-tree` 31、`commit-tree` 16、`update-ref` 15。比上文的 82 个多出的 45 个，是 15 次不改文件的命令照拍（每次 3 个）。
- 假模型每次请求延迟 300 ms 时，3598273 两遍整个运行为 9,955 / 9,885 ms，上文基线为 10,396 / 10,529 ms。
- 这一轮测量时服务器负载较高，绝对值比上文高；表内两列是同一时段交替测得的。

### verify

- 提交 3598273，服务器 pigeon-verify：`npm run lint`（547 个文件，无问题）、`npm run check`、`npm run deps`（576 个模块，无违规）通过。测试分两批前台运行，并发按负载取：application、tui、cli 一批 588 项全过（并发 6）；其余目录一批 1,060 项，通过 1,058，跳过 2（并发 2）。合计 1,648 项，通过 1,646，失败 0，跳过 2。
- 提交 1dccb4e（在 3598273 之上只改本审计文件），同一台服务器：`npm run lint`、`npm run check`、`npm run deps` 通过；测试并发 2，分两批：588 项全过；1,060 项，通过 1,058，跳过 2。合计 1,648 项，通过 1,646，失败 0，跳过 2。

## 第三轮修复：快照的 add 不进程序状态目录

代码提交 c40f386（在 8320b3a 之上）。

### 问题

快照改到后台以后，`git add -A -- .` 扫描工作区时，会话存储可能正在同一工作区的 `.pigeon/state` 下建删临时锁文件。文件在 git 列出目录与读取它的属性之间消失，git 报 `fatal: unable to stat '….jsonl.lock.….tmp': No such file or directory`，整次 add 失败，这张快照记为失败。原先同步拍时快照与会话写入不并发，没有暴露。项目的 `.gitignore` 若没有排除 `.pigeon/state`，真实使用中同样会撞上。

### 改法

- `currentTree` 的 add 改为 `git -c advice.addIgnoredFile=false add -A -- . ':(exclude).pigeon/state' ':(exclude).pigeon/settings.local.json'`（排除路径取 `PROGRAM_OWNED_PATHS`），git 不进这两处，扫不到其中一闪而过的文件。基线、增量快照与现状快照都经同一个 `currentTree`。在服务器上用一个读不到其中条目的目录（权限 600）核实过：不带排除时 add 报同样的 `unable to stat` 并失败，带排除时成功。
- 这些路径已被 `.gitignore` 忽略时，git 照样加完其余文件，但会以退出码 1 报"路径被忽略"。新增 `onlyIgnoredOwnedPaths`：退出码为 1、标准错误输出首行是这句提示、其后列出的每一行都是被排除的路径或忽略了它们的上级目录（整个 `.pigeon` 被忽略时 git 列出 `.pigeon`）时，算成功；其余一律失败。提示按英文判定，这条 git 以 `LC_ALL=C`、空 `LANGUAGE` 运行。
- 之后的 `rm --cached` 照留：排除路径不动已在索引里的条目，仓库若跟踪了程序状态里的文件，仍从临时索引摘掉。
- 仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills` 不在排除之列，照常进快照。

### 两处排除口径的差别

- run_command 的文件变化报告（`LISTING_SKIPPED_DIRS` 与 `LISTING_SKIPPED_ROOT_DIRS`）：任意层级跳过 `.git` 与 `node_modules`，工作区根下跳过整个 `.pigeon`，不列符号链接，被 `.gitignore` 忽略的文件照列。
- 快照：只排除根下的 `.pigeon/state` 与 `.pigeon/settings.local.json`；`.pigeon` 下其余文件（已跟踪的 `settings.json`、`skills`）照常进快照；被 `.gitignore` 忽略的文件不进（git 的口径）；各层 `node_modules` 是否进快照取决于是否被忽略；符号链接按 git 记为链接。
- 第二轮起 run_command 之后一律拍快照、不看文件变化报告，两者口径不同不影响快照该不该拍。

### 测试（`src/orchestration/checkpoint-state-dir.test.ts`，新增，5 项）

- 另起一个进程不停在 `.pigeon/state/sessions` 下建删临时文件，同时连拍 30 次改动的快照：每次都拍到，内容正确，快照里不含 `.pigeon/state` 与 `.pigeon/settings.local.json`。测试仓库不忽略 `.pigeon/state`。
- `.pigeon/state` 下有一个读不到其中条目的目录：快照照样成功。只在非 Windows、非 root 用户下运行。
- 只忽略程序状态、整个 `.pigeon` 被忽略两种仓库：快照成功，已跟踪的 `.pigeon/settings.json` 的改动进快照，快照里不含程序状态。
- `onlyIgnoredOwnedPaths`：只列被排除路径或其上级时认，列出别的路径、没有列出路径或其他错误时不认。

### 变异

| 变异 | 变红的测试文件 |
|---|---|
| add 不带排除路径 | checkpoint-state-dir |
| 不认"路径被忽略"的提示 | checkpoint-state-dir、orchestration/checkpoint |
| 提示里列出别的路径也认 | checkpoint-state-dir |

每个变异做完都还原，还原后工作区干净。

### verify

- 提交 c40f386，服务器 pigeon-verify：`npm run lint`（548 个文件，无问题）、`npm run check`、`npm run deps`（577 个模块，无违规）通过。全量测试在负载下以并发 2 跑两遍，每遍分两批前台运行：application、tui、cli 588 项全过；其余目录 1,065 项，通过 1,063，跳过 2。两遍结果相同：合计 1,653 项，通过 1,651，失败 0，跳过 2。

## 第四轮修复：改用临时忽略文件，成败只看退出码

代码提交 6d91134（在 4a8c1ea 之上）。本节取代第三轮"改法"里排除路径与提示识别的做法；第三轮的问题描述、两处排除口径的差别仍然成立。

### 问题

第三轮用排除路径让 git 不进程序状态。这些路径已被 `.gitignore` 忽略时，git 以退出码 1 报"路径被忽略"，第三轮靠解析这句英文提示判成功，依赖 git 给人看的文字，随版本可能变。

核实过的两种替代：
- 通配写法的排除（如 `.pigeo[n]/state`）：路径已被忽略时返回 0，但路径没被忽略时 git 仍会进 `.pigeon/state`，读不到的目录照报 `unable to stat`，竞态还在，不采用。
- 临时忽略文件：采用，见下。

### 改法

- 快照的 add 改为 `git -c core.excludesFile=<临时文件> add -A -- .`，不再带排除路径，也不再解析提示文字，成败只看退出码。
- 临时文件的内容为用户原有的全局忽略文件，加上 `/<前缀>.pigeon/state` 与 `/<前缀>.pigeon/settings.local.json` 两条（`snapshotExcludes`）。这两处因此在任何仓库里都算被忽略，git 不进 `.pigeon/state`，也不收个人设置。git 进忽略文件规则判定的被忽略目录时不往下走，由此避开其中一闪而过的文件；没有显式点名被忽略的路径，也就不会触发退出码 1。
  - 开头的 `/` 把路径锚在仓库根，前缀为工作区在仓库里的路径，前缀里的通配字符按字面转义。
  - 不带结尾的 `/`，目录与文件都认。
- 用户原有的全局忽略文件：配了 `core.excludesFile` 用它，没配用 git 的缺省位置（`$XDG_CONFIG_HOME/git/ignore`，没设该变量时为主目录下 `.config/git/ignore`）。读不到时临时文件只含这两条。
- 仓库自己的 `.gitignore` 与 `.git/info/exclude` 照常生效，优先级高于全局忽略文件；其中若有否定规则把程序状态重新放出，git 会进这两处，这是仓库自己的选择。
- 工作区前缀与用户索引的位置由同一次 `git rev-parse --show-prefix --path-format=absolute --git-path index` 取得；全局忽略文件的位置另由一次 `git config --path --get core.excludesFile` 取得。两者都只在首次操作时取，首次操作因此多起 1 个 git 进程，之后每次快照的进程数不变。
- 临时文件放在系统临时目录（不在会话状态目录里），用时建；`close()` 时删除，进程退出时也清理。
- `rm --cached` 照留：仓库若跟踪了程序状态里的文件，仍从临时索引摘掉。仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills` 照常进快照。

### 测试

- `src/orchestration/checkpoint-state-dir.test.ts` 改写为 8 项：
  - 6 项矩阵：工作区在仓库根与子目录，各三种情形（程序状态没被忽略、只忽略程序状态、整个 `.pigeon` 被忽略）。每项都在 `.pigeon/state` 下放一个读不到其中条目的目录（只在非 Windows、非 root 用户下设权限），快照成功，不含程序状态，已跟踪的 `.pigeon/settings.json` 的改动进快照。
  - 另起进程不停建删临时文件的同时连拍 30 次，每次都拍到，不含程序状态（第三轮已有，保留）。
  - 用户原有的全局忽略规则（`*.log`）照常生效，`debug.log` 不进快照；配置的全局忽略文件读不到时，快照照样成功、照样不含程序状态。
  - 第三轮的提示识别单测随识别函数删除。
- `src/orchestration/checkpoint-index.test.ts`：关闭后临时索引与临时忽略文件都删掉。

### 变异

| 变异 | 变红的测试文件 |
|---|---|
| add 不带临时忽略文件 | checkpoint-state-dir |
| 忽略文件里的路径不带工作区前缀 | checkpoint-state-dir |
| 不带用户原有的全局忽略规则 | checkpoint-state-dir |
| 改回字面的排除路径 | checkpoint-state-dir、orchestration/checkpoint |
| close 不删临时忽略文件 | checkpoint-index |

每个变异做完都还原，还原后工作区干净。

### verify

- 提交 6d91134，服务器 pigeon-verify：`npm run lint`（548 个文件，无问题）、`npm run check`、`npm run deps`（577 个模块，无违规）通过。全量测试在负载下以并发 2 跑两遍，每遍分两批前台运行：application、tui、cli 588 项全过；其余目录 1,068 项，通过 1,066，跳过 2。两遍结果相同：合计 1,656 项，通过 1,654，失败 0，跳过 2。
