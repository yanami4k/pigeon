// 缓存规则表（决策 362）：按实际服务方查、精确型号优先、其次最长前缀；没有兜底行的服务方下匹配不到的型号为未知；
// 表的每行有出处，各档的数彼此自洽。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CACHE_RULES,
  type CacheRuleRow,
  findCacheRule,
  SERVED_BY_HOSTS,
  servedByOfHost,
} from "./cache-rules.ts";

test("按服务方查：精确型号优先、其次最长前缀、不匹配取兜底；别家同名前缀不串行；查不到为 undefined", () => {
  const rule = { mode: "auto", minPrefixTokens: "unknown", sources: [] } as const;
  const rows: CacheRuleRow[] = [
    { id: "a", servedBy: ["a", "a-cn"], rule },
    { id: "a/x", servedBy: ["a"], modelPrefixes: ["x-"], rule },
    { id: "a/x1", servedBy: ["a"], modelPrefixes: ["x-1"], rule },
    { id: "a/exact", servedBy: ["a"], models: ["x-1"], rule },
    { id: "b/x", servedBy: ["b"], modelPrefixes: ["x-"], rule },
  ];
  const id = (servedBy: string, model: string) => findCacheRule(servedBy, model, rows)?.id;
  assert.equal(id("a", "x-1"), "a/exact");
  assert.equal(id("a", "x-1-pro"), "a/x1");
  assert.equal(id("a", "x-2"), "a/x");
  assert.equal(id("a", "y"), "a");
  assert.equal(id("a-cn", "x-1"), "a");
  assert.equal(id("b", "y"), undefined);
  assert.equal(id("c", "x-1"), undefined);
});

test("首批表的细分：各家型号落到对应行，文档没点名的型号与未来型号不借用别的行", () => {
  const id = (servedBy: string, model: string) => findCacheRule(servedBy, model)?.id;
  assert.equal(id("deepseek", "deepseek-flash"), "deepseek");
  assert.equal(id("anthropic", "claude-opus-5-5"), "anthropic/opus-5.5");
  assert.equal(id("anthropic", "claude-sonnet-5"), "anthropic");
  assert.equal(id("openai", "gpt-6.1-sol"), "openai/gpt-6.1-sol");
  assert.equal(id("openai", "gpt-5.6-terra"), "openai/gpt-5.6+");
  assert.equal(id("openai", "gpt-5"), "openai/earlier");
  assert.equal(id("openai", "gpt-4o"), "openai/earlier");
  assert.equal(id("openai", "gpt-7"), undefined);
  assert.equal(id("google-vertex", "gemini-2.0-flash"), "google-vertex/gemini-2.0");
  assert.equal(id("google-vertex", "gemini-3.5-flash"), "google-vertex/gemini-2.5+");
  assert.equal(id("google-vertex", "gemini-flash-latest"), undefined);
  assert.equal(id("kimi", "kimi-k2.7"), "kimi/k2.6-k2.7");
  assert.equal(id("kimi", "kimi-k2.7-code"), "kimi");
  assert.equal(id("amazon-bedrock", "eu.anthropic.claude-opus-5"), "amazon-bedrock/claude");
  assert.equal(id("amazon-bedrock", "amazon.nova-pro-v1:0"), undefined);
});

test("按接口主机名判定服务方：已知主机整段匹配，主机表里的服务方在规则表里都有行", () => {
  assert.equal(servedByOfHost("api.deepseek.com"), "deepseek");
  assert.equal(servedByOfHost("us-central1-aiplatform.googleapis.com"), "google-vertex");
  assert.equal(servedByOfHost("bedrock-runtime.eu-central-1.amazonaws.com"), "amazon-bedrock");
  assert.equal(servedByOfHost("token-plan.cn-beijing.maas.aliyuncs.com"), "alibaba-bailian");
  assert.equal(servedByOfHost("api.deepseek.com.example.net"), undefined);
  assert.equal(servedByOfHost("127.0.0.1"), undefined);
  for (const { servedBy } of SERVED_BY_HOSTS) {
    assert.ok(
      CACHE_RULES.some((row) => row.servedBy.includes(servedBy)),
      servedBy
    );
  }
});

test("表的每行：行标识唯一、有出处；依据类别与秒数一致，长档不短于短档；已知的写入倍率不小于 1、命中倍率小于 1", () => {
  const ids = CACHE_RULES.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, rule } of CACHE_RULES) {
    assert.ok(rule.sources.length > 0, id);
    for (const source of rule.sources) {
      assert.match(source.url, /^https:\/\//, id);
      assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/, id);
      assert.ok(source.quote.trim().length > 0, id);
    }
    if (rule.minPrefixTokens !== "unknown") {
      assert.ok(rule.minPrefixTokens.min <= rule.minPrefixTokens.max, id);
    }
    for (const tier of [rule.short, rule.long]) {
      if (tier === undefined) continue;
      if (tier.basis === "unstated") assert.equal(tier.seconds, "unknown", id);
      if (["fixed", "minimum", "typical"].includes(tier.basis)) {
        assert.equal(typeof tier.seconds, "number", id);
      }
      if (tier.writeMultiplier !== "unknown") assert.ok(tier.writeMultiplier >= 1, id);
      if (tier.readMultiplier !== "unknown") assert.ok(tier.readMultiplier < 1, id);
    }
    const [short, long] = [rule.short?.seconds, rule.long?.seconds];
    if (typeof short === "number" && typeof long === "number") assert.ok(long >= short, id);
  }
});
