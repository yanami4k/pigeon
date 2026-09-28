// 不带任何工具的单次补全（决策 289）：网页提炼用——经调用方给的模型接入（与主请求同一个 streamFn）发一条只有系统提示与一条
// 用户消息的请求，不带工具、不请求推理，温度与输出上限由调用方给；取回终态消息的文本与用量。
// 只在 pi-runtime 触达上游的流式接口；application 经本函数拿到结果，不直接消费上游事件流。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TurnUsage } from "../state/runtime-events.ts";
import { turnUsageOf } from "./events.ts";

export interface CompletionRequest {
  systemPrompt: string;
  userText: string;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

export interface CompletionOutcome {
  text: string;
  usage: TurnUsage;
  // 上游停止原因：stop / length（撞输出上限）等
  stopReason: string;
}

export class CompletionError extends Error {}

export async function completeWithoutTools(
  streamFn: StreamFn,
  model: Model<Api>,
  request: CompletionRequest
): Promise<CompletionOutcome> {
  const stream = await streamFn(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.userText }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    }
  );
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new CompletionError(
      message.errorMessage !== undefined && message.errorMessage !== ""
        ? message.errorMessage
        : `模型请求以 ${message.stopReason} 收尾`
    );
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, usage: turnUsageOf(message.usage), stopReason: message.stopReason };
}
