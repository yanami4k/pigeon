// tester 角色（M5.5 S5，决策 048）：只读 + run_command，且只在父策略允许时拿得到——子集构造不因角色扩权。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPolicySubset, deriveWorkerPolicy } from "./roles.ts";

test("tester 角色：父策略允许时拿到 read_file 与 run_command；父策略没有 run_command 时拿不到", () => {
  const full = {
    allow: ["read_file", "edit_file", "run_command"],
    deny: [],
    approvalMode: "prompt" as const,
  };
  const tester = deriveWorkerPolicy(full, "tester");
  assert.deepEqual(tester.allow, ["read_file", "run_command"]);
  assert.doesNotThrow(() => assertPolicySubset(tester, full));

  const noExec = { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" as const };
  assert.deepEqual(deriveWorkerPolicy(noExec, "tester").allow, ["read_file"]);

  const denied = {
    allow: ["read_file", "run_command"],
    deny: ["run_command"],
    approvalMode: "yolo" as const,
  };
  assert.deepEqual(deriveWorkerPolicy(denied, "tester").allow, ["read_file"]);
});
