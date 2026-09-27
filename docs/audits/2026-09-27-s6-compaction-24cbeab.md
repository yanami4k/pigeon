# 上下文压缩：压缩服务、两个触发挂点、/compact 与压缩前回调（基线 24cbeab）

范围：在 formal-v2（头 24cbeab：账本重构第一至三段、DeepSeek 接入、跑批器一与二）上新开 compaction-s6，实现 188、189 的上下文压缩，按 218 取产品缺省阈值，留出 192、207 的压缩前复盘挂点。依据：决策 179、183、188、189、192、203、207、218。

| 提交 | 内容 |
|---|---|
| cb4fb02 | 压缩服务；会话写者读主分支、写压缩条目；Run 开始条目的压缩配置字段 |
| 8f11868 | 运行面：两个触发挂点、手动压缩、压缩提示订阅、Run 结束后按会话树还原、convertToLlm |
| 8bb63d2 | 装配根缺省开启压缩；启动参数、无头运行与跑批器的配置透传 |
| 5fa514a | 命令行对话与终端界面的 /compact 与压缩提示 |

改动：28 个文件，新增 2326 行、删除 20 行；其中生产代码（含测试设施 `pi-runtime/fixtures.ts`）新增 832 行、删除 18 行，测试新增 1494 行、删除 2 行。上游 pi-agent-core、pi-ai 0.84.4 只调用、未改动。

## 一、压缩服务（`src/pi-runtime/compaction.ts`）

复用 pi-agent-core 0.84.4 公开导出的 `prepareCompaction`、`compact`、`buildSessionContext`、`shouldCompact`、`estimateTokens`、`calculateContextTokens`，不经 `AgentHarness`（其 `compact` 为桩）。

- 判定：`exceedsThreshold` 调上游 `shouldCompact`（上下文 token 数大于窗口减预留）；触发点调低时以"触发点加预留"作窗口传入，判定口径不变，等于触发点不压缩。
- 上下文 token 估算 `contextTokens`：与上游 `estimateContextTokens` 同口径（最后一条正常助手消息的 usage，加其后消息按字符数除 4），只多一条：最近一个压缩摘要之前产生的助手 usage 视为过期、不用。压缩后的保留段里仍有助手消息，其 usage 量的是压缩前的整段上下文；照用则压缩刚完成、下一轮又判为超限。以摘要消息的时间为界，界前的 usage 不算，没有新鲜 usage 时整段按字符估算。
- 摘要请求的模型接入：`summaryModels(streamFn)` 只实现 `completeSimple`（经给定的 streamFn 发出、取终态消息），其余方法调用即报错。上游对摘要请求强制 `cacheRetention: "none"` 与新的 sessionId，按 `min(0.8 × 预留, 模型输出上限)` 定输出上限，只有模型对象 `reasoning` 为真且给了推理档位才请求推理；本服务不给推理档位，摘要请求一律不请求推理。
- 判空：`prepareCompaction` 给出的历史段与被切开那一轮的前段都为空时返回"没有可摘要的"，不调模型、不调压缩前回调、不写条目（上游 `compact` 对空段照样发请求）。
- 一次压缩的顺序：读主分支 → 准备 → 判空 → 压缩前回调 → 生成摘要 → 写压缩条目 → 按会话树还原上下文。服务从不抛，失败以结果返回。

会话写者（`src/pi-runtime/session-store.ts`）新增两项，都排进写入队列、排在此前的写入之后：

- `branch()`：读主分支，从根到叶；会话没打开或读失败时为 undefined。
- `appendCompaction(result)`：写一条 pi 原生的 compaction 条目（摘要、保留段、tokensBefore、上游给的文件清单与摘要请求的 usage），返回写入后的主分支。原始消息不动（179）。思考不持久化时，保留段里助手消息的思考块同样剥去，与消息写入同一口径。

Run 开始条目（`pigeon.run-start`）新增可缺省字段 `compaction`：`contextWindow`、`reserveTokens`、`keepRecentTokens`、`thresholdTokens`。运行面配置了压缩即每个 Run 写一次。旧账本的 run.started 未改。

## 二、阈值与配置（218）

- 缺省：模型窗口取产品缺省模型 DeepSeek 的 1,000,000，预留 16,384，保留 20,000，触发点 = 窗口 − 预留 = 983,616。
- 可配置：`--context-window`、`--compact-threshold`、`--compact-keep`，命令行对话、终端界面、`pigeon run` 与 `pigeon eval stream` 都接受；无头运行的 `compaction` 选项、跑批器 Pigeon 条件的 `compaction` 选项同样透传到装配根。校验：均为正整数，窗口须大于预留，触发点须小于窗口，畸形在打开会话文件之前报错。
- 装配根（`src/application/runtime.ts`）对每个运行面都建压缩服务，Pigeon 的全部条件因此都生效。worker 用产品缺省，不继承主会话给的配置。最简 agent 不经这条装配，未改动（188）。

