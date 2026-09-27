# 账本重构第四段：停写旧账本、删除旧代码、迁跑批器的会话文件操作（基线 24cbeab）

范围：决策 176–187、206、210、211、238 的最后一段——跑批器按新存储布局操作会话文件（读者 E），停写旧账本（去掉双写里写旧账本的一侧），删除旧账本引擎、旧记录与迁移链、正文截断与旁置正文、回执、会话树投影与导入、旧读法回退、双写与读者对照工具及只为它们存在的测试，依赖规则与探针脚本随之改写，旧格式会话在新代码里跳过并提示。不改 Run 的执行流程、不加新挂点、不改 docs/roadmap/decisions.md。基线为 formal-v2 分支 24cbeab，分支 ledger-s5。

## 一、改动规模

相对基线：210 个文件，+2,983 / −15,954 行。

| 类别 | 文件数 | 行数 |
|---|---|---|
| 删除的生产文件 | 17 | −4,713 |
| 删除的测试文件 | 25 | −6,326 |
| 删除的探针脚本 | 4 | −673 |
| 新增文件（state/hashing.ts、state/hashing.test.ts、state/session-payloads.ts） | 3 | +301 |
| 修改的生产文件 | 70 | +497 / −1,764 |
| 修改的测试与测试夹具 | 81 | +2,151 / −2,390 |

## 二、删除清单

### 2.1 生产代码（按块）

| 块 | 文件（基线行数） |
|---|---|
| 旧账本引擎与旧读取面 | persistence/event-log.ts（692）、persistence/session-read.ts（24） |
| 旧记录与迁移链 | state/event-log.ts（729）、state/migration.ts（73） |
| 旧物化与由它现算的判定、显示 | state/materialize.ts（645）、state/episode.ts（127）、state/repair-step.ts（75）、state/checkpoint-ref.ts（35）、state/trace.ts（314）、state/replay.ts（119） |
| 正文截断与旁置正文 | state/message-content.ts（290） |
| 回执与 MCP 回执证据 | state/receipt.ts（200）、state/mcp-evidence.ts（86） |
| 会话树投影、导入、写穿与重建 | pi-runtime/session-tree.ts（240）、application/session-tree.ts（329） |
| 双写与读者对照 | persistence/dual-write-compare.ts（360）、application/reader-compare.ts（375） |

另在保留的文件里删除的段落：

- state/outcome-label.ts：从旧物化现算尝试事实的 attemptOutcomeFacts，只留判据 labelAttempt 与事实类型。
- state/classification.ts：旧账本的工具执行分类 classifyToolOutcome（新读法的工具级判据在 state/session-judge.ts）。
- state/session-summary.ts：旧投影 summarizeSession 与"待对账"字段。
- state/runtime-events.ts：观察族常量与 llm.request、eval.verified、run.limit-hit 的载荷形状；run.started 形状里的这一步起点字段。
- state/ids.ts：回执标识种类；state/tool-execution.ts：回执号字段。
- pi-runtime/snapshot.ts：注入快照 v1→v12 的迁移函数（快照只在运行面内存里冻结，读旧版本快照的迁移链随旧格式读取删除）。
- application/format.ts：只剩旧投影在用的正文缺口与熔断计数措辞。
- application/headless-core.ts：旧读法 summarizeRunMetrics 与回退分支。
- cli/index.ts：`pigeon tree rebuild` 命令。
- persistence/session-lock.ts：按会话号加锁的旧入口（acquireSessionLock、sessionLockPath）；锁错误类改名 SessionLockedError。
- tools/run-command.ts、mcp/registry-bridge.ts：按调用暂存执行证据、供写回执时取走的暂存表与取出接口（成功结果的证据照旧作为工具结果的 details 记进会话存储）。
- tools/edit-file.ts、tools/replace-edit.ts、tools/wrap.ts：只为 intent 内容哈希与冷恢复对账存在的内容证据探针。

被别处借用的小工具 sha256Hex、Sha256HexSchema、canonicalJson、truncateUtf8 挪到 state/hashing.ts；state/session-view.ts 原先自抄的一份随之去掉。state/event-log.ts 里新存储仍在用的载荷 schema（worker 角色、工作区、委派策略、上限、收尾结果、分叉点、快照引用、分叉触发）与各写入点的输入类型挪到 state/session-payloads.ts，输入类型去掉旧记录信封；收尾结果去掉回执号字段。ActiveGrant 挪到 state/grants.ts。

