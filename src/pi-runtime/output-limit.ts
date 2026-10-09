// 单轮输出上限（决策 063 第 1 件；缺省值经决策 347 改为跟模型走）。
// 配置了上限（--max-output-tokens）时：包装 streamFn，调用时把 maxTokens 传进选项，给无人值守运行的失控
// 输出止损；传入的 model 带有效上限（大于 0）时取两者中更小的那个。Adapter 交给上游的 model 是占位身份（maxTokens 为 0），
// 此时只传配置值，由看得到真实模型对象的接入再与模型上限取较小者（modelOutputLimit）。
// 未配置时 Pigeon 不另设上限、不包装：按模型定义的上限发，由 provider 按剩余上下文收窄（pi-ai 的 clampMaxTokensToContext）。
// 上游 agent-loop 以 { ...config, apiKey, signal } 调用 streamFn，Pigeon 在装配层包一层即可，不改上游。
// 撞上限时上游把该消息里的工具调用判为未执行并提示重发，不会执行残缺参数。
import type { StreamFn } from "@earendil-works/pi-agent-core";

// 模型定义没有上限（maxTokens 缺失或不为正）时发的上限
export const FALLBACK_MODEL_MAX_TOKENS = 32_000;

export function limitOutputTokens(streamFn: StreamFn, limit: number): StreamFn {
  return (model, context, options) => {
    const modelLimit = model.maxTokens;
    const maxTokens = modelLimit > 0 ? Math.min(limit, modelLimit) : limit;
    return streamFn(model, context, { ...options, maxTokens });
  };
}

// 看得到真实模型对象的接入（如自带的 DeepSeek）用的取值：模型上限缺失或不为正时按 32,000 计，
// 交给 provider 的模型对象带上这个上限；调用方传了 maxTokens（配置了上限）时取它与模型上限的较小者，没传就不传，
// 由 provider 用模型上限并按剩余上下文收窄。第三方接入模块须自己在模型对象上带 maxTokens（见 docs/configuration.md）
export function modelOutputLimit<M extends { maxTokens: number }>(
  model: M,
  requested: number | undefined
): { model: M; maxTokens?: number } {
  const cap =
    Number.isFinite(model.maxTokens) && model.maxTokens > 0
      ? model.maxTokens
      : FALLBACK_MODEL_MAX_TOKENS;
  const capped = cap === model.maxTokens ? model : { ...model, maxTokens: cap };
  return requested !== undefined
    ? { model: capped, maxTokens: Math.min(requested, cap) }
    : { model: capped };
}

// 选项里的 maxTokens 按取值结果放或去掉（未配置时不传，避免带着 undefined 的键）
export function withMaxTokens<O extends { maxTokens?: number }>(
  options: O,
  maxTokens: number | undefined
): O {
  const { maxTokens: _dropped, ...rest } = options;
  return (maxTokens !== undefined ? { ...rest, maxTokens } : rest) as O;
}
