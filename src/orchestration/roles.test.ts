// worker 委派策略（M5.5 S2，决策 040）：allow 只缩、deny 只增、审批模式不升级；子集校验拒绝扩权。
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { WorkerRoleSchema } from "../state/session-payloads.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import {
  assertPolicySubset,
  deriveWorkerPolicy,
  isWorkerRole,
  WORKER_ROLES,
  WorkerPolicyError,
} from "./roles.ts";

const FULL = [
  "read_file",
  "edit_file",
  SEARCH_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  LIST_SESSIONS_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
];

test("委派策略：父策略齐全时按角色给默认工具，审批模式继承", () => {
  const parent = { allow: FULL, deny: [], approvalMode: "prompt" as const };
  // 决策 287–291：三种角色都带联网的两件工具（父策略里有才带）
  assert.deepEqual(deriveWorkerPolicy(parent, "implementer"), {
    allow: ["read_file", "edit_file", WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
    deny: [],
    approvalMode: "prompt",
  });
  assert.deepEqual(deriveWorkerPolicy(parent, "explorer").allow, [
    "read_file",
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
    LIST_SESSIONS_TOOL,
    WEB_SEARCH_TOOL,
    WEB_FETCH_TOOL,
  ]);
  assert.deepEqual(deriveWorkerPolicy(parent, "tester").allow, [
    "read_file",
    WEB_SEARCH_TOOL,
    WEB_FETCH_TOOL,
  ]);
  // tester 只在父策略允许时拿到 run_command（决策 048），子集构造不因角色扩权
  const withExec = {
    allow: ["read_file", "edit_file", "run_command"],
    deny: [],
    approvalMode: "prompt" as const,
  };
  const tester = deriveWorkerPolicy(withExec, "tester");
  assert.deepEqual(tester.allow, ["read_file", "run_command"]);
  assert.doesNotThrow(() => assertPolicySubset(tester, withExec));
  // 父策略里没有联网工具（沙箱断网档、跑批器各条件）时角色也不带
  const offline = { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" as const };
  assert.deepEqual(deriveWorkerPolicy(offline, "implementer").allow, ["read_file", "edit_file"]);
});

test("委派策略：父策略没有的工具角色拿不到；父 deny 原样继承并剔除出 allow", () => {
  const readOnlyParent = { allow: ["read_file"], deny: [], approvalMode: "yolo" as const };
  const implementer = deriveWorkerPolicy(readOnlyParent, "implementer");
  assert.deepEqual(implementer.allow, ["read_file"]);
  assert.equal(implementer.approvalMode, "yolo");

  const denyingParent = { allow: FULL, deny: ["edit_file"], approvalMode: "prompt" as const };
  const denied = deriveWorkerPolicy(denyingParent, "implementer");
  assert.deepEqual(denied.allow, ["read_file", WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
  assert.deepEqual(denied.deny, ["edit_file"]);
  assert.doesNotThrow(() => assertPolicySubset(denied, denyingParent));
});

test("子集校验：扩 allow、丢 deny、审批模式升级一律拒绝", () => {
  const parent = { allow: ["read_file"], deny: ["edit_file"], approvalMode: "prompt" as const };
  assert.throws(
    () =>
      assertPolicySubset(
        { allow: ["read_file", "edit_file"], deny: ["edit_file"], approvalMode: "prompt" },
        parent
      ),
    WorkerPolicyError
  );
  assert.throws(
    () => assertPolicySubset({ allow: ["read_file"], deny: [], approvalMode: "prompt" }, parent),
    WorkerPolicyError
  );
  assert.throws(
    () =>
      assertPolicySubset(
        { allow: ["read_file"], deny: ["edit_file"], approvalMode: "yolo" },
        parent
      ),
    WorkerPolicyError
  );
});

test("退役角色（决策 137 / 158）：reviewer、distiller、verifier 写入侧不再可派出，账本里的角色取值照常可读", () => {
  assert.deepEqual([...WORKER_ROLES], ["explorer", "implementer", "tester"]);
  for (const role of ["reviewer", "distiller", "verifier"]) {
    assert.equal(isWorkerRole(role), false, `${role} 不再可派出`);
    assert.ok(Value.Check(WorkerRoleSchema, role), `${role} 仍是账本里的合法取值`);
  }
});
