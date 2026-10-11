# 压缩跟随模型窗口与超长后压缩重试（决策 422）施工审计

基线 ae3e596。提交 7c1d2f6（窗口取自模型元数据）、a1b8408（超长后压缩重试）、cb7fb0a（测试补强），另加本审计所在的提交。依据：决策 188、189、218、362、417、422。

## 一、压缩所用的窗口（7c1d2f6）

改前：`src/pi-runtime/compaction.ts` 的 `resolveCompactionConfig` 只看运行参数，窗口没给即取 `DEFAULT_CONTEXT_WINDOW`（1,000,000）。装配根在解析模型信息之前就定下压缩配置，模型信息里已逐项解析的窗口（决策 362，写进 Run 开始条目的 `modelInfo`）不参与。worker 继承父运行面解析后的整份配置（`PiRuntimeAdapter.compactionConfig()`），连同父运行面的窗口。

各路径拿到模型元数据的位置：Pigeon 看不到接入模块里的 pi-ai 模型对象本身。接入模块经 `loadStreamFn` 加载时，具名导出的 `modelInfo`（pi-ai 模型对象的字段）与 pi-ai 自带目录的查询随 StreamFn 登记（`registerModelAccess`）；`buildRuntime` 按 StreamFn 取出（`modelAccessOf`），连同设置的 `modelInfo` 一节解析成 `ResolvedModelInfo`（`resolveModelInfo`），窗口为其中的 `contextWindow`（设置 > 声明 > 目录 > 未知）。无人值守（`pigeon run`，经 `workers.ts` 的 `createDetachedRuntime`，与 worker 同一装配内核 `openRuntimeSurface`）、交互（终端界面、逐行对话与续跑，经 `session-runtime.ts` 的 `openSessionRuntime`）与 worker（`createWorkerRuntimeFactory` 经 `openRuntimeSurface`；角色另配模型接入时用它的 StreamFn 与身份）都经 `buildRuntime` 装配，窗口在同一处取。

改后：

- `resolveCompactionConfig(input, modelWindow?)`：窗口取运行参数显式给的（来源 `explicit`）> 模型信息的 `contextWindow`（来源 `settings`、`declared`、`catalog`）> `DEFAULT_CONTEXT_WINDOW`（数值不变，来源 `default`）。触发点取法不变：没显式给即窗口减预留（16384）。校验不变（窗口须大于预留、触发点须小于窗口），报错里写上窗口的来源。
- `CompactionConfig` 新增 `contextWindowSource`；`CompactionConfigInput` 不含它。Run 开始条目的 `compaction` 照旧记整份配置，schema 新增可选的 `contextWindowSource`，此前的记录没有它。
- `buildRuntime`：压缩配置改在解析模型信息之后定（仍在打开会话文件之前），传入 `modelInfo.contextWindow`。摘要请求的占位模型对象的 `contextWindow`、终端界面状态栏的上下文用量（`contextUsage`）随之按这个窗口。
- worker：`RuntimeBundle` 新增 `compaction`（装配时显式给的配置，原样）；`sessionWorkerRuntimeFactory` 改为继承它，worker 的窗口按 worker 自己解析出的模型信息取。`PiRuntimeAdapter.compactionConfig()` 随之没有调用方，已删除。
- 自带的 DeepSeek 接入声明窗口 1,000,000，取值与改前相同，来源记 `declared`。
- 文档：`docs/configuration.md` 新增"上下文压缩"一节（窗口的取法与来源、Run 开始条目的记录、worker 的继承），"模型信息"一节改写"不改变压缩的行为"一句。

## 二、超长出错后压缩重试（a1b8408、cb7fb0a）

放在哪一层：适配器（`src/pi-runtime/adapter.ts`），与空回复重试、拒收图片重试（决策 417）同一套暂扣收尾机制。理由：

1. 上游循环里请求出错即以这条出错的助手消息结束本次运行（发出 turn_end、agent_end 后返回），不再调用轮间挂点 `prepareNextTurnWithContext`，轮间压缩接不到它。
2. 压缩要读写会话树（读主分支、写压缩条目）并整体替换智能体的消息，这些都在适配器手里。包在 streamFn 外层重试只能换掉一次请求的上下文，智能体的消息与会话记录不随之改变，下一次请求照旧超长。
3. 暂扣 agent_end 使一次 Run 只发一次收尾（run.ended 与 Run 收尾条目），中止请求、钩子停止与另两种重试的先后沿用同一套判断。

