// 联网工具的装配（决策 287–291）：按 .pigeon/web.json 与环境变量决定搜索后端并建出后端实例（key 只在实例的闭包里，
// 不进配置对象、不打印）；抓取上限取配置或缺省；提炼器用本会话同一个模型接入（温度 0、不带工具、有输出上限），
// 提炼请求的用量交回工具，由工具写进结果的 modelUsage 计入本会话花费。
// 注册范围由各入口决定：交互入口与 pigeon run 缺省装上；--sandbox-network off 不装（291）；跑批器各条件不装（265 的先例）。
import { loadWebConfig } from "../persistence/web-config.ts";
import {
  completeWithoutTools,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_KEY_ENV,
  DEEPSEEK_MODEL_ID,
  type StreamFn,
} from "../pi-runtime/index.ts";
import {
  DEFAULT_DISTILL_MAX_TOKENS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_SEARCH_BACKEND,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type SearchBackendId,
  type WebConfigFile,
} from "../state/web-config.ts";
import { createAnthropicSearchBackend } from "../web/backends/anthropic-search.ts";
import { createTavilySearchBackend, TAVILY_DEFAULT_BASE_URL } from "../web/backends/tavily.ts";
import { createZaiSearchBackend, ZAI_DEFAULT_BASE_URL } from "../web/backends/zai.ts";
import {
  DISTILL_SYSTEM_PROMPT,
  type Distiller,
  type DistillInput,
  distillUserText,
} from "../web/distill.ts";
import type { FetchLimits } from "../web/fetch.ts";
import type { DnsLookup, Transport } from "../web/network.ts";
import type { WebSearchSetup } from "../web/tools.ts";

// 智谱与 Tavily 的 key 的环境变量名（配置里的 apiKey 优先）
export const ZAI_KEY_ENV = "ZAI_API_KEY";
export const TAVILY_KEY_ENV = "TAVILY_API_KEY";

// 装配根接收的联网工具配置：在场即注册两件工具
export interface WebToolsConfig {
  search: WebSearchSetup;
  fetch: FetchLimits;
  distillMaxTokens: number;
  // 测试注入：DNS 解析与传输层
  lookup?: DnsLookup;
  transport?: Transport;
}

export interface ResolveWebToolsOptions {
  governanceRoot: string;
  // key 的来源（缺省 process.env；测试注入）
  env?: Record<string, string | undefined>;
  // 测试注入：不读磁盘上的配置（显式给 undefined 也算注入：不读磁盘）
  config?: WebConfigFile | undefined;
}

// 读配置、挑后端、取 key。缺 key 不在装配时报错（工具仍注册），调用时按 unavailable 的文字回话，文字里不带 key
export function resolveWebTools(options: ResolveWebToolsOptions): WebToolsConfig {
  const env = options.env ?? process.env;
  const config = options.config ?? loadWebConfig(options.governanceRoot);
  const search = config?.search;
  const backendId: SearchBackendId = search?.backend ?? DEFAULT_SEARCH_BACKEND;
  const timeoutMs = search?.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const defaultMaxResults = search?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  let setup: WebSearchSetup;
  if (backendId === "deepseek") {
    const apiKey = env[DEEPSEEK_KEY_ENV];
    setup =
      apiKey !== undefined && apiKey !== ""
        ? {
            backend: createAnthropicSearchBackend({
              id: "deepseek",
              baseUrl: search?.deepseek?.baseUrl ?? DEEPSEEK_ANTHROPIC_BASE_URL,
              model: search?.deepseek?.model ?? DEEPSEEK_MODEL_ID,
              apiKey,
              timeoutMs,
            }),
            defaultMaxResults,
          }
        : {
            unavailable: `搜索后端 deepseek 缺少 key：请设置环境变量 ${DEEPSEEK_KEY_ENV}`,
            defaultMaxResults,
          };
  } else if (backendId === "zai") {
    const apiKey = search?.zai?.apiKey ?? env[ZAI_KEY_ENV];
    setup =
      apiKey !== undefined && apiKey !== ""
        ? {
            backend: createZaiSearchBackend({
              baseUrl: search?.zai?.baseUrl ?? ZAI_DEFAULT_BASE_URL,
              apiKey,
              timeoutMs,
            }),
            defaultMaxResults,
          }
        : {
            unavailable: `搜索后端 zai 缺少 key：在 .pigeon/web.json 的 search.zai.apiKey 或环境变量 ${ZAI_KEY_ENV} 里给出`,
            defaultMaxResults,
          };
  } else {
    const apiKey = search?.tavily?.apiKey ?? env[TAVILY_KEY_ENV];
    setup =
      apiKey !== undefined && apiKey !== ""
        ? {
            backend: createTavilySearchBackend({
              baseUrl: search?.tavily?.baseUrl ?? TAVILY_DEFAULT_BASE_URL,
              apiKey,
              timeoutMs,
            }),
            defaultMaxResults,
          }
        : {
            unavailable: `搜索后端 tavily 缺少 key：在 .pigeon/web.json 的 search.tavily.apiKey 或环境变量 ${TAVILY_KEY_ENV} 里给出`,
            defaultMaxResults,
          };
  }
  return {
    search: setup,
    fetch: {
      timeoutMs: config?.fetch?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      maxBytes: config?.fetch?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES,
      maxChars: config?.fetch?.maxChars ?? DEFAULT_FETCH_MAX_CHARS,
    },
    distillMaxTokens: config?.fetch?.distillMaxTokens ?? DEFAULT_DISTILL_MAX_TOKENS,
  };
}

// 提炼器（289）：本会话同一个模型接入，温度 0，不带工具，输出上限为 distillMaxTokens。模型对象只是占位身份（真实模型
// 元数据在模型接入插件里），与压缩摘要请求用的同一份
export function createModelDistiller(options: {
  streamFn: StreamFn;
  model: Parameters<typeof completeWithoutTools>[1];
  maxTokens: number;
}): Distiller {
  return async (input: DistillInput) => {
    const outcome = await completeWithoutTools(options.streamFn, options.model, {
      systemPrompt: DISTILL_SYSTEM_PROMPT,
      userText: distillUserText(input),
      maxTokens: options.maxTokens,
      temperature: 0,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return {
      text: outcome.text,
      usage: outcome.usage,
      ...(outcome.stopReason === "length" ? { outputTruncated: true } : {}),
    };
  };
}
