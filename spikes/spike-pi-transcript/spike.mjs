// Spike: 实证 pi-agent-core 0.84.4 transcript(state.messages)的对象身份与稳定性。
// 纯 .mjs,直接 import dist;脚本化假 streamFn 驱动真实 Agent,无需 API key。
// 运行: node tmp/spike-pi-transcript/spike.mjs
//
// 场景:
//   T1: prompt → assistant(toolCall tc1) → toolResult → assistant(text)      [2 次模型调用]
//   T2: prompt → 流式中途 abort → assistant(stopReason=aborted)               [1 次模型调用]
//   T3: prompt → assistant(text)                                             [1 次模型调用]
// 探针:
//   P1: message_end 事件载荷与 state.messages 条目是否同一对象引用
//   P2: 已入 transcript 的消息在后续 run 中是否被上游原地修改(深快照对比)
//   P3: message_start/message_update 的 partial 与最终消息是否同一对象
//   P4: 调用方传给 prompt() 的 user 消息对象与 transcript 条目是否同一引用
//   P5: state.messages 数组引用在整个会话期间是否恒定(push 原地增长)
//   P6: 外部经捕获引用篡改旧消息,是否直接反映到 state.messages(无防御拷贝的证明)
//   P7: abort 后 transcript 终态形状 + state.errorMessage
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const FAKE_MODEL = {
  id: "fake-model-1",
  name: "fake-model-1",
  api: "fake-api",
  provider: "fake-provider",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---- 可控假流:支持回复队列 + 中途门闩(用于确定性 abort) ----
function createGate() {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release: () => release() };
}

// reply: { text?, toolCalls?: [{id,name,args}], holdGate?: Gate }
function createScriptedStreamFn(replies, calls) {
  const streamFn = (model, context, options) => {
    calls.push({ context });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const stream = createAssistantMessageEventStream();
    void pump(stream, model, reply, options?.signal);
    return stream;
  };
  return streamFn;
}

async function pump(stream, model, reply, signal) {
  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const finalize = (content, stopReason) => ({
    ...partial,
    content,
    usage: { ...zeroUsage(), output: 10, totalTokens: 10 },
    stopReason,
    timestamp: Date.now(),
    ...(stopReason === "aborted" ? { errorMessage: "Operation aborted" } : {}),
  });
  const abortNow = () => stream.push({ type: "error", reason: "aborted", error: finalize([], "aborted") });

  stream.push({ type: "start", partial });
  if (signal?.aborted) return abortNow();

  const content = [];
  let contentIndex = 0;
  if (reply.text) {
    stream.push({ type: "text_start", contentIndex, partial });
    partial.content = [{ type: "text", text: reply.text }];
    stream.push({ type: "text_delta", contentIndex, delta: reply.text, partial });
    if (reply.holdGate) {
      // 门闩:此时文本已流出,等待测试侧放行;放行前先 abort → 走 abortNow
      await reply.holdGate.promise;
      if (signal?.aborted) return abortNow();
    }
    stream.push({ type: "text_end", contentIndex, content: reply.text, partial });
    content.push({ type: "text", text: reply.text });
    contentIndex++;
  }
  for (const tc of reply.toolCalls ?? []) {
    const toolCall = { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args };
    stream.push({ type: "toolcall_start", contentIndex, partial });
    partial.content = [...content, toolCall];
    stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(tc.args), partial });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
    content.push(toolCall);
    contentIndex++;
  }
  if (signal?.aborted) return abortNow();
  const reason = (reply.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop";
  stream.push({ type: "done", reason, message: finalize(content, reason) });
}

// ---- 身份追踪 ----
const objIds = new WeakMap();
let nextObjId = 1;
function oid(obj) {
  if (obj === null || typeof obj !== "object") return String(obj);
  if (!objIds.has(obj)) objIds.set(obj, nextObjId++);
  return objIds.get(obj);
}

const deepSnapshots = new Map(); // oid -> JSON string(append 时刻)
function snapOnce(obj) {
  const id = oid(obj);
  if (!deepSnapshots.has(id)) deepSnapshots.set(id, JSON.stringify(obj));
  return id;
}

const endEventRefs = [];       // 每次 message_end 的事件载荷引用
const startUpdateRefs = [];    // message_start/message_update 的载荷引用
const events = [];             // 序时日志

function summarizeMessage(m) {
  const kinds = Array.isArray(m.content) ? m.content.map((c) => c.type).join("+") : typeof m.content;
  const extra =
    m.role === "toolResult" ? ` toolCallId=${m.toolCallId} isError=${m.isError}` :
    m.role === "assistant" ? ` stopReason=${m.stopReason}${m.errorMessage ? ` err="${m.errorMessage}"` : ""}` : "";
  return `${m.role}[${kinds}]${extra} ts=${m.timestamp} keys=${Object.keys(m).sort().join(",")}`;
}

// ---- 组装 Agent ----
const calls = [];
const abortGate = createGate();
const replies = [
  { toolCalls: [{ id: "tc1", name: "echo", args: { value: "hello" } }] }, // T1 轮1
  { text: "第一题完成" },                                                 // T1 轮2
  { text: "这段文本会被 abort 截断", holdGate: abortGate },               // T2(中途 abort)
  { text: "第三题完成" },                                                 // T3
];
const streamFn = createScriptedStreamFn(replies, calls);