识别函数：pi-ai 0.84.4 公开导出的 `isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean`。出错收尾、错误文本命中各家的超长文案、且不命中限额类文案（`rate limit`、`too many requests`、一家服务方的限流前缀）时为真；给了窗口时另按用量推断正常收尾的静默超长。`src/pi-runtime/overflow.ts` 新增 `isContextOverflowReply(message: AgentMessage): boolean`：出错收尾的助手消息才交给它判定，不传窗口（只认报错文案）。没有另加按状态码或文案的判断。

判定（`#shouldRetryOverflow`）：配置了压缩、当前这次超长还没重试过、本 Run 没来过中止请求、钩子没要求停止，且最后一条消息经上面的函数判为超长。满足即暂扣这次 agent_end。

重试（`#retryOverflow`）：

- 经 `#runCompaction("overflow", …)` 走一次压缩，与自动压缩同一条路：读主分支、准备、判空、压缩前回调、摘要请求、写压缩条目、按会话树还原、发出压缩提示。触发时的 token 数按去掉出错消息的上下文估算（与压缩判定同一口径）。
- 不先做"压缩之前先裁"：这时的估算已低于实际（服务方报了超长），先裁再按估算重判多半判为不必压缩。
- 压成了：智能体的消息换成按会话树还原的压缩后上下文，并去掉末尾随之还原回来的那条出错消息（它在会话文件里，也在压缩条目的保留段里；pi-ai 组请求时本就跳过出错收尾的助手消息）。本 Run 早先轮间压缩的还原标记清掉（智能体的消息已是压缩后的上下文）。状态通道按"压缩过"重发完整的开工状态块，经 steer 交给上游、进会话记录。然后 `continue()` 接着运行，其间来了中止请求即发起后立即中止。
- 没压成（准备失败、摘要请求失败或被中止、压缩条目写不进会话文件、没有可摘要的内容、会话文件不可用）：不重试，补发暂扣的收尾，Run 以原错误收尾（failed，错误文本为那条超长报错）。Run 收尾条目新增可选的 `overflowCompaction`：`{ kind: "failed", stage, error }`（stage 为 prepare、summary、store，error 为错误文本）或 `{ kind: "skipped", reason }`（nothing-to-summarize、store-unavailable）。

同一次超长只重试一次：开始重试即记下；重试的那次请求仍超长，不再暂扣，照原错误收尾（错误文本为第二次的）。之后来了一条不是出错收尾的助手回复即清掉，再出现超长算新的一次，同样可重试一次。每个 Run 开始时清掉。

提示与钩子：压缩的触发位置新增 `overflow`。界面与无头运行的压缩提示写"自动，上下文超长出错后"；没压成时后半句为"不再重试，按原错误收尾"（其余触发位置照旧"本轮按原上下文继续"）。PreCompact、PostCompact 钩子的 matcher 记 auto，与轮间、Run 开始前相同。`docs/configuration.md` 的"上下文压缩"一节写明以上行为。

## 三、与拒收图片重试（决策 417）的关系

- 暂扣时先判拒收图片（HTTP 400，且上次成功回复之后有新加的带图工具结果），不成立再判超长；接着运行时同样先判拒收图片。两处"已重试"的记号各自独立：拒收图片重试之后那次请求若报超长，照超长处理。
- 核对 `isContextOverflow` 对 4xx 文本的判定（pi-ai 0.84.4，以样例文本直接调用）：
  - 不判为超长：`400 Bad Request`；`400 {"type":"error","error":{"type":"invalid_request_error","message":"x"}}`；`400 {"error":{"message":"Invalid image data","type":"invalid_request_error"}}`；`400 messages: text content blocks must be non-empty`；`413 Request Entity Too Large`；`429 Too many tokens, rate limit exceeded`；`500 Internal Server Error`。
  - 判为超长：`400 status code (no body)` 与 `413 status code (no body)`（上游为一家服务方写的规则：没有响应体的 400、413 一律当超长）；带超长文案的 400，如 `prompt is too long: …`、`Input length (…) exceeds model's maximum context length (…)`。
- 因此两者只在两处相交：没有响应体的 400——请求里有新加的图时走拒收图片重试，没有时走超长后压缩重试；带超长文案的 400 且有新加的图——先走拒收图片重试，去图后仍超长再走超长后压缩重试。一般的、带响应体的 400 不会被认成超长。

## 四、测试与变异

