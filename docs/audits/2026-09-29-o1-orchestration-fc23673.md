# 编排一段：积木与任务清单（决策 294、297–300、302、303）实现审计

- 基线：formal-v2 的 fc23673；开发中并入 formal-v2 的 6cb88be（终端界面完善一段）。
- 分支：o1-orchestration
- 代码提交：d8f52ab（编排器：标签、生命周期事件、等待、发消息、卡住监控、嵌套、审批超时与补批续做）、eb46c91（运行面的通知队列）、99f91d8（后台派出与完成通知、四件积木工具、任务清单、pigeon run 等 worker 结束）、238325f（终端界面：通知显示与叫醒、状态行刷新、/tasks）、58e9ede（并入 formal-v2）、18b04f1（/tasks 登记进命令表，通知与排队输入的次序用例）；本审计另起一个提交。
- 范围：后台派出与完成通知（297）；结构化结果与卡住监控（298，打转检测只留接入点）；嵌套（299）；额度（300）；五个接口与任务清单 B1（294）；worker 改自己工作树放行与请示的超时交回（302、303）；界面三处（通知进消息区、agent 派出的 worker 刷新状态行、/tasks）。
- 不做：打转检测本身（293）；脚本编排与"本次脚本内同类都允许"（294 D、303 的脚本部分）；进入 worker 会话补批的界面、编排面板与完整的清单显示（编排二段，301）；输入框、状态栏与工具调用显示（终端界面一段）。
- 依据：决策 264–268、271、279、292、293、294、297、298、299、300、302、303。

## 一、后台派出与完成通知（297）

- `spawn_worker` 派出后立即返回 worker 的名字、分支与标签，不再等它收尾；`attempts` 照旧派 2 到 4 份、按验证命令标签，改为在后台跑，派出即返回名单，全部结束并验证后发一条汇总通知（每份一段，前缀"第 n 份（通过/未通过/未知）："）。角色、名字、attempts 的参数与定稿语义不变。
- 主 agent 这一轮结束或被中断都不影响已派出的 worker（原先"等待中被中止即取消本次派出的 worker"随阻塞语义一并取消）。
- 完成通知（`src/application/worker-notices.ts`）：模型派出的 worker 结束（完成、失败、超时、撞上限、取消、卡住）时，一条以 `[worker 通知] ` 开头的用户消息进派出方的下一轮，文字为 271 定稿的各情形文字（含起点一行），带标签的在前面写明"标签 X："。人用 /spawn 派的收尾照旧显示在消息区、不发通知；程序直接派的由调用方自己收。
- 进下一轮的做法（`src/pi-runtime/adapter.ts`）：运行面新增通知队列 `notify`、`withdrawNotice`、`noticeDelivered`、`pendingNotices`、`runNotices`。Run 进行中递来的通知先留在队列里，每轮结束（`turn_end`）时转入上游的 steer 队列，上游在进入下一轮前取走——本轮没有工具调用时同样接着跑一轮，不另开 Run。空闲时 `runNotices` 只带通知开一个 Run；下一次 `run(输入)` 连同输入带上待递的通知（通知在前、输入在后）。没有通知时 `run` 与之前逐字节一致。
- 同一结果不在对话里出现两遍：派出方正用 `wait_workers` 等着的 worker 结束时不另发通知；已结束、通知还没递出的，等待工具撤回通知、交回完整结果；通知已递出的，等待工具照常交回、只写一句"worker X（角色）已结束（状态），结果见此前的通知。"。多份尝试里已由等待交回的一份，汇总通知里只写"worker X 的结果已由 wait_workers 交回。"；汇总已发出后再等，只交回一句。
- 空闲时叫醒：终端界面见第八节；pigeon run 与能再派的 worker 见下条。
- pigeon run（`src/application/headless-core.ts`）：每次运行（首轮与回炉各轮）结束后，经 `drainWorkers` 等本次派出的 worker 全部结束、多份尝试的汇总发出、待递的通知都作为新的一轮处理完，这一步才往下走（验证、回炉、收尾复盘）；最后一次运行的结果为这一步的结果。等的途中撞上轮数、墙钟或 token 上限，或被外部中止，即不再等，这一步按撞上限的原因（或中止）收尾，释放前停掉仍在跑的 worker 并等其收尾记录写进本会话。
- 新增积木工具（四件分开，与 spawn_worker、take_worker 同为单一动作的风格；都在 `src/application/orchestration-tools.ts`，与 spawn_worker 同槽同注册范围，只读档、不经审批）：
  - `wait_workers`：`workers`（不给即所有还在跑的）、`mode`（any / all，缺省 all）、`timeout_seconds`（缺省 300，最多为每个 worker 的时间上限，缺省 1800 秒，跟着配置走）。到时仍未结束即返回当时的状态，没结束的继续跑。
  - `worker_status`：名字、角色、标签、状态、已用轮数与时间，已结束的附结果摘要（前 200 字）。
  - `message_worker`：给在跑的 worker 递一段话，前缀 `[来自派出方的消息] `，进它的下一轮（同样经运行面的通知队列）；已结束的收不到；它在下一轮之前结束（最后一轮之后才递到、正在收尾）时如实交回"未送达"，不静默丢掉（见第十三节）。
  - `stop_worker`：停掉在跑或排队的 worker，走编排器的取消，结果照常交回。