const agent = new Agent({
  streamFn,
  toolExecution: "sequential",
  initialState: {
    model: FAKE_MODEL,
    systemPrompt: "spike",
    tools: [
      {
        name: "echo",
        description: "echo tool",
        parameters: Type.Object({ value: Type.String() }),
        execute: async (id, args) => ({ content: [{ type: "text", text: `echo-result:${JSON.stringify(args)}` }], details: {} }),
      },
    ],
  },
});

agent.subscribe((event) => {
  const e = event;
  if (e.type === "message_end") {
    endEventRefs.push(e.message);
    events.push(`message_end ${summarizeMessage(e.message)}`);
  } else if (e.type === "message_start" || e.type === "message_update") {
    startUpdateRefs.push(e.message);
  }
});

const arrayRefs = [];
function stageSnapshot(label) {
  const arr = agent.state.messages;
  arrayRefs.push(arr);
  console.log(`\n== ${label} ==`);
  console.log(`state.messages 长度=${arr.length} 数组oid=${oid(arr)}`);
  arr.forEach((m, i) => {
    const id = snapOnce(m);
    console.log(`  [${i}] oid=${id} ${summarizeMessage(m)}`);
  });
}

// ============ T1: 完整工具调用轮 ============
const userMsg1 = { role: "user", content: "第一题:调用 echo", timestamp: Date.now() };
await agent.prompt(userMsg1);
stageSnapshot("T1 结束");

// ============ T2: 流式中途 abort ============
const userMsg2 = { role: "user", content: "第二题:会被打断", timestamp: Date.now() };
const p2 = agent.prompt(userMsg2);
// 等流推进到门闩处(start/text_delta 已发),再 abort + 放行
await new Promise((r) => setTimeout(r, 20));
agent.abort();
abortGate.release();
await p2;
stageSnapshot("T2(abort)结束");
console.log(`state.errorMessage = ${JSON.stringify(agent.state.errorMessage)}`);

// ============ T3: abort 后再跑一轮 ============
const userMsg3 = { role: "user", content: "第三题:继续", timestamp: Date.now() };
await agent.prompt(userMsg3);
stageSnapshot("T3 结束");

// ============ 探针判读 ============
console.log("\n== P1: message_end 载荷 === state.messages 条目? ==");
agent.state.messages.forEach((m, i) => {
  console.log(`  [${i}] 同一引用: ${endEventRefs[i] === m}`);
});

console.log("\n== P2: 已入 transcript 消息是否被上游原地修改(append 时深快照 vs 终态)? ==");
let mutated = 0;
agent.state.messages.forEach((m, i) => {
  const id = oid(m);
  const before = deepSnapshots.get(id);
  const after = JSON.stringify(m);
  const same = before === after;
  if (!same) mutated++;
  console.log(`  [${i}] oid=${id} 内容未变: ${same}${same ? "" : `\n    before=${before}\n    after =${after}`}`);
});
console.log(`  → 被修改的消息数: ${mutated}`);

console.log("\n== P3: 流式 partial 与最终消息是否同一对象? ==");
const finalOids = new Set(agent.state.messages.map((m) => oid(m)));
let partialOverlap = 0;
for (const ref of startUpdateRefs) {
  if (finalOids.has(oid(ref))) {
    partialOverlap++;
    console.log(`  命中: oid=${oid(ref)} role=${ref.role} ${ref.role === "assistant" ? `stopReason=${ref.stopReason}` : ""}`);
  }
}
console.log(`  message_start/update 载荷总数=${startUpdateRefs.length},与终态消息同引用的个数=${partialOverlap}`);

console.log("\n== P4: prompt() 传入的 user 对象 === transcript 条目? ==");
console.log(`  userMsg1: ${agent.state.messages[0] === userMsg1}`);
console.log(`  userMsg2: ${agent.state.messages[4] === userMsg2}`);
console.log(`  userMsg3: ${agent.state.messages[6] === userMsg3}`);

console.log("\n== P5: state.messages 数组引用是否恒定? ==");
console.log(`  三次快照数组引用相同: ${arrayRefs[0] === arrayRefs[1] && arrayRefs[1] === arrayRefs[2]}`);

console.log("\n== P6: 外部篡改捕获引用 → state.messages 是否直接可见(无防御拷贝)? ==");
const tampered = agent.state.messages[3];
const origText = tampered.content[0].text;
tampered.content[0].text = "TAMPERED-EXTERNALLY";
console.log(`  篡改后 state.messages[3].content[0].text = ${JSON.stringify(agent.state.messages[3].content[0].text)}`);
tampered.content[0].text = origText; // 还原,避免影响后续输出

console.log("\n== Q2 补充: 三类消息的完整 JSON 样例 ==");
console.log("user:      " + JSON.stringify(agent.state.messages[0]));
console.log("assistant: " + JSON.stringify(agent.state.messages[1]));
console.log("toolResult:" + JSON.stringify(agent.state.messages[2]));
console.log("aborted:   " + JSON.stringify(agent.state.messages[5]));

console.log("\n== 事件序(message_end 序列) ==");
events.forEach((l, i) => console.log(`  ${String(i).padStart(3)} ${l}`));
