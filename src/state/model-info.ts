// 模型信息（决策 362）：价格、上下文窗口、单次输出上限逐项取值——设置里手填的 > 接入模块声明的 > pi-ai 自带目录 > 未知。
// 每一项单独取（价格来自目录、窗口来自声明也可以）；价格的四个数与币种算一项，整体取自同一来源（不同币种的数不能拼在一起）。
// 身份（provider 与模型名）：接入模块声明了就用声明的，否则用启动参数的标签（--provider、--model）；设置与目录都按这个身份查。
// 价格全为 0 的一层视为没给价格（pi-ai 自定义模型的写法），继续往下层取。
// 缓存规则按实际服务方查 cache-rules.ts 的表。服务方：设置里指明的 > 声明里指明的 > 按声明的 baseUrl 主机名查已知服务方 >
// provider 标签；设置可再逐项覆盖规则。
// 查询（modelProfile）给后续的上下文裁剪等功能用：解析后的模型信息、缓存规则，以及命中价、未命中价、写缓存价（带币种；
// 三者的比值与币种无关）。本模块只取值与记录，不改裁剪、压缩或输出上限的行为。纯 schema 与合并，无 IO；目录查询由调用方传入。
import { type Static, type TSchema, Type } from "typebox";
import {
  applyCacheRuleOverride,
  type CacheRule,
  findCacheRule,
  servedByOfHost,
  UNKNOWN_CACHE_RULE,
  type Unknown,
} from "./cache-rules.ts";

const Closed = { additionalProperties: false } as const;
const Price = () => Type.Number({ minimum: 0 });
const CurrencySchema = Type.String({ pattern: "^[A-Z]{3}$" });
// 声明与目录不写币种时的币种（pi-ai 目录的价格是美元）
export const DEFAULT_CURRENCY = "USD";

// 接入模块具名导出的 modelInfo：字段取 pi-ai 模型对象的那一套（价格每百万 token，另加币种），另可指明实际服务方 servedBy，
// 各项可缺省。对象非严格：直接导出一个 pi-ai 模型对象也可以；两边都不认识的顶层键由加载方告警
export const ModelInfoDeclarationSchema = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  id: Type.Optional(Type.String({ minLength: 1 })),
  // 接口地址：按主机名判定实际服务方
  baseUrl: Type.Optional(Type.String()),
  servedBy: Type.Optional(Type.String({ minLength: 1 })),
  cost: Type.Optional(
    Type.Object({
      input: Price(),
      output: Price(),
      cacheRead: Price(),
      cacheWrite: Price(),
      currency: Type.Optional(CurrencySchema),
    })
  ),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ModelInfoDeclaration = Static<typeof ModelInfoDeclarationSchema>;

// 声明里认得的顶层键：pi-ai 模型对象的字段（0.84.4 的 Model）与 modelInfo 另加的 servedBy
export const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "api",
  "provider",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
  "servedBy",
]);

const RetentionBasisSchema = Type.Union([
  Type.Literal("fixed"),
  Type.Literal("minimum"),
  Type.Literal("typical"),
  Type.Literal("best-effort"),
  Type.Literal("unstated"),
]);
const TierOverrideSchema = Type.Object(
  {
    seconds: Type.Optional(Type.Integer({ minimum: 1 })),
    basis: Type.Optional(RetentionBasisSchema),
    refreshOnHit: Type.Optional(Type.Boolean()),
    writeMultiplier: Type.Optional(Type.Number({ minimum: 0 })),
    readMultiplier: Type.Optional(Type.Number({ minimum: 0 })),
  },
  Closed
);

// 设置里一个模型的覆盖值。价格须四个数与币种写全：三层设置按键合并，币种必填才不会沿用低层的币种
export const ModelOverrideSchema = Type.Object(
  {
    cost: Type.Optional(
      Type.Object(
        {
          input: Price(),
          output: Price(),
          cacheRead: Price(),
          cacheWrite: Price(),
          currency: CurrencySchema,
        },
        Closed
      )
    ),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    cache: Type.Optional(
      Type.Object(
        {
          servedBy: Type.Optional(Type.String({ minLength: 1 })),
          mode: Type.Optional(
            Type.Union([
              Type.Literal("auto"),
              Type.Literal("explicit"),
              Type.Literal("both"),
              Type.Literal("none"),
            ])
          ),
          short: Type.Optional(TierOverrideSchema),
          long: Type.Optional(TierOverrideSchema),
          minPrefixTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        Closed
      )
    ),
  },
  Closed
);
export type ModelOverride = Static<typeof ModelOverrideSchema>;

// settings.json 的 modelInfo 一节：models 的键为 "<provider>/<模型名>"（按上面的身份匹配）
export const ModelInfoSectionSchema = Type.Object(
  {
    // 不合"provider/模型名"格式的键报错（additionalProperties 关掉，pattern 才对键生效）
    models: Type.Optional(
      Type.Record(Type.String({ pattern: "^[^/]+/.+$" }), ModelOverrideSchema, Closed)
    ),
  },
  Closed
);
export type ModelInfoSection = Static<typeof ModelInfoSectionSchema>;

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  currency: string;
}

