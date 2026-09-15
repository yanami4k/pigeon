// 单轮输出上限（决策 063 第 1 件）：包装 streamFn，调用时把 maxTokens 传进选项，给无人值守运行的失控输出止损。
// 上游 agent-loop 以 { ...config, apiKey, signal } 调用 streamFn，Pigeon 在装配层包一层即可，不改上游。
// 取值：配置值（缺省 16,384）；传入的 model 带有效上限（大于 0）时取两者中更小的那个。Adapter 交给上游的 model
// 是占位身份（maxTokens 为 0），真实模型元数据在 streamFn 插件里，此时只传配置值，由插件侧 provider 再按真实模型处理。
// 撞上限时上游把该消息里的工具调用判为未执行并提示重发，不会执行残缺参数。
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function limitOutputTokens(streamFn: StreamFn, limit: number): StreamFn {
  return (model, context, options) => {
    const modelLimit = model.maxTokens;
    const maxTokens = modelLimit > 0 ? Math.min(limit, modelLimit) : limit;
    return streamFn(model, context, { ...options, maxTokens });
  };
}
