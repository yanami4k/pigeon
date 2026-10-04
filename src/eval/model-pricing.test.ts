import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CN_ADJUSTED_WORKDAYS,
  CN_PUBLIC_HOLIDAYS,
  isPeakAt,
  PEAK_MULTIPLIER,
  PRICE_CNY_PER_MTOK,
  requestCostCny,
} from "../state/model-pricing.ts";

// 北京时间的时刻（UTC+8，无夏令时）
const bj = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);

test("价目：命中 ¥0.02、未命中 ¥1、输出 ¥4（每百万 token），高峰翻倍", () => {
  assert.deepEqual(PRICE_CNY_PER_MTOK, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
  assert.equal(PEAK_MULTIPLIER, 2);
});

test("高峰：北京时间工作日 9–12 时、14–18 时，左闭右开；其余为空闲", () => {
  // 2026-09-28 为周一
  const day = "2026-09-28";
  assert.equal(isPeakAt(bj(day, "08:59:59.999")), false);
  assert.equal(isPeakAt(bj(day, "09:00:00")), true);
  assert.equal(isPeakAt(bj(day, "11:59:59.999")), true);
  assert.equal(isPeakAt(bj(day, "12:00:00")), false);
  assert.equal(isPeakAt(bj(day, "13:59:59.999")), false);
  assert.equal(isPeakAt(bj(day, "14:00:00")), true);
  assert.equal(isPeakAt(bj(day, "17:59:59.999")), true);
  assert.equal(isPeakAt(bj(day, "18:00:00")), false);
  // 按北京时间判，不按宿主时区：UTC 01:00 即北京 9:00
  assert.equal(isPeakAt(Date.parse("2026-09-28T01:00:00Z")), true);
  assert.equal(isPeakAt(Date.parse("2026-09-28T00:59:59Z")), false);
});

test("周末全天空闲；法定节假日全天空闲（含落在周一至周五的）", () => {
  // 2026-10-03 周六、10-04 周日
  assert.equal(isPeakAt(bj("2026-10-03", "10:00:00")), false);
  assert.equal(isPeakAt(bj("2026-11-08", "10:00:00")), false);
  // 国庆 10-01（周四）至 10-07（周三）
  for (const d of ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]) {
    assert.equal(isPeakAt(bj(d, "10:00:00")), false, d);
  }
  // 中秋 09-25（周五）
  assert.equal(isPeakAt(bj("2026-09-25", "15:00:00")), false);
  // 节后第一个工作日照常
  assert.equal(isPeakAt(bj("2026-10-08", "10:00:00")), true);
});

test("调休上班的周末按工作日计：2026-09-20（周日）、10-10（周六）", () => {
  assert.equal(isPeakAt(bj("2026-09-20", "10:00:00")), true);
  assert.equal(isPeakAt(bj("2026-09-20", "13:00:00")), false);
  assert.equal(isPeakAt(bj("2026-10-10", "17:30:00")), true);
  assert.equal(isPeakAt(bj("2026-10-11", "10:00:00")), false);
});

test("节假日表按国办发明电〔2025〕7号录入全年：放假 33 天、调休上班 6 天，互不重叠", () => {
  assert.equal(CN_PUBLIC_HOLIDAYS.size, 33);
  assert.deepEqual(
    [...CN_ADJUSTED_WORKDAYS],
    ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]
  );
  for (const d of CN_ADJUSTED_WORKDAYS) assert.equal(CN_PUBLIC_HOLIDAYS.has(d), false, d);
  for (const d of ["2026-01-01", "2026-02-23", "2026-04-06", "2026-05-05", "2026-06-19"]) {
    assert.equal(CN_PUBLIC_HOLIDAYS.has(d), true, d);
  }
});

test("表外年份只按周一至周五判，不减节假日（宁多勿少）", () => {
  // 2027-01-01 为周五
  assert.equal(isPeakAt(bj("2027-01-01", "10:00:00")), true);
  assert.equal(isPeakAt(bj("2027-01-02", "10:00:00")), false);
});

test("花费：未命中 × 未命中价 + 命中 × 命中价 + 输出 × 输出价；缓存写入按未命中价计", () => {
  const idle = requestCostCny(
    { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 },
    bj("2026-09-28", "20:00:00"),
    bj("2026-09-28", "20:01:00")
  );
  assert.equal(idle.peak, false);
  assert.ok(Math.abs(idle.cny - 5.02) < 1e-9);
  const peak = requestCostCny(
    { input: 170, cacheRead: 1664, cacheWrite: 0, output: 30 },
    bj("2026-09-28", "10:00:00"),
    bj("2026-09-28", "10:00:05")
  );
  assert.equal(peak.peak, true);
  assert.ok(Math.abs(peak.cny - (170 * 1 + 1664 * 0.02 + 30 * 4) * 2e-6) < 1e-12);
  const write = requestCostCny(
    { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 },
    bj("2026-09-28", "20:00:00"),
    bj("2026-09-28", "20:00:01")
  );
  assert.ok(Math.abs(write.cny - 1) < 1e-9);
});

test("跨边界的请求：开始或结束任一落在高峰即整条按高峰价", () => {
  const usage = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
  // 开始在空闲、结束进入高峰
  const into = requestCostCny(usage, bj("2026-09-28", "08:59:30"), bj("2026-09-28", "09:00:10"));
  assert.equal(into.peak, true);
  assert.ok(Math.abs(into.cny - 2) < 1e-9);
  // 开始在高峰、结束已出高峰
  const out = requestCostCny(usage, bj("2026-09-28", "11:59:50"), bj("2026-09-28", "12:00:20"));
  assert.equal(out.peak, true);
  // 两头都在空闲
  const idle = requestCostCny(usage, bj("2026-09-28", "12:00:00"), bj("2026-09-28", "13:59:59"));
  assert.equal(idle.peak, false);
  assert.ok(Math.abs(idle.cny - 1) < 1e-9);
  // 跨入节假日：9-30（周三）17:59 开始、18:00 之后结束仍按高峰
  const eve = requestCostCny(usage, bj("2026-09-30", "17:59:59"), bj("2026-10-01", "00:00:01"));
  assert.equal(eve.peak, true);
});
