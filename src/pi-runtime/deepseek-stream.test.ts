import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as realStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { loadStreamFn } from "../application/runtime.ts";
import { streamGatewayStreamFn } from "../eval/stream-experiment.ts";
import { DEEPSEEK_ANTHROPIC_BASE_URL, deepseekModel } from "./deepseek-model.ts";
import {
  createDeepSeekStreamFn,
  DEEPSEEK_BASE_URL_ENV,
  redactUserinfo,
  resolveDeepSeekBaseUrl,
} from "./deepseek-stream.ts";
import { gatewayStreamFn } from "./gateway-stream.ts";
import { limitOutputTokens } from "./output-limit.ts";
import { fixTemperature } from "./sampling.ts";

type Call = { model: Parameters<typeof streamSimple>[0]; options: Record<string, unknown> };

// 假的 streamSimple：记下发出的模型对象与选项
function fakeStream() {
  const calls: Call[] = [];
  const stream = ((model, _context, options) => {
    calls.push({ model, options: { ...(options ?? {}) } });
    return {} as ReturnType<typeof streamSimple>;
  }) as typeof streamSimple;
  return { calls, stream };
}

const context = { messages: [] } as never;
const placeholder = { id: "custom", provider: "custom", api: "unknown", baseUrl: "" } as never;

test("日常 DeepSeek 接入：缺 DEEPSEEK_API_KEY 即响亮报错；空值同样报错", () => {
  assert.throws(() => createDeepSeekStreamFn({}), /缺少 DEEPSEEK_API_KEY 环境变量/);
  assert.throws(() => createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "" }), /缺少 DEEPSEEK_API_KEY/);
});

