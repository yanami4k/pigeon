// 模型信息（决策 362）：价格、上下文窗口、单次输出上限逐项取值——设置里手填的 > 接入模块声明的 > pi-ai 自带目录 > 未知。
// 每一项单独取（价格来自目录、窗口来自声明也可以）；价格的四个数与币种算一项，整体取自同一来源（不同币种的数不能拼在一起）。
// 身份（provider 与模型名）：接入模块声明了就用声明的，否则用启动参数的标签（--provider、--model）；设置与目录都按这个身份查。
// 缓存规则按实际服务方查 cache-rules.ts 的表（设置可指明服务方并逐项覆盖）。
// 查询（modelProfile）给后续的上下文裁剪等功能用：解析后的模型信息、缓存规则，以及命中价、未命中价、写缓存价（带币种；
// 三者的比值与币种无关）。本模块只取值与记录，不改裁剪、压缩或输出上限的行为。纯 schema 与合并，无 IO；目录查询由调用方传入。
import { type Static, type TSchema, Type } from "typebox";
import {
  applyCacheRuleOverride,
  type CacheRule,
  findCacheRule,
  UNKNOWN_CACHE_RULE,
  type Unknown,
} from "./cache-rules.ts";

const Closed = { additionalProperties: false } as const;
const Price = () => Type.Number({ minimum: 0 });
const CurrencySchema = Type.String({ pattern: "^[A-Z]{3}$" });
// 声明与目录不写币种时的币种（pi-ai 目录的价格是美元）
export const DEFAULT_CURRENCY = "USD";

// 接入模块具名导出的 modelInfo：字段取 pi-ai 模型对象的那一套（价格每百万 token，另加币种），各项可缺省。
// 对象非严格：直接导出一个 pi-ai 模型对象也可以，多余字段不看
export const ModelInfoDeclarationSchema = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  id: Type.Optional(Type.String({ minLength: 1 })),
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

export interface ResolvedCacheRule {
  // 按哪家服务方查的
  servedBy: string;
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
  const override = inputs.section?.models?.[`${provider}/${id}`];
  const fromDeclared: ModelInfoValues = {
    ...(declared?.cost !== undefined
      ? { cost: { ...declared.cost, currency: declared.cost.currency ?? DEFAULT_CURRENCY } }
      : {}),
    ...(declared?.contextWindow !== undefined ? { contextWindow: declared.contextWindow } : {}),
    ...(declared?.maxTokens !== undefined ? { maxTokens: declared.maxTokens } : {}),
  };
  // 目录只在前两层没给全时才查
  const needsCatalog = (["cost", "contextWindow", "maxTokens"] as const).some(
    (key) => override?.[key] === undefined && fromDeclared[key] === undefined
  );
  const fromCatalog = needsCatalog ? inputs.catalog?.(provider, id) : undefined;
  const pick = <K extends keyof ModelInfoValues>(
    key: K
  ): Sourced<NonNullable<ModelInfoValues[K]>> => {
    const layers: Array<[ModelInfoSource, ModelInfoValues | undefined]> = [
      ["settings", override],
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
    cache: resolveCacheRule(provider, id, override?.cache),
  };
}

function resolveCacheRule(
  provider: string,
  id: string,
  override: ModelOverride["cache"]
): ResolvedCacheRule {
  const servedBy = override?.servedBy ?? provider;
  const row = findCacheRule(servedBy, id);
  const base = row?.rule ?? UNKNOWN_CACHE_RULE;
  const { servedBy: _servedBy, ...fields } = override ?? {};
  const overridden = Object.keys(fields).length > 0;
  return {
    servedBy,
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

// 本次所用的模型信息与每一项的来源；缓存规则只记按哪家服务方查、命中哪一行、有没有设置覆盖（规则内容在表里）
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

// 命中价取 cacheRead、未命中价取 input、写缓存价取 cacheWrite。约定：价格全为 0 视为没给（pi-ai 自定义模型的写法），三者都未知；
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
  const { input, output, cacheRead, cacheWrite, currency } = cost.value;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return unknown;
  return {
    currency,
    hit: cacheRead > 0 ? cacheRead : "unknown",
    miss: input,
    write: cacheWrite > 0 ? cacheWrite : input,
  };
}
