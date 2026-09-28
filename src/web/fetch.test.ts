// 抓取流水线（决策 289）：在本地假网站上抓——HTML 转正文（脚本样式不进正文、标题提取）、超大页面截断、非文本拒绝、
// HTTP 错误、同站跳转跟随、跨站跳转交回、超时。DNS 解析注入为公网地址，传输层把请求转到本地端口。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { type FetchLimits, fetchPage } from "./fetch.ts";
import type { Transport, UnsafeUrlError } from "./network.ts";

const PAGE_HTML = `<!doctype html>
<html><head><title> 示例 &amp; 标题 </title><style>body{color:red}</style>
<script>var STYLE_SCRIPT_MARKER = 1;</script></head>
<body><h1>正文标题</h1><p>第一段 <a href="/x">链接</a></p>
<img src="data:image/png;base64,AAAA" alt="示意图"><noscript>NOSCRIPT_MARKER</noscript>
<ul><li>甲</li><li>乙</li></ul><pre><code>const a = 1;</code></pre></body></html>`;

let server: Server;
let port: number;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    switch (url.pathname) {
      case "/page":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      case "/big":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(100_000));
        return;
      case "/bin":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3]));
        return;
      case "/json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "1.2.3" }));
        return;
      case "/missing":
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
        return;
      case "/same":
        res.writeHead(302, { location: "/page" });
        res.end();
        return;
      case "/cross":
        res.writeHead(302, { location: "https://elsewhere.example/landing" });
        res.end();
        return;
      case "/slow":
        // 永不回复：由超时收尾
        return;
      default:
        res.writeHead(500);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
// 传输层：把对假域名的请求转到本地端口，不跟随跳转（与钉址传输同语义）
const transport: Transport = async (url, _target, init) =>
  fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    method: init.method ?? "GET",
    headers: { ...(init.headers ?? {}), host: url.host },
    redirect: "manual",
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });

const limits: FetchLimits = { timeoutMs: 5_000, maxBytes: 1_000_000, maxChars: 500_000 };
const options = { limits, lookup, transport };

test("HTML 页面：标题取 <title>（解实体、去空白），正文为 Markdown；脚本、样式、noscript 不进正文；图片只留说明", async () => {
  const page = await fetchPage("https://site.example/page", options);
  assert.equal(page.kind, "page");
  if (page.kind !== "page") return;
  assert.equal(page.title, "示例 & 标题");
  assert.equal(page.finalUrl, "https://site.example/page");
  assert.match(page.content, /# 正文标题/);
  assert.match(page.content, /第一段 \[链接\]\(\/x\)/);
  assert.match(page.content, /\[图：示意图\]/);
  assert.match(page.content, /const a = 1;/);
  assert.doesNotMatch(page.content, /STYLE_SCRIPT_MARKER|color:red|NOSCRIPT_MARKER|base64/);
  assert.equal(page.truncated, false);
});

test("超大页面截断：字节上限只读前 N 字节并标记；字符上限截正文并标记", async () => {
  const byBytes = await fetchPage("https://site.example/big", {
    ...options,
    limits: { ...limits, maxBytes: 1_000 },
  });
  assert.equal(byBytes.kind, "page");
  if (byBytes.kind === "page") {
    assert.equal(byBytes.bytes, 1_000);
    assert.equal(byBytes.content.length, 1_000);
    assert.equal(byBytes.truncated, true);
  }
  const byChars = await fetchPage("https://site.example/big", {
    ...options,
    limits: { ...limits, maxChars: 50 },
  });
  assert.equal(byChars.kind, "page");
  if (byChars.kind === "page") {
    assert.equal(byChars.bytes, 100_000);
    assert.equal(byChars.content.length, 50);
    assert.equal(byChars.truncated, true);
  }
});

test("非文本内容拒绝；HTTP 错误状态报错；JSON 原样交回", async () => {
  await assert.rejects(fetchPage("https://site.example/bin", options), /不是文本内容/);
  await assert.rejects(fetchPage("https://site.example/missing", options), /HTTP 404/);
  const json = await fetchPage("https://site.example/json", options);
  assert.equal(json.kind, "page");
  if (json.kind === "page") {
    assert.equal(json.content, '{"version":"1.2.3"}');
    assert.equal(json.title, "https://site.example/json");
  }
});

test("同站跳转跟随（最终网址为跳转后的）；跨站跳转不跟随，交回目标网站", async () => {
  const same = await fetchPage("https://site.example/same", options);
  assert.equal(same.kind, "page");
  if (same.kind === "page") {
    assert.equal(same.url, "https://site.example/same");
    assert.equal(same.finalUrl, "https://site.example/page");
  }
  const cross = await fetchPage("https://site.example/cross", options);
  assert.deepEqual(cross, {
    kind: "cross-host-redirect",
    from: "https://site.example/cross",
    to: "https://elsewhere.example/landing",
    toHost: "elsewhere.example",
  });
});

test("超时：网站不回应即按超时中止", async () => {
  await assert.rejects(
    fetchPage("https://site.example/slow", { ...options, limits: { ...limits, timeoutMs: 200 } }),
    (error: unknown) => error instanceof Error && /Timeout|abort/i.test(error.name)
  );
});

test("内网地址在抓取之前就被拒绝，不发请求", async () => {
  let called = 0;
  const counting: Transport = async (...args) => {
    called += 1;
    return transport(...args);
  };
  await assert.rejects(
    fetchPage("http://127.0.0.1/page", { ...options, transport: counting }),
    (error: unknown) => (error as UnsafeUrlError).message.includes("只能访问公网")
  );
  assert.equal(called, 0);
});
