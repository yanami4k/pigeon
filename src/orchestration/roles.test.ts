// worker 委派策略（M5.5 S2，决策 040）：allow 只缩、deny 只增、审批模式不升级；子集校验拒绝扩权。
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import { assertPolicySubset, deriveWorkerPolicy, WorkerPolicyError } from "./roles.ts";

const FULL = ["read_file", "edit_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL];

test("委派策略：父策略齐全时按角色给默认工具，审批模式继承", () => {
  const parent = { allow: FULL, deny: [], approvalMode: "prompt" as const };
  assert.deepEqual(deriveWorkerPolicy(parent, "implementer"), {
    allow: ["read_file", "edit_file"],
    deny: [],
    approvalMode: "prompt",
  });
  assert.deepEqual(deriveWorkerPolicy(parent, "reviewer").allow, [
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
  ]);
  assert.deepEqual(deriveWorkerPolicy(parent, "explorer").allow, [
    "read_file",
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
  ]);
});

test("委派策略：父策略没有的工具角色拿不到；父 deny 原样继承并剔除出 allow", () => {
  const readOnlyParent = { allow: ["read_file"], deny: [], approvalMode: "yolo" as const };
  const implementer = deriveWorkerPolicy(readOnlyParent, "implementer");
  assert.deepEqual(implementer.allow, ["read_file"]);
  assert.equal(implementer.approvalMode, "yolo");

  const denyingParent = { allow: FULL, deny: ["edit_file"], approvalMode: "prompt" as const };
  const denied = deriveWorkerPolicy(denyingParent, "implementer");
  assert.deepEqual(denied.allow, ["read_file"]);
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
