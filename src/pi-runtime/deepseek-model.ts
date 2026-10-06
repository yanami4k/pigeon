// DeepSeek 的模型对象（决策 203、234）：跑批网关与日常使用共用这一份定义。走 DeepSeek 的 Anthropic 兼容端点与 pi-ai 的
// anthropic-messages 线路；pi-ai 目录里没有 deepseek-flash（只有暂时转到 V4.1 的旧名），故自构。
//   reasoning 为真：未请求推理时 pi-ai 显式发 thinking disabled（DeepSeek 不发 thinking 即默认开思考）；
//   contextWindow 为官方 1M；maxTokens 为官方单次输出上限 393,216（决策 347，改决策 203 的 16384）；Pigeon 未配置输出上限时
//   即按它发，由 provider 按剩余上下文收窄；
//   cost 全为 0：花费由跑批网关按官方人民币价目与高峰时段逐请求计（state/model-pricing.ts），不在这里另算一份；
//   compat.allowEmptySignature 为真：签名为空的历史思考仍以 thinking 块回传（pi-ai 缺省会改作普通文字）。
// 模型信息的声明（决策 362）：deepseekModelInfo 带官方人民币非高峰价（取自 model-pricing.ts；高峰加价由计费另算，不影响命中与
// 未命中的价格比），与模型对象同一组身份、窗口、输出上限与是否支持推理（决策 390：据此缺省开思考）；接入模块经具名导出
// modelInfo 交给 Pigeon。
import type { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ModelInfoDeclaration } from "../state/model-info.ts";
import { PRICE_CNY_PER_MTOK } from "../state/model-pricing.ts";

// DeepSeek 的 Anthropic 兼容端点，请求路径 /v1/messages
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_MODEL_ID = "deepseek-flash";
export const DEEPSEEK_PROVIDER = "deepseek";
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_MAX_TOKENS = 393_216;

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
    // 价格在 deepseekModelInfo 里，不放进模型对象：pi-ai 按 model.cost 算每条回复的 usage.cost，现有计费、状态栏与脚本预算
    // 靠"DeepSeek 回复的 usage.cost 为 0"改按人民币价目与高峰时段计，放进来会改变这一判断
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_MAX_TOKENS,
    // 历史回复的思考块签名为空时仍以 thinking 块（signature 为空串）回传，不让 pi-ai 改成普通文字；有签名时不受影响
    compat: { allowEmptySignature: true },
  };
}

// 写缓存：Anthropic 兼容端点的 cache_creation_input_tokens 实测恒为 0、价目没有单列，出现时按未命中价计（同 model-pricing.ts）。
// 实际服务方恒为 DeepSeek（端点根改指转发代理或经跑批网关时也是）。输出上限不是正整数时不声明（按未知处理）
export function deepseekModelInfo(
  modelId = DEEPSEEK_MODEL_ID,
  maxTokens = DEEPSEEK_MAX_TOKENS
): ModelInfoDeclaration {
  return {
    provider: DEEPSEEK_PROVIDER,
    id: modelId,
    servedBy: DEEPSEEK_PROVIDER,
    cost: {
      input: PRICE_CNY_PER_MTOK.cacheMiss,
      output: PRICE_CNY_PER_MTOK.output,
      cacheRead: PRICE_CNY_PER_MTOK.cacheHit,
      cacheWrite: PRICE_CNY_PER_MTOK.cacheMiss,
      currency: "CNY",
    },
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    reasoning: true,
  };
}
