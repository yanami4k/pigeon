// 上下文超长的识别直接用上游的判定（pi-ai 的 isContextOverflow：按各 provider 的报错文案，先排除限额类）；
// 这里不另造正则。不传上下文窗口：只认出错收尾的报错文案，不做静默超长的推断（那是按 usage 比窗口判正常收尾的回复，
// 不是请求出错）。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

// 一段错误文案：包成上游要的错误态 assistant 消息再交给上游判定
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

// 决策 422：一条消息是否为"模型请求因上下文超长出错"——出错收尾的助手消息，交给上游判定
export function isContextOverflowReply(message: AgentMessage): boolean {
  return (
    message.role === "assistant" && message.stopReason === "error" && isContextOverflow(message)
  );
}
