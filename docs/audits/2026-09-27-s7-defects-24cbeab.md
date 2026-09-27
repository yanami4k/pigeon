# 两处缺陷：空回复与检查工具崩溃（基线 24cbeab）

范围：决策 170 的 ② 空回复与 ③ 验证工具自身崩溃。基线为 formal-v2 头 24cbeab（含账本重构第一至三段、DeepSeek 接入、跑批器一与二）。两个提交：

| 提交 | 内容 |
|---|---|
| 44aefce | 空回复重试一次，仍空即以 empty-reply 结束 Run |
| f153354 | 验证中识别检查工具自身崩溃，记为工具故障 |

合计 27 个文件，+1095 / −56 行；其中生产代码与测试设施（非 `.test.ts`）+255 / −55，测试 +840 / −1。

## 一、空回复（170 ②）

### 判定

`pi-runtime/adapter.ts` 的 `isEmptyReply`：助手消息以正常停止（stopReason 为 stop）收尾，内容里既没有工具调用块，也没有去掉首尾空白后非空的文字块。思考块不算内容，只有空白的文字算空。以撞输出上限（length）、中止、出错收尾的消息不在此列。

### 重试

- 上游一次运行以空回复收尾时，运行面在同一个 Run 里从 Agent 状态去掉这条空消息，以上游 `continue` 再运行一次。每个 Run 至多重试一次，下一个 Run 重新计。
- 重试那一轮照常发事件：`turn.completed` 计入 headless 的轮数与 token 预算，墙钟照走；重试中撞上限按原有中止路径收尾。
- 一个 Run 只发一次 `run.ended`：决定重试时暂扣上游第一次运行的 `agent_end`，由重试那次的 `agent_end` 作为本 Run 的收尾事件。主会话的验证挂载、会话树写穿等按 `run.ended` 工作的订阅方因此不会对同一个 Run 触发两次。
- 空回复那一轮里已来过中止请求（任何来源：撞上限、外部中止）即不重试；已暂扣的 `agent_end` 补发。上游 `continue` 同步建立活动运行，"查中止标记"与"开始重试"之间没有中止请求可插入的空档。
- 那条空消息照实留在会话文件里（它确实发生过），Run 收尾条目的消息条数含它；只从 Agent 的对话上下文里去掉，重试请求里不带它。

### 仍空的收尾

- Run 结果：`status` 为 failed，`emptyReply` 为 true，错误文本为 `EMPTY_REPLY_ERROR`。
- Run 收尾条目：结束方式 `empty-reply`（枚举值由账本重构第一段预留），停止原因 stop，错误文本同上。
- 失败分类：`classifyRunOutcome` 增加可选事实 `emptyReply`，为真即业务失败（与撞输出上限同类：模型输出的问题）。活侧取自 Run 结果；新存储的两处读者（`state/session-judge.ts` 的 `storeRunFailure`、`state/session-view.ts` 的 Run 分类）取自收尾条目的结束方式。旧账本没有这项事实，未改。
- headless：新终态 `empty-reply`，退出码 8。回炉开启时照常做这一次验证，之后不再开回炉轮，这一步收尾，结论以这次验证为准（与修满轮数、预算耗尽同一处判断）。回炉关闭时与原来一样收尾后验证。
- Worker 运行面的返回类型加可选的 `emptyReply`。

### 跑批器

`eval/stream-agents.ts`：headless 终态为 `empty-reply` 的步不落入"模型服务故障→作废重做"一支，不报被打断，按这一步的真实结果照常判题、留结果行。终态与 failed 分开，失败分类为业务失败，两者都不满足原判据；另在判据里显式排除 `empty-reply`，防止以后分类口径变化时落回作废一支。

## 二、检查工具自身崩溃（170 ③）

### 识别

- 分步验证配置的每一步加可选字段 `tool`（`state/attempt-config.ts` 的 `VerifyStepSchema`，加法式，旧配置与旧快照逐字有效），声明这一步用的检查工具。
- 退出码表 `TOOL_CRASH_EXIT_CODES`（`state/verify-steps.ts`），可扩充：

| 工具 | 崩溃退出码 | 不算崩溃的退出码 |
|---|---|---|
| pytest | 3 内部错误、4 命令行用法错误 | 1 有用例失败、2 被中断、5 没收集到用例 |
| mypy | 2 致命错误（内部崩溃，即提示 `--show-traceback` 的一类；配置或参数错误） | 1 有类型错误 |
| ruff | 2 非正常结束（配置或参数错误、内部错误） | 1 有违规 |

- 只认声明了工具、且工具在表里的步；没声明或不在表里的不按命令行去猜。超时、拉不起来（没有退出码）不算崩溃。
- 项目验证配置 `.pigeon/verify.json` 读取时，声明了表里没有的工具即响亮失败（写错的工具名会让识别悄悄失效）。
- 单条命令的旧配置没有步级声明，不识别。

### 重跑与记录

