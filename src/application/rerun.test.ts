// 回放执行体（M8 S3 / S5 / S7，决策 082 / 083 / 087）：验证器的命令档工具只在固化命令规则内放行；回放单设并发闸。
// 预算、工具交集与推理档位的核对用例在 replay/fidelity.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_TOOLS } from "../orchestration/roles.ts";
import {
  createRerunGate,
  DEFAULT_RERUN_CONCURRENCY,
  RerunNameError,
  rerunWorkerName,
  verifierParentPolicy,
} from "./rerun.ts";

test("权限形态：验证器拿写代码那一组工具，命令档工具靠角色清单收口", () => {
  assert.deepEqual([...ROLE_TOOLS.verifier].sort(), ["edit_file", "read_file", "run_command"]);
  const policy = verifierParentPolicy("yolo");
  assert.deepEqual(policy.deny, []);
  assert.equal(policy.approvalMode, "yolo", "审批模式沿用被验证那次尝试");
  for (const tool of ROLE_TOOLS.verifier) {
    assert.ok(policy.allow.includes(tool));
  }
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
