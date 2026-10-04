// 不带工具的单次补全（决策 289 的提炼请求）：请求里没有工具、温度与输出上限按给定值下发；取回文本、用量与停止原因；
// 流以错误收尾即报错。
import assert from "node:assert/strict";
import { test } from "vitest";
import { CompletionError, completeWithoutTools } from "./complete.ts";
import { createFakeStreamFn } from "./fixtures.ts";

const model = {
  id: "m",
  name: "m",
  api: "unknown" as const,
  provider: "p",
  baseUrl: "",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

test("提炼请求不带任何工具；温度 0 与输出上限按给定值下发；系统提示与用户正文原样；取回文本与用量", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "提炼结果", contextTokens: 321 }] });
  const outcome = await completeWithoutTools(streamFn, model, {
    systemPrompt: "系统提示",
    userText: "问题与正文",
    maxTokens: 512,
    temperature: 0,
  });
  assert.equal(outcome.text, "提炼结果");
  assert.equal(outcome.stopReason, "stop");
  assert.equal(outcome.usage.totalTokens, 321);
  const call = streamFn.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.context.tools, undefined, "不带任何工具");
  assert.equal(call.context.systemPrompt, "系统提示");
  assert.equal(call.context.messages.length, 1);
  assert.equal(call.context.messages[0]?.role, "user");
  assert.equal(call.options?.temperature, 0);
  assert.equal(call.options?.maxTokens, 512);
  assert.equal(call.options?.reasoning, undefined, "不请求推理");
});

test("撞输出上限时停止原因为 length；流以错误收尾即报错", async () => {
  const capped = createFakeStreamFn({ replies: [{ text: "半截", stopReason: "length" }] });
  const outcome = await completeWithoutTools(capped, model, {
    systemPrompt: "s",
    userText: "u",
    maxTokens: 8,
    temperature: 0,
  });
  assert.equal(outcome.stopReason, "length");
  const failing = createFakeStreamFn({ replies: [{ text: "", streamError: "服务端 503" }] });
  await assert.rejects(
    completeWithoutTools(failing, model, {
      systemPrompt: "s",
      userText: "u",
      maxTokens: 8,
      temperature: 0,
    }),
    (error: unknown) => error instanceof CompletionError && /503/.test(error.message)
  );
});
