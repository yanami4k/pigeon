# Spike：pi-agent-core 0.84.4 transcript 结构与消息身份稳定性（D3 输入）

- 日期：2026-09-12
- 对象：`@earendil-works/pi-agent-core@0.84.4` + `@earendil-works/pi-ai@0.84.4`（锁定版本，全部结论以 node_modules 内 dist 实际代码 + 实跑输出为准）
- 复现脚本（已于 2026-10-09 移出仓库）：`spikes/spike-pi-transcript/spike.mjs`（纯 .mjs，直接 import dist；`node spikes/spike-pi-transcript/spike.mjs`，约 3 秒跑完，无悬挂）
- 方法：① 静态通读 `dist/agent.js` / `dist/agent-loop.js` / `dist/types.d.ts` 与 pi-ai 消息类型；② 实证：脚本化假 `streamFn`（支持回复队列 + 中途门闩）驱动真实 `Agent`，跑「T1 完整工具调用轮（2 次模型调用）→ T2 流式中途 abort → T3 abort 后再跑一轮」；全程 WeakMap 分配对象身份号（oid），在 append 时刻对每条消息做深快照，终态再比对；记录每次 `message_end` 事件载荷引用与 `state.messages` 条目逐一做 `===` 比较。
- 目的：为设计决策 D3（Pigeon EntryId ↔ Pi 消息映射粒度）提供事实基础。

## Q1 消息是否携带稳定唯一 id —— 否（事实）

pi-ai 的三个消息类型定义（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:302-345`）：

```
UserMessage      { role:"user", content: string|(TextContent|ImageContent)[], timestamp: number }
AssistantMessage { role:"assistant", content:(TextContent|ThinkingContent|ToolCall)[],
                   api, provider, model, responseModel?, responseId?, diagnostics?,
                   usage, stopReason, deferred?, errorMessage?, rawStopReason?, endTurn?, timestamp }
ToolResultMessage{ role:"toolResult", toolCallId, toolName, content, details?, usage?,
                   addedToolNames?, isError, timestamp }
```

**没有任何 id 字段**。逐候选排查：

- `timestamp: number`（毫秒）：实证会撞车——本次运行中 T1 的 toolResult 与收尾 assistant 同为 `1789151358155`，T2 的 aborted assistant 与 T3 的 user 同为 `1789151358185`。既不能当唯一键，也不能当排序键。
- `AssistantMessage.responseId?`：provider 侧响应 id，可选且 provider 相关；fake 流、abort 消息、失败消息都没有 → 不可靠，不能作为 Pigeon 级稳定 id。
- `ToolResultMessage.toolCallId`：已知存在且上游保证「每条 assistant 消息里的 toolCall id 唯一」（见 `src/pi-runtime/fixtures.ts:63-65` 的模拟依据），但那是 **call 级** id，不是 message 级 id。
- 对照发现：pi-agent-core 自带的 harness 持久层 `Session` 给消息包了一层 `MessageEntry extends EntryBase { id, seq, parentId, timestamp }`（`dist/harness/session/types.d.ts:12-22`）——**Pi 自己的做法正是「消息无 id → append 时包一层 entry id」**，这直接验证了 D3 推荐方案的可行性（见下文）。

## Q2 transcript 消息形状（实证 JSON 样例）

终态 transcript（8 条，顺序即 `state.messages` 数组序）：

```
[0] user      {"role":"user","content":"第一题:调用 echo","timestamp":...}
[1] assistant content=[{type:"toolCall",id:"tc1",name:"echo",arguments:{value:"hello"}}],
              api/provider/model/usage/stopReason="toolUse"/timestamp
[2] toolResult{"role":"toolResult","toolCallId":"tc1","toolName":"echo",
              content:[{type:"text",text:"echo-result:{\"value\":\"hello\"}"}],
              details:{}, isError:false, timestamp}
