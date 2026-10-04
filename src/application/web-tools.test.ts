// 联网工具的装配（决策 288、289）：缺省后端 DeepSeek 用现有的 key（环境变量）；智谱与 Tavily 的 key 只取环境变量（决策 325）；
// 缺 key 不在装配时报错，工具调用时按说明回话；key 不出现在配置对象里；抓取上限取配置或缺省。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DEFAULT_DISTILL_MAX_TOKENS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_SEARCH_MAX_RESULTS,
  type WebSection,
} from "../state/web-config.ts";
import { resolveWebTools } from "./web-tools.ts";

const config = (section: WebSection): WebSection => section;

test("未作配置：后端为 DeepSeek，key 取环境变量 DEEPSEEK_API_KEY；缺 key 时后端缺省、说明点名环境变量；上限为缺省", () => {
  const withKey = resolveWebTools({
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
  assert.equal(DEFAULT_FETCH_MAX_CHARS, 400_000);
  assert.ok(!JSON.stringify(withKey).includes("sk-deepseek-secret"), "key 不进配置对象");

  const noKey = resolveWebTools({
    env: {},
    config: undefined,
  });
  assert.equal(noKey.search.backend, undefined);
  assert.match(noKey.search.unavailable ?? "", /DEEPSEEK_API_KEY/);
});

test("配置选智谱或 Tavily：key 只取环境变量；没有时说明点名环境变量；上限与条数取配置", () => {
  const zaiByConfig = resolveWebTools({
    env: { ZAI_API_KEY: "sk-zai-secret" },
    config: config({
      search: { backend: "zai", maxResults: 9 },
      fetch: { timeoutMs: 1234, maxBytes: 5678, maxChars: 91011, distillMaxTokens: 1213 },
    }),
  });
  assert.equal(zaiByConfig.search.backend?.id, "zai");
  assert.equal(zaiByConfig.search.defaultMaxResults, 9);
  assert.deepEqual(zaiByConfig.fetch, { timeoutMs: 1234, maxBytes: 5678, maxChars: 91011 });
  assert.equal(zaiByConfig.distillMaxTokens, 1213);
  assert.ok(!JSON.stringify(zaiByConfig).includes("sk-zai-secret"));

  const zaiByEnv = resolveWebTools({
    env: { ZAI_API_KEY: "sk-zai-env" },
    config: config({ search: { backend: "zai" } }),
  });
  assert.equal(zaiByEnv.search.backend?.id, "zai");

  const zaiMissing = resolveWebTools({
    env: { DEEPSEEK_API_KEY: "sk-deepseek" },
    config: config({ search: { backend: "zai" } }),
  });
  assert.equal(zaiMissing.search.backend, undefined);
  assert.match(zaiMissing.search.unavailable ?? "", /ZAI_API_KEY/);

  const tavily = resolveWebTools({
    env: { TAVILY_API_KEY: "tvly-secret" },
    config: config({ search: { backend: "tavily" } }),
  });
  assert.equal(tavily.search.backend?.id, "tavily");
  const tavilyMissing = resolveWebTools({
    env: {},
    config: config({ search: { backend: "tavily" } }),
  });
  assert.match(tavilyMissing.search.unavailable ?? "", /TAVILY_API_KEY/);
});

// web_search 的 DeepSeek 后端基址：设置里显式给了 baseUrl 以设置为准；没给时跟环境变量 DEEPSEEK_BASE_URL；都没有用官方地址。
// 用假 fetch 捕获实际请求的地址
test("DeepSeek 搜索后端的基址优先次序：设置 > 环境变量 DEEPSEEK_BASE_URL > 官方地址；非法环境变量装配即报错", async () => {
  const requestedUrl = async (
    env: Record<string, string | undefined>,
    section: WebSection | undefined
  ): Promise<string> => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    }) as typeof fetch;
    const tools = resolveWebTools({
      env: { DEEPSEEK_API_KEY: "sk-ds", ...env },
      config: section,
      searchFetch: fetchImpl,
    });
    await tools.search.backend?.search({ query: "q", maxResults: 5 });
    assert.equal(urls.length, 1);
    return urls[0] ?? "";
  };
  assert.equal(await requestedUrl({}, undefined), "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(
    await requestedUrl({ DEEPSEEK_BASE_URL: "http://127.0.0.1:9/ds" }, undefined),
    "http://127.0.0.1:9/ds/v1/messages"
  );
  assert.equal(
    await requestedUrl(
      { DEEPSEEK_BASE_URL: "http://127.0.0.1:9/ds" },
      config({ search: { deepseek: { baseUrl: "https://configured.example.com/a" } } })
    ),
    "https://configured.example.com/a/v1/messages"
  );
  assert.equal(
    await requestedUrl({ DEEPSEEK_BASE_URL: "" }, config({ search: { deepseek: { model: "m" } } })),
    "https://api.deepseek.com/anthropic/v1/messages"
  );
  assert.throws(
    () =>
      resolveWebTools({
        env: { DEEPSEEK_API_KEY: "sk-ds", DEEPSEEK_BASE_URL: "ftp://x" },
        config: undefined,
      }),
    /DEEPSEEK_BASE_URL/
  );
  // 设置里显式给了地址时，不看环境变量（非法值也不影响）
  assert.equal(
    await requestedUrl(
      { DEEPSEEK_BASE_URL: "ftp://x" },
      config({ search: { deepseek: { baseUrl: "https://configured.example.com/a" } } })
    ),
    "https://configured.example.com/a/v1/messages"
  );
});
