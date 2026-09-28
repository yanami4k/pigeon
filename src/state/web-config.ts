// 联网工具的项目配置 schema（决策 288、289）：<治理根>/.pigeon/web.json。
// search.backend 选搜索后端（缺省 deepseek：经 DeepSeek 的 Anthropic 接口请服务端搜索，用现有的 key）；智谱（zai）与
// Tavily 的 key 可写在这里，也可用环境变量（ZAI_API_KEY、TAVILY_API_KEY），环境变量优先级低于配置；key 只在进程内持有，
// 绝不打印、不落日志。fetch 段是抓取的上限（超时、字节数、正文字符数）与提炼的输出上限。
// 文件缺失 = 全部缺省（合法）；存在但畸形 → 响亮失败（与 verify.json / grants.json 同一口径）。
import { type Static, Type } from "typebox";

export const WEB_CONFIG_VERSION = 1;

export const SEARCH_BACKENDS = ["deepseek", "zai", "tavily"] as const;
export type SearchBackendId = (typeof SEARCH_BACKENDS)[number];
// 显式列出三个字面量（对数组做 map 会让 typebox 推不出静态类型）
export const SearchBackendIdSchema = Type.Union([
  Type.Literal("deepseek"),
  Type.Literal("zai"),
  Type.Literal("tavily"),
]);

const HttpUrl = () => Type.String({ minLength: 1, pattern: "^https?://" });
const Secret = () => Type.String({ minLength: 1 });

// 各后端的连接参数：DeepSeek 的 key 一律取环境变量（与模型接入同一来源），这里只能改地址与模型名
export const WebConfigFileSchema = Type.Object({
  version: Type.Literal(WEB_CONFIG_VERSION),
  search: Type.Optional(
    Type.Object({
      backend: Type.Optional(SearchBackendIdSchema),
      // 缺省返回条数（1 到 20，缺省 5）；模型调用时给了条数以调用为准
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      deepseek: Type.Optional(
        Type.Object({
          baseUrl: Type.Optional(HttpUrl()),
          model: Type.Optional(Type.String({ minLength: 1 })),
        })
      ),
      zai: Type.Optional(
        Type.Object({
          apiKey: Type.Optional(Secret()),
          baseUrl: Type.Optional(HttpUrl()),
        })
      ),
      tavily: Type.Optional(
        Type.Object({
          apiKey: Type.Optional(Secret()),
          baseUrl: Type.Optional(HttpUrl()),
        })
      ),
    })
  ),
  fetch: Type.Optional(
    Type.Object({
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
      distillMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    })
  ),
});
export type WebConfigFile = Static<typeof WebConfigFileSchema>;

// 抓取与提炼的缺省上限（决策 289：限制大小与超时；提炼有输出上限）
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_MAX_CHARS = 120_000;
export const DEFAULT_DISTILL_MAX_TOKENS = 4_096;
// 搜索的缺省
export const DEFAULT_SEARCH_BACKEND: SearchBackendId = "deepseek";
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