- `application/attempt-verify.ts`：某步以该工具的崩溃码收尾即重跑这一步一次，按重跑的结果记这一步；重跑仍是崩溃码即这一步标工具故障（验证记录各步上的 `toolFault: true`，字段由账本重构第一段预留在新存储的 `VerificationStepSchema` 上）。该步自身的退出码与结论照实保留。
- 整体结论 `verdictOfSteps`：只取不是工具故障的步做合取；全是工具故障即无法判定。整体退出码取第一个不是工具故障的失败步。整体输出里工具故障的步在分段标题上注明。
- 回炉：工具故障不判失败，因此不据此进入回炉；其余步失败照常回炉。全是工具故障时整体无法判定，按原口径不回炉。
- 旧账本的验证记录经 schema 解析时不带这个字段（只进新存储），旧账本代码未改。

### 反馈、报告与计数

- 回炉反馈（`application/repair-loop.ts`）：工具故障的步不列入"失败的步骤"，另起一行"工具故障的步骤（检查工具自身崩溃，重跑一次仍崩溃，不计入结论）"，不附其输出。
- trace：验证行后加"工具故障（不计入结论）：步名"。
- headless 回炉结果 `HeadlessRepairSummary.toolFaults`：这一步各次验证里工具故障的步数合计，没有即缺省。
- 跑批器：步结果 `repair.toolFaults`；结果行新字段 `verifyToolFaults`（开回炉的条件为合计数、缺省记 0，未开回炉或没跑 agent 为 null；此前写下的旧结果行没有这个字段）；报告"次要指标（第一遍）"加"验证工具故障（步次）"一列。

### strands 三步

- `eval/stream-profiles.ts` 的 strands 验证三步分别声明 ruff、mypy、pytest。本仓库自身的三步（tsc、node --test、dependency-cruiser）没有公开的崩溃码约定，不声明。
- pytest 一步的外壳原先按 junit 报告判通过与否、不看 pytest 的退出码。改为：pytest 自身以 3 或 4 退出时外壳交出这个退出码；其余情形照旧按报告判。外壳在报告写完后杀掉 pytest 的情形退出码为 137，不受影响；缺人的 pytest 配置时外壳自身的退出码 2 不在 pytest 的崩溃码里。

## 三、测试

各处测试先于对应实现写成，但没有在实现之前单独运行确认变红；承重处能否被抓住由第四节的变异反向验证确认。

| 文件 | 用例 |
|---|---|
| `pi-runtime/adapter-empty-reply.test.ts`（新） | 重试后有内容：同一 Run 正常完成、重试请求不带空消息、计 2 轮、只发一次 `run.ended`、会话文件留着空消息；仍空：失败、`empty-reply`、业务失败、只重试一次；判空：只有思考块、只有空白算空，有工具调用、撞输出上限不算；空回复那一轮已来中止请求：不重试、仍只一次 `run.ended`；重试次数按 Run 计 |
| `application/repair-loop.test.ts` | headless 仍空：终态 `empty-reply`、验证一次后不再回炉、整步 3 轮、业务失败；重试后有内容：回炉照常 |
| `application/verify-tool-fault.test.ts`（新） | 退出码表与 `isToolCrash`；整体结论只看其余步；崩溃一次重跑正常；重跑仍崩溃标工具故障、其余通过即通过；工具故障不掩盖其余步的失败；全是工具故障即无法判定；不猜（没声明、表外工具、非崩溃码都不重跑）；项目配置读出 `tool`、表外工具报错；回炉反馈单列；headless 不据此回炉并计数、按各次验证累计、没有时不带字段 |
| `eval/stream-agents.test.ts` | Pigeon 步空回复异常结束不报被打断、不再回炉；容器里验证出现工具故障不回炉、步结果带次数 |
| `eval/stream-runner.test.ts` | 结果行 `verifyToolFaults` 的取值；终态 `empty-reply` 的步照常判题留行、不重做 |
| `eval/stream-report.test.ts` | 次要指标的工具故障一列 |
| `eval/stream-profiles.test.ts` | strands 三步的工具声明、本仓库三步不声明；pytest 外壳对 3、4 交出原码，对 2 仍按报告判为 1（报告路径换到用例自己的临时目录，避免与同机其他测试进程共用容器内的固定路径） |
| `cli/trace.test.ts` | 空回复收尾的分类为业务失败；验证行单列工具故障 |

另：`cli/run-cli.test.ts` 已有"退出码表各终态互不相同"的断言，覆盖新增的 8。

## 四、变异反向验证

在服务器上逐个植入（每次只植入一处），跑列出的测试文件，记精确变红的用例；以 `git checkout` 还原，15 处还原后源文件 sha256 均与植入前一致。植入所在的提交与最终提交的代码只差 `state/session-entries.ts` 的一句注释。