## 三、两个触发挂点与状态还原（188）

`PiRuntimeAdapter` 新增构造选项 `compaction`（压缩服务），只在新存储写入面带 `branch` 与 `appendCompaction` 时生效。

- 轮间：交给 Agent 的 `prepareNextTurnWithContext`。上游在一轮完成、循环要继续时调用；此时本轮消息都已交给写者。超过触发点即压缩，返回以压缩后上下文替换的 context；未超过、没有可摘要的或压缩失败时返回 undefined，照原上下文继续。该回调上游无防护，这里自包、绝不抛。
- Run 开始之前：`run()` 与 `continueRun()` 在写完 Run 开始条目之后、发起 prompt 或 continue 之前，按 Agent 当前消息判定，超过即压缩并整体替换 `agent.state.messages`。回炉轮、交互中的下一条输入、续跑都经这里。压缩期间收到 `interrupt()` 时：压缩的中止口一并中止，照常发起后立即中止 Agent，这个 Run 按上游的标准事件序列以中止收尾，不照常开跑。
- Run 结束后还原：轮间替换上下文后，Agent 的消息仍按 message_end 累积全量。本 Run 内轮间压缩过时，Run 收尾条目写完后，按会话树（写者读主分支，`buildSessionContext`）重新还原一次 Agent 的消息；会话树读不到时，退回"压缩后的上下文加压缩之后追加的消息"。
- convertToLlm：把上游的 `convertToLlm` 交给 Agent。上游缺省实现只留 user、assistant、toolResult，会把压缩摘要消息静默丢掉；上游实现把它转成带 `<summary>` 包裹的用户消息。
- 续跑（183）：`restoreSessionContext` 本就经 `buildSessionContext`，从最后一个压缩条目往后接（摘要、保留段、压缩之后的消息），未改，补了测试。

失败处理：摘要请求失败、会话写入失败、压缩前回调的故障都只进 `listenerErrors`（命令行对话与终端界面按既有口径提示"事件落盘失败"计数），本轮照原上下文继续。

## 四、摘要请求与计量

装配根给压缩服务的 streamFn 就是主请求用的那一个（跑批时即按作业网关地址造的模型接入）。它只套温度包装：摘要从不请求推理，温度总能生效；关思考、温度 0 的条件下，摘要请求与主请求设置相同。它不套单轮输出上限包装，因为那层会用 16,384 盖掉上游给摘要定的输出上限（0.8 × 16,384 = 13,107）。经网关时，摘要请求与主请求同样计入该作业的花费、花费上限与计量；网关计量的上下文峰值按每次请求的"输入 + 缓存读 + 缓存写"取最大值（合并二审计第四节），摘要请求也在其内。

## 五、交互（189）

- `/compact [重点]`：命令行对话与终端界面都有。重点即 `/compact` 之后的文字，作为 `customInstructions` 交给上游的摘要函数（以 "Additional focus:" 附在摘要提示后）；不带重点即不给。只在没有进行中的 Run 时接受（`adapter.compact` 在 Run 中报错）；手动压缩进行中 `run()` 报错。终端界面把手动压缩期间当作运行中，提交按 busy 语义拒绝、保留输入。
- 提示：每次压缩（自动或手动）提示一行"上下文已压缩（手动 / 自动，轮间 / 自动，Run 开始前）：约 前 → 后 token"，终端界面前缀 `[compact]`。前为压缩条目的 tokensBefore，后为压缩后上下文的估算。手动压缩没有压成时说明原因（没有可压缩的内容 / 会话文件没有打开 / 未开启 / 压缩失败及原因）。不常显用量。
- 两处"未知命令"的可用命令说明都加了 `/compact [重点]`。

## 六、压缩前回调（192、207 的挂点）

装配根选项 `beforeCompaction`，交给压缩服务。它在判空之后、摘要请求发出之前调用并等待，三个触发位置（轮间、Run 开始之前、手动）都经这里；调用时，此前的消息都已写进会话文件。回调收到触发位置、触发时的 token 估算、手动重点与中止信号。抛错或拒绝只记为内部故障，压缩照常进行。复盘本身不在本次范围。

## 七、上游行为（只调用、不改）