[3] assistant content=[text], stopReason="stop"
[4] user      (T2 prompt)
[5] assistant content=[], stopReason="aborted", errorMessage="Operation aborted"
[6] user      (T3 prompt)
[7] assistant content=[text], stopReason="stop"
```

要点：

- 三种 role：`user` / `assistant` / `toolResult`；每个 role 都有 `timestamp`。
- assistant 的 tool call 以 `content` 内 `ToolCall` 块出现（`{type:"toolCall", id, name, arguments}`），与同消息的 text/thinking 块平铺混排。
- tool result 是独立的 `role:"toolResult"` 消息，经 `toolCallId` 回指 toolCall。
- abort 轮照常落一条 `stopReason:"aborted"` 的 assistant 消息（content 可为空数组），并带 `errorMessage`；`state.errorMessage` 同步置位。**transcript 不删 abort 痕迹，后续 prompt 在其后正常追加。**
- 事件序（`message_end` 序列）与数组序严格一致：`user → assistant(toolCall) → toolResult → assistant(text)`。

## Q3 core 是否含有改写 state.messages 的 compaction/持久化机制 —— 否（事实）

- `dist/agent.js:1-2`：core `Agent` 只 import `agent-loop.js` 与 `stream-fn.js`，**不 import harness 下任何模块**。
- compaction 与 session 机制确实存在于 0.84.4 的 dist 里（`dist/harness/compaction/compaction.js`、`dist/harness/session/`），并从 `dist/index.js:8-14` 导出——但它们是 **app 层可选机制**（pi-coding-agent 使用），`compact()` 操作的对象是 session 的 pathEntries，不是 `Agent.state.messages`；core Agent 从不调用。
- loop 内唯一的「改写」是对 **loop 私有 context 副本** 的流式 partial 替换：`agent.js:280-285`（`createContextSnapshot` 用 `.slice()` 拷贝数组）→ `agent-loop.js:45-48`（再展开成新数组）→ `agent-loop.js:203/218/230/245`（partial 替换最后一条，只动副本）。
- `transformContext`（agent-loop.js:178-183）只变换**发给 LLM 的请求消息**，结果喂给 `convertToLlm`，不回写 state。
- core 对 `state.messages` 的全部写操作：① `message_end` 时 push 最终消息（`agent.js:388-391`）；② `reset()` 整数组替换为 `[]`（`agent.js:218`）；③ messages setter 对赋值数组做 `.slice()`（`agent.js` `createMutableAgentState`）。**无 splice/pop/逐条重写路径。**

## Q4 对象身份与跨 run 稳定性（实证）

七个探针全部跑完，原始输出见脚本。结论：

| 探针 | 结果 | 含义 |
|---|---|---|
| P1 | 8/8 `message_end` 事件载荷 `=== state.messages` 对应条目 | **身份锚点 = message_end**：事件载荷与 transcript 条目是同一对象 |
| P2 | 跨 3 个 run（含中途 abort），全部已入 transcript 消息深快照**零变化** | 上游从不原地修改已追加消息；transcript 事实上 **append-only** |
| P3 | 19 个 `message_start`/`message_update` 载荷中仅 4 个与终态条目同引用：3 个 user + 1 个 toolResult；**assistant 的 start/update 全部是 `{...partial}` 浅拷贝**（agent-loop.js:205/222），≠ 最终对象 | 流式阶段的事件载荷**不能当身份**；身份只在 message_end 确立 |
| P4 | 调用方传给 `prompt()` 的 user 对象 `===` transcript 条目（agent-loop.js:51-54 原样转发） | user 消息入 transcript 也无拷贝 |
| P5 | 三次阶段快照 `state.messages` 数组引用恒定 | 数组是**活引用**，push 原地增长（getter 直接返回内部数组） |
| P6 | 经捕获引用篡改旧消息的 `content[0].text`，`state.messages` 立即可见 | 上游**零防御拷贝**；listener 拿到的就是真身 |
| P7 | abort 后终态：`assistant[] stopReason=aborted err="Operation aborted"` 落 transcript，`state.errorMessage` 置位，下一 run 正常 | abort 不破坏 append-only 性 |

补充事实：toolResult 消息由 `createToolResultMessage`（`agent-loop.js:532-545`）新建字面量，经 `emitToolResultMessage`（`agent-loop.js:547-550`）以**同一引用**发 `message_start`+`message_end`。

## 对 D3 的含义（映射方案推荐）

**事实基础**：消息无 id（Q1）→ 无法靠上游 id 做 entry 级映射；但 transcript append-only（Q2/Q3/Q4-P2）、`message_end` 载荷与 transcript 条目同一引用且顺序一致（P1）、事件序 = 数组序（Q2）。

**推荐方案：run 相对序号（message_end 计数）为权威映射键，entry 级映射可行，无需退化到事后 index 猜测。**

1. **EntryId 在 `message_end` 事件落地时刻分配**。Pigeon adapter 的 subscribe 链路按序数 message_end，分配 `entry_` ULID，并把 `(entryId, runId, runSeq)` 记入事件日志（M4 Event Log 的一个事件族）。transcript 数组下标 = 会话累计 message_end 序号，两者天然对齐。
2. **exec_ ↔ toolCallId 双向绑定**：toolCallId 在 run 内唯一，`tool.proposed`/`tool.settled` 事件已携带；toolCall 所在的 assistant 消息用其 message_end 序号定位。
3. **turn 边界**：turn_end 事件给出「本 turn 追加的最后一条 assistant 消息 + toolResults」，与 message_end 计数交叉校验即可（turn = 一段连续的 entry 区间）。
4. **绝不用 timestamp 做键**（同 ms 撞车实证）；**绝不在流式阶段锚定身份**（P3：assistant 的 start/update 是浅拷贝）。
5. Pi 自己的 harness Session 用同一模式（`MessageEntry{ id, seq, parentId }` 在 append 时包装无 id 的消息，`dist/harness/session/types.d.ts:12-22`）——方案与上游官方持久层同构，不是自创异类。

## M4 冷物化风险提示

1. **上游零防御拷贝（P6）**：listener/hook 里任何对消息对象的意外写入都直接污染 transcript 与一切基于引用的缓存。约束：Pigeon listener 只读；`adapter.transcript()` 现有的 `structuredClone`（`src/pi-runtime/adapter.ts:254-255`）必须保留。冷物化重放时同样不得把重建出的消息对象交给可写路径。
2. **abort 轮也产生 entry**（P7）：`stopReason:"aborted"` 的 assistant 消息（content 可能为空）占一个序号。冷物化按 message_end 重放时必须把它计入，否则序号整体错位。
3. **`reset()` / messages setter 整数组替换**（agent.js:218）：若未来允许会话内 reset，序号空间会归零重排。建议 EntryId 绑定 `(runId, runSeq)` 或显式 epoch，而非全局数组下标。
4. **事件日志必须先于/同于 transcript 变更落盘**：身份锚点只在 message_end 事件时刻存在（P1）；错过事件就无法事后区分「数组里这条消息对应哪个 entry」。这正是 M4 事件溯源的天然形状（message_end → entry append 一条事件），但要保证 adapter 订阅不丢事件——对照 M3 已知事实：listener 路径无 try/catch 保护（agent.js:417-419），治理记录逻辑放 listener 里必须自身不抛。
5. **未来若启用 harness Session/compaction**：compaction 会以 `CompactionEntry + retainedTail` 重写对话（`dist/harness/session/types.d.ts:37-43`），届时 entry 映射需跟随 CompactionEntry 走。当前 core 不触发（Q3），M4 可暂缓，但设计文档应标注该扩展点。
6. **synthetic failure 消息**（agent.js:349-365 `handleRunFailure`）也走 message_start/message_end 进 transcript——listener 异常导致的合成失败消息同样占序号，冷物化需覆盖此路径。

## 总评

**消息级稳定 id 不存在，但 entry 级稳定映射可行。** 关键支撑是三个实证事实：transcript append-only（上游零原地修改）、`message_end` 事件载荷即 transcript 条目真身、事件序即数组序。推荐 D3 采用「`message_end` 时刻分配 EntryId + `(runId, runSeq)` 权威键 + toolCallId 绑定 exec_」的方案，与 Pi 官方 harness Session 的 entry 包装模式同构。主要风险集中在：零防御拷贝（listener 必须只读）、abort/合成失败消息也占序号、以及身份只在 message_end 时刻确立（事件落盘时序是硬约束）。
