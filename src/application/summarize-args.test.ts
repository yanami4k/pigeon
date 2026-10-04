import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeArgs } from "./format.ts";

const EMOJI = "\u{1F600}";

// 不含孤立代理（按 UTF-16 码元匹配，不用 u 标志）
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test("切点落在代理对中间：少取一个码元，结果是合法 UTF-16", () => {
  // JSON：引号(0) + 158 个 a(1..158) + emoji(159..160) + 20 个 b + 引号，共 182
  const args = `${"a".repeat(158)}${EMOJI}${"b".repeat(20)}`;
  const summary = summarizeArgs(args);
  assert.equal(summary, `"${"a".repeat(158)}…（共 182 字符）`);
  assert.ok(wellFormed(summary));
});

test("连续 emoji：前缀停在最后一个完整字符", () => {
  const args = EMOJI.repeat(100);
  const summary = summarizeArgs(args);
  assert.equal(summary, `"${EMOJI.repeat(79)}…（共 202 字符）`);
  assert.ok(wellFormed(summary));
});

test("代理对完整落在前 160 个码元内：照常截到 160", () => {
  const args = `${"a".repeat(157)}${EMOJI}${"b".repeat(20)}`;
  const summary = summarizeArgs(args);
  assert.equal(summary, `"${"a".repeat(157)}${EMOJI}…（共 181 字符）`);
  assert.ok(wellFormed(summary));
});

test("不超过上限原样返回", () => {
  const exact = `${"a".repeat(156)}${EMOJI}`;
  assert.equal(JSON.stringify(exact).length, 160);
  assert.equal(summarizeArgs(exact), JSON.stringify(exact));
  assert.equal(summarizeArgs({ path: EMOJI }), JSON.stringify({ path: EMOJI }));
});

test("普通 ASCII 截断口径不变", () => {
  const args = "x".repeat(300);
  assert.equal(summarizeArgs(args), `"${"x".repeat(159)}…（共 302 字符）`);
});

test("不可序列化与 undefined 行为不变", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(summarizeArgs(circular), "<不可序列化参数>");
  assert.equal(summarizeArgs(undefined), "undefined");
});
