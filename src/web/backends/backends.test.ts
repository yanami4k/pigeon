// 三家搜索后端（决策 288）：用本地假服务核对请求形状（路径、鉴权头、正文）与结果整理；报错文字带状态码、不带 key。
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createAnthropicSearchBackend } from "./anthropic-search.ts";
import { createTavilySearchBackend } from "./tavily.ts";
import { createZaiSearchBackend } from "./zai.ts";

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const KEY = "sk-super-secret-key-value";
let server: Server;
let base: string;
const seen: Seen[] = [];
let failNext: number | undefined;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      if (failNext !== undefined) {
        const status = failNext;
        failNext = undefined;
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(`denied ${KEY.slice(0, 3)}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/v1/messages") === true) {
        res.end(
          JSON.stringify({
            content: [
              { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
              {
                type: "web_search_tool_result",
                tool_use_id: "s1",
                content: [
                  { type: "web_search_result", url: "https://a.example/1", title: "A1" },
                  { type: "web_search_result", url: "https://a.example/2", title: "A2" },
                  { type: "web_search_result", url: "https://a.example/3", title: "A3" },
                ],
              },
              {
                type: "text",
                text: "答案文本",
                citations: [{ url: "https://a.example/2", title: "A2", cited_text: "引用片段" }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          })
        );
        return;
      }
      if (req.url === "/api/paas/v4/web_search") {
        res.end(
          JSON.stringify({
            search_result: [
              { title: "智谱一", link: "https://z.example/1", content: "内容一" },
              { title: "智谱二", link: "https://z.example/2", content: "内容二" },
            ],
          })
        );
        return;
      }
      if (req.url === "/search") {
        res.end(
          JSON.stringify({
            query: "q",
            answer: "Tavily 答案",
            results: [{ title: "T1", url: "https://t.example/1", content: "片段" }],
          })
        );
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Anthropic 协议后端：请求发到 <baseUrl>/v1/messages，带 x-api-key 与服务端 web_search 工具；引用过的结果排前并带原文片段，其余搜索结果补后；条数截断；用量记下", async () => {
  seen.length = 0;
  const backend = createAnthropicSearchBackend({
    id: "deepseek",
    baseUrl: `${base}/anthropic/`,
    apiKey: KEY,
    model: "deepseek-flash",
    timeoutMs: 5_000,
  });
  const response = await backend.search({ query: "pigeon", maxResults: 2 });
  const request = seen[0];
  assert.equal(request?.method, "POST");
  assert.equal(request?.path, "/anthropic/v1/messages");
  assert.equal(request?.headers["x-api-key"], KEY);
  assert.equal(request?.headers["anthropic-version"], "2023-06-01");
  const body = request?.body as { model: string; tools: { type: string; name: string }[] };
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.tools[0], { type: "web_search_20250305", name: "web_search", max_uses: 3 });
  assert.equal(response.backend, "deepseek");
  assert.equal(response.answer, "答案文本");
  assert.deepEqual(response.results, [
    { title: "A2", url: "https://a.example/2", snippet: "引用片段" },
    { title: "A1", url: "https://a.example/1", snippet: "" },
  ]);
  assert.deepEqual(response.usage, {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("智谱后端：请求发到 /api/paas/v4/web_search，Bearer 鉴权，正文带查询词与条数；结果 link 映射为链接", async () => {
  seen.length = 0;
  const backend = createZaiSearchBackend({ baseUrl: base, apiKey: KEY, timeoutMs: 5_000 });
  const response = await backend.search({ query: "智谱", maxResults: 5 });
  assert.equal(seen[0]?.path, "/api/paas/v4/web_search");
  assert.equal(seen[0]?.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(seen[0]?.body, {
    search_engine: "search-prime",
    search_query: "智谱",
    count: 5,
  });
  assert.equal(response.backend, "zai");
  assert.equal(response.answer, undefined);
  assert.deepEqual(response.results, [
    { title: "智谱一", url: "https://z.example/1", snippet: "内容一" },
    { title: "智谱二", url: "https://z.example/2", snippet: "内容二" },
  ]);
});

test("Tavily 后端：请求发到 /search，Bearer 鉴权，正文带条数并要答案；答案与结果一并交回", async () => {
  seen.length = 0;
  const backend = createTavilySearchBackend({ baseUrl: base, apiKey: KEY, timeoutMs: 5_000 });
  const response = await backend.search({ query: "tavily", maxResults: 4 });
  assert.equal(seen[0]?.path, "/search");
  assert.equal(seen[0]?.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(seen[0]?.body, { query: "tavily", max_results: 4, include_answer: true });
  assert.equal(response.answer, "Tavily 答案");
  assert.deepEqual(response.results, [
    { title: "T1", url: "https://t.example/1", snippet: "片段" },
  ]);
});

test("后端报错：HTTP 状态进报错文字，响应正文只截取片段；报错文字里没有 key", async () => {
  for (const backend of [
    createAnthropicSearchBackend({
      id: "deepseek",
      baseUrl: base,
      apiKey: KEY,
      model: "m",
      timeoutMs: 5_000,
    }),
    createZaiSearchBackend({ baseUrl: base, apiKey: KEY, timeoutMs: 5_000 }),
    createTavilySearchBackend({ baseUrl: base, apiKey: KEY, timeoutMs: 5_000 }),
  ]) {
    failNext = 401;
    await assert.rejects(backend.search({ query: "x", maxResults: 1 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(KEY), error.message);
      return true;
    });
  }
});
