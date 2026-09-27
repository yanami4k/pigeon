// 日常使用的 DeepSeek 模型接入（工厂）：直连 DeepSeek 的 Anthropic 兼容端点，模型对象与跑批网关同一份定义
// （deepseek-model.ts）；CLI 传入的模型是快照身份占位，忽略之。key 只从环境变量 DEEPSEEK_API_KEY 读，缺失即报错；
// 不打印、不落盘。思考档位、温度与单次输出上限都由 Pigeon 这一层经调用选项传入（--thinking 未给即 off，pi-ai 发
// thinking disabled；温度走 fixTemperature 包装；输出上限走 limitOutputTokens 包装），这里原样透传。
// 入口模块见 deepseek-stream-fn.ts（--stream-fn / PIGEON_STREAM_FN 指向它）。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL_ID, deepseekModel } from "./deepseek-model.ts";

export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";

export function createDeepSeekStreamFn(
  env: Record<string, string | undefined>,
  stream: typeof streamSimple = streamSimple
): StreamFn {
  const apiKey = env[DEEPSEEK_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(`缺少 ${DEEPSEEK_KEY_ENV} 环境变量：DeepSeek 模型接入的 key 从这里取`);
  }
  const model = deepseekModel(DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL_ID);
  return (_model, context, options) => stream(model, context, { ...options, apiKey });
}