- 说明文字：spawn_worker 的第 1、3 句按 297 改写（第 3 句写明四件积木的用法与"不要把派出去的活自己再做一遍"），给了一次运行的派出上限时第 3 句末加"一次运行最多派 N 个。"；第 5 句"也不能再派 worker"只在新 worker 已在最底层时出现，放开嵌套时改为"它还能往下再派 k 层 worker。"；label 参数的说明在任务清单关着时不提清单。其余 271 定稿句不变。各工具说明、参数说明与返回文字由用例逐字钉住（`spawn-worker-tool.test.ts`）。

## 二、结构化结果与卡住监控（298）

- `WorkerOutcome` 新增：`errorKind`（错误类型，非完成时在场）、`recoverable` 与 `blocked`（请示被搁下时，见第七节）、`label`、`origin`（agent / human / program）、`transcript`（会话记录位置：worker 会话文件路径）、`durationMs`。最后一段输出即原有的 `result.summary`（末条助手正文，上限 2000 字），已改文件即 `result.changedFiles`。
- 状态：在原有取值上新增 `stalled`（卡住）。等待工具按 298 的六种说法写：completed 为完成，wall-clock-limit 为超时，turn-limit 与 token-limit 为撞上限，cancelled 与 aborted 为取消，stalled 为卡住，其余为失败。
- 错误类型取值：run-failed、empty-reply、exception、spawn-failed、cancelled、aborted、turn-limit、wall-clock-limit、token-limit、stalled、looping、approval-timeout、approval-unattended。
- 不由框架自动重试。
- 卡住监控：每个 worker 开跑后，运行面发出任何事件（模型回复、工具结果、轮次收尾等）即重新计时；缺省 10 分钟没有新事件即中断，以 `stalled` 收尾、错误类型 stalled。等审批期间不计（到点时有待决的审批即顺延）。阈值可配置（第四节）。自带超时的工具（run_command、web_search、web_fetch）从提出到结束期间暂停计时，由工具自己的超时兜底，命令跑得比卡住时限久也不判卡住；其余工具执行期间照常计时（见第十三节）。
- 打转检测的接入点：编排器选项 `watchers`，每个 worker 开跑时各建一份观察者，观察它的运行事件，可经 `control.stop(错误类型, 原因)` 叫停，worker 以失败收尾、错误类型与原因照给出的记（错误类型已预留 looping）。本段不实现打转检测，装配根未注入观察者。

## 三、嵌套（299）

