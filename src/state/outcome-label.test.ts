// 五个标签由会话现算（M7 S1，决策 072；322 修订）：验证门删除后，新会话不再有"通过"——正常做完记未知；
// 撞上限、熔断与打转叫停算失败；人主动取消算放弃；基础设施错误单列；业务失败算失败；
// 缺运行结束或有悬账一律未知。旧会话的验证记录照常参与现算（verdict 分支只为旧会话保留）。
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

test("决策 322：正常做完记未知——没有验证结论时正常完成不再是成功", () => {
  assert.equal(labelAttempt(NORMAL), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "unknown" } }), "Unknown");
});

test("旧会话的验证结论照常贴标签（压过运行终态）：通过即成功、失败即失败、未判定即未知", () => {
  assert.equal(labelAttempt({ ...NORMAL, verdict: "pass" }), "Passed");
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "business" }, verdict: "pass" }),
    "Passed"
  );
  assert.equal(labelAttempt({ ...NORMAL, verdict: "fail" }), "Failed");
  assert.equal(labelAttempt({ ...NORMAL, verdict: "undetermined" }), "Unknown");
});

test("打转叫停算失败（验证结论也不压过它）", () => {
  assert.equal(labelAttempt({ ...NORMAL, looping: true }), "Failed");
  assert.equal(labelAttempt({ ...NORMAL, looping: true, verdict: "pass" }), "Failed");
});

test("撞上限算失败（上限中止在运行终态上表现为中止，不得落成放弃）", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false }, limitHit: true }),
    "Failed"
  );
});

test("熔断算失败，不算放弃；人主动取消算放弃", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: true } }),
    "Failed"
  );
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false } }),
    "Abandoned"
  );
});

test("基础设施错误单列；业务失败算失败", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "infrastructure" } }),
    "InfrastructureError"
  );
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "business" } }), "Failed");
});

test("证据不完整一律未知：缺运行结束、有悬账", () => {
  assert.equal(labelAttempt({ ...NORMAL, hasRunEnded: false }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1 }), "Unknown");
  // 证据不完整压过旧会话的验证结论
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1, verdict: "pass" }), "Unknown");
});
