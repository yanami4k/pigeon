// 联网工具的装配（决策 288、289）：缺省后端 DeepSeek 用现有的 key（环境变量）；智谱与 Tavily 的 key 取配置或环境变量；
// 缺 key 不在装配时报错，工具调用时按说明回话；key 不出现在配置对象里；抓取上限取配置或缺省。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DISTILL_MAX_TOKENS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_SEARCH_MAX_RESULTS,
  type WebConfigFile,
} from "../state/web-config.ts";
import { resolveWebTools } from "./web-tools.ts";

const config = (file: WebConfigFile): WebConfigFile => file;

test("未作配置：后端为 DeepSeek，key 取环境变量 DEEPSEEK_API_KEY；缺 key 时后端缺省、说明点名环境变量；上限为缺省", () => {
  const withKey = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: { DEEPSEEK_API_KEY: "sk-deepseek-secret" },
    config: undefined,
  });
  assert.equal(withKey.search.backend?.id, "deepseek");
  assert.equal(withKey.search.unavailable, undefined);
  assert.equal(withKey.search.defaultMaxResults, DEFAULT_SEARCH_MAX_RESULTS);
  assert.deepEqual(withKey.fetch, {
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes: DEFAULT_FETCH_MAX_BYTES,
    maxChars: DEFAULT_FETCH_MAX_CHARS,
  });
  assert.equal(withKey.distillMaxTokens, DEFAULT_DISTILL_MAX_TOKENS);
  assert.ok(!JSON.stringify(withKey).includes("sk-deepseek-secret"), "key 不进配置对象");

  const noKey = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: {},
    config: undefined,
  });
  assert.equal(noKey.search.backend, undefined);
  assert.match(noKey.search.unavailable ?? "", /DEEPSEEK_API_KEY/);
});

test("配置选智谱或 Tavily：key 取配置的 apiKey 或环境变量；两处都没有时说明点名两处；上限与条数取配置", () => {
  const zaiByConfig = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: {},
    config: config({
      version: 1,
      search: { backend: "zai", maxResults: 9, zai: { apiKey: "sk-zai-secret" } },
      fetch: { timeoutMs: 1234, maxBytes: 5678, maxChars: 91011, distillMaxTokens: 1213 },
    }),
  });
  assert.equal(zaiByConfig.search.backend?.id, "zai");
  assert.equal(zaiByConfig.search.defaultMaxResults, 9);
  assert.deepEqual(zaiByConfig.fetch, { timeoutMs: 1234, maxBytes: 5678, maxChars: 91011 });
  assert.equal(zaiByConfig.distillMaxTokens, 1213);
  assert.ok(!JSON.stringify(zaiByConfig).includes("sk-zai-secret"));

  const zaiByEnv = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: { ZAI_API_KEY: "sk-zai-env" },
    config: config({ version: 1, search: { backend: "zai" } }),
  });
  assert.equal(zaiByEnv.search.backend?.id, "zai");

  const zaiMissing = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: { DEEPSEEK_API_KEY: "sk-deepseek" },
    config: config({ version: 1, search: { backend: "zai" } }),
  });
  assert.equal(zaiMissing.search.backend, undefined);
  assert.match(zaiMissing.search.unavailable ?? "", /search\.zai\.apiKey.*ZAI_API_KEY/);

  const tavily = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: { TAVILY_API_KEY: "tvly-secret" },
    config: config({ version: 1, search: { backend: "tavily" } }),
  });
  assert.equal(tavily.search.backend?.id, "tavily");
  const tavilyMissing = resolveWebTools({
    governanceRoot: "/nonexistent-root",
    env: {},
    config: config({ version: 1, search: { backend: "tavily" } }),
  });
  assert.match(tavilyMissing.search.unavailable ?? "", /TAVILY_API_KEY/);
});