- 缺省层数 1：主会话派出的 worker 在第 1 层，不能再派（编排器拒绝，委派策略里也没有派出的工具）。
- 配置放开（`maxDepth` 大于 1）时：未到最底层的 worker 的委派策略另带 spawn_worker、wait_workers、worker_status、message_worker、stop_worker（父策略里有才带；不带 take_worker，叠加只往主工作目录），装配时另拿一个本层的派出槽，绑到主会话的同一个编排器——各层共用同一份并发额度与生命周期事件。下层的派出与收尾记录写进上层 worker 自己的会话；下层从上层 worker 的工作树拍快照开工；下层的完成通知进上层 worker 的下一轮。
- 能再派的 worker 在自己的运行结束后，同样等它派出的 worker 全部结束、把通知处理完才算结束；它被取消或撞上限时一并取消它派出的在跑 worker。
- 防互相卡死：在跑的 worker 调用 wait_workers 等下层时，等待期间把自己占的空位借出，等完再收回（收回时没有空位即排队）。

## 四、额度与配置（300）

- 同时在跑的上限缺省由 4 改为 8，人派、模型派与程序派共用，只在编排器一处管（排队不拒绝）。
- 取消 worker 总数上限：`--worker-limit` 的缺省 16 去掉，参数保留为可选上限（一次运行里模型派出的个数，人派的不计），给了才生效、满了按 268 定稿文字拒绝。配置里的 `maxWorkersPerRun` 同义。
- 每个 worker 仍为 40 轮、30 分钟，可配置。
- 新增项目配置 `.pigeon/orchestration.json`（人手写，可缺省；缺失取缺省，畸形响亮失败，形态同 web.json）：`version`（1）、`maxConcurrent`（缺省 8）、`maxDepth`（缺省 1）、`maxWorkersPerRun`（缺省不设）、`worker.maxTurns`（缺省 40）、`worker.wallClockMinutes`（缺省 30）、`stallMinutes`（缺省 10）、`approvalTimeoutMinutes`（缺省 5）、`taskList`（缺省 true）。启动参数 `--worker-concurrency`、`--worker-limit` 优先于配置。终端界面与 pigeon run 读它；跑批器不读。

## 五、五个接口（294）

1. 标签：`SpawnRequest.label`（spawn_worker 的 `label` 参数），写进派出记录（`child.spawned` 新增可选 `label`），在生命周期事件、状态、结构化结果、完成通知与等待结果里原样带回；多份尝试各份共用。
2. 生命周期统一发事件：`WorkerOrchestrator.subscribe`，事件为 `worker.spawned`（带是否排队）、`worker.started`、`worker.blocked`（请示被搁下）、`worker.settled`（带结构化结果）、`worker.resumed`（补批续做），各带 worker 身份（会话号、名字、角色、标签、来源、所在层、派出方会话）。监听器抛错只进内部故障清单。
3. 积木可被程序直接调用：编排器的 `spawn`、`wait`（任一 / 全部、超时、可中止、可借出空位）、`send`、`cancel`、`status`、`awaitResult`、`resume`、`subscribe` 都是普通方法，工具只是其上一层；收回为 `takeWorkerChanges`（`take-worker-tool.ts`，/take 与 take_worker 共用）。
4. 并发额度只在编排器一处管：先到先得的空位队列，派出排队与等待中借出的空位收回共用同一条队列。
5. 结果与工作树跨轮保留：worker 的结果与工作树在派出方这一轮结束后仍在编排器里，状态、等待与收回照常可用；终端界面里随会话保留，退出时照旧取消在跑的并等收尾记录落盘；工作树不自动清理（279 不变）。

## 六、任务清单 B1（294）

- 两件工具（`src/application/task-list-tool.ts`）：`update_tasks`（建立与更新合为一件：给 id 更新该项，不给即新建；每项标题、状态 pending / in_progress / done / dropped，可选 `depends_on` 与 `worker_label`；一批里有不成立的项即整批不改；返回整份清单）与 `list_tasks`。只记录不调度，不派出、不按依赖排序或拦截。只读档，不经审批。
- 存进会话：每次更新后的整份清单随 update_tasks 的工具结果 details 写进会话文件；续聊（/resume、--continue、--resume）时从会话里最后一次更新还原，编号接着排。
- 开关：编排配置 `taskList` 缺省开；只给主会话注册（worker 不注册）；终端界面与 pigeon run 按配置给，装配层与 headless 缺省关。
- 终端界面：`/tasks` 显示当前清单，清单关着时如实说明；登记进命令表（`command-table.ts`），运行中可用。完整的清单显示留给编排二段。

