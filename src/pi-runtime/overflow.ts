// 上下文超长的识别直接用上游的判定（pi-ai 的 isContextOverflow：按各 provider 的报错文案，先排除限额类）；
// 这里只把"一段错误文案"包成上游要的错误态 assistant 消息，不另造正则。不传上下文窗口：只认报错文案，
// 不做静默超长的推断（那要按 usage 比窗口，调用方拿不到可靠的窗口值）。
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

export function isContextOverflowError(errorMessage: string): boolean {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
  return isContextOverflow(message);
}
