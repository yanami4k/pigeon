# Spike：`beforeToolCall` 拦截能力实证(pi-agent-core 0.84.4)

- 日期：2026-09-10
- 对象：`@earendil-works/pi-agent-core@0.84.4`（锁定版本，全部结论以 node_modules 内 dist 实际代码 + 实跑输出为准）
- 复现脚本：`spikes/spike-before-tool-call/spike.mjs`（纯 .mjs，直接 import dist;`node spikes/spike-before-tool-call/spike.mjs`，全部 10 个场景约 3 秒跑完，无悬挂）
- 方法：脚本化假 `streamFn`（可发 toolCall 块、abort 感知、回复队列）驱动真实 `Agent`；全量事件订阅打序时日志；hook 进出日志；execute() 计数与实收参数；终态 state.messages 摘要。每场景 15–20s 超时兜底。

## S0 API 存在性

**结论**(事实）:`beforeToolCall` 存在，是 `Agent` 的可赋值实例字段（构造选项同名），签名 `(context: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult | undefined>`。配套 `afterToolCall`、`shouldStopAfterTurn` 同形存在。

**证据**:

```
Agent.prototype/实例字段 beforeToolCall 赋值前: undefined
赋值后: function
afterToolCall: undefined (赋值前)
shouldStopAfterTurn: undefined (赋值前)
toolExecution 默认: parallel
```

**源码锚点**:

- `dist/types.d.ts:240` — `beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;`
- `dist/types.d.ts:40-48` — `BeforeToolCallResult { block?: boolean; reason?: string; terminate?: boolean }`（无 args 字段）
- `dist/types.d.ts:74-84` — `BeforeToolCallContext { assistantMessage, toolCall, args, context }`
- `dist/types.d.ts:254` — `afterToolCall` 同位签名
- `dist/agent.js:97,123,300` — 实例字段声明 / 构造选项读取 / 传入 loop config

## S1 基线（无 hook，单 toolCall)

**结论**(事实）：无 hook 时 execute() 正常执行；事件序为 `tool_execution_start → (execute) → tool_execution_end → toolResult message_start/end → turn_end`；toolResult 以 `role:"toolResult"` 消息入 transcript；循环进入下一模型轮次并以 stop 收尾。

**证据**（关键行）:

```
008 EVENT message_end assistant[toolCall] stopReason=toolUse
009 EVENT tool_execution_start echo id=tc1 args={"value":"hello"}
010 EXECUTE echo id=tc1 args={"value":"hello"}
011 EVENT tool_execution_end echo id=tc1 isError=false resultText="echo-result:{\"value\":\"hello\"}"
013 EVENT message_end toolResult[text] isError=false text="echo-result:{...}"
execute() 调用次数: 1;streamFn 调用次数: 2;终态 errorMessage=null
state.messages: [user, assistant(toolCall), toolResult, assistant(text)]
```

**源码锚点**:`dist/agent-loop.js:285-291`（执行模式分派）、`293-329`/`330-374`（两种执行器）、`122-147`(toolResult 入 context/newMessages)。

## S2a 阻断：`return {block:true, reason}`(terminate 缺省）

**结论**(事实）:execute() 完全不被调用；`tool_execution_start` 照常在 hook 之前发出；`reason` 文本**逐字**成为 error toolResult 的 content.text，并在下一轮模型请求的 messages 里逐字送达模型；循环正常继续并干净终止（终态 stop,errorMessage=null,prompt() 不抛）。

**证据**:

```
009 EVENT tool_execution_start echo id=tc1 args={"value":"hello"}   ← start 先于 hook
010 HOOK_ENTER echo id=tc1 args={"value":"hello"}
011 HOOK_EXIT echo returned={"block":true,"reason":"BLOCKED-BY-SPIKE 自定义原因"}
012 EVENT tool_execution_end echo id=tc1 isError=true resultText="BLOCKED-BY-SPIKE 自定义原因"
013/014 toolResult isError=true text="BLOCKED-BY-SPIKE 自定义原因"
execute() 调用次数: 0
末次模型请求的最后一条消息: role=toolResult text="BLOCKED-BY-SPIKE 自定义原因"   ← reason 逐字反馈给模型
streamFn 调用次数: 2(阻断后仍有第二轮);终态 stop / errorMessage=null
```

**源码锚点**:`dist/agent-loop.js:403-409`(hook 调用）、`417-427`(block → error toolResult)、`517-522`(`createErrorToolResult`:reason 原样进 content[0].text)、`297-302`/`333-338`(start 事件先于 hook)。

## S2b 阻断 + `terminate:true`

**结论**(事实）：阻断同上，且**不再发起下一轮模型请求**(streamFn 仅调用 1 次）;run 正常结束（非错误终态），最后一个 assistant 消息的 stopReason 仍是 `toolUse`——没有专门的"已终止"标记，终止只体现为"没有后续轮次"。

**证据**:

```
015 EVENT turn_end stopReason=toolUse toolResults=1
016 EVENT agent_end messages=3        ← 直接收尾,无第二个 turn_start
execute() 调用次数: 0;streamFn 调用次数: 1;errorMessage=null
```

**源码锚点**:`dist/agent-loop.js:419-421`(terminate 挂到 result)、`375-377`(`shouldTerminateToolBatch`:**批次内全部** result 都 terminate 才停）、`141`(`hasMoreToolCalls = !terminate`)。

## S3 hook 抛错

**结论**(事实）:hook 抛错**不会**毒化 run。错误消息逐字降级为 error toolResult 反馈给模型；execute() 未执行；循环继续，终态 stop、errorMessage=null、prompt() 不抛。即 hook 路径自带 try/catch 保护，与"listener 顺序 await 无保护"(agent.js:417-419）的脆弱性**不共享**——那条注释针对的是 subscribe listener,hook 是另一条受保护路径。

**证据**:

```
010 HOOK_ENTER echo id=tc1 args={"value":"hello"}
011 EVENT tool_execution_end echo id=tc1 isError=true resultText="HOOK-THROW spike 爆炸"
012/013 toolResult isError=true text="HOOK-THROW spike 爆炸"
execute() 调用次数: 0;streamFn 调用次数: 2;prompt() 抛错: 无;终态 errorMessage=null
```

**源码锚点**:`dist/agent-loop.js:400`(try 起点，包裹校验+hook)、`443-449`(catch → `createErrorToolResult(error.message)`,immediate 结果）。对照 `dist/agent.js:417-419`(listener 无保护顺序 await,异常会上溯进 `handleRunFailure`)。

## S4 坚持循环（模型永不放弃 + hook 永远阻断）

**结论**(事实）:**上游没有任何 max-turns / 循环护栏**。模型每轮重发同一 toolCall、hook 每轮阻断，循环无限空转（每轮追加 assistant+toolResult 两条消息），直到外部干预。本次由 hook 内第 10 次调用 `agent.abort()` 兜底：abort 后 hook 的 block reason 被覆盖为 `"Operation aborted"`，下一轮 stream 看到 signal.aborted 后以 stopReason=aborted 收尾，run 正常结束。

**证据**:

```
hook 调用次数: 10;streamFn(模型) 调用次数: 11   ← 若无 abort 将无限继续
128 HOOK_EXIT echo returned={"block":true,"reason":"第 10 次阻断后 abort"}
129 EVENT tool_execution_end ... resultText="Operation aborted"   ← abort 覆盖了自定义 reason
135 EVENT message_end assistant[] stopReason=aborted
136 EVENT turn_end stopReason=aborted;137 agent_end messages=22
execute() 调用次数: 0;终态 errorMessage=null
```

**源码锚点**:`dist/agent-loop.js:85-169`(`runLoop` 内外两层 while,唯一出口是 `shouldStopAfterTurn`(154)、abort、或模型不再发 toolCall)、`410-416`(hook 返回后若 signal 已 aborted，返回 "Operation aborted" 覆盖 block 结果）。

## S5 参数篡改 / 审批参数绑定 seam(M3 最重要输入）

四个变体，实证"execute 实收"与"transcript/事件记录"的各自走向：

| 变体 | hook 行为 | execute() 实收 | transcript 的 toolCall.arguments | tool_execution_start 的 args |
|---|---|---|---|---|
| S5a | 原地改 `ctx.args.value` | **MUTATED-IN-PLACE**（生效） | original（不变） | original |
| S5b | `ctx.args = 新对象`（整体重赋值） | original(**无效**) | original | original |
| S5c | `return { args: 新对象 }` | original(**被忽略**,API 无此通道） | original | original |
| S5d | 原地改 `ctx.toolCall.arguments.value` | original(不影响执行） | **TC-ARGS-MUTATED（被改）** | original |

**证据**(S5a / S5d 关键行）:

```
S5a: 012 EXECUTE echo id=tc1 args={"value":"MUTATED-IN-PLACE"}
     state.messages[1] assistant toolCall(echo,id=tc1,args={"value":"original"})
S5d: 012 EXECUTE echo id=tc1 args={"value":"original"}
     state.messages[1] assistant toolCall(echo,id=tc1,args={"value":"TC-ARGS-MUTATED"})
```

**结论**(事实 + 推断）:
- (事实）`validateToolArguments` 在 hook 之前对 `toolCall.arguments` 做了 `structuredClone`,`ctx.args` 就是这个克隆，且**同一引用**原样传给 `execute()`。因此**原地修改 ctx.args 是唯一有效的参数改写通道**。
- (事实）不存在返回值改参通道（S5c 被静默忽略）；整体重赋值 ctx.args 无效（hook context 是调用点临时字面量，prepared.args 捕获的是局部变量）。
- (事实）`tool_execution_start` 事件和 transcript 里的 toolCall 记录的是**模型原始参数**，与 execute 实收可双向背离（S5a 执行被改而记录不变；S5d 记录被改而执行不变）。
- (推断）"审批参数 ≠ 执行参数"在此 seam 上**不可被事件/transcript 自动发现**，必须由 hook 实现者（Pigeon）自己保证：hook 入场快照原始 args → 审批后把批准参数**原地写回** ctx.args → Receipt 记录自己快照+批准值，而不是事后从 transcript 取证。

**源码锚点**:`node_modules/@earendil-works/pi-ai/dist/utils/validation.js:281`(`structuredClone(toolCall.arguments)`)、`dist/agent-loop.js:402`(校验在 hook 前）、`404-409`(hook context 为临时字面量）、`436-441`(`prepared.args = validatedArgs`)、`455`(`execute(prepared.toolCall.id, prepared.args, …)`)、`337`/`462`（事件的 args 取自 `toolCall.arguments` 而非 validatedArgs)。

## S6 一条消息两个 toolCall（默认 parallel)：放行 slow(tcA)、阻断 echo(tcB)

**结论**(事实）:hook **逐 call 调用**且在准备阶段**串行**；可以只阻断其中一个。parallel 模式下事件交错为：两个 `tool_execution_start` 与两次 hook 全部先完成，被阻断 call 的 `tool_execution_end` **先于任何 execute** 发出；放行 call 的 execute 在 Promise.all 阶段并发执行；toolResult 消息在**全部执行完成后**按 toolCall 声明顺序（而非完成顺序）逐条入 transcript。

**证据**:

```
012 EVENT tool_execution_start slow id=tcA
013/014 HOOK_ENTER/EXIT slow → returned=null
015 EVENT tool_execution_start echo id=tcB
016/017 HOOK_ENTER/EXIT echo → returned={"block":true,"reason":"只阻断 tcB"}
018 EVENT tool_execution_end echo id=tcB isError=true   ← 被阻断者先 end,早于任何 execute
019 EXECUTE slow id=tcA args={"value":"A"}              ← 只执行了放行的
020 EVENT tool_execution_end slow id=tcA isError=false
021/022 toolResult slow(tcA) → 023/024 toolResult echo(tcB)   ← 按声明顺序,不按完成顺序
execute() 调用次数: 1(仅 tcA);hook 调用次数: 2;终态正常
```

**源码锚点**:`dist/agent-loop.js:330-374`(parallel 执行器：332-362 循环发 start+prepare(hook),immediate 结果就地 end(340-352),363 `Promise.all` 并发执行，364-369 按序发 toolResult 消息）、`287-291`（任工具 `executionMode:"sequential"` 或 `toolExecution:"sequential"` 则整体走串行执行器 293-329:start→hook→execute→end→toolResult 严格逐 call)。

## M3 设计含义

1. **审批-at-hook 可行（结论：阻断可靠）**。`{block:true, reason}` 100% 阻止 execute(),reason 逐字变成模型可见的 error toolResult;`terminate:true` 可整run 收尾；hook 抛错不会毒化 run（降级为错误反馈）。逐 call 粒度、混合批次放行/阻断均实证可用。
2. **参数绑定必须发生在 hook 内，且只有"原地改写 ctx.args"一条通道**。没有返回值改参通道；审批通过且参数被修改时，必须把批准参数逐字段写回 ctx.args（不可整体重赋值）。Receipt 的"执行参数"必须取 Pigeon 自己在 hook 内的写回值/快照——上游 transcript 与 tool_execution_start 只记录模型原始参数，无法事后证明执行了什么。
3. **防背离是 Pigeon 自己的责任**。因为 ctx.args 是克隆且 execute 吃同一引用，hook 独占者可以强制"批准参数 == 执行参数"（先 structuredClone 入场 args 存证，审批后用批准值原地覆盖再放行）；反之若 hook 被第三方污染，执行与记录可双向背离而上游无感（S5a/S5d)。
4. **无循环护栏（landmine)**。模型坚持重发被阻断的 toolCall 时上游无限空转。M3 必须在 Pigeon 侧实现预算/熔断：hook 内计数 + `agent.abort()`，或 `shouldStopAfterTurn`。另注意 abort 与阻断竞态：abort 后 block reason 会被 `"Operation aborted"` 覆盖(agent-loop.js:410-416)。
5. **parallel 模式的审批 UX 是"整批前置"**:一条消息的所有 hook 在任何 execute 之前串行发完，且被阻断 call 的 end 事件先于放行 call 的 execute。若 M3 要求"逐个审批-立即执行"的交错观感，需设 `toolExecution:"sequential"`（或给工具标 `executionMode:"sequential"`)。
6. **事件语义**:`tool_execution_start` 先于 hook，**不代表执行会发生**;"执行真实发生"的判据是 hook 放行 + `tool_execution_end isError=false`（且 execute 包装器计数）。OutcomeUnknown 语境下， receipt 应以 tool_execution_end 的 result/isError 为准。
7. **hook 与 listener 的保护级别不同**:hook 路径有 try/catch(agent-loop.js:443-449),subscribe listener 没有(agent.js:417-419)。治理逻辑应放在 hook 内；listener 里只做只读记录，抛异常会把 run 打进 error 终态。

## 总评

**阻断可靠**。限制清单：① 无返回值改参通道，参数绑定只能原地改 ctx.args;② 无内置循环护栏，须自建熔断；③ parallel 模式 hook 整批前置、被阻断者 end 事件早于放行者 execute;④ transcript/事件记录模型原始参数，"批准≠执行"上游不可自检，须 Pigeon 在 hook 内保证一致并自行留证。
