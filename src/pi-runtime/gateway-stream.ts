// 经跑批网关的模型接入（决策 155、234）：上游为 DeepSeek 的 Anthropic 兼容端点，模型对象取 deepseek-model.ts 的同一份
// 定义，只把基址换成网关给这个作业的地址；请求里的 key 是占位，真 key 只在网关里注入。单轮输出上限与自带的 DeepSeek 接入
// 共用 modelOutputLimit 取值；modelMaxTokens 给了就替换模型定义的上限（跑批器用它让进程内条件不随产品缺省变化）。
// 模型信息的声明（决策 362）随返回的 StreamFn 登记，与自带的 DeepSeek 接入同一份。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PROVIDER,
  deepseekModel,
  deepseekModelInfo,
} from "./deepseek-model.ts";
import { registerModelAccess } from "./model-access.ts";
import { modelOutputLimit, withMaxTokens } from "./output-limit.ts";

// 交给网关的占位 key：网关一律换成真 key，它本身不能用于上游
export const GATEWAY_PLACEHOLDER_KEY = "pigeon-gateway";

export const DEFAULT_GATEWAY_MODEL_ID = DEEPSEEK_MODEL_ID;
export const GATEWAY_PROVIDER = DEEPSEEK_PROVIDER;
// 上游基址（网关转发的目标）
export const GATEWAY_UPSTREAM_BASE_URL = DEEPSEEK_ANTHROPIC_BASE_URL;

export function gatewayStreamFn(
  baseUrl: string,
  modelId = DEFAULT_GATEWAY_MODEL_ID,
  modelMaxTokens?: number
): StreamFn {
  // 调用方传入的 model 只是快照身份占位，忽略之，用自构的模型对象
  const defined = deepseekModel(baseUrl, modelId);
  const model = modelMaxTokens !== undefined ? { ...defined, maxTokens: modelMaxTokens } : defined;
  const streamFn: StreamFn = (_model, context, options) => {
    const limit = modelOutputLimit(model, options?.maxTokens);
    return streamSimple(
      limit.model,
      context,
      withMaxTokens({ ...options, apiKey: GATEWAY_PLACEHOLDER_KEY }, limit.maxTokens)
    );
  };
  return registerModelAccess(streamFn, { declared: deepseekModelInfo(modelId, model.maxTokens) });
}
