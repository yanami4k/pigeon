// 两件工具（决策 287–290）：web_fetch 只交回提炼结果、网页原文不出现在工具结果里，提炼收到问题与正文，用量记进 details；
// 跨站跳转交回目标而不提炼；inspectHost 给出主机名。web_search 走注入的后端，结果整理成标题、链接、摘要；后端不可用时报错。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, test } from "vitest";
import { TOOL_RESULT_USAGE_KEY } from "../state/tool-usage.ts";
import { type DistillInput, distillUserText } from "./distill.ts";
import type { Transport } from "./network.ts";
import type { SearchBackend, SearchParams } from "./search.ts";
import {
  createWebFetchTool,
  createWebSearchTool,
  WEB_FETCH_TEXTS,
  webFetchRegistration,
  webSearchRegistration,
} from "./tools.ts";

const RAW = "RAWPAGEMARKER不应出现在主对话";
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/doc") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><title>文档</title></head><body><h1>安装</h1><p>${RAW}</p></body></html>`
      );
      return;
    }
    if (req.url === "/long") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("长".repeat(5_000));
      return;
    }
    if (req.url === "/away") {
      res.writeHead(302, { location: "https://cdn.example/x" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const transport: Transport = async (url, _target, init) =>
  fetch(`http://127.0.0.1:${port}${url.pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.headers ?? {}), host: url.host },
    redirect: "manual",
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });
const limits = { timeoutMs: 5_000, maxBytes: 1_000_000, maxChars: 100_000 };
const usage = {
  input: 120,
  output: 30,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("web_fetch：网页原文只交给提炼，工具结果只有提炼结果；提炼收到问题、标题与正文；用量写进 details", async () => {
  const inputs: DistillInput[] = [];
  const tool = createWebFetchTool({
    limits,
    lookup,
    transport,
    distill: async (input) => {
      inputs.push(input);
      return { text: "提炼：安装步骤是 npm install", usage };
    },
  });
  const result = await tool.execute(
    "tc-1",
    { url: "https://docs.example/doc", prompt: "怎么安装" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  assert.doesNotMatch(text, new RegExp(RAW), "网页原文不进主对话");
  assert.match(text, /网页：文档/);
  assert.match(text, /网址：https:\/\/docs\.example\/doc/);
  assert.match(text, /提炼结果（针对：怎么安装）：\n提炼：安装步骤是 npm install/);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.prompt, "怎么安装");
  assert.equal(inputs[0]?.title, "文档");
  assert.match(inputs[0]?.content ?? "", new RegExp(RAW));
  assert.equal(inputs[0]?.truncated, false);
  assert.deepEqual(result.details[TOOL_RESULT_USAGE_KEY], usage);
  assert.equal(result.details.host, "docs.example");
  assert.equal(result.details.title, "文档");
  assert.equal(tool.inspectHost({ url: "HTTPS://Docs.Example/doc" }), "docs.example");
  assert.equal(tool.inspectHost({ url: "nope" }), undefined);
  assert.equal(tool.inspectHost({}), undefined);
});

test("web_fetch：跨站跳转交回目标网站，不提炼；提炼结果撞输出上限时注明", async () => {
  let distilled = 0;
  const tool = createWebFetchTool({
    limits,
    lookup,
    transport,
    distill: async () => {
      distilled += 1;
      return { text: "半截", outputTruncated: true };
    },
  });
  const redirect = await tool.execute(
    "tc-2",
    { url: "https://docs.example/away", prompt: "找什么" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  const text = redirect.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  assert.equal(
    text,
    WEB_FETCH_TEXTS.redirect("https://docs.example/away", "https://cdn.example/x", "cdn.example")
  );
  assert.equal(distilled, 0);
  assert.equal(redirect.details.redirectedTo, "https://cdn.example/x");

  const capped = await tool.execute(
    "tc-3",
    { url: "https://docs.example/doc", prompt: "找什么" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  const cappedText = capped.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.match(cappedText, /半截\n（提炼结果撞上输出上限/);
  assert.equal(capped.details.outputTruncated, true);
});

test("web_fetch：内网网址被拒绝，报错为域错误；注册为 network 档、不触碰文件系统", async () => {
  const tool = createWebFetchTool({
    limits,
    lookup,
    transport,
    distill: async () => ({ text: "" }),
  });
  await assert.rejects(
    tool.execute(
      "tc-4",
      { url: "http://10.0.0.8/admin", prompt: "x" },
      undefined as unknown as AbortSignal,
      () => {}
    ),
    /只能访问公网/
  );
  const registration = webFetchRegistration();
  assert.equal(registration.tier, "network");
  assert.deepEqual(registration.pathConfinement, { kind: "none" });
  assert.equal(webSearchRegistration().tier, "read");
});

test("web_search：查询词与条数交给后端（条数缺省取配置），结果整理为标题、链接、摘要，答案与用量一并交回", async () => {
  const seen: SearchParams[] = [];
  const backend: SearchBackend = {
    id: "fake",
    search: async (params) => {
      seen.push(params);
      return {
        backend: "fake",
        query: params.query,
        answer: "答案在此",
        results: [
          { title: "甲", url: "https://a.example/1", snippet: "摘要甲" },
          { title: "乙", url: "https://b.example/2", snippet: "" },
        ],
        usage,
      };
    },
  };
  const tool = createWebSearchTool({ backend, defaultMaxResults: 7 });
  const result = await tool.execute(
    "tc-5",
    { query: "pigeon harness" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  assert.deepEqual(seen, [{ query: "pigeon harness", maxResults: 7 }]);
  const text = result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(
    text,
    [
      "搜索：pigeon harness（后端 fake，2 条结果）",
      "答案：",
      "答案在此",
      "结果：",
      "1. 甲",
      "   https://a.example/1",
      "   摘要甲",
      "2. 乙",
      "   https://b.example/2",
    ].join("\n")
  );
  assert.deepEqual(result.details, {
    backend: "fake",
    query: "pigeon harness",
    results: 2,
    answered: true,
    [TOOL_RESULT_USAGE_KEY]: usage,
  });
  await tool.execute(
    "tc-6",
    { query: "x", maxResults: 3 },
    undefined as unknown as AbortSignal,
    () => {}
  );
  assert.equal(seen[1]?.maxResults, 3);
});

test("web_search：没有可用后端时按配置的说明报错（不带 key）", async () => {
  const tool = createWebSearchTool({
    unavailable: "搜索后端 deepseek 缺少 key：请设置环境变量 DEEPSEEK_API_KEY",
    defaultMaxResults: 5,
  });
  await assert.rejects(
    tool.execute("tc-7", { query: "x" }, undefined as unknown as AbortSignal, () => {}),
    /缺少 key：请设置环境变量 DEEPSEEK_API_KEY/
  );
});

test("web_fetch：正文超过字符上限时保留开头，提炼请求与交回结果都注明“原文过长，只看了前 X 字符”；未截断时都不注明", async () => {
  const inputs: DistillInput[] = [];
  const tool = createWebFetchTool({
    limits: { ...limits, maxChars: 1_200 },
    lookup,
    transport,
    distill: async (input) => {
      inputs.push(input);
      return { text: "提炼" };
    },
  });
  const result = await tool.execute(
    "tc-8",
    { url: "https://docs.example/long", prompt: "找什么" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  const text = result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(inputs[0]?.content.length, 1_200);
  assert.equal(inputs[0]?.truncated, true);
  assert.match(distillUserText(inputs[0] as DistillInput), /（原文过长，只看了前 1200 字符）/);
  assert.match(text, /（原文过长，只看了前 1200 字符）/);
  assert.equal(result.details.truncated, true);

  await tool.execute(
    "tc-9",
    { url: "https://docs.example/doc", prompt: "找什么" },
    undefined as unknown as AbortSignal,
    () => {}
  );
  assert.equal(inputs[1]?.truncated, false);
  assert.doesNotMatch(distillUserText(inputs[1] as DistillInput), /原文过长/);
});
