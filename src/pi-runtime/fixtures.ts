// 测试用假 streamFn：实现 pi 的 AssistantMessageEventStream 形状（仅测试与 fixture 使用）。
// 事件协议（pi-ai/dist/types.d.ts AssistantMessageEvent）：
//   start{partial} → text_start → text_delta × N → text_end → done{reason, message}
// 终态由 done/error 事件携带的完整 AssistantMessage 决定（EventStream.result()）。
// 支持：预录回复队列、可控抛错、可控延迟（FakeGate 逐 chunk 门闩，确定性，不用真实定时器）。
// abort 响应模拟真实 provider：检测到 signal.aborted 后 push error{reason:"aborted"} 事件收尾。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

// 逐 chunk 门闩：pump 在发每个分片前 wait()，测试用 release()/open() 精确控制流的推进时机，
// 从而在“流式进行中”这个确定的时间点执行 interrupt。
export interface FakeGate {
  // 等一个放行额度；open 之后立即放行
  wait(): Promise<void>;
  // 放行一个 chunk
  release(): void;
  // 永久放行后续所有 chunk
  open(): void;
}

export function createGate(): FakeGate {
  let credits = 0;
  let opened = false;
  const waiters: (() => void)[] = [];
  return {
    wait() {
      if (opened) {
        return Promise.resolve();
      }
      if (credits > 0) {
        credits--;
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push(resolve);
      return promise;
    },
    release() {
      const waiter = waiters.shift();
      if (waiter) {
        waiter();
      } else {
        credits++;
      }
    },
    open() {
      opened = true;
      while (waiters.length > 0) {
        waiters.shift()?.();
      }
    },
  };
}

// 一次回复要模型发起的工具调用；id 缺省按调用序自动生成（tc-调用序-块序），
// 模拟真实上游"每条 assistant 消息里的 toolCall id 唯一"
export interface FakeToolCallSpec {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface FakeReply {
  text: string;
  // 思考块（可选）：在文本之前以 thinking_start/thinking_delta/thinking_end 一次发完，
  // 用于验证"thinking 增量不转发"（M2 决策 024 子裁决）等流式观察行为
  thinking?: string;
  // 每个 text_delta 携带的字符数；缺省整条文本一次发完
  chunkSize?: number;
  // 逐 chunk 门闩：设置后每个分片发出前都要等放行
  chunkGate?: FakeGate;
  // 本回复携带的工具调用块；非空时 done 的 stopReason 为 toolUse
  toolCalls?: FakeToolCallSpec[];
  // 模拟撞输出上限：done 的 stopReason 为 length（上游对 length 停止的消息不执行其中的工具调用）
  stopReason?: "length";
  // 模拟 provider 在流里以错误收尾（连接中断、服务端报错）：start 之后直接发 error 事件，
  // 终态消息 stopReason 为 error 且 usage 非零——与上游的合成失败消息（请求层抛错、usage 全零）是两条路
  streamError?: string;
  // 终态消息 usage 的 totalTokens（上下文压缩按它估算上下文大小）；缺省按内容长度
  contextTokens?: number;
}

export interface FakeStreamBehavior {
  // 预录回复队列：每次调用按序消费一条，耗尽后重复最后一条
  replies: FakeReply[];
  // 第 N 次调用（从 1 起）直接抛错，模拟模型/请求层失败
  failOnCall?: number;
  // 抛错文本
  failureMessage?: string;
}

export interface FakeStreamCall {
  model: Model<Api>;
  context: Context;
  // 调用选项（输出上限、温度、推理档位等）
  options?: SimpleStreamOptions;
}

export type FakeStreamFn = StreamFn & { readonly calls: FakeStreamCall[] };

export function createFakeStreamFn(behavior: FakeStreamBehavior): FakeStreamFn {
  if (behavior.replies.length === 0) {
    throw new Error("createFakeStreamFn: replies 至少一条");
  }
  const calls: FakeStreamCall[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    calls.push({ model, context, ...(options !== undefined ? { options } : {}) });
    if (calls.length === behavior.failOnCall) {
      return Promise.reject(new Error(behavior.failureMessage ?? "模拟模型错误"));
    }
    const reply = behavior.replies[Math.min(calls.length - 1, behavior.replies.length - 1)];
    if (!reply) {
      return Promise.reject(new Error("createFakeStreamFn: 回复队列状态异常"));
    }
    const stream = createAssistantMessageEventStream();
    void pump(stream, model, reply, calls.length, options?.signal);
    return stream;
  };
  return Object.assign(streamFn, { calls });
}

async function pump(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  reply: FakeReply,
  callIndex: number,
  signal: AbortSignal | undefined
): Promise<void> {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial });
  // 提前 abort 检查：纯 toolCall 回复没有 text 分片循环，不能在分片里才第一次看中止
  if (signal?.aborted) {
    stream.push({ type: "error", reason: "aborted", error: finalize(partial, [], "aborted") });
    return;
  }

  if (reply.streamError !== undefined) {
    stream.push({
      type: "error",
      reason: "error",
      error: { ...finalize(partial, [], "error"), errorMessage: reply.streamError },
    });
    return;
  }

  // 已完成的 content 块（thinking + text + toolCall），partial.content 随流式进度逐块推进
  const contents: AssistantMessage["content"] = [];
  // 思考块在文本之前（真实 provider 的块序）；一次发完，不走分片门闩
  if (reply.thinking !== undefined && reply.thinking.length > 0) {
    const thinkingIndex = contents.length;
    partial.content = [{ type: "thinking", thinking: "" }];
    stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial });
    if (signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: finalize(partial, [], "aborted") });
      return;
    }
    partial.content = [{ type: "thinking", thinking: reply.thinking }];
    stream.push({
      type: "thinking_delta",
      contentIndex: thinkingIndex,
      delta: reply.thinking,
      partial,
    });
    stream.push({
      type: "thinking_end",
      contentIndex: thinkingIndex,
      content: reply.thinking,
      partial,
    });
    contents.push({ type: "thinking", thinking: reply.thinking });
  }
  if (reply.text.length > 0) {
    const textIndex = contents.length;
    const chunkSize = reply.chunkSize ?? reply.text.length;
    stream.push({ type: "text_start", contentIndex: textIndex, partial });
    let accumulated = "";
    for (let i = 0; i < reply.text.length; i += chunkSize) {
      if (reply.chunkGate) {
        await reply.chunkGate.wait();
      }
      // 真实 provider 的中止响应：发出 error{reason:"aborted"}，携带 stopReason=aborted 的终态消息
      if (signal?.aborted) {
        stream.push({
          type: "error",
          reason: "aborted",
          error: finalize(partial, [...contents, { type: "text", text: accumulated }], "aborted"),
        });
        return;
      }
      accumulated += reply.text.slice(i, i + chunkSize);
      partial.content = [...contents, { type: "text", text: accumulated }];
      stream.push({
        type: "text_delta",
        contentIndex: textIndex,
        delta: reply.text.slice(i, i + chunkSize),
        partial,
      });
    }
    stream.push({ type: "text_end", contentIndex: textIndex, content: accumulated, partial });
    contents.push({ type: "text", text: accumulated });
  }

  const toolCalls: ToolCall[] = (reply.toolCalls ?? []).map((spec, index) => ({
    type: "toolCall",
    id: spec.id ?? `tc-${callIndex}-${index + 1}`,
    name: spec.name,
    arguments: spec.args,
  }));
  for (const toolCall of toolCalls) {
    const contentIndex = contents.length;
    partial.content = [...contents, { ...toolCall, arguments: {} }];
    stream.push({ type: "toolcall_start", contentIndex, partial });
    // 真实 provider 以 JSON 文本流式传输参数；这里一次发完
    if (signal?.aborted) {
      stream.push({
        type: "error",
        reason: "aborted",
        error: finalize(partial, contents, "aborted"),
      });
      return;
    }
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(toolCall.arguments),
      partial,
    });
    partial.content = [...contents, toolCall];
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
    contents.push(toolCall);
  }
  const stopReason = reply.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop");
  stream.push({
    type: "done",
    reason: stopReason,
    message: finalize(partial, contents, stopReason, reply.contextTokens),
  });
}

function finalize(
  partial: AssistantMessage,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" | "length" | "aborted" | "error",
  contextTokens?: number
): AssistantMessage {
  return {
    ...partial,
    content,
    // 非零 usage：与上游合成失败消息（usage 全零）区分开
    usage: {
      ...zeroUsage(),
      output: Math.max(JSON.stringify(content).length, 1),
      totalTokens: contextTokens ?? Math.max(JSON.stringify(content).length, 1),
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
