import assert from "node:assert/strict";
import { test } from "vitest";
import { deterministicErrorOf, isContentRefusal } from "./stream-errors.ts";

test("内容审核类拒答：只认审核文案；连接中断、限额与缺省都不算", () => {
  for (const [message, expected] of [
    ["The model refused to complete the request", true],
    ["Provider stopped with: sensitive", true],
    [
      '400 {"error":{"type":"content_filter","message":"The request was rejected because it was considered high risk"}}',
      true,
    ],
    // 各分支单独成立：只带"high risk"的也认
    ["The request was rejected because it was considered high risk", true],
    ["Connection error.", false],
    ['429 {"error":{"type":"rate_limit_error"}}', false],
    [undefined, false],
  ] as const) {
    assert.equal(isContentRefusal(message), expected, String(message));
  }
});

test("确定性错误：只认上游识别的上下文超长；限额、服务故障、拒答都不算", () => {
  for (const [text, expected] of [
    ["exceeded model token limit: 262144 (requested: 301234)", "context-overflow"],
    ["400 prompt is too long: 210000 tokens > 200000 maximum", "context-overflow"],
    ['400 {"error":{"code":"context_length_exceeded"}}', "context-overflow"],
    ["429 Too many requests: too many tokens per minute", undefined],
    ["Rate limit reached: token limit exceeded for this minute", undefined],
    ["Request timed out.", undefined],
    ["Connection error.", undefined],
    ["The model refused to complete the request", undefined],
    [undefined, undefined],
  ] as const) {
    assert.equal(deterministicErrorOf(text), expected, String(text));
  }
});