## 七、权限（302、303）

- 302（`src/application/governance.ts`）：worker 的治理加一档——排律 deny、放权（会话放权与 .pigeon/grants.json 固化规则）、免审、yolo、只读之后，原本要问人的调用，若是写层文件工具（edit_file，两种编辑模式同名）且 path 落在它的工作区根（它自己的工作树）之内，即放行，账本记 `policy:auto`。越出工作树、跑命令、读网页、MCP 写工具等照旧请示。只由 worker 装配时开（`ownWorkspaceWrites`）；主会话规则不变；worker 仍不继承主会话的会话放权，固化规则照常生效（排在这一档之前）。
- 303（`src/orchestration/workers.ts` 的审批入口）：worker 需请示的动作经编排器汇到派出方的审批回调，请求带 worker 的名字、角色与标签，面板照旧写"来源：worker 名（角色）"与要做的动作（命令串、网站或工具与路径）。
  - 等满时限（缺省 5 分钟，可配置）无人批：撤回请求（请求新增 `signal`：审批队列里还没轮到的不再上面板，已在面板上的撤下并写一行说明），拒绝这次调用并中断这个 worker；它以失败收尾，错误类型 approval-timeout，`recoverable` 为真，`blocked` 记下工具、参数与动作；其余 worker 照常。
  - 无人值守（pigeon run，没有审批通道）：不等，直接按上条交回，错误类型 approval-unattended。原先无人值守时 worker 被拒后自行继续的做法随之改为停下交回。
  - 完成通知写"worker X（角色）停在等审批：要<动作>，<k 分钟内无人批准｜无人值守运行没有人审批>。分支 … 上有已做的部分；人补批后它可以接着做。"，k 取配置值。
  - 补批续做的底层能力：`orchestrator.resume(会话号, { approve, message })`——同一个会话号与工作树重新装运行面（从会话文件还原对话，悬空的工具调用补"结果未知"），给它一句续做的话（补批时为"人已批准你之前等待审批的调用（<动作>）。请重新发起这个调用，然后接着完成任务。"），并只放行它重新发起的同一个调用一次（工具名与参数都相同，不经审批回调）。重新占额度，收尾照常发事件、写收尾记录。进入 worker 会话补批的界面不在本段。
- 主会话的审批规则与本段之前相同。

## 八、界面（三处）与并入终端界面一段后的接法

- 完成通知以消息形式出现在消息区（`[worker 通知] …` 一行或多行）。
- 修"agent 派出的 worker 不刷新状态行"：编排面新增 `subscribe`，壳在绑定运行面时订阅编排器的生命周期事件，派出、开跑、收尾都即时刷新 worker 行（原先只在 /spawn、/workers 等命令之后刷新，模型派出的要等下一条命令）。
- `/tasks` 见第六节。
- 通知与运行中排队输入走同一个出口（壳的 `drainQueue`，即"下一轮发什么"）：空闲时先逐条发出排队的人工输入，其中第一条发出的那一轮由运行面在开头带上已到的通知（通知在前、输入在后）；没有排队的输入时，已到的通知单独跑一轮（只带通知）。完成通知到来时的叫醒（`runNotices`）同样只是调用这个出口；运行中不打断，通知在本轮每一轮结束时进下一轮，这一轮结束后仍有没递出的再经这个出口处理。
- worker 请示被撤回时审批面板撤下（第七节）。输入框、状态栏与工具调用显示未动。

## 九、记录与视图

- `child.spawned` 新增可选 `label`；`child.settled` 新增可选 `errorKind`，状态取值新增 `stalled`。加这些之前的记录照常读取。
- 会话视图：同一个 worker 的第二条收尾记录（补批续做后再收尾）以后到的为准，不再计为孤立的收尾记录。
- 请求审批新增可选 `signal`（只在内存里，不落盘）。

## 十、实验（265）

