// 经跑批网关的模型接入（决策 155、234）：上游为 DeepSeek 的 Anthropic 兼容端点，模型对象取 deepseek-model.ts 的同一份
// 定义，只把基址换成网关给这个作业的地址；请求里的 key 是占位，真 key 只在网关里注入。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PROVIDER,
  deepseekModel,
} from "./deepseek-model.ts";

// 交给网关的占位 key：网关一律换成真 key，它本身不能用于上游
export const GATEWAY_PLACEHOLDER_KEY = "pigeon-gateway";

export const DEFAULT_GATEWAY_MODEL_ID = DEEPSEEK_MODEL_ID;
export const GATEWAY_PROVIDER = DEEPSEEK_PROVIDER;
// 上游基址（网关转发的目标）
export const GATEWAY_UPSTREAM_BASE_URL = DEEPSEEK_ANTHROPIC_BASE_URL;

export function gatewayStreamFn(baseUrl: string, modelId = DEFAULT_GATEWAY_MODEL_ID): StreamFn {
  // 调用方传入的 model 只是快照身份占位，忽略之，用自构的模型对象
  const model = deepseekModel(baseUrl, modelId);
  return (_model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: GATEWAY_PLACEHOLDER_KEY });
}
