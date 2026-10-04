// 缓存感知的上下文裁剪的配置（决策 361）：settings.json 的 contextPrune 一节，不给的取缺省（缺省开启），以及按模型信息
// （决策 362）算出的重写价与命中价之比、缓存保留时长。
// 价格比的取值顺序：设置里的 priceRatio > 缓存规则写明不做缓存（mode 为 none）按 1 > 模型信息的价格（重写价取未命中价与
// 写缓存价中较高者，除以命中价；设置里给了 writeMultiplier 时写缓存价按未命中价乘它算）> 缓存规则里的写入、读取倍率 >
// 取不到按价差很大（50）保守处理。
// 保留时长：设置里的 retentionSeconds > 缓存规则较短一档的秒数 > 未知（不按空闲触发）。
import { type Static, Type } from "typebox";
import type { ModelProfile } from "./model-info.ts";

// 取不到价格时假定的重写价与命中价之比（价差很大，付费裁剪从严）
export const UNKNOWN_PRICE_RATIO = 50;

export const ContextPruneSectionSchema = Type.Object(
  {
    // 总开关：关掉后不再新裁，会话里已有的裁剪记录照旧重放（前缀不变）
    enabled: Type.Optional(Type.Boolean()),
    // 最近这么多轮（一条助手消息及其工具结果为一轮）的工具结果不裁
    protectTurns: Type.Optional(Type.Integer({ minimum: 0 })),
    // 付费时机的 N：之后至少还会再跑的轮数的保守下限
    horizonTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    // 付费时机一次至少裁掉这么多 token
    minBatchTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    // 较大的旧结果：至少这么多 token 才算
    minResultTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    // 覆盖：重写价与命中价之比、写缓存价按未命中价的倍数、缓存保留时长（秒）
    priceRatio: Type.Optional(Type.Number({ minimum: 1 })),
    writeMultiplier: Type.Optional(Type.Number({ minimum: 0 })),
    retentionSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    // 两种免费时机：压缩时、空闲超过保留时长
    onCompaction: Type.Optional(Type.Boolean()),
    onIdle: Type.Optional(Type.Boolean()),
    // 过时读取（被后来的读取覆盖或被整体覆写）的清理
    staleReads: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type ContextPruneSection = Static<typeof ContextPruneSectionSchema>;

export interface ContextPruneSettings {
  enabled: boolean;
  protectTurns: number;
  horizonTurns: number;
  minBatchTokens: number;
  minResultTokens: number;
  // 重写价 / 命中价
  priceRatio: number;
  // 缓存保留时长（秒）；未知为 undefined
  retentionSeconds: number | undefined;
  onCompaction: boolean;
  onIdle: boolean;
  staleReads: boolean;
}

export const DEFAULT_CONTEXT_PRUNE = {
  enabled: true,
  protectTurns: 5,
  horizonTurns: 20,
  minBatchTokens: 10_000,
  minResultTokens: 500,
  onCompaction: true,
  onIdle: true,
  staleReads: true,
} as const;

export function contextPruneSettings(
  section: ContextPruneSection | undefined,
  profile: ModelProfile | undefined
): ContextPruneSettings {
  return {
    enabled: section?.enabled ?? DEFAULT_CONTEXT_PRUNE.enabled,
    protectTurns: section?.protectTurns ?? DEFAULT_CONTEXT_PRUNE.protectTurns,
    horizonTurns: section?.horizonTurns ?? DEFAULT_CONTEXT_PRUNE.horizonTurns,
    minBatchTokens: section?.minBatchTokens ?? DEFAULT_CONTEXT_PRUNE.minBatchTokens,
    minResultTokens: section?.minResultTokens ?? DEFAULT_CONTEXT_PRUNE.minResultTokens,
    priceRatio: section?.priceRatio ?? priceRatioOf(profile, section?.writeMultiplier),
    retentionSeconds: section?.retentionSeconds ?? retentionOf(profile),
    onCompaction: section?.onCompaction ?? DEFAULT_CONTEXT_PRUNE.onCompaction,
    onIdle: section?.onIdle ?? DEFAULT_CONTEXT_PRUNE.onIdle,
    staleReads: section?.staleReads ?? DEFAULT_CONTEXT_PRUNE.staleReads,
  };
}

// 重写价 / 命中价（比值与币种无关）
export function priceRatioOf(profile: ModelProfile | undefined, writeMultiplier?: number): number {
  // 服务方不做缓存：没有命中价可言，改写不多花钱，只受下限约束
  if (profile?.cacheRule.mode === "none") return 1;
  const prices = profile?.prices;
  if (prices !== undefined && typeof prices.hit === "number" && typeof prices.miss === "number") {
    const write =
      writeMultiplier !== undefined
        ? prices.miss * writeMultiplier
        : typeof prices.write === "number"
          ? prices.write
          : prices.miss;
    return Math.max(1, Math.max(prices.miss, write) / prices.hit);
  }
  const tier = profile?.cacheRule.short;
  const read = tier?.readMultiplier;
  if (typeof read === "number" && read > 0) {
    const write =
      writeMultiplier ?? (typeof tier?.writeMultiplier === "number" ? tier.writeMultiplier : 1);
    return Math.max(1, Math.max(1, write) / read);
  }
  return UNKNOWN_PRICE_RATIO;
}

function retentionOf(profile: ModelProfile | undefined): number | undefined {
  const seconds = profile?.cacheRule.short?.seconds;
  return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
}
