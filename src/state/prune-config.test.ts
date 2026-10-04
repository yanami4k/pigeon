// 上下文裁剪的价格比（决策 361）：设置覆盖优先；服务方不做缓存按 1；有价格时按 max(未命中价, 写缓存价) / 命中价，
// 给了写缓存倍率按未命中价乘它；只有缓存规则的倍率时按倍率；都取不到按 50。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CacheRule } from "./cache-rules.ts";
import type { CachePrices, ModelProfile } from "./model-info.ts";
import { contextPruneSettings, priceRatioOf, UNKNOWN_PRICE_RATIO } from "./prune-config.ts";

function profile(prices: Partial<CachePrices>, rule: Partial<CacheRule> = {}): ModelProfile {
  return {
    info: {} as ModelProfile["info"],
    cacheRule: { mode: "auto", minPrefixTokens: "unknown", sources: [], ...rule },
    prices: { currency: "USD", hit: "unknown", miss: "unknown", write: "unknown", ...prices },
  };
}

const tier = (readMultiplier: number, writeMultiplier: number, seconds: number) => ({
  seconds,
  basis: "fixed" as const,
  refreshOnHit: true,
  writeMultiplier,
  readMultiplier,
  enable: "auto",
});

test("价格比的取值顺序与保留时长", () => {
  assert.equal(priceRatioOf(profile({ hit: 0.1, miss: 1, write: 1.25 })), 12.5);
  assert.equal(priceRatioOf(profile({ hit: 0.1, miss: 1, write: 1.25 }), 2), 20);
  assert.equal(priceRatioOf(profile({}, { short: tier(0.1, 1.25, 300) })), 12.5);
  assert.equal(priceRatioOf(profile({ hit: 0.1, miss: 1, write: 1 }, { mode: "none" })), 1);
  assert.equal(priceRatioOf(profile({})), UNKNOWN_PRICE_RATIO);
  assert.equal(priceRatioOf(undefined), UNKNOWN_PRICE_RATIO);
  const known = profile({ hit: 0.1, miss: 1, write: 1 }, { short: tier(0.1, 1, 300) });
  assert.deepEqual(
    [
      contextPruneSettings(undefined, known).priceRatio,
      contextPruneSettings(undefined, known).retentionSeconds,
    ],
    [10, 300]
  );
  const overridden = contextPruneSettings({ priceRatio: 3, retentionSeconds: 60 }, known);
  assert.deepEqual([overridden.priceRatio, overridden.retentionSeconds], [3, 60]);
});