### 2.2 测试

整体删除的 25 个测试文件：persistence 的 event-log、event-log-receipt-migration、message-content-log、retired-kinds、child-families、contrast-families、dual-write-compare；pi-runtime 的 adapter-persistence、adapter-entry、adapter-content、adapter-observe、session-tree、trace-e2e；state 的 receipt、receipt-v5、migration、mcp-evidence、replay、trace、episode、contrast-records、message-content；application 的 reader-compare、session-tree-lock；migration-completeness。被测对象是本段删除的模块，或只断言已停写的记录。

message-content.test 里规范序列化与 UTF-8 截断两部分的断言移到新增的 state/hashing.test.ts。

### 2.3 探针

spikes/ledger-migration 下的双写对照（compare-dual-write.ts）、判定与续跑读者对照（compare-judge-readers.ts）、搜索与显示读者对照（compare-readers.ts）随旧账本退役删除；转换器样例 sample.ts 需要在同一份代码上双写，停写后无法运行，一并删除。第一至三段用这些工具得到的结论照旧记在各段审计里：双写对照在第二、三段的试跑会话上差异为 0（预期差异清单外），判定与续跑读者对照 6 个会话、搜索与显示读者对照 4 个会话清单外差异为 0。

## 三、跑批器会话文件操作的新做法

读者 E 在当前代码里只剩 eval/stream-runner.ts 一处（stream-trial.ts 已不存在）。

- 会话文件清单（sessionFilesOf）：递归列出会话根下的全部文件（新存储的会话文件与同目录的锁文件），以相对会话根的路径标识、分隔符一律为 `/`，逐个文件区分。此前只列会话根的一层，新存储按工作目录编码的子目录只算一项：子目录在一步开始前已存在时，作废尝试写进这个子目录的会话文件不会被移走。
- 作废隔离与续跑回滚（quarantineSessions）：不在保留清单里的文件连同子目录的相对路径移到输出目录下的 `voided/<作业>/<标签>/`，移空的子目录删去。作废重做与进程死在一步中途后的续跑共用这一做法。
- 每步完成时的会话清单 `sessions-<步序>.json`：记相对路径（含子目录）。续跑按上一个完成步的清单保留文件，其余移出。
- 第三段在双写期"检索只看旧账本仍有事件文件的会话"的过渡筛选（hasLegacyEventFile）从 memory/session-search.ts 与 memory/search-tools.ts 去掉：跑批器作废时直接移走新存储的会话文件，检索自然看不到。

## 四、停写的覆盖面

新存储成为唯一的写入目标。原先写旧账本的点与处理如下。

| 写入点 | 处理 |
|---|---|
| pi-runtime/adapter.ts：message_end 的 entry 与正文、运行事件五种、run.started 与系统提示全文、transformContext 观察写的 llm.request、recordObservation 入口 | 全部删去；消息、Run 开始与 Run 收尾只写新存储。transformContext 挂点随观察一起去掉（只读观察、原样返回，删去不改变执行）；recordObservation 删除 |
| application/governance.ts：intent（执行前 await、写不进即阻断）、decision、receipt、breaker | 四处落盘删除；审批闸、熔断与内存里的 ToolExecution 账本照旧；审批决定与错误归类照旧挂在工具结果消息的 details 上 |
| approvals/grant-store.ts 的授权建立与撤销 | 落盘口选项改名 sink，由装配根接到会话存储（grantEventSink） |
| orchestration/workers.ts 的 worker 派出与收尾 | 父会话落盘口接到会话存储（childFamilySink） |
| application/workers.ts 的 worker 会话头与分支会话头 | 旧记录删去；来历只在新建会话文件时写进文件头（177） |
| application/attempt-verify.ts 的验证记录 | 只写验证记录条目；verifyAttempt 的 store 改为必填，结果里的 record 即写入的输入 |
| application/checkpoints.ts 的 workspace.checkpoint | 删去，只写代码快照条目（位置在发起调用的助手消息之后、工具结果消息之前） |
| application/fork.ts 的分叉记录 | 删去，只在来源会话文件里记分叉条目 |
| 撞上限记录 run.limit-hit（headless 与 worker 编排器的 recordLimitHit） | 整条路径删除；撞上限原因经 interrupt(原因) 交给运行面，Run 收尾条目的结束方式记它 |
| load_skill 的 skill.loaded | 回调删除；读取摘要仍是工具结果的 details |
| 运行面装配的旧账本构造与关闭 | RuntimeBundle 去掉 eventLog；释放运行面只关会话存储写者 |
| 这一步起点 stepStart（headless → 运行面 → Adapter） | 只为写 run.started 存在，整条透传删除；headless 用于还原受保护文件的起点标记不变 |