// 一个来源能给出的值（各项可缺）
export interface ModelInfoValues {
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
}

// pi-ai 自带目录的查询：按 provider 与模型名，查不到为 undefined
export type CatalogLookup = (provider: string, id: string) => ModelInfoValues | undefined;

export type ModelInfoSource = "settings" | "declared" | "catalog";
export type Sourced<T> = { source: ModelInfoSource; value: T } | { source: "unknown" };

// 服务方从哪来：设置、声明、声明的 baseUrl 主机名、provider 标签
export type ServedByFrom = "settings" | "declared" | "host" | "provider";

export interface ResolvedCacheRule {
  // 按哪家服务方查的
  servedBy: string;
  servedByFrom: ServedByFrom;
  // 命中的表行；查不到为缺省
  row?: string;
  // 设置里是否逐项覆盖了
  overridden: boolean;
  rule: CacheRule;
}

export interface ResolvedModelInfo {
  provider: string;
  id: string;
  // 身份来自接入模块的声明还是启动参数的标签
  identity: "declared" | "launch";
  cost: Sourced<ModelCost>;
  contextWindow: Sourced<number>;
  maxTokens: Sourced<number>;
  cache: ResolvedCacheRule;
}

export interface ModelInfoInputs {
  // 启动参数的标签
  launch: { provider: string; id: string };
  declared?: ModelInfoDeclaration;
  catalog?: CatalogLookup;
  section?: ModelInfoSection;
}

export function resolveModelInfo(inputs: ModelInfoInputs): ResolvedModelInfo {
  const { declared } = inputs;
  const identity = declared?.provider !== undefined || declared?.id !== undefined;
  const provider = declared?.provider ?? inputs.launch.provider;
  const id = declared?.id ?? inputs.launch.id;
  const entry = inputs.section?.models?.[`${provider}/${id}`];
  const fromSettings = given(entry);
  const fromDeclared = given({
    ...(declared?.cost !== undefined
      ? { cost: { ...declared.cost, currency: declared.cost.currency ?? DEFAULT_CURRENCY } }
      : {}),
    ...(declared?.contextWindow !== undefined ? { contextWindow: declared.contextWindow } : {}),
    ...(declared?.maxTokens !== undefined ? { maxTokens: declared.maxTokens } : {}),
  });
  // 目录只在前两层没给全时才查
  const needsCatalog = (["cost", "contextWindow", "maxTokens"] as const).some(
    (key) => fromSettings?.[key] === undefined && fromDeclared?.[key] === undefined
  );
  const fromCatalog = needsCatalog ? given(inputs.catalog?.(provider, id)) : undefined;
  const pick = <K extends keyof ModelInfoValues>(
    key: K
  ): Sourced<NonNullable<ModelInfoValues[K]>> => {
    const layers: Array<[ModelInfoSource, ModelInfoValues | undefined]> = [
      ["settings", fromSettings],
      ["declared", fromDeclared],
      ["catalog", fromCatalog],
    ];
    for (const [source, values] of layers) {
      const value = values?.[key];
      if (value !== undefined) return { source, value: value as NonNullable<ModelInfoValues[K]> };
    }
    return { source: "unknown" };
  };
  return {
    provider,
    id,
    identity: identity ? "declared" : "launch",
    cost: pick("cost"),
    contextWindow: pick("contextWindow"),
    maxTokens: pick("maxTokens"),
    cache: resolveCacheRule(provider, id, declared, entry?.cache),
  };
}