- 跑批器各条件不注册本段新增的任何工具：派 worker 照旧明确关掉（五件积木与 take_worker 同槽随之不注册），任务清单另以 `STREAM_TASK_LIST = false` 明确关掉。
- 身份头照先例记上两项：`workerTools: false`（四件积木）、`taskList: false`；加这两项之前写下的身份头没有它们，续跑即判为不同（与 takeWorker、webTools 同一口径）。
- pigeon run 缺省不带任务清单（headless 缺省关），由 CLI 入口按编排配置打开。

## 十一、测试

- 新增专门用例：
  - `src/orchestration/orchestration-core.test.ts`（10）：标签与生命周期事件；程序直接调用积木（派出、发消息、等任一与全部、超时、停止）；缺省同时 8 个、派 20 个不设总数上限；卡住被中断、等审批不计；观察者接入点叫停；嵌套缺省拦住；放开嵌套后共用额度、借出空位不卡死、到底层拦住、派出记录写在上层 worker；审批超时撤回、可恢复交回、其余照常；无人值守即交回；补批续做。
  - `src/application/spawn-worker-tool.test.ts`（重写，16）：定稿文字逐字；说明随配置变化；派出立即返回；完成通知带标签并叫醒、人派与程序派不发；各种结束状态与六种说法；wait_workers 的任一、全部与超时；同一结果不出现两遍（三种情形）；worker_status 与 message_worker；派出前检查；同时 8 个且不设总数上限；给了上限即拒绝；额度用完；token 回报；多份尝试汇总通知。
  - `src/application/spawn-worker-headless.test.ts`（重写，8）：pigeon run 等全部 worker 结束、通知作为新的一轮处理完才结束；主 agent 还在跑时的通知进同一 Run 的下一轮；token 上限与时间上限在等 worker 时撞上即按撞上限收尾并停掉 worker；无人值守时要跑命令的 worker 停下交回、改自己工作树的照常完成；给了上限时回炉各轮共用；多份尝试汇总一条通知；放开嵌套两层的端到端。
  - `src/pi-runtime/adapter-notices.test.ts`（3）：通知进同一 Run 的下一轮；递出前撤回；空闲时 runNotices 与下一次 run 带上通知。
  - `src/application/orchestration-wiring.test.ts`（6）：新工具的注册范围与嵌套槽；任务清单开关与编排配置（缺省、可关、参数优先、畸形失败）；实验条件一件都不注册、身份头记关；任务清单的增改查与整批校验；清单存进会话、续聊还原；302 放行与越界、跑命令、主会话仍请示。
  - `src/tui/orchestration-shell.test.ts`（5）：agent 派出的 worker 即时刷新状态行；空闲叫醒与在跑时不打断；/tasks；请示撤回时面板撤下；通知与排队输入的次序、运行中 /tasks 可用、未知命令提示含 /tasks。
  - `src/approvals/queue.test.ts`（+1）：排队中撤回的请求不交给 handler。
- 改写（语义变更）：`spawn-worker-registration.test.ts`（同一次回复两次派出都立即返回）；`spawn-worker-cli.test.ts`（pigeon run 端到端改为派出后用 wait_workers 等二者并行完成再合并；缺省同时 8 个、不设总数上限；给了上限的拒绝）；`workers-approvals-e2e.test.ts`（302 起 implementer 改自己工作树不请示，改用两个 tester 跑登记过的命令测审批汇聚）；`workers-e2e.test.ts`（改自己工作树记 policy:auto、不请示）；`workers.test.ts`（审批请求多带 signal）；`take-worker-tool.test.ts`（编排面替身补新方法）；`stream-experiment.test.ts`（身份头两项）；并入后 `input-queue.test.ts` 的运行中放行表加 tasks。
- 变异反向验证（服务器；每项只改一处实现、只跑相关用例文件，单用例超时 8 秒、单文件外包 120 秒；还原后哈希与原文件一致、工作区干净）：