停写后检查过没有读旧账本的地方剩下。第二、三段留在生产代码里的旧读法回退一并删除：续跑的"双写之前的旧会话"判定、成败标签（session-runtime 的失败重试判定）、运行指标（headless）、尝试切片（并行同任务派发）、授权种子恢复、运行面范围、分叉来源的旧会话判定、会话存储写者对旧会话的空写者。新存储里没有某个会话时，这些地方分别按"未知"标签、空指标、空种子、主会话范围、"会话不存在"处理。

随停写改变的语义：

- 授权建立与 worker 派出此前在旧账本写不进时抛错、动作不生效；新存储的写入面按内部故障告警、从不抛错（178），这两类动作不再因落盘失败而被阻断。
- 分叉此前由旧账本记分叉记录时的会话锁挡住"冷会话被另一个进程持有"的情形；现在由来源会话的分叉条目写不成来判定，在建工作树之前报错（application/fork.ts）。快照引用在写分叉条目之前已经建好，这一点与之前相同。
- 会话存储告警文案去掉"旧账本照常写入"：`会话存储告警：<原因>（会话记录缺这一条，运行不受影响）`。cli 与 tui 的"事件落盘失败，证据链不完整"改为"会话记录写入失败，证据链不完整"。
- headless 结果的验证结论去掉恒为真的 recorded 字段。

## 五、依赖规则与探针

.dependency-cruiser.js：

- actors-no-persistence-writes：禁止的目标由 persistence/grants-config.ts 扩到 persistence/session-lock.ts，注释改为"会话文件经只读读取器与会话目录读"。
- actors-no-event-log-direct 改为 actors-no-session-writer-direct：Actor（cli / tui）不直连会话存储写者 pi-runtime/session-store.ts。

src/boundary-rules.test.ts 的夹具与断言随之改为 Actor 直连会话写者、直连会话锁两个探针。依赖检查：无违规（379 个模块、2502 条依赖）。

探针脚本（不在 verify 内）：

| 脚本 | 处理 |
|---|---|
| ledger-migration/convert-legacy.ts | 保留；文件头注明只能拷进只读旧版工作树（455d88d）的同一路径运行 |
| ledger-migration 的三件对照工具与 sample.ts | 删除（见 2.3） |
| mcp-acc/run-everything.mjs、run-filesystem.mjs，tui-acc/run-m5.mjs、run-m55.mjs、run-m5c.mjs，m7-tree-write-bench.ts | 文件头加"只适用于旧格式"标注：读写旧账本、回执或会话树写穿，只能在只读旧版代码 455d88d 上运行 |

spikes/README.md 同步：上述脚本在目录表里标"只适用于旧格式"，另加一段说明；ledger-migration/README.md 改为只说明转换器与它的预期差异清单，退役工具指向各段审计。

## 六、旧格式会话的处理

旧格式会话即会话根下平铺的 `sess_<ULID>.jsonl`（旁置正文与锁文件不算）。新代码只按文件名认出它们，不读内容（187）；判定与文案在 persistence/session-catalog.ts（hasLegacySessionFile、listLegacySessionIds、legacySessionsNote、LEGACY_READER_HINT）。新存储的读取器本来只列子目录里的新格式文件，旧格式文件不会进入任何列举。

| 读者 | 遇到旧格式会话 |
|---|---|
| 会话列表、`/search` 命令 | 跳过，末尾一行：`另有 N 个旧格式会话（迁移之前创建）未列出；旧格式会话请用只读的旧版代码 455d88d 读取` |
| trace、replay（按会话号） | 报错：`会话 <id> 是旧格式会话（迁移之前创建），这里不读；旧格式会话请用只读的旧版代码 455d88d 读取` |
| 续跑（cli、tui 的 /resume） | 报错不进入续会话：`会话 <id> 是旧格式会话（迁移之前创建），不能续跑；……` |
| 历史视图 | 一行提示：`[旧格式会话（迁移之前创建），这里不显示历史；……]`；会话存储里也没有记录时为 `[该会话在会话存储里没有记录，这里不显示历史]` |
| agent 可见的 search_sessions 与 read_session_entry | 只跳过、不加提示：两个工具的输出按 185 冻结，提示对 agent 也无用处；正式跑的作业目录里不会有旧格式文件 |

