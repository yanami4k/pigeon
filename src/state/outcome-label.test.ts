// 五个标签由会话现算（M7 S1，决策 072）：成功只认验证通过，验证结论压过运行终态；撞上限与熔断算失败；
// 人主动取消算放弃；基础设施错误取失败分类；缺运行结束、有悬账、验证未判定、无验证且正常完成一律未知。
// 纯函数，不落盘。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AttemptOutcomeFacts, labelAttempt } from "./outcome-label.ts";

const NORMAL: AttemptOutcomeFacts = {
  hasRunEnded: true,
  pendingCount: 0,
  failure: null,
  limitHit: false,
};

test("验证通过压过运行失败：业务失败、人主动取消、基础设施错误、撞上限的尝试验证通过都算成功", () => {
  assert.equal(labelAttempt({ ...NORMAL, verdict: "pass" }), "Passed");
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "business" }, verdict: "pass" }),
    "Passed"
  );
  assert.equal(
    labelAttempt({
      ...NORMAL,
      failure: { category: "cancelled", breaker: false },
      verdict: "pass",
    }),
    "Passed"
  );
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "infrastructure" }, verdict: "pass" }),
    "Passed"
  );
  assert.equal(
    labelAttempt({
      ...NORMAL,
      failure: { category: "cancelled", breaker: false },
      limitHit: true,
      verdict: "pass",
    }),
    "Passed"
  );
});

test("验证失败算失败，正常完成也一样", () => {
  assert.equal(labelAttempt({ ...NORMAL, verdict: "fail" }), "Failed");
});

test("撞上限算失败（上限中止在运行终态上表现为中止，不得落成放弃）", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false }, limitHit: true }),
    "Failed"
  );
});

test("熔断算失败，不算放弃", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: true } }),
    "Failed"
  );
});

test("人主动取消算放弃", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false } }),
    "Abandoned"
  );
});

test("无验证时：业务失败算失败，基础设施错误单列", () => {
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "business" } }), "Failed");
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "infrastructure" } }),
    "InfrastructureError"
  );
});

test("缺 run.ended 或有悬账算未知（即使验证通过也不下确定性结论）", () => {
  assert.equal(labelAttempt({ ...NORMAL, hasRunEnded: false }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, hasRunEnded: false, verdict: "pass" }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1 }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1, verdict: "fail" }), "Unknown");
});

test("无验证但正常完成算未知；验证未判定算未知；分类为未知的仍是未知", () => {
  assert.equal(labelAttempt(NORMAL), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, verdict: "undetermined" }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "unknown" } }), "Unknown");
});
