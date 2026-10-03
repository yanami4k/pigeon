// 模型信息的逐项取值（决策 362）：设置 > 接入模块声明 > pi-ai 目录 > 未知，每项单独取；价格整体取自同一来源；
// 缓存规则按实际服务方查；查询给出命中、未命中、写缓存三价（带币种）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CatalogLookup, modelProfile, resolveModelInfo } from "./model-info.ts";
import { validateSettingsLayer } from "./settings.ts";

const USD = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: "USD" };
const CNY = { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" };
const catalog: CatalogLookup = () => ({ cost: USD, contextWindow: 200_000, maxTokens: 64_000 });

test("逐项取值：设置 > 声明 > 目录 > 未知，每项各自取最高的一层", () => {
  const info = resolveModelInfo({
    launch: { provider: "custom", id: "custom" },
    declared: { provider: "acme", id: "m1", cost: { ...CNY }, contextWindow: 500_000 },
    catalog,
    section: { models: { "acme/m1": { contextWindow: 300_000 } } },
  });
  assert.deepEqual(info.cost, { source: "declared", value: CNY });
  assert.deepEqual(info.contextWindow, { source: "settings", value: 300_000 });
  assert.deepEqual(info.maxTokens, { source: "catalog", value: 64_000 });
  const bare = resolveModelInfo({ launch: { provider: "custom", id: "custom" } });
  assert.deepEqual(
    [bare.cost, bare.contextWindow, bare.maxTokens],
    [{ source: "unknown" }, { source: "unknown" }, { source: "unknown" }]
  );
});

test("价格整体取：设置的价格连同币种盖掉声明的；声明不写币种按 USD；前两层给全时不查目录", () => {
  let lookups = 0;
  const counting: CatalogLookup = (...args) => {
    lookups += 1;
    return catalog(...args);
  };
  const { currency: _omit, ...declaredCost } = USD;
  const declared = { cost: declaredCost, contextWindow: 1, maxTokens: 1 };
  const overridden = resolveModelInfo({
    launch: { provider: "acme", id: "m1" },
    declared,
    catalog: counting,
    section: { models: { "acme/m1": { cost: CNY } } },
  });
  assert.deepEqual(overridden.cost, { source: "settings", value: CNY });
  const plain = resolveModelInfo({
    launch: { provider: "acme", id: "m1" },
    declared,
    catalog: counting,
  });
  assert.deepEqual(plain.cost, { source: "declared", value: USD });
  assert.equal(lookups, 0);
});

test("身份：声明的 provider 与模型名优先于启动参数的标签，设置与目录都按它匹配", () => {
  const seen: string[] = [];
  const info = resolveModelInfo({
    launch: { provider: "custom", id: "custom" },
    declared: { provider: "acme", id: "m1" },
    catalog: (provider, id) => {
      seen.push(`${provider}/${id}`);
      return undefined;
    },
    section: { models: { "custom/custom": { maxTokens: 9 }, "acme/m1": { contextWindow: 7 } } },
  });
  assert.deepEqual([info.provider, info.id, info.identity], ["acme", "m1", "declared"]);
  assert.deepEqual(info.contextWindow, { source: "settings", value: 7 });
  assert.deepEqual(info.maxTokens, { source: "unknown" });
  assert.deepEqual(seen, ["acme/m1"]);
  assert.equal(resolveModelInfo({ launch: { provider: "p", id: "m" } }).identity, "launch");
});

test("缓存规则按实际服务方查：经兼容端点的 DeepSeek 查 DeepSeek；设置可指明服务方并逐项覆盖", () => {
  const deepseek = resolveModelInfo({ launch: { provider: "deepseek", id: "deepseek-flash" } });
  assert.equal(deepseek.cache.row, "deepseek");
  assert.equal(deepseek.cache.rule.mode, "auto");
  const proxied = resolveModelInfo({
    launch: { provider: "my-proxy", id: "claude-sonnet-5" },
    section: {
      models: {
        "my-proxy/claude-sonnet-5": { cache: { servedBy: "anthropic", short: { seconds: 120 } } },
      },
    },
  });
  assert.deepEqual([proxied.cache.servedBy, proxied.cache.row], ["anthropic", "anthropic"]);
  assert.equal(proxied.cache.overridden, true);
  assert.equal(proxied.cache.rule.short?.seconds, 120);
  assert.equal(proxied.cache.rule.short?.writeMultiplier, 1.25);
  const unknown = resolveModelInfo({ launch: { provider: "my-proxy", id: "x" } });
  assert.equal(unknown.cache.row, undefined);
  assert.equal(unknown.cache.rule.mode, "unknown");
});

test("查询：命中、未命中、写缓存三价带币种；写入不另收费时写缓存价取未命中价；价格全 0 或未知即三者未知", () => {
  const profile = (cost: typeof USD) =>
    modelProfile(resolveModelInfo({ launch: { provider: "acme", id: "m" }, declared: { cost } }))
      .prices;
  assert.deepEqual(profile(USD), { currency: "USD", hit: 0.3, miss: 3, write: 3.75 });
  assert.deepEqual(profile({ ...CNY, cacheWrite: 0 }), {
    currency: "CNY",
    hit: 0.02,
    miss: 1,
    write: 1,
  });
  const unknown = { currency: "unknown", hit: "unknown", miss: "unknown", write: "unknown" };
  assert.deepEqual(
    profile({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, currency: "USD" }),
    unknown
  );
  assert.deepEqual(
    modelProfile(resolveModelInfo({ launch: { provider: "acme", id: "m" } })).prices,
    unknown
  );
});

test("设置的 modelInfo 一节：键须为 provider/模型名，价格须带币种", () => {
  const source = { layer: "project", file: ".pigeon/settings.json" } as const;
  const ok = validateSettingsLayer(
    { modelInfo: { models: { "acme/m1": { cost: CNY, contextWindow: 1000 } } } },
    source
  );
  assert.ok("file" in ok);
  for (const bad of [
    { models: { m1: { contextWindow: 1000 } } },
    { models: { "acme/m1": { cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } } },
  ]) {
    assert.ok("problems" in validateSettingsLayer({ modelInfo: bad }, source));
  }
});