## 七、测试与变异

### 7.1 测试改写

先写、先红：跑批器的两例（作废重做一例改为两步在同一工作区、同一工作目录子目录里各跑一次 headless，第二步第一次尝试作废；崩溃续跑一例改为新存储布局下同一子目录里的会话文件与锁文件）在旧的清单实现上变红（作废会话在重做时仍可检索；会话清单只记下子目录名），实现后变绿。

改写原则：断言对象是已停写的记录（intent、decision、receipt、resolution、breaker 记录、llm.request、skill.loaded、run.started 的系统提示哈希与这一步起点、eval.verified、运行事件落盘、entry 与正文文件、内容哈希、正文截断）时只删这些断言；断言对象是仍在记录的事实时改读新存储，保持同样的值与条数。改写后逐条回看保留与改写的断言，确认对应行为被破坏时会变红。

删除的整例（文件整体删除的除外）：

| 文件 | 用例 | 原因 |
|---|---|---|
| application/approval-reason-source.test.ts | 策略自动拒绝的理由标系统默认 | 只断言理由来源，该字段只在已停写的决定记录里 |
| tools/edit-file.test.ts | 内容证据探针两例 | 探针随回执与对账删除 |
| state/worker-workspace.test.ts | 已退役 Reviewer 旧记录的读路径 | 旧格式不读 |
| application/verify-steps.test.ts | v15 验证记录经迁移链升级 | 迁移链删除 |
| application/fork.test.ts | 会话树写穿失败的告警 | 写穿删除 |
| application/workspace.test.ts、worker-scope.test.ts | 只写旧账本的授权种子与运行面范围用例 | 覆盖面并入已有的新存储用例 |
| pi-runtime/snapshot.test.ts | 快照迁移链各例（v7–v12 各例保留当前 schema 的字段检查） | 快照迁移函数删除 |
| state/classification.test.ts、outcome-label.test.ts | 旧工具执行分类、旧物化现算事实的各例 | 被测函数删除；新读法的对应用例在 session-judge 与会话读者一侧 |

新增的用例：会话锁三例改为按会话文件加锁直接测（存活进程持有即拒绝并指明 pid、崩溃残留接管；同进程重入；锁文件不进会话清单）；冷会话被另一个进程持锁时，分叉在建工作树之前报错、不留工作树与分支文件、来源文件逐字不变、持锁进程的锁不被删（application/fork.test.ts）；/search 与会话列表的旧格式计数提示；历史视图对不存在会话的提示；hashing 的两例。

因记录停写而确实变弱的断言（原断言在新存储里没有对应来源）：

- 熔断：只能断言 Run 收尾条目的结束方式为熔断，熔断种类（按工具名、按参数指纹、上游拦截）与计数不再可读。
- 审批决定里的 grantRef：固化规则命中时"凭哪条规则放行"（规则的 promotedFrom.grantId）与会话放权的回指只在内存里的 ToolExecution 上，会话存储的审批标记只有结果与批准来源。
- 审批理由来源（人写或系统默认）；fail-closed 拒绝的决定理由（工具结果正文是固定理由，照旧逐字断言）。
- 并行同任务派发的共享任务标识：派出条目不写 taskKey，改为在派出请求层面断言两次派出带同一个标识。
- 执行证据：出错路径（超时、被拒、清单外命令）不再暂存证据；成功路径断言工具结果 details 里的命令、退出码、输出与哈希。

### 7.2 变异反向验证

在服务器上每次只植入一处，跑相应的测试文件，记下变红用例；以 git checkout 还原后源文件 sha256 与植入前一致（六处均一致）。

