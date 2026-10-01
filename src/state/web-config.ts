// 联网工具的配置 schema（决策 288、289；决策 325 起为 settings.json 的 web 一节）。
// search.backend 选搜索后端（缺省 deepseek：经 DeepSeek 的 Anthropic 接口请服务端搜索，用现有的 key）；智谱（zai）与
// Tavily 的 key 只从环境变量读（ZAI_API_KEY、TAVILY_API_KEY），设置文件里没有任何 key 字段——写了即报错并给出应设的环境变量名
// （决策 325：key 离开文件，模型读不到）。key 只在进程内持有，绝不打印、不落日志。fetch 段是抓取的上限（超时、字节数、
// 正文字符数）与提炼的输出上限。
import { type Static, Type } from "typebox";

export const SEARCH_BACKENDS = ["deepseek", "zai", "tavily"] as const;
export type SearchBackendId = (typeof SEARCH_BACKENDS)[number];
// 显式列出三个字面量（对数组做 map 会让 typebox 推不出静态类型）
export const SearchBackendIdSchema = Type.Union([
  Type.Literal("deepseek"),
  Type.Literal("zai"),
  Type.Literal("tavily"),
]);

// 智谱与 Tavily 的 key 的环境变量名
export const ZAI_KEY_ENV = "ZAI_API_KEY";
export const TAVILY_KEY_ENV = "TAVILY_API_KEY";

// 设置里不许出现的 key 字段（旧 web.json 曾有）→ 应设的环境变量
export const WEB_KEY_FIELDS: ReadonlyArray<{ backend: "zai" | "tavily"; env: string }> = [
  { backend: "zai", env: ZAI_KEY_ENV },
  { backend: "tavily", env: TAVILY_KEY_ENV },
];

const HttpUrl = () => Type.String({ minLength: 1, pattern: "^https?://" });
const Closed = { additionalProperties: false } as const;

// 各后端的连接参数：key 一律取环境变量，这里只能改地址与模型名
export const WebSectionSchema = Type.Object(
  {
    search: Type.Optional(
      Type.Object(
        {
          backend: Type.Optional(SearchBackendIdSchema),
          // 缺省返回条数（1 到 20，缺省 5）；模型调用时给了条数以调用为准
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
          deepseek: Type.Optional(
            Type.Object(
              {
                baseUrl: Type.Optional(HttpUrl()),
                model: Type.Optional(Type.String({ minLength: 1 })),
              },
              Closed
            )
          ),
          zai: Type.Optional(Type.Object({ baseUrl: Type.Optional(HttpUrl()) }, Closed)),
          tavily: Type.Optional(Type.Object({ baseUrl: Type.Optional(HttpUrl()) }, Closed)),
        },
        Closed
      )
    ),
    fetch: Type.Optional(
      Type.Object(
        {
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
          distillMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        Closed
      )
    ),
  },
  Closed
);
export type WebSection = Static<typeof WebSectionSchema>;

// 抓取与提炼的缺省上限（决策 289：限制大小与超时；提炼有输出上限）
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
// 正文字符上限 40 万：DeepSeek 的上下文装得下，一次提炼多花约一毛钱，换长文档不漏段落；仍超长时保留开头并注明
export const DEFAULT_FETCH_MAX_CHARS = 400_000;
export const DEFAULT_DISTILL_MAX_TOKENS = 4_096;
// 搜索的缺省
export const DEFAULT_SEARCH_BACKEND: SearchBackendId = "deepseek";
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
