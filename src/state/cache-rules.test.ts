// 缓存规则表（决策 362）：按实际服务方查、同一服务方下取最长的匹配模型名前缀；表的每行都有出处。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_RULES, type CacheRuleRow, findCacheRule } from "./cache-rules.ts";

test("按服务方查，同一服务方下最长前缀优先、不匹配取兜底；别家的同名模型不串行；查不到为 undefined", () => {
  const rule = { mode: "auto", minPrefixTokens: "unknown", sources: [] } as const;
  const rows: CacheRuleRow[] = [
    { id: "a", servedBy: ["a", "a-cn"], rule },
    { id: "a/x", servedBy: ["a"], modelPrefixes: ["x-"], rule },
    { id: "a/x1", servedBy: ["a"], modelPrefixes: ["x-1"], rule },
    { id: "b/x", servedBy: ["b"], modelPrefixes: ["x-"], rule },
  ];
  const id = (servedBy: string, model: string) => findCacheRule(servedBy, model, rows)?.id;
  assert.equal(id("a", "x-1-pro"), "a/x1");
  assert.equal(id("a", "x-2"), "a/x");
  assert.equal(id("a", "y"), "a");
  assert.equal(id("a-cn", "x-1"), "a");
  assert.equal(id("b", "y"), undefined);
  assert.equal(id("c", "x-1"), undefined);
});

test("首批表：DeepSeek、Anthropic 与 OpenAI 的细分各落到对应行", () => {
  const id = (servedBy: string, model: string) => findCacheRule(servedBy, model)?.id;
  assert.equal(id("deepseek", "deepseek-flash"), "deepseek");
  assert.equal(id("anthropic", "claude-opus-5-5"), "anthropic/opus-5.5");
  assert.equal(id("anthropic", "claude-sonnet-5"), "anthropic");
  assert.equal(id("openai", "gpt-6.1-sol"), "openai/gpt-6.1-sol");
  assert.equal(id("openai", "gpt-5.6-terra"), "openai/gpt-5.6+");
  assert.equal(id("openai", "gpt-4o"), "openai/earlier");
  assert.equal(id("amazon-bedrock", "eu.anthropic.claude-opus-5"), "amazon-bedrock/claude");
  assert.equal(id("amazon-bedrock", "amazon.nova-pro-v1:0"), undefined);
});

test("表的每行：行标识唯一，至少一条出处（https 地址、取用日期、非空引句），档位的数在合理范围", () => {
  const ids = CACHE_RULES.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, rule } of CACHE_RULES) {
    assert.ok(rule.sources.length > 0, id);
    for (const source of rule.sources) {
      assert.match(source.url, /^https:\/\//, id);
      assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/, id);
      assert.ok(source.quote.trim().length > 0, id);
    }
    for (const tier of [rule.short, rule.long]) {
      if (tier === undefined) continue;
      for (const value of [tier.seconds, tier.writeMultiplier, tier.readMultiplier]) {
        assert.ok(value === "unknown" || value >= 0, id);
      }
    }
  }
});