| 变异 | 测试文件 | 精确变红 |
|---|---|---|
| M1 跑批器会话文件清单退回只列会话根一层（eval/stream-runner.ts） | eval/stream-runner.test.ts（55 例） | 2 例：作废一步时清掉这次尝试的痕迹……同一工作目录下前一步的会话保留；进程死在一步中途留下的会话……（同一工作目录子目录里逐个文件区分）（所在的"固定起点跑批"一组随之标红） |
| M2 续跑时不把悬空调用补的"结果未知"工具结果写进会话（application/session-runtime.ts） | resume、workers-recovery-e2e、session-runtime、tui/session-view（14 例） | 1 例：续跑：进程死在工具执行途中——还原上下文，悬空调用补"结果未知"的工具结果写进会话并交给模型，接着跑 |
| M3 分叉时来源会话不记分叉条目（application/session-store.ts） | fork、fork-session、session-store（15 例） | 7 例：主会话 --retry-on-fail 1（两例）、/fork 命令、分叉续跑、--retry-on-fail 1 首次失败后分叉重试、失败自动分叉重试端到端、手动分叉时来源写者在本进程 |
| M4 来源分叉条目写不成时不报错（application/fork.ts） | fork（4 例） | 1 例：冷会话被另一进程持有：来源分叉条目写不成，在建工作树之前报错，不留工作树与分支文件 |
| M5 认不出旧格式会话文件（persistence/session-catalog.ts 的 hasLegacySessionFile 恒为假） | resume、history、trace、replay、legacy-memory-fields、workers-recovery-e2e、tui/session-view（31 例） | 6 例：历史视图的旧格式与不存在提示、续跑旧格式报错（两例）、旧格式会话的显示读者提示、trace 旧格式会话说明、/resume 旧格式会话 |
| M6 旧格式会话计数提示不出现（legacySessionsNote） | session-list、search、legacy-memory-fields、persistence/session-list（16 例） | 3 例：/search 末尾提示、session list 末尾提示、旧格式会话的显示读者提示 |

## 八、verify 的实际运行情况

测试在服务器上跑：阿里云实例 pigeon-verify，8 vCPU、31 GB 内存，Linux，Node 24.12.0，有 Docker，已载入实验镜像 pigeon-stream-strands:v6 与 pigeon-stream-pigeon:v4。专属目录经 git bundle 取分支头（本段第二个提交）强制检出（工作树无改动），依赖声明与基线相同。跑前确认没有别的测试进程，测试步并发 6：

- lint：通过（363 个文件）；
- check：通过；
- 测试：`node --test --test-concurrency=6 "src/**/*.test.ts"`，977 例，975 通过、0 失败、0 取消、2 跳过（仅 Windows 的 .cmd 启动器两例），用时 85.2 秒，测试进程最大常驻内存 513,132 KB；需要实验镜像的真容器用例本次运行并通过；
- deps：无违规（379 个模块、2502 条依赖）。

删除 readTextSync 之后，在同一台服务器上以该提交重跑全量（跑前无别的测试进程，并发 6）：lint 通过（363 个文件）；check 通过；测试 977 例，975 通过、0 失败、0 取消、2 跳过，用时 85.0 秒，最大常驻内存 512,196 KB；deps 无违规（379 个模块、2502 条依赖）。

第一次全量（改写后的首轮）977 例 4 例失败：历史视图的旧会话提示仍按旧文案断言（此前漏改），改为新文案并补上不存在会话的提示；worker 编排器撞上限两例仍断言已删的 recordLimitHit，改为断言中止请求带的原因；失败自动分叉重试一例新加的"来源会话只有 1 条分叉条目"断言不成立——来源会话的第二个 Run 同样验证失败，会再触发一次后台分叉重试，删去这一条（第一次重试之后恰好 1 条的断言保留）。修改后三个文件重跑 22 例全部通过；另去掉 lint 报出的一个测试里的未用变量，再跑上面的全量。本机（Windows）只跑类型检查、biome 与依赖规则检查。

## 九、留意事项

- 执行端接口 WorkspaceHost 的同步读 readTextSync：生产代码已无调用方（原调用方是写回执时实测目标内容哈希），已删除接口方法、本地与容器两份实现（容器实现专用的同步读缓冲上限一并删除），以及只测它的断言；本地执行端路径解析一例改用 resolveExisting 断言同样的"不存在"与"越界"两种错误。单独一个提交。
- state/runtime-events.ts 的 RunStartedPayloadSchema 仍保留 systemPromptHash 与结构化记忆字段的形状，Run 开始条目只逐项取用其中仍写的字段。
- 撞上限后又被人主动取消：运行面只认同一 Run 先到的中止原因，Run 收尾条目记撞上限，编排器给出的收尾状态是取消。该口径自第一段引入中止原因时即如此，本段未改。
- headless 以指定会话号运行时，若会话根下有同号的旧格式文件，照常在新存储里新建该会话的文件、不读也不改旧文件；续跑入口对同号旧格式会话则明确拒绝。
