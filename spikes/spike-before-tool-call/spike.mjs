// Spike: 实证 @earendil-works/pi-agent-core@0.84.4 的 beforeToolCall 拦截能力。
// 纯 .mjs，直接 import dist/*.js；脚本化假 streamFn 驱动真实 Agent。
// 运行: node tmp/spike-before-tool-call/spike.mjs
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

// reply: { text?: string, toolCalls?: [{ id, name, args }] }
// 回复队列耗尽后重复最后一条。abort 感知：流开始/推进时发现 signal.aborted 则发 error{aborted}。
function createScriptedStreamFn(replies, calls) {
  const streamFn = (model, context, options) => {
    calls.push({ model, context });
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
  });
  const abortNow = () => {
    stream.push({ type: "error", reason: "aborted", error: finalize([], "aborted") });
  };
  stream.push({ type: "start", partial });
  if (signal?.aborted) return abortNow();
  let contentIndex = 0;
  const content = [];
  if (reply.text) {
    stream.push({ type: "text_start", contentIndex, partial });
    if (signal?.aborted) return abortNow();
    partial.content = [...content, { type: "text", text: reply.text }];
    stream.push({ type: "text_delta", contentIndex, delta: reply.text, partial });
    stream.push({ type: "text_end", contentIndex, content: reply.text, partial });
    content.push({ type: "text", text: reply.text });
    contentIndex++;
  }
  for (const tc of reply.toolCalls ?? []) {
    const toolCall = { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args };
    stream.push({ type: "toolcall_start", contentIndex, partial });
    if (signal?.aborted) return abortNow();
    partial.content = [...content, toolCall];
    stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(tc.args), partial });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
    content.push(toolCall);
    contentIndex++;
  }
  const reason = (reply.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop";
  stream.push({ type: "done", reason, message: finalize(content, reason) });
}

function summarizeEvent(event) {
  const e = event;
  switch (e.type) {
    case "message_start":
    case "message_end": {
      const m = e.message;
      const kinds = Array.isArray(m.content) ? m.content.map((c) => c.type).join("+") : "?";
      const extra =
        m.role === "toolResult"
          ? ` isError=${m.isError} text=${JSON.stringify(m.content?.[0]?.text ?? null)}`
          : m.role === "assistant"
            ? ` stopReason=${m.stopReason}`
            : "";
      return `${m.role}[${kinds}]${extra}`;
    }
    case "tool_execution_start":
      return `${e.toolName} id=${e.toolCallId} args=${JSON.stringify(e.args)}`;
    case "tool_execution_end":
      return `${e.toolName} id=${e.toolCallId} isError=${e.isError} resultText=${JSON.stringify(e.result?.content?.[0]?.text ?? null)}`;
    case "turn_end":
      return `stopReason=${e.message?.stopReason} toolResults=${e.toolResults?.length ?? 0}`;
    case "agent_end":
      return `messages=${e.messages?.length ?? 0}`;
    default:
      return "";
  }
}

function summarizeMessages(messages) {
  return messages.map((m, i) => {
    if (m.role === "toolResult") {
      return `  [${i}] toolResult tool=${m.toolName} isError=${m.isError} text=${JSON.stringify(m.content?.[0]?.text ?? null)}`;
    }
    if (m.role === "assistant") {
      const parts = m.content.map((c) =>
        c.type === "toolCall"
          ? `toolCall(${c.name},id=${c.id},args=${JSON.stringify(c.arguments)})`
          : `text(${JSON.stringify(c.text)})`
      );
      return `  [${i}] assistant stopReason=${m.stopReason} errorMessage=${JSON.stringify(m.errorMessage ?? null)} content: ${parts.join(" | ")}`;
    }
    return `  [${i}] ${m.role} ${JSON.stringify(m.content?.[0]?.text ?? "")}`;
  });
}