- 切点落在被切开的一轮中间、且这一轮之前没有历史时，上游只给这一轮的前段写摘要，这一路不带附加说明。此时手动压缩的重点不进摘要请求。
- 从末尾往前累计到保留量时，若累计点之后没有可作切点的条目（工具结果不作切点），切点退回第一个可切位置，待摘要段为空。例如最后一条工具结果本身就超过保留量时，这次压缩按"没有可摘要的"跳过，不调模型；下一轮仍超过时会再判一次。
- 摘要输入里的工具结果被截到 2,000 字符；摘要请求不走缓存。

## 八、测试

新增测试文件：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `pi-runtime/compaction.test.ts` | 12 | 配置缺省与校验、阈值判定（等于不压、大于才压）、token 估算与过期 usage、Models 适配、判空不调模型、回调先于摘要请求、输出上限两种取值、重点作为附加说明、回调抛错不阻断、摘要失败与无存储 |
| `pi-runtime/session-store-compaction.test.ts` | 4 | 读主分支排在写入之后、压缩条目落盘且原始消息保留、续跑从压缩条目往后接、思考不持久化时保留段剥去思考、会话打不开时两项返回 undefined |
| `pi-runtime/adapter-compaction.test.ts` | 9 | 轮间挂点、Run 结束后还原、Run 开始前挂点（下一条输入与续跑）、convertToLlm 不丢摘要、未超过不压缩、手动压缩与 Run 中拒绝、Run 开始前压缩期间被中断、Run 开始条目的压缩配置 |
| `application/runtime-compaction.test.ts` | 4 | 缺省配置写进 Run 开始条目、无头运行调低触发点后轮间压缩且摘要请求经同一模型接入（温度 0、不请求推理、输出上限不超过 13,107）、主请求开思考时摘要仍关思考、压缩前回调经装配根接上 |
| `cli/repl-compact.test.ts` | 3 | 自动压缩提示、/compact 重点、没有可压缩的内容 |
| `tui/compact.test.ts` | 5 | /compact 重点与不带重点、自动压缩两种提示、没有压成的说明、压缩期间拒绝提交 |

另在 `application/launch-flags.test.ts` 加 1 例（三个参数的解析与校验）。测试设施 `pi-runtime/fixtures.ts`：假回复可指定 usage 的 totalTokens，调用记录带调用选项。

改动的既有测试：`cli/approval-ui.test.ts` 的结构替身补一个空的压缩提示订阅（命令行对话启动时订阅）；`tui/grants-view.test.ts` 的未知命令说明加 `/compact [重点]`。

测试先行：运行面、装配、交互三批测试先于实现写成，实现前在服务器上运行，全部变红：`adapter-compaction` 9 例（`subscribeCompaction` 不存在）、`runtime-compaction` 4 例（Run 开始条目没有压缩配置、没有摘要请求）、`tui/compact` 5 例与 `repl-compact` 3 例。压缩服务与写者的测试在各自实现的同一步写成，由下节变异覆盖。

## 九、变异反向验证

在服务器上以 5fa514a 运行：每次只植入一处，跑上表 6 个测试文件（共 37 例），并发 3；以 `git checkout` 还原，12 次还原后源文件 sha256 均与植入前一致，工作树干净。

| 变异 | 精确变红 |
|---|---|
| M1 阈值判定改为"大于等于触发点" | 1 例：上下文 token 数大于触发点才压缩，等于触发点不压缩 |
| M2 待摘要段为空时照样压缩 | 1 例：待摘要段为空：不调用模型、不调压缩前回调、不写压缩条目 |
| M3 不调用压缩前回调 | 8 例：服务的回调顺序与回调抛错 2 例；运行面的轮间、Run 开始前（下一条输入、续跑）、手动、Run 开始前被中断 5 例；装配根接上回调 1 例 |
| M4 压缩前回调失败即中止压缩 | 1 例：压缩前回调抛错：记为内部故障，压缩照常完成 |
| M5 压缩摘要之前的旧 usage 照用 | 2 例：过期 usage 的估算、轮间挂点 |
| M6 不把上游 convertToLlm 交给 Agent | 5 例：convertToLlm 不丢摘要、轮间挂点、Run 结束后还原、Run 开始前两例 |
| M7 去掉轮间挂点 | 3 例：运行面轮间挂点、Run 结束后还原、无头运行轮间压缩 |
| M8 去掉 Run 开始前挂点 | 6 例：运行面 Run 开始前两例与被中断一例、命令行对话的自动压缩提示、装配根的关思考与回调两例 |
| M9 Run 结束后不按会话树还原 | 1 例：Run 结束后按会话树还原 |
| M10 Run 开始条目不记压缩配置 | 3 例：运行面与装配根的配置两例、无头运行一例 |
| M11 摘要请求不套温度 | 1 例：无头运行轮间压缩（摘要请求温度 0） |
| M12 摘要请求套单轮输出上限包装 | 1 例：无头运行轮间压缩（摘要请求输出上限） |