| 植入 | 文件 | 变红（其余通过） |
|---|---|---|
| M1 思考块算内容 | adapter.ts | 判空一例（1/5） |
| M2 判空不看停止原因（撞输出上限也算空） | adapter.ts | 判空一例（1/5） |
| M3 重试不限一次 | adapter.ts | "重试一次仍空"一例（1/23） |
| M4 不暂扣首次 `agent_end` | adapter.ts | 重试后有内容、仍空、重试次数按 Run 计三例（3/5） |
| M5 空回复收尾记为 error | adapter.ts | adapter 仍空、中止请求两例，headless 仍空一例（3/23） |
| M6 空回复后照常回炉 | headless-core.ts | headless 仍空、Pigeon 步空回复两例（2/49） |
| M7 headless 终态不区分空回复 | headless-core.ts | 同 M6 两例（2/49） |
| M8 跑批器把空回复当模型服务故障 | stream-agents.ts | Pigeon 步空回复一例（1/31） |
| M9 崩溃码表去掉 pytest 的 4 | verify-steps.ts | 退出码表、全是工具故障两例（2/30） |
| M10 崩溃不重跑、直接记工具故障 | attempt-verify.ts | 崩溃一次重跑正常、重跑仍崩溃、全是工具故障三例（3/12） |
| M11 工具故障照常计入结论 | verify-steps.ts | 纯判据、重跑仍崩溃、全是工具故障、headless 两例、Pigeon 步一例，共六例（6/43） |
| M12 整体退出码取到工具故障的步 | attempt-verify.ts | 工具故障不掩盖其余步的失败一例（1/12） |
| M13 不累计工具故障次数 | headless-core.ts | headless 两例、Pigeon 步一例（3/43） |
| M14 pytest 外壳不交出崩溃码 | stream-profiles.ts | 外壳一例（1/18） |
| M15 结果行不记工具故障次数 | stream-runner.ts | 结果行一例（1/57） |

M8 说明：跑批器判据里显式排除 `empty-reply` 属双保险——即使去掉这一条，终态与失败分类也都不满足作废条件；M8 植入的是把 `empty-reply` 反向并入作废条件，验证用例能抓住作废。

## 五、与其他段的交集

- 账本重构第四段：本段改动了 `pi-runtime/adapter.ts`（`#runWith`、`#recordAndForward` 开头、`interrupt`、`#judgeTerminal`、`#recordRunEnded`）、`state/session-judge.ts` 与 `state/session-view.ts` 的 Run 分类各一行、`state/classification.ts`、`orchestration/workers.ts` 的运行面返回类型、`application/headless-core.ts`。旧账本代码未改。
- 旧账本与新存储的对照工具 `persistence/dual-write-compare.ts` 按旧账本推算结束方式与消息条数：遇到空回复异常结束的 Run 会报两处差异（结束方式按旧账本推为 completed；消息条数按旧账本的 `run.ended` 只数重试那一段）。属旧账本过渡工具，本段未改。
- 上下文压缩：交集在 `adapter.ts` 的 Run 执行；本段未加压缩挂点。重试以上游 `continue` 在同一 Run 内进行，压缩挂点若挂在每次模型调用前，会同样作用于重试那一轮。

## 六、verify 的实际运行情况

服务器：阿里云实例 pigeon-verify，8 vCPU、31 GB 内存，Linux，Node 24.12.0，有 Docker。专属目录经 git bundle 取最终提交 f153354 检出（工作树无改动），依赖按锁文件 `npm ci` 安装。跑前确认服务器上没有别的测试进程，测试步并发 6：

- lint：通过（404 个文件）；
- check：通过；
- 测试：`node --test --test-concurrency=6 "src/**/*.test.ts"`，1167 个用例，1165 通过、0 失败、0 取消、2 跳过（仅 Windows 的 .cmd 启动器两例），用时 99.1 秒，测试进程最大常驻内存 550,648 KB；
- deps：无违规（421 个模块、2894 条依赖）。

另在服务器上单独检出第一个提交 44aefce 跑类型检查，通过（两个提交各自可编译）。

本机（Windows）只跑类型检查与 biome，均通过；测试全部在服务器上跑。开发途中一次多文件并发运行里，新加的 pytest 外壳用例因容器内固定的报告路径在宿主上与同机其他测试进程共用而失败一次，改为用例自己的临时报告路径后单独连跑三遍与全量运行均通过；原有的"strands 验证门"用例仍用那个固定路径，本段未改。

## 七、已知限制

1. 空回复那条消息留在会话文件里。按会话树还原上下文（续跑，以及其他按会话树重建 Agent 消息的路径）之后，它会回到 Agent 的上下文里。pi-ai 0.84.4 的 anthropic-messages 转换会跳过这样的助手消息：没有非空文字、没有工具调用，也没有可发出的思考块（思考为空白且无签名的思考块同样跳过）。因此关思考时，这条空消息不会发给模型。开思考时，只含思考块的空回复还原后会随上下文发出，紧跟在它后面的是重试得到的那条助手消息。
2. 第六节提到的"strands 验证门"用例仍用容器内固定的报告路径，同机多个测试进程并发运行时可能相互干扰。