| 变异 | 改动 | 变红的用例 |
|---|---|---|
| 派出仍阻塞 | spawn_worker 派出后先等 worker 收尾再回话 | 派出立即返回；各种结束状态；wait_workers 任一全部超时；同一结果不出现两遍；worker_status 与 message_worker；同时 8 个不设总数上限（6 条） |
| 通知不进下一轮 | 运行面在一轮结束时不转交通知 | 通知进同一 Run 的下一轮（Adapter）；主 agent 还在跑时的通知进这次运行的下一轮（pigeon run）（2 条） |
| 嵌套未拦 | 编排器的层数判断失效 | 嵌套缺省拦住；放开嵌套到底层拦住；深度 1 拒绝再派（既有）（3 条） |
| 写自己工作树仍请示 | 302 这一档不生效 | 302 放行；无人值守时改自己工作树照常完成；并行 worker 写自己的工作树（既有）（3 条） |
| 请示不超时 | 审批等待不设时限 | 审批等满时限无人批（1 条；文件进程因挂起的审批由外层时限收掉） |

## 十二、verify 的实际运行情况

- 全部在服务器上跑：8 vCPU、31 GB 内存、Node 24.12.0，专属目录，提交 18b04f1（已含并入的 formal-v2 6cb88be）。
- `npm run lint`、`npm run check` 通过；测试步 `node --test --test-concurrency=3 "src/**/*.test.ts"`（当时服务器上另有测试进程在跑，并发取 3）：1359 条，通过 1357，跳过 2（既有），失败 0，约 117 秒；`npm run deps`：510 个模块、3539 条依赖，0 违规。四步合计约 134 秒。

## 十三、验收后的修改

- 提交：ae71c8c（卡住监控在自带超时的工具执行期间暂停、message_worker 如实交回未送达）；本节另起一个提交。

### 1. 自带超时的工具执行期间暂停卡住计时

- 编排器新增选项 `selfTimedTools`，缺省为 run_command、web_search、web_fetch（三者各有自己的超时：run_command 为工具选项 `timeoutMs`，缺省 2 分钟，目前未开放到配置；两件联网工具取 .pigeon/web.json 的超时）。worker 的运行事件里出现这些工具的 `tool.proposed` 即记下这次调用，对应的 `tool.settled` 到达即划掉；卡住计时到点时仍有记下的调用即顺延，与等审批同一处理。暂停不看工具超时的具体值，超时配到 10 分钟以上时同样不会误判为卡住。
- 其余工具（read_file、edit_file、会话检索、MCP 工具等）执行期间照常计时。
- 用例（`src/orchestration/orchestration-core.test.ts`）：自带超时的工具跑了卡住时限的 5 倍仍在跑、结束后照常完成；不自带超时的工具静默超过卡住时限即以 stalled 收尾。

### 2. message_worker 未送达如实交回

- 编排器的 `send` 改为交回是否送达：运行面的 `notify` 交回键，另有 `noticeDelivered`、`withdrawNotice`；话进了 worker 的下一轮即 delivered；worker 在那之前结束（最后一轮之后才递到、正在收尾）即 undelivered，没递出的撤回。运行面不支持查询送达的按 delivered。
- `message_worker` 等到有结论才回话：送达时照旧"已把话递给 worker X，它在下一轮看到。"；未送达时交回"未送达：worker X 已结束或正在收尾。要这段话生效，另派一个 worker 或自己做。"，details 的 `delivered` 为 false。不补跑那一轮。
- 用例：`orchestration-core.test.ts` 的 send 送达与未送达（未送达的撤回、已送达的不再撤回）；`spawn-worker-tool.test.ts` 的 message_worker 未送达。修改中发现并修正：已判送达的话在 worker 收尾时仍被撤回一次，现收尾时先看是否已有结论。

### 3. 已知限制

- 放开嵌套时，下层 worker 不带 take_worker：下层的改动只留在它自己的分支与工作树上，不能由上层 worker 叠进上层的工作树。嵌套缺省关着（层数 1）。

### 4. verify

- 服务器（8 vCPU、31 GB 内存、Node 24.12.0，专属目录），提交 ae71c8c：`npm run lint`、`npm run check` 通过；测试步 `node --test --test-concurrency=3 "src/**/*.test.ts"`（当时服务器上另有测试进程在跑）：1363 条，通过 1361，跳过 2（既有），失败 0，约 117 秒；`npm run deps`：510 个模块、3539 条依赖，0 违规。