## 十、verify 的实际运行情况

服务器：阿里云实例 pigeon-verify，8 vCPU、31 GB 内存，Linux，Node 24.12.0。专属目录经 git bundle 取 5fa514a 强制检出（工作树无改动）。首次克隆后 `npm ci`，之后依赖声明未变。跑前查到服务器上另有测试进程在跑，测试步并发 3：

- lint：通过（410 个文件）；
- check：通过；
- 测试：`node --test --test-concurrency=3 "src/**/*.test.ts"`，1179 个用例，1177 通过、0 失败、0 取消、2 跳过（仅 Windows 的 .cmd 启动器两例），用时 110.5 秒，测试进程最大常驻内存 570,496 KB；
- deps：无违规（427 个模块、2958 条依赖）。

本机（Windows）只跑类型检查与 biome，均通过；测试全部在服务器上跑。

## 十一、与其他分支的交集

- ledger-s5（账本重构第四段：停写旧账本、删旧代码）：`pi-runtime/adapter.ts`（本次只加挂点、订阅、手动压缩与 Run 开始条目的一个字段，未碰旧账本写入与 run.started）、`application/runtime.ts`（装配压缩服务的一段与两个选项）、`application/session-store.ts`（双写之前旧会话的空写者补了 `branch` 与 `appendCompaction` 两行，若该写者随第四段删除，这两行一并去掉）、`pi-runtime/session-store.ts`、`state/session-entries.ts`、`application/workers.ts`、`application/headless-core.ts`。
- defects-s7（空回复与检查工具崩溃两处缺陷）：`pi-runtime/adapter.ts` 的 `#runWith` 与收尾判定（本次在 `start()` 前后各加了挂点与还原，终态判定未改）、`application/headless-core.ts`（只加一个选项透传）、`eval/stream-agents.ts`（只加一个选项透传）。

## 十二、worker 继承、跑批身份头、切开那一轮的重点、压缩失败可见

| 提交 | 内容 |
|---|---|
| 173fc5e | worker 与分叉续跑沿用本次运行的压缩配置 |
| 7a4d8ec | 跑批身份头与结果行记实际生效的压缩配置；续跑时列出具体不同的参数 |
| 20dfa9d | 自动压缩没压成与压缩前回调失败改为压缩提示，无头运行写标准错误输出；不再计成事件落盘失败 |

改动：20 个文件，新增 604 行、删除 69 行；其中生产代码新增 150 行、删除 50 行，测试新增 454 行、删除 19 行。本节取代第二节"worker 用产品缺省"一句与第三节"失败处理"一段；第十一节的交集文件另加 `application/headless.ts`、`application/session-runtime.ts`、`cli/index.ts`、`tui/main.ts`、`eval/stream-identity.ts`、`eval/stream-experiment.ts`（各为一两行透传或一个字段）。

### 1. worker 继承主会话的压缩配置

- 运行面新增 `compactionConfig()`，给出本运行面生效的压缩配置。按会话装配的 worker 工厂在没有显式给配置时取父运行面的这一份，worker 会话的 Run 开始条目因此与主会话记同一份；主会话没给参数时即产品缺省。
- 分叉续跑沿用启动参数里的压缩配置：无头运行的失败自动分叉重试、会话里的失败自动分叉重试、命令行对话与终端界面的手动 `/fork`。
- 测试 `application/workers-compaction.test.ts` 2 例：父运行面给了配置时 worker 的 Run 开始条目记同一份；没给时记产品缺省。

### 2. 跑批身份头记压缩配置

- `effectivePigeonSettings` 增加 `compaction`，取 `resolveCompactionConfig` 的结果：没给参数记产品缺省（窗口 1,000,000、预留 16,384、保留 20,000、触发点 983,616），不记 null。身份头 `core.agents.pigeon` 与结果行的 `agentSettings` 同取这一份；最简 agent 不记。
- 续跑比对：同一 agent 两次都记了参数时，不同即拒绝，报错改为列出具体不同的参数（如 `agents.pigeon.compaction`），此前只列到 `agents.pigeon`。加这一项之前写下的身份头没有 `compaction`，用本版续跑即判为不同而拒绝。
- 测试：`eval/stream-experiment.test.ts` 的生效参数一例补上缺省与给定两种压缩配置；`eval/stream-identity.test.ts` 新增 1 例，续跑时触发点不同即拒绝，报错含 `agents.pigeon.compaction`。

