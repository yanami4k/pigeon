// Spike: 实证"幽灵工具名"（模型请求从未广告的工具名）路径的事件可见性。
// 问题：prepareToolCall 在 beforeToolCall hook 之前以 "Tool not found" 拦截，
// 审批闸/熔断不可见。本脚本回答：
//   Q1 tool_execution_start/end 是否为 not-found 调用发出？payload 是什么？
//   Q2 transcript 里的 toolResult 消息长什么样（错误原文）？
//   Q3 无任何 hook 调用时循环是否会跨模型轮次重复？
// 运行: node tmp/notfound-spike.mjs
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
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// 假模型：永远请求从未广告的工具 delete_everything（广告集只有 echo）
function phantomStreamFn(model, context, options) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
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
    });
    const signal = options?.signal;
    stream.push({ type: "start", partial });
    if (signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: finalize([], "aborted") });
      return;
    }
    const toolCall = {
      type: "toolCall",
      id: `tc-phantom-${Date.now()}`,
      name: "delete_everything",
      arguments: { target: "/" },
    };
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    if (signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: finalize([], "aborted") });
      return;
    }
    partial.content = [toolCall];
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(toolCall.arguments),
      partial,
    });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    stream.push({ type: "done", reason: "toolUse", message: finalize([toolCall], "toolUse") });
  })();
  return stream;
}

const echoTool = {
  name: "echo",
  label: "echo",
  description: "echo tool (advertised)",
  parameters: Type.Object({ value: Type.String() }),
  execute: async (id, args) => ({ content: [{ type: "text", text: `echo:${args.value}` }], details: {} }),
};

const agent = new Agent({
  streamFn: phantomStreamFn,
  toolExecution: "sequential",
  beforeToolCall: async (context) => {
    hookCalls.push(context.toolCall.name);
    return undefined;
  },
  initialState: { systemPrompt: "spike", model: FAKE_MODEL, tools: [echoTool] },
});

const hookCalls = [];
const lines = [];
let seq = 0;
let phantomEndCount = 0;
const ABORT_AFTER = 3; // 看到第 3 次 not-found end 后 abort，给循环设界

agent.subscribe((event) => {
  const e = event;
  seq++;
  let summary = "";
  switch (e.type) {
    case "message_start":
    case "message_end": {
      const m = e.message;
      const kinds = Array.isArray(m.content) ? m.content.map((c) => c.type).join("+") : "?";
      if (m.role === "toolResult") {
        summary = `${m.role}[${kinds}] toolName=${m.toolName} isError=${m.isError} text=${JSON.stringify(m.content?.[0]?.text ?? null)}`;
      } else if (m.role === "assistant") {
        summary = `${m.role}[${kinds}] stopReason=${m.stopReason}`;
      } else {
        summary = `${m.role}[${kinds}]`;
      }
      break;
    }
    case "tool_execution_start":
      summary = `${e.toolName} id=${e.toolCallId} args=${JSON.stringify(e.args)}`;
      break;
    case "tool_execution_end":
      summary = `${e.toolName} id=${e.toolCallId} isError=${e.isError} resultText=${JSON.stringify(e.result?.content?.[0]?.text ?? null)}`;
      if (e.toolName === "delete_everything" && e.isError) {
        phantomEndCount++;
        if (phantomEndCount >= ABORT_AFTER) agent.abort();
      }
      break;
    case "turn_end":
      summary = `stopReason=${e.message?.stopReason} toolResults=${e.toolResults?.length ?? 0}`;
      break;
    case "agent_end":
      summary = `messages=${e.messages?.length ?? 0}`;
      break;
    default:
      summary = "";
  }
  lines.push(`${String(seq).padStart(3, "0")} EVENT ${e.type} ${summary}`.trimEnd());
});

console.log(`广告工具集: ${JSON.stringify(agent.state.tools.map((t) => t.name))}`);

const timeout = setTimeout(() => {
  console.log("!! 20s 超时兜底 abort（循环无界实锤）");
  agent.abort();
}, 20000);

await agent.prompt("开始");
await agent.waitForIdle();
clearTimeout(timeout);

console.log("--- 完整事件时间线 ---");
for (const line of lines) console.log(line);
console.log("--- transcript (state.messages) ---");
for (const [i, m] of agent.state.messages.entries()) {
  if (m.role === "toolResult") {
    console.log(
      `[${i}] toolResult toolName=${m.toolName} toolCallId=${m.toolCallId} isError=${m.isError} text=${JSON.stringify(m.content?.[0]?.text ?? null)}`
    );
  } else if (m.role === "assistant") {
    const kinds = m.content.map((c) => (c.type === "toolCall" ? `toolCall(${c.name},${c.id})` : c.type)).join("+");
    console.log(`[${i}] assistant[${kinds}] stopReason=${m.stopReason}`);
  } else {
    console.log(`[${i}] ${m.role}`);
  }
}
console.log("--- 结论数据 ---");
console.log(`beforeToolCall hook 调用次数: ${hookCalls.length}`);
console.log(`观察到的 phantom tool_execution_end 次数: ${phantomEndCount}`);
console.log(`终态 stopReason: ${agent.state.messages.findLast((m) => m.role === "assistant")?.stopReason}`);
console.log(`终态 errorMessage: ${JSON.stringify(agent.state.errorMessage ?? null)}`);
