// 日常使用的 DeepSeek 模型接入（工厂）：直连 DeepSeek 的 Anthropic 兼容端点，模型对象取 deepseek-model.ts 的定义；
// CLI 传入的模型是快照身份占位，忽略之。key 只从环境变量 DEEPSEEK_API_KEY 读，缺失即报错；
// 不打印、不落盘。思考档位与温度由 Pigeon 这一层经调用选项传入（缺省 high，决策 390；档位为 off 时不带 reasoning，pi-ai
// 据此发 thinking disabled；温度走 fixTemperature 包装，开思考时不传），这里原样透传；单轮输出上限经 modelOutputLimit 取值
// （配置了取配置值与模型上限的较小者，未配置不传，由 provider 按模型上限并按剩余上下文收窄）。
// 端点根可由环境变量 DEEPSEEK_BASE_URL 改指（例如本机的转发代理），没给或为空时用官方地址；请求照旧拼 /v1/messages。
// 入口模块见 deepseek-stream-fn.ts（--stream-fn / PIGEON_STREAM_FN 指向它）。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL_ID, deepseekModel } from "./deepseek-model.ts";
import { modelOutputLimit, withMaxTokens } from "./output-limit.ts";

export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";
// Anthropic 兼容端点的根（可选）
export const DEEPSEEK_BASE_URL_ENV = "DEEPSEEK_BASE_URL";

// 端点根：环境变量给了就用它（须为 http 或 https 地址，否则启动即报错，报错里带上地址），没给或为空用官方地址
export function resolveDeepSeekBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[DEEPSEEK_BASE_URL_ENV];
  if (raw === undefined || raw === "") return DEEPSEEK_ANTHROPIC_BASE_URL;
  let protocol: string | undefined;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      `环境变量 ${DEEPSEEK_BASE_URL_ENV} 须为 http 或 https 地址（Anthropic 兼容端点的根，请求拼 /v1/messages），现为：${redactUserinfo(raw)}`
    );
  }
  return raw;
}

// 报错里的地址去掉用户名与密码（"…//用户:密码@主机" 或无协议的 "用户:密码@主机"）
export function redactUserinfo(address: string): string {
  return address.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)?[^/?#@\s]*@/i,
    (_m, scheme?: string) => `${scheme ?? ""}***@`
  );
}

export function createDeepSeekStreamFn(
  env: Record<string, string | undefined>,
  stream: typeof streamSimple = streamSimple
): StreamFn {
  const apiKey = env[DEEPSEEK_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(`缺少 ${DEEPSEEK_KEY_ENV} 环境变量：DeepSeek 模型接入的 key 从这里取`);
  }
  const model = deepseekModel(resolveDeepSeekBaseUrl(env), DEEPSEEK_MODEL_ID);
  return (_model, context, options) => {
    const limit = modelOutputLimit(model, options?.maxTokens);
    return stream(limit.model, context, withMaxTokens({ ...options, apiKey }, limit.maxTokens));
  };
}
