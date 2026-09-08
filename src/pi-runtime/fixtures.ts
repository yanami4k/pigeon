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

export interface FakeReply {
  text: string;
  // 每个 text_delta 携带的字符数；缺省整条文本一次发完
  chunkSize?: number;
  // 逐 chunk 门闩：设置后每个分片发出前都要等放行
  chunkGate?: FakeGate;
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
}

export type FakeStreamFn = StreamFn & { readonly calls: FakeStreamCall[] };

export function createFakeStreamFn(behavior: FakeStreamBehavior): FakeStreamFn {
  if (behavior.replies.length === 0) {
    throw new Error("createFakeStreamFn: replies 至少一条");
  }
  const calls: FakeStreamCall[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    calls.push({ model, context });
    if (calls.length === behavior.failOnCall) {
      return Promise.reject(new Error(behavior.failureMessage ?? "模拟模型错误"));
    }
    const reply = behavior.replies[Math.min(calls.length - 1, behavior.replies.length - 1)];
    if (!reply) {
      return Promise.reject(new Error("createFakeStreamFn: 回复队列状态异常"));
    }
    const stream = createAssistantMessageEventStream();
    void pump(stream, model, reply, options?.signal);
    return stream;
  };
  return Object.assign(streamFn, { calls });
}

async function pump(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  reply: FakeReply,
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
  const chunkSize = reply.chunkSize ?? Math.max(reply.text.length, 1);
  const chunks: string[] = [];
  for (let i = 0; i < reply.text.length; i += chunkSize) {
    chunks.push(reply.text.slice(i, i + chunkSize));
  }
  stream.push({ type: "text_start", contentIndex: 0, partial });
  let accumulated = "";
  for (const chunk of chunks) {
    if (reply.chunkGate) {
      await reply.chunkGate.wait();
    }
    // 真实 provider 的中止响应：发出 error{reason:"aborted"}，携带 stopReason=aborted 的终态消息
    if (signal?.aborted) {
      stream.push({
        type: "error",
        reason: "aborted",
        error: finalize(partial, accumulated, "aborted"),
      });
      return;
    }
    accumulated += chunk;
    partial.content = [{ type: "text", text: accumulated }];
    stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: accumulated, partial });
  stream.push({ type: "done", reason: "stop", message: finalize(partial, accumulated, "stop") });
}

function finalize(
  partial: AssistantMessage,
  text: string,
  stopReason: "stop" | "aborted"
): AssistantMessage {
  return {
    ...partial,
    content: [{ type: "text", text }],
    // 非零 usage：与上游合成失败消息（usage 全零）区分开
    usage: {
      ...zeroUsage(),
      output: Math.max(text.length, 1),
      totalTokens: Math.max(text.length, 1),
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