// 一层给出的值：价格全为 0 视为没给价格
function given(values: ModelInfoValues | undefined): ModelInfoValues | undefined {
  if (values?.cost === undefined) return values;
  const { input, output, cacheRead, cacheWrite } = values.cost;
  if (input !== 0 || output !== 0 || cacheRead !== 0 || cacheWrite !== 0) return values;
  const { cost: _zero, ...rest } = values;
  return rest;
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function servedByOf(
  provider: string,
  declared: ModelInfoDeclaration | undefined,
  override: ModelOverride["cache"]
): { servedBy: string; servedByFrom: ServedByFrom } {
  if (override?.servedBy !== undefined) {
    return { servedBy: override.servedBy, servedByFrom: "settings" };
  }
  if (declared?.servedBy !== undefined) {
    return { servedBy: declared.servedBy, servedByFrom: "declared" };
  }
  const host = hostOf(declared?.baseUrl);
  const byHost = host !== undefined ? servedByOfHost(host) : undefined;
  return byHost !== undefined
    ? { servedBy: byHost, servedByFrom: "host" }
    : { servedBy: provider, servedByFrom: "provider" };
}

function resolveCacheRule(
  provider: string,
  id: string,
  declared: ModelInfoDeclaration | undefined,
  override: ModelOverride["cache"]
): ResolvedCacheRule {
  const { servedBy, servedByFrom } = servedByOf(provider, declared, override);
  const row = findCacheRule(servedBy, id);
  const base = row?.rule ?? UNKNOWN_CACHE_RULE;
  const { servedBy: _servedBy, ...fields } = override ?? {};
  const overridden = Object.keys(fields).length > 0;
  return {
    servedBy,
    servedByFrom,
    ...(row !== undefined ? { row: row.id } : {}),
    overridden,
    rule: overridden ? applyCacheRuleOverride(base, fields) : base,
  };
}

// ---- 会话记录（Run 开始条目的 modelInfo）----

const SourcedSchema = <T extends TSchema>(value: T) =>
  Type.Union([
    Type.Object({
      source: Type.Union([
        Type.Literal("settings"),
        Type.Literal("declared"),
        Type.Literal("catalog"),
      ]),
      value,
    }),
    Type.Object({ source: Type.Literal("unknown") }),
  ]);

// 本次所用的模型信息与每一项的来源；缓存规则只记按哪家服务方查、服务方从哪来、命中哪一行、有没有设置覆盖（规则内容在表里）
export const RunModelInfoSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  identity: Type.Union([Type.Literal("declared"), Type.Literal("launch")]),
  cost: SourcedSchema(
    Type.Object({
      input: Price(),
      output: Price(),
      cacheRead: Price(),
      cacheWrite: Price(),
      currency: CurrencySchema,
    })
  ),
  contextWindow: SourcedSchema(Type.Integer({ minimum: 1 })),
  maxTokens: SourcedSchema(Type.Integer({ minimum: 1 })),
  cacheRule: Type.Object({
    servedBy: Type.String({ minLength: 1 }),
    servedByFrom: Type.Union([
      Type.Literal("settings"),
      Type.Literal("declared"),
      Type.Literal("host"),
      Type.Literal("provider"),
    ]),
    row: Type.Optional(Type.String({ minLength: 1 })),
    overridden: Type.Boolean(),
  }),
});
export type RunModelInfo = Static<typeof RunModelInfoSchema>;

export function runModelInfoRecord(info: ResolvedModelInfo): RunModelInfo {
  return {
    provider: info.provider,
    id: info.id,
    identity: info.identity,
    cost: structuredClone(info.cost),
    contextWindow: { ...info.contextWindow },
    maxTokens: { ...info.maxTokens },
    cacheRule: {
      servedBy: info.cache.servedBy,
      servedByFrom: info.cache.servedByFrom,
      ...(info.cache.row !== undefined ? { row: info.cache.row } : {}),
      overridden: info.cache.overridden,
    },
  };
}

// ---- 查询 ----

// 每百万 token 的价格；未知的项标 unknown
export interface CachePrices {
  currency: string | Unknown;
  hit: number | Unknown;
  miss: number | Unknown;
  write: number | Unknown;
}

export interface ModelProfile {
  info: ResolvedModelInfo;
  cacheRule: CacheRule;
  prices: CachePrices;
}

// 命中价取 cacheRead、未命中价取 input、写缓存价取 cacheWrite。约定：价格未知时三者都未知（全为 0 的价格合并时已当作没给）；
// cacheRead 为 0 视为没给命中价；cacheWrite 为 0 表示不另收写入费，写入的 token 按未命中价计，故写缓存价取未命中价
export function modelProfile(info: ResolvedModelInfo): ModelProfile {
  return { info, cacheRule: info.cache.rule, prices: cachePrices(info.cost) };
}

function cachePrices(cost: Sourced<ModelCost>): CachePrices {
  const unknown: CachePrices = {
    currency: "unknown",
    hit: "unknown",
    miss: "unknown",
    write: "unknown",
  };
  if (cost.source === "unknown") return unknown;
  const { input, cacheRead, cacheWrite, currency } = cost.value;
  return {
    currency,
    hit: cacheRead > 0 ? cacheRead : "unknown",
    miss: input,
    write: cacheWrite > 0 ? cacheWrite : input,
  };
}