### 3. 切开那一轮的前段摘要不带重点

接受上游行为，不自补，见第七节。

### 4. 压缩失败可见

- 压缩提示由一类改为三类：压成了（压缩前后的 token 数）；自动压缩没压成（"上下文压缩未完成（自动，轮间 / 自动，Run 开始前）：原因；本轮按原上下文继续"）；压缩前回调失败（"压缩前回调失败：原因；压缩照常进行"）。压缩被中断时不发"没压成"的提示；手动压缩没压成时结果直接交回调用方，照旧在界面说明原因，不另发提示。
- 原因：失败即错误信息；跳过即"最近保留的消息之外没有更早的对话可摘要"或"会话文件没有打开"。压缩服务的失败结果标明出在哪一步（准备、摘要、写入）。
- 命令行对话与终端界面经原有的压缩提示通道显示这两类（终端界面前缀 `[compact]`）。
- 无头运行（`pigeon run` 与跑批的 Pigeon 条件）在运行面装起来时订阅压缩提示，经 `dedupedWarner` 写标准错误输出：没压成与回调失败各按原因去重，同一类只说一次；压成了不告警。无头运行新增 `warn`（告警出口，缺省标准错误输出）与 `beforeCompaction`（压缩前回调）两个选项。
- 摘要请求失败与回调失败不再进 `listenerErrors`，不再计成"事件落盘失败"；压缩条目写不进会话文件仍进 `listenerErrors`。没有新增账本或会话记录的种类。
- 测试：`pi-runtime/adapter-compaction.test.ts` 新增 3 例（摘要失败：提示没压成、按原上下文继续、不计入落盘失败；回调失败：提示回调失败、压缩照常完成、不计入；写入失败：提示没压成、仍计入）；`pi-runtime/compaction.test.ts` 新增 1 例（写入失败标明出在写入一步），摘要失败一例补断言（出在摘要一步）；`application/runtime-compaction.test.ts` 新增 2 例（无头运行两次没压成只告警一行、回调失败告警一行，文案逐字）；`cli/repl-compact.test.ts` 新增 1 例（打印没压成的一行，不出现"事件落盘失败"）；`tui/compact.test.ts` 新增 1 例（两类提示的文字）。既有的压缩提示用例随提示形状补上 `kind`。

测试先行：本节测试先于实现写成，实现前在服务器上运行，16 例变红（其中含随提示形状与回调参数名变化而落空的既有用例）；"父运行面没给配置时 worker 即产品缺省"一例在实现前即通过（原行为如此）。

### 5. 变异反向验证

在服务器上以 20dfa9d 运行：每次只植入一处，跑 8 个测试文件（压缩服务、运行面、装配、worker、命令行对话、终端界面、身份头、生效参数，共 57 例），并发 3；以 `git checkout` 还原，6 次还原后源文件 sha256 均与植入前一致，工作树干净。

| 变异 | 精确变红 |
|---|---|
| N1 worker 改回产品缺省 | 1 例：worker 继承父运行面的压缩配置 |
| N2 生效参数不记压缩配置 | 1 例：身份头与结果行记 Pigeon 实际生效的参数 |
| N3 去掉无头告警 | 2 例：无头运行没压成告警、回调失败告警 |
| N4 去掉自动压缩没压成的提示 | 4 例：运行面摘要失败与写入失败 2 例、命令行对话没压成 1 例、无头运行没压成告警 1 例 |
| N5 去掉压缩前回调失败的提示 | 2 例：运行面回调失败、无头运行回调失败告警 |
| N6 摘要请求失败也计入事件落盘失败 | 2 例：运行面摘要失败、命令行对话没压成 |

### 6. verify 的实际运行情况

服务器同上。专属目录经 git bundle 取 20dfa9d 强制检出（工作树无改动），依赖声明未变。跑前服务器上没有别的测试进程，测试步并发 6：

- lint：通过（411 个文件）；
- check：通过；
- 测试：`node --test --test-concurrency=6 "src/**/*.test.ts"`，1190 个用例，1188 通过、0 失败、0 取消、2 跳过（仅 Windows 的 .cmd 启动器两例），用时 97.1 秒，测试进程最大常驻内存 570,564 KB；
- deps：无违规（428 个模块、2976 条依赖）。
