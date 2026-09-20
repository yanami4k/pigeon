// 回放执行体（M8 S3 / S5 / S7，决策 082 / 083 / 087）：预算与模型沿用被验证那次尝试且不得放宽；
// 验证器的命令档工具只在固化命令规则内放行；回放单设并发闸。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_TOOLS } from "../orchestration/roles.ts";
import { DEFAULT_WORKER_LIMITS } from "../orchestration/workers.ts";
import type { AttemptBudget } from "../state/attempt-config.ts";
import {
  BudgetWidenedError,
  createRerunGate,
  DEFAULT_RERUN_CONCURRENCY,
  effectiveLimits,
  RerunNameError,
  rerunWorkerName,
  verifierParentPolicy,
} from "./rerun.ts";

test("预算：沿用被验证那次尝试的上限，逐项照搬", () => {
  const budget: AttemptBudget = { maxTurns: 7, wallClockMs: 60_000, maxTokens: 9000 };
  assert.deepEqual(effectiveLimits(budget), budget);
});

test("预算：尝试没设某项上限时按编排缺省收紧，不放宽", () => {
  const limits = effectiveLimits({ maxTurns: 3 });
  assert.equal(limits.maxTurns, 3);
  assert.equal(limits.wallClockMs, DEFAULT_WORKER_LIMITS.wallClockMs, "未设墙钟按缺省收紧");
  assert.equal(limits.maxTokens, undefined);
});

test("预算：任何一项放宽都被拒绝——这条是回放结论成立的前提", () => {
  const budget: AttemptBudget = { maxTurns: 7, wallClockMs: 60_000, maxTokens: 9000 };
  for (const widened of [
    { ...effectiveLimits(budget), maxTurns: 8 },
    { ...effectiveLimits(budget), wallClockMs: 60_001 },
    { ...effectiveLimits(budget), maxTokens: 9001 },
  ]) {
    assert.throws(() => effectiveLimits(budget, widened), BudgetWidenedError);
  }
  // 收紧允许：回放拿到的资源少于原尝试，结论只会偏保守
  assert.deepEqual(
    effectiveLimits(budget, { ...effectiveLimits(budget), maxTurns: 6 }).maxTurns,
    6
  );
});

test("预算：原尝试某项不设限时，回放给该项设限属收紧，放开成不设限属放宽", () => {
  assert.equal(
    effectiveLimits({ maxTurns: 3 }, { maxTurns: 3, wallClockMs: 1000 }).wallClockMs,
    1000
  );
  assert.throws(
    () => effectiveLimits({ maxTurns: 3, maxTokens: 100 }, { maxTurns: 3, wallClockMs: 1000 }),
    BudgetWidenedError
  );
});

test("权限形态：验证器拿写代码那一组工具，命令档工具靠角色清单收口", () => {
  assert.deepEqual([...ROLE_TOOLS.verifier].sort(), ["edit_file", "read_file", "run_command"]);
  const policy = verifierParentPolicy("yolo");
  assert.deepEqual(policy.deny, []);
  assert.equal(policy.approvalMode, "yolo", "审批模式沿用被验证那次尝试");
  for (const tool of ROLE_TOOLS.verifier) {
    assert.ok(policy.allow.includes(tool));
  }
});

test("权限形态：原尝试没有的工具，回放也不给——工具多一件与预算多一点是同一类失效", () => {
  const narrowed = verifierParentPolicy("yolo", ["read_file", "edit_file"]);
  assert.deepEqual([...narrowed.allow].sort(), ["edit_file", "read_file"]);
  // 原尝试有而验证器上限没有的工具，不会被带进来
  const widened = verifierParentPolicy("prompt", ["read_file", "edit_file", "run_command", "x"]);
  assert.deepEqual([...widened.allow].sort(), ["edit_file", "read_file", "run_command"]);
  assert.deepEqual(verifierParentPolicy("prompt", []).allow, []);
});

test("工作树名：种子不是十六进制哈希时响亮失败——四组必须共用候选哈希这一个种子", () => {
  assert.throws(
    () => rerunWorkerName("run_01M2XBMFN7GEH6WTR3Z57JQ102", "failed-baseline", 1),
    RerunNameError
  );
  assert.throws(() => rerunWorkerName("abc", "failed-with", 1), RerunNameError);
});

test("工作树名：合法且四组各不相同", () => {
  const names = new Set<string>();
  for (const arm of [
    "failed-baseline",
    "failed-with",
    "successful-baseline",
    "successful-with",
  ] as const) {
    for (const index of [1, 5]) {
      const name = rerunWorkerName("a".repeat(64), arm, index);
      assert.match(name, /^[a-z0-9][a-z0-9-]{0,39}$/);
      names.add(name);
    }
  }
  assert.equal(names.size, 8);
});

test("并发闸：回放单设一道闸，缺省 1", () => {
  assert.equal(DEFAULT_RERUN_CONCURRENCY, 1);
  const gate = createRerunGate();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false, "缺省同时只跑一个回放");
  gate.release();
  assert.equal(gate.tryAcquire(), true);
  const wider = createRerunGate(2);
  assert.equal(wider.tryAcquire(), true);
  assert.equal(wider.tryAcquire(), true);
  assert.equal(wider.tryAcquire(), false);
});