// 每个场景独立运行；超时兜底（超时即失败，记录 TIMEOUT 并 abort）。
async function runScenario(name, { replies, hook, tools, toolExecution, timeoutMs = 15000 }) {
  console.log(`\n${"=".repeat(72)}\n### ${name}\n${"=".repeat(72)}`);
  const log = [];
  const execCalls = [];
  const hookCalls = [];
  const streamCalls = [];
  let order = 0;
  const record = (kind, detail) => log.push(`${String(order++).padStart(3, "0")} ${kind}${detail ? " " + detail : ""}`);

  const wrappedTools = tools.map((t) => ({
    ...t,
    execute: async (toolCallId, params, signal, onUpdate) => {
      execCalls.push({ toolCallId, name: t.name, params: structuredClone(params) });
      record("EXECUTE", `${t.name} id=${toolCallId} args=${JSON.stringify(params)}`);
      if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
      return { content: [{ type: "text", text: `${t.name}-result:${JSON.stringify(params)}` }], details: {} };
    },
  }));

  const streamFn = createScriptedStreamFn(replies, streamCalls);
  const agent = new Agent({
    streamFn,
    toolExecution,
    initialState: { model: FAKE_MODEL, tools: wrappedTools, systemPrompt: "spike" },
    beforeToolCall: hook
      ? async (ctx, signal) => {
          hookCalls.push({ name: ctx.toolCall.name, id: ctx.toolCall.id, args: structuredClone(ctx.args) });
          record("HOOK_ENTER", `${ctx.toolCall.name} id=${ctx.toolCall.id} args=${JSON.stringify(ctx.args)}`);
          const out = await hook(ctx, agent);
          record("HOOK_EXIT", `${ctx.toolCall.name} returned=${JSON.stringify(out ?? null)}`);
          return out;
        }
      : undefined,
  });
  agent.subscribe((event) => record(`EVENT ${event.type}`, summarizeEvent(event)));

  let promptError = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    record("TIMEOUT", `>${timeoutMs}ms → agent.abort()`);
    agent.abort();
  }, timeoutMs);
  try {
    await agent.prompt("go");
  } catch (e) {
    promptError = e;
    record("PROMPT_REJECTED", String(e?.message ?? e));
  } finally {
    clearTimeout(timer);
  }

  console.log("--- 事件时间线 ---");
  for (const line of log) console.log(line);
  console.log("--- 观测摘要 ---");
  console.log(`execute() 调用次数: ${execCalls.length}${execCalls.length ? " → " + JSON.stringify(execCalls) : ""}`);
  console.log(`hook 调用次数: ${hookCalls.length}`);
  console.log(`streamFn(模型) 调用次数: ${streamCalls.length}`);
  // 最后一轮模型请求看到的最后一条消息（验证 reason 是否作为反馈送达模型）
  const lastCall = streamCalls[streamCalls.length - 1];
  if (lastCall && streamCalls.length > 1) {
    const lastMsg = lastCall.context.messages[lastCall.context.messages.length - 1];
    console.log(`末次模型请求的最后一条消息: role=${lastMsg?.role} text=${JSON.stringify(lastMsg?.content?.[0]?.text ?? null)}`);
  }
  console.log(`prompt() 抛错: ${promptError ? String(promptError.message ?? promptError) : "无"}`);
  console.log(`超时触发: ${timedOut}`);
  console.log(`终态: isStreaming=${agent.state.isStreaming} errorMessage=${JSON.stringify(agent.state.errorMessage ?? null)}`);
  console.log("--- state.messages ---");
  for (const line of summarizeMessages(agent.state.messages)) console.log(line);
  return { log, execCalls, hookCalls, streamCalls, agent, promptError, timedOut };
}

const echoTool = {
  name: "echo",
  label: "Echo",
  description: "回显 value",
  parameters: Type.Object({ value: Type.String() }),
  execute: async () => ({ content: [], details: {} }), // 被 wrappedTools 替换
};
const slowTool = {
  name: "slow",
  label: "Slow",
  description: "延迟 50ms 后回显 value",
  delayMs: 50,
  parameters: Type.Object({ value: Type.String() }),
  execute: async () => ({ content: [], details: {} }),
};

// S0: API 存在性（实证:实例字段可赋值、loop 确实调用）
console.log("### S0 API 存在性");
{
  const probe = new Agent({ streamFn: createScriptedStreamFn([{ text: "x" }], []) });
  console.log(`Agent.prototype/实例字段 beforeToolCall 赋值前: ${typeof probe.beforeToolCall}`);
  probe.beforeToolCall = async () => undefined;
  console.log(`赋值后: ${typeof probe.beforeToolCall}`);
  console.log(`afterToolCall: ${typeof probe.afterToolCall} (赋值前)`);
  console.log(`shouldStopAfterTurn: ${typeof probe.shouldStopAfterTurn} (赋值前)`);
  console.log(`toolExecution 默认: ${probe.toolExecution}`);
}