- 产品代码 +194 −35 行，测试 +142 −13 行。
- `pi-runtime/compaction.test.ts`：模型元数据给了窗口即用它，触发点随之为它减预留；显式给的优先；取不到用缺省；触发点不小于模型窗口时报错且写明来源。
- `application/runtime-model-info.test.ts`（无人值守路径 `runHeadless`）：接入模块声明窗口 500,000 时，Run 开始条目的 `compaction` 为该窗口、来源 declared、触发点 483,616。`application/runtime-compaction.test.ts`：没有模型信息时记缺省窗口与来源 default。
- `application/workers-compaction.test.ts`（worker 路径）：接入模块声明窗口 500,000，父运行面显式给触发点与保留量，worker 的 Run 开始条目记窗口 500,000（declared）与父运行面给的两项。
- 交互路径（`openSessionRuntime`）没有另加用例：与另两条路径同经 `buildRuntime` 取值。
- `pi-runtime/adapter-compaction.test.ts`：超长出错后先压缩（压缩前回调与压缩提示的触发位置为 overflow，会话文件里一条压缩条目）再重试成功，重试的请求以摘要开头、不含出错消息，出错消息留在会话文件里；重试的那次仍超长按原错误收尾、不再尝试压缩；来过正常回复之后再超长，可再重试；摘要请求失败时不重试、按原错误收尾、提示写明，Run 收尾条目记 failed、summary 与错误文本；一般的 400 不压缩、不重试。
- 变异（改后跑相应用例，再还原并逐字核对）：去掉超长识别（任何出错都压缩重试）→"一般的 400"变红；去掉"这次超长已重试过"的判断 →"仍超长"变红（第一次做时该用例未变红：第二次压缩因没有可摘要的内容而跳过，结果相同；补了"不再尝试压缩"的断言后变红，即 cb7fb0a）；去掉正常回复之后的清零 →"之后再超长"变红；窗口取值把模型元数据排到显式之前 → 窗口单元用例变红；忽略模型元数据 → 窗口单元用例、无人值守装配与 worker 用例变红。均已还原，产品文件与提交一致。

## 五、本机验证

- 改动涉及的 12 个测试文件（`--maxWorkers=2`，含拒收图片、空回复、撞上限续跑、逐行对话与终端界面的 `/compact`、启动参数、会话条目 schema）：79 通过。另跑相邻的 5 个装配测试文件：17 通过、1 失败——`application/image-reject-resume.test.ts` 在基线 ae3e596 上同样失败，原因是本次所用的依赖目录没有 `@silvia-odwyer/photon-node`（图片解码库），与本改动无关。
- `npm run check`：只报 `@silvia-odwyer/photon-node` 缺包（`src/tools/image-resize.ts`、`src/tools/read-file-images.test.ts`），其余无错。
- `npm run deps` 通过；改动文件的 `biome check` 通过。
- 没有调用模型接口。

## 六、待补与未定

- 需在验证服务器上补跑 `verify:full`。
- 真实服务方的超长报错未发：自带 DeepSeek 接入（Anthropic 兼容端点）超长时的报错文案是否命中 `isContextOverflow` 的规则未核实；不命中时不重试，照原错误收尾（与改前相同）。
- 没有模型信息时窗口仍取缺省 1,000,000（数值同自带 DeepSeek 接入的窗口）。实际窗口更小而模型信息里没有窗口的模型上，自动压缩不会在窗口上沿触发，只能靠超长后的压缩重试兜底；这时待摘要的部分可能本身超过窗口，摘要请求随之超长失败，按原错误收尾。
- 模型元数据给的窗口不大于预留（16384）时启动报错，预留没有启动参数可调；显式的触发点不小于模型窗口时同样启动报错（改前对照的是 1,000,000）。worker 另配模型接入、其窗口不大于继承来的触发点时，该 worker 装配失败。
- Run 收尾条目的 `overflowCompaction` 只在会话文件里，`pigeon replay`、`pigeon trace` 不显示。
- 超长后的压缩不先做"压缩之前先裁"。

## 七、回报

分支 worktree-agent-a3b519e8bf9311c4e，头为本审计提交。窗口：显式>模型信息>缺省 1M，来源记入 Run 开始条目。超长重试放适配器暂扣收尾（上游出错不经轮间挂点），识别用 isContextOverflow；无响应体 400 也判超长，有新图先走 417。变异 5 处均红；测试、tsc（仅缺 photon）、biome、deps 过。待服务器 verify:full；DeepSeek 超长文案未核实。
