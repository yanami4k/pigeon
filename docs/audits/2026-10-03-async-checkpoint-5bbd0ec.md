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

- 机器：服务器 pigeon-verify，8 vCPU、31 GB 内存，Node v24.12.0；同时有别的施工会话在跑测试，按负载取测试并发 2。
- 树与 6ccfdde 相同的提交上：`npm run lint`（545 个文件，无问题）、`npm run check`、`npm run deps`（574 个模块，无违规）通过。测试按目录分四批，每批一条前台命令，用 `node --test --test-concurrency=2`：application 376 项，tui 与 cli 201 项，eval 与 tools 424 项（跳过 2 项），其余目录 633 项。合计 1,634 项，通过 1,632，失败 0，跳过 2。application 这一批第一次跑出 `session-store.test.ts` 的那 1 项（第 5 处改动），改后单独重跑该文件通过。
- 含本审计的提交上另跑一次 verify，结果追加在下一节。

## 含本审计的提交上的 verify

- 提交 d2dcd59（在 6ccfdde 之上只加本审计文件），同一台服务器，同时有别的施工会话在跑测试：`npm run lint`（545 个文件，无问题）、`npm run check`、`npm run deps`（574 个模块，无违规）通过。测试用 `node --test --test-concurrency=2` 分两批前台运行：application、tui、cli 577 项全过；其余目录 1,057 项，通过 1,055，跳过 2。合计 1,634 项，通过 1,632，失败 0，跳过 2。