// S1: 基线 —— 无 hook,单 toolCall,第二轮纯文本收尾
await runScenario("S1 基线:无 hook,单个 toolCall", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "hello" } }] },
    { text: "最终回答" },
  ],
  tools: [echoTool],
});

// S2a: 阻断(terminate:false) —— 循环应继续,reason 应作为 toolResult 反馈送达模型
await runScenario("S2a 阻断:return {block:true, reason}", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "hello" } }] },
    { text: "收到阻断反馈后的回答" },
  ],
  tools: [echoTool],
  hook: () => ({ block: true, reason: "BLOCKED-BY-SPIKE 自定义原因" }),
});

// S2b: 阻断(terminate:true) —— run 应立即结束,不再请求模型
await runScenario("S2b 阻断:return {block:true, reason, terminate:true}", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "hello" } }] },
    { text: "不应被请求" },
  ],
  tools: [echoTool],
  hook: () => ({ block: true, reason: "BLOCKED-TERMINATE 终止", terminate: true }),
});

// S3: hook 抛错 —— 是否毒化 run,还是降级为 toolResult 错误反馈
await runScenario("S3 hook 抛错", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "hello" } }] },
    { text: "抛错恢复后的回答" },
  ],
  tools: [echoTool],
  hook: () => {
    throw new Error("HOOK-THROW spike 爆炸");
  },
});

// S4: 坚持循环 —— 模型永远发同一 toolCall,hook 永远阻断;第 10 次 hook 时 abort 兜底
await runScenario("S4 坚持循环:模型永不放弃 + hook 永远阻断(10 次后 abort)", {
  replies: [{ toolCalls: [{ id: "tc-loop", name: "echo", args: { value: "again" } }] }],
  tools: [echoTool],
  hook: (() => {
    let n = 0;
    return (ctx, agent) => {
      n++;
      if (n >= 10) {
        agent.abort();
        return { block: true, reason: `第 ${n} 次阻断后 abort` };
      }
      return { block: true, reason: `第 ${n} 次阻断` };
    };
  })(),
  timeoutMs: 20000,
});

// S5a: 原地修改 ctx.args 的字段
await runScenario("S5a 参数篡改:原地改 ctx.args.value", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "original" } }] },
    { text: "done" },
  ],
  tools: [echoTool],
  hook: (ctx) => {
    ctx.args.value = "MUTATED-IN-PLACE";
    return undefined;
  },
});

// S5b: 整体替换 ctx.args(重新赋值属性)
await runScenario("S5b 参数篡改:ctx.args = 新对象", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "original" } }] },
    { text: "done" },
  ],
  tools: [echoTool],
  hook: (ctx) => {
    ctx.args = { value: "WHOLESALE-REPLACED" };
    return undefined;
  },
});

// S5c: 试图通过返回值携带修改后的 args(API 无此字段)
await runScenario("S5c 参数篡改:return { args: 新对象 }", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "original" } }] },
    { text: "done" },
  ],
  tools: [echoTool],
  hook: () => ({ args: { value: "RETURNED-ARGS" } }),
});

// S5d: 原地改 ctx.toolCall.arguments(transcript/事件副本),不改 ctx.args
await runScenario("S5d 参数篡改:原地改 ctx.toolCall.arguments.value", {
  replies: [
    { toolCalls: [{ id: "tc1", name: "echo", args: { value: "original" } }] },
    { text: "done" },
  ],
  tools: [echoTool],
  hook: (ctx) => {
    ctx.toolCall.arguments.value = "TC-ARGS-MUTATED";
    return undefined;
  },
});

// S6: 一条消息两个 toolCall(默认 parallel) —— 阻断第二个、放行第一个
await runScenario("S6 多 toolCall:slow(放行) + echo(阻断)", {
  replies: [
    {
      toolCalls: [
        { id: "tcA", name: "slow", args: { value: "A" } },
        { id: "tcB", name: "echo", args: { value: "B" } },
      ],
    },
    { text: "批次后的回答" },
  ],
  tools: [slowTool, echoTool],
  hook: (ctx) =>
    ctx.toolCall.id === "tcB" ? { block: true, reason: "只阻断 tcB" } : undefined,
});

console.log("\n全部场景完成。");
