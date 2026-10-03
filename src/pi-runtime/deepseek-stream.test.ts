import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { loadStreamFn } from "../application/runtime.ts";
import { DEEPSEEK_ANTHROPIC_BASE_URL, deepseekModel } from "./deepseek-model.ts";
import {
  createDeepSeekStreamFn,
  DEEPSEEK_BASE_URL_ENV,
  resolveDeepSeekBaseUrl,
} from "./deepseek-stream.ts";
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

test("日常 DeepSeek 接入：忽略 CLI 的占位模型，发出与网关同一份模型对象（deepseek-flash、anthropic-messages、reasoning 为真、1M 窗口、输出上限 16384）；key 取自环境变量", async () => {
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
    maxTokens: 16_384,
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
