import assert from "node:assert/strict";
import { test } from "node:test";
import * as format from "./format.ts";

type FormatDuration = (ms: number) => string;

function fn(): FormatDuration {
  const candidate = (format as Record<string, unknown>).formatDuration;
  assert.equal(typeof candidate, "function", "format.ts 应导出 formatDuration");
  return candidate as FormatDuration;
}

test("毫秒档", () => {
  const formatDuration = fn();
  assert.equal(formatDuration(0), "0 毫秒");
  assert.equal(formatDuration(7), "7 毫秒");
  assert.equal(formatDuration(999), "999 毫秒");
});

test("秒档：一位小数向下截断，零小数位保留", () => {
  const formatDuration = fn();
  assert.equal(formatDuration(1000), "1.0 秒");
  assert.equal(formatDuration(1500), "1.5 秒");
  assert.equal(formatDuration(2049), "2.0 秒");
  assert.equal(formatDuration(59_999), "59.9 秒");
});

test("分档：分与秒向下取整", () => {
  const formatDuration = fn();
  assert.equal(formatDuration(60_000), "1 分 0 秒");
  assert.equal(formatDuration(125_400), "2 分 5 秒");
  assert.equal(formatDuration(3_599_999), "59 分 59 秒");
});

test("小时档：舍去秒，小时不封顶", () => {
  const formatDuration = fn();
  assert.equal(formatDuration(3_600_000), "1 小时 0 分");
  assert.equal(formatDuration(7_384_000), "2 小时 3 分");
  assert.equal(formatDuration(90_000_000), "25 小时 0 分");
});

test("非整数先四舍五入，可跨档", () => {
  const formatDuration = fn();
  assert.equal(formatDuration(0.4), "0 毫秒");
  assert.equal(formatDuration(12.5), "13 毫秒");
  assert.equal(formatDuration(999.6), "1.0 秒");
});

test("负数与非有限数抛 RangeError", () => {
  const formatDuration = fn();
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => formatDuration(bad), RangeError, String(bad));
  }
});
