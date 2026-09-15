// 单轮输出上限包装（决策 063 第 1 件）：包装 streamFn，调用时把 maxTokens 传进选项——缺省 16,384；
// 传入的 model 带有效上限（大于 0）时取两者中更小的那个；调用方已传的其他选项原样保留。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createFakeStreamFn } from "./fixtures.ts";
import type { StreamFn } from "./index.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, limitOutputTokens } from "./output-limit.ts";

function recording() {
  const seen: Array<{ maxTokens: unknown; signal: unknown }> = [];
  const fake = createFakeStreamFn({ replies: [{ text: "好" }] });
  const streamFn: StreamFn = (model, context, options) => {
    seen.push({ maxTokens: options?.maxTokens, signal: options?.signal });
    return fake(model, context, options);
  };
  return { seen, streamFn };
}

const MODEL: Model<Api> = {
  id: "m",
  name: "m",
  api: "unknown",
  provider: "p",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

test("输出上限包装：缺省 16,384；配置值覆盖；model 上限更小时取更小值，model 上限为 0 时只用配置值；其他选项保留", async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 16_384);
  const context = { messages: [] };
  const signal = new AbortController().signal;

  const byDefault = recording();
  await limitOutputTokens(byDefault.streamFn, DEFAULT_MAX_OUTPUT_TOKENS)({ ...MODEL }, context, {
    signal,
  });
  assert.equal(byDefault.seen[0]?.maxTokens, 16_384);
  assert.equal(byDefault.seen[0]?.signal, signal);

  const configured = recording();
  await limitOutputTokens(configured.streamFn, 4096)({ ...MODEL }, context, {});
  assert.equal(configured.seen[0]?.maxTokens, 4096);

  const smallerModel = recording();
  await limitOutputTokens(smallerModel.streamFn, 16_384)(
    { ...MODEL, maxTokens: 8000 },
    context,
    {}
  );
  assert.equal(smallerModel.seen[0]?.maxTokens, 8000);

  const largerModel = recording();
  await limitOutputTokens(largerModel.streamFn, 16_384)(
    { ...MODEL, maxTokens: 32_768 },
    context,
    undefined
  );
  assert.equal(largerModel.seen[0]?.maxTokens, 16_384);
});
