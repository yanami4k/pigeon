// 单轮输出上限（决策 063 第 1 件、347）：配置了上限时包装 streamFn，调用时把 maxTokens 传进选项；传入的 model 带有效上限
// （大于 0）时取两者中更小的那个；调用方已传的其他选项原样保留。看得到真实模型的接入共用 modelOutputLimit：模型没有上限时按
// 32,000 计，配置了取较小者，未配置不传。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createFakeStreamFn } from "./fixtures.ts";
import type { StreamFn } from "./index.ts";
import {
  FALLBACK_MODEL_MAX_TOKENS,
  limitOutputTokens,
  modelOutputLimit,
  withMaxTokens,
} from "./output-limit.ts";

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

test("输出上限包装：传入配置值；model 上限更小时取更小值，model 上限为 0 时只用配置值；其他选项保留", async () => {
  const context = { messages: [] };
  const signal = new AbortController().signal;

  const byDefault = recording();
  await limitOutputTokens(byDefault.streamFn, 16_384)({ ...MODEL }, context, {
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

test("modelOutputLimit：模型上限缺失或不为正时按 32,000 计；配置了取配置值与模型上限的较小者；未配置不给 maxTokens", () => {
  assert.equal(FALLBACK_MODEL_MAX_TOKENS, 32_000);
  for (const bad of [0, -1, Number.NaN, undefined as unknown as number]) {
    const limit = modelOutputLimit({ ...MODEL, maxTokens: bad }, undefined);
    assert.equal(limit.model.maxTokens, 32_000, String(bad));
    assert.equal("maxTokens" in limit, false);
    assert.equal(modelOutputLimit({ ...MODEL, maxTokens: bad }, 50_000).maxTokens, 32_000);
    assert.equal(modelOutputLimit({ ...MODEL, maxTokens: bad }, 4096).maxTokens, 4096);
  }
  const real = { ...MODEL, maxTokens: 393_216 };
  assert.equal(modelOutputLimit(real, undefined).model, real, "模型上限有效时原样交出模型对象");
  assert.equal(modelOutputLimit(real, undefined).maxTokens, undefined);
  assert.equal(modelOutputLimit(real, 4096).maxTokens, 4096);
  assert.equal(modelOutputLimit(real, 500_000).maxTokens, 393_216);
  assert.deepEqual(withMaxTokens({ maxTokens: 9, apiKey: "k" }, undefined), { apiKey: "k" });
  const keyOnly: { apiKey: string; maxTokens?: number } = { apiKey: "k" };
  assert.deepEqual(withMaxTokens(keyOnly, 7), { apiKey: "k", maxTokens: 7 });
});
