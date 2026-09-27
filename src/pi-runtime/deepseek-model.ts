// DeepSeek 的模型对象（决策 203、234）：跑批网关与日常使用共用这一份定义。走 DeepSeek 的 Anthropic 兼容端点与 pi-ai 的
// anthropic-messages 线路；pi-ai 目录里没有 deepseek-flash（只有暂时转到 V4.1 的旧名），故自构。
//   reasoning 为真：未请求推理时 pi-ai 显式发 thinking disabled（DeepSeek 不发 thinking 即默认开思考）；
//   contextWindow 为官方 1M；maxTokens 为单次输出上限 16384（决策 203）；
//   cost 全为 0：花费由跑批网关按官方人民币价目与高峰时段逐请求计（eval/model-pricing.ts），不在这里另算一份。
import type { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

// DeepSeek 的 Anthropic 兼容端点，请求路径 /v1/messages
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_MODEL_ID = "deepseek-flash";
export const DEEPSEEK_PROVIDER = "deepseek";
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_MAX_TOKENS = 16_384;

export type DeepSeekModel = Parameters<typeof streamSimple>[0];

export function deepseekModel(
  baseUrl = DEEPSEEK_ANTHROPIC_BASE_URL,
  modelId = DEEPSEEK_MODEL_ID
): DeepSeekModel {
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: DEEPSEEK_PROVIDER,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_MAX_TOKENS,
  };
}