test("日常 DeepSeek 接入：忽略 CLI 的占位模型，发出与网关同一份模型对象（deepseek-flash、anthropic-messages、reasoning 为真、1M 窗口、输出上限 393,216）；key 取自环境变量", async () => {
  const { calls, stream } = fakeStream();
  const fn = createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-daily" }, stream);
  await fn(placeholder, context, {});
  const sent = calls[0];
  assert.deepEqual(sent?.model, deepseekModel());
  assert.deepEqual(sent?.model, {
    id: "deepseek-flash",
    name: "deepseek-flash",
    api: "anthropic-messages",
    provider: "deepseek",
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  });
  assert.equal(DEEPSEEK_ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(sent?.options.apiKey, "sk-daily");
});

test("日常 DeepSeek 接入：思考档位按 Pigeon 的选项透传——未给（off）时不带 reasoning（pi-ai 据此发 thinking disabled），给了原样带上；温度与输出上限经 Pigeon 的包装传入", async () => {
  const { calls, stream } = fakeStream();
  const base = createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-daily" }, stream);
  // 与 buildRuntime 相同的包装顺序：温度在内、输出上限在外
  const wrapped: StreamFn = limitOutputTokens(fixTemperature(base, 0), 16_384);
  await wrapped(placeholder, context, {});
  assert.equal(calls[0]?.options.reasoning, undefined);
  assert.equal(calls[0]?.options.temperature, 0);
  assert.equal(calls[0]?.options.maxTokens, 16_384);
  await base(placeholder, context, { reasoning: "high" } as never);
  assert.equal(calls[1]?.options.reasoning, "high");
  assert.equal(calls[1]?.options.apiKey, "sk-daily");
});

test("日常 DeepSeek 接入入口：经 loadStreamFn 按文件路径加载得到函数；缺 key 时加载即报错（报错不含其他环境变量的值）", async () => {
  const entry = fileURLToPath(new URL("./deepseek-stream-fn.ts", import.meta.url));
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-entry";
  try {
    assert.equal(typeof (await loadStreamFn(entry)), "function");
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
  // 缺 key：另起进程加载（同一进程里模块只求值一次）
  const env: Record<string, string | undefined> = {
    ...process.env,
    OTHER_SECRET: "should-not-appear",
  };
  delete env.DEEPSEEK_API_KEY;
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)})`],
      { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
    );
    assert.fail("缺 key 时应当报错");
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? "");
  }
  assert.match(stderr, /缺少 DEEPSEEK_API_KEY 环境变量/);
  assert.doesNotMatch(stderr, /should-not-appear/);
});

// DeepSeek 端点根（环境变量 DEEPSEEK_BASE_URL）：给了就用它作 Anthropic 兼容端点的根，请求照旧拼 /v1/messages；
// 没给或为空用官方地址；不是 http/https 地址时启动即报错（报错里有地址，没有 key）
test("DEEPSEEK_BASE_URL：给了就用作模型基址；没给或为空用官方地址；非法值启动即报错", async () => {
  const sentBase = async (env: Record<string, string | undefined>) => {
    const { calls, stream } = fakeStream();
    const fn = createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-daily", ...env }, stream);
    await fn(placeholder, context, {});
    return calls[0]?.model.baseUrl;
  };
  assert.equal(await sentBase({}), DEEPSEEK_ANTHROPIC_BASE_URL);
  assert.equal(await sentBase({ DEEPSEEK_BASE_URL: "" }), DEEPSEEK_ANTHROPIC_BASE_URL);
  assert.equal(
    await sentBase({ DEEPSEEK_BASE_URL: "http://127.0.0.1:8080/anthropic" }),
    "http://127.0.0.1:8080/anthropic"
  );
  assert.equal(
    await sentBase({ DEEPSEEK_BASE_URL: "https://proxy.example.com/ds" }),
    "https://proxy.example.com/ds"
  );
  for (const bad of ["ftp://example.com/anthropic", "api.deepseek.com/anthropic", "not a url"]) {
    assert.throws(
      () => createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-secret-value", DEEPSEEK_BASE_URL: bad }),
      (error: Error) =>
        /DEEPSEEK_BASE_URL/.test(error.message) &&
        /http 或 https/.test(error.message) &&
        error.message.includes(bad) &&
        !error.message.includes("sk-secret-value"),
      bad
    );
  }
  assert.equal(resolveDeepSeekBaseUrl({}), DEEPSEEK_ANTHROPIC_BASE_URL);
  assert.equal(DEEPSEEK_BASE_URL_ENV, "DEEPSEEK_BASE_URL");
});

// 实际请求体：用真的 streamSimple，经调用选项注入假的 fetch，捕获发往端点的地址与请求体（不连任何真实接口）
async function captureRequest(
  fn: StreamFn,
  options: Record<string, unknown>,
  messages: unknown[] = []
): Promise<{ url: string; body: Record<string, unknown> }> {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "假上游" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const stream = await fn(
    placeholder,
    { messages } as never,
    {
      ...options,
      fetch: fakeFetch,
      maxRetries: 0,
    } as never
  );
  await stream.result();
  assert.ok(captured !== undefined, "应当发出一次请求");
  return captured;
}

// 一条约 70 万 token 的用户消息（pi-ai 按 4 字符一个 token 估算）：1M 窗口剩下的不到 393,216
const LONG_CONTEXT = [{ role: "user", content: "字".repeat(2_800_000), timestamp: 0 }];
const NARROWED = 1_000_000 - 700_000 - 4096;

test("单轮输出上限跟模型走（决策 347）：未配置时实际请求的 max_tokens 为 393,216，并随上下文收窄；开思考时同样", async () => {
  const fn = createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-daily" }, realStreamSimple);
  const plain = await captureRequest(fn, {});
  assert.equal(plain.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(plain.body.max_tokens, 393_216);
  const thinking = await captureRequest(fn, { reasoning: "high" });
  assert.equal(thinking.body.max_tokens, 393_216);
  const long = await captureRequest(fn, {}, LONG_CONTEXT);
  assert.equal(long.body.max_tokens, NARROWED);
  const longThinking = await captureRequest(fn, { reasoning: "high" }, LONG_CONTEXT);
  assert.equal(longThinking.body.max_tokens, NARROWED);
});

test("配置了单轮输出上限：实际请求取配置值与模型上限的较小者（经 Pigeon 的包装）", async () => {
  const fn = createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-daily" }, realStreamSimple);
  const small = await captureRequest(limitOutputTokens(fn, 4096), {});
  assert.equal(small.body.max_tokens, 4096);
  const large = await captureRequest(limitOutputTokens(fn, 500_000), {});
  assert.equal(large.body.max_tokens, 393_216);
});

test("DEEPSEEK_BASE_URL：实际请求发往给定的根拼 /v1/messages", async () => {
  const fn = createDeepSeekStreamFn(
    { DEEPSEEK_API_KEY: "sk-daily", DEEPSEEK_BASE_URL: "http://127.0.0.1:9/ds" },
    realStreamSimple
  );
  const sent = await captureRequest(fn, {});
  assert.equal(sent.url, "http://127.0.0.1:9/ds/v1/messages");
});

test("网关接入与自带接入共用取值：未配置按模型上限；跑批器给的模型上限（16,384）开思考时请求与改动前一致", async () => {
  const plain = await captureRequest(gatewayStreamFn("http://127.0.0.1:9/j/x"), {});
  assert.equal(plain.url, "http://127.0.0.1:9/j/x/v1/messages");
  assert.equal(plain.body.max_tokens, 393_216);
  const capped = gatewayStreamFn("http://127.0.0.1:9/j/x", "deepseek-flash", 16_384);
  const configured = await captureRequest(limitOutputTokens(capped, 16_384), {
    reasoning: "high",
  });
  assert.equal(configured.body.max_tokens, 16_384);
  const noThinking = await captureRequest(limitOutputTokens(capped, 16_384), {});
  assert.equal(noThinking.body.max_tokens, 16_384);
  // 模型对象没有上限时按 32,000 发
  const unbounded = gatewayStreamFn("http://127.0.0.1:9/j/x", "deepseek-flash", 0);
  assert.equal((await captureRequest(unbounded, {})).body.max_tokens, 32_000);
});

test("跑批器进程内条件的网关接入：没配置时以 16,384 作模型上限（开不开思考都发 16,384）；配置了 32,000 时原样发 32,000，不被压到 16,384", async () => {
  const url = "http://127.0.0.1:9/j/x";
  const unconfigured = limitOutputTokens(
    streamGatewayStreamFn(url, "deepseek-flash", undefined),
    16_384
  );
  assert.equal((await captureRequest(unconfigured, {})).body.max_tokens, 16_384);
  assert.equal((await captureRequest(unconfigured, { reasoning: "high" })).body.max_tokens, 16_384);
  const configured = limitOutputTokens(
    streamGatewayStreamFn(url, "deepseek-flash", 32_000),
    32_000
  );
  assert.equal((await captureRequest(configured, {})).body.max_tokens, 32_000);
});

test("DEEPSEEK_BASE_URL 非法时的报错：地址里的用户名与密码脱敏，其余照原样", () => {
  for (const [bad, shown, hidden] of [
    ["ftp://alice:s3cret@proxy.example.com/ds", "ftp://***@proxy.example.com/ds", "s3cret"],
    ["bob:hunter2@proxy.example.com/ds", "***@proxy.example.com/ds", "hunter2"],
    ["ftp://token-only@h/x", "ftp://***@h/x", "token-only"],
  ] as const) {
    assert.throws(
      () => createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-x", DEEPSEEK_BASE_URL: bad }),
      (error: Error) => error.message.includes(shown) && !error.message.includes(hidden),
      bad
    );
  }
  assert.equal(redactUserinfo("ftp://example.com/a"), "ftp://example.com/a");
  assert.equal(redactUserinfo("not a url"), "not a url");
});
