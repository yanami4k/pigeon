// 委派策略里的 MCP 工具（M5.7 S4）：implementer 继承父策略里的 MCP 工具（外部写工具照样逐次审批）；
// 其余角色不继承；父策略 deny 的 MCP 工具照样剔除，子集校验通过。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPolicySubset, deriveWorkerPolicy } from "./roles.ts";

test("委派策略：implementer 继承父策略里的 MCP 工具，其余角色不继承，父 deny 照样剔除", () => {
  const parent = {
    allow: ["read_file", "edit_file", "mcp__fs__write_file", "mcp__fs__read_text_file"],
    deny: ["mcp__fs__read_text_file"],
    approvalMode: "prompt" as const,
  };
  const implementer = deriveWorkerPolicy(parent, "implementer");
  assert.deepEqual(implementer.allow, ["read_file", "edit_file", "mcp__fs__write_file"]);
  assert.doesNotThrow(() => assertPolicySubset(implementer, parent));
  assert.deepEqual(deriveWorkerPolicy(parent, "explorer").allow, ["read_file"]);
  assert.deepEqual(deriveWorkerPolicy(parent, "reviewer").allow, []);
  assert.deepEqual(deriveWorkerPolicy(parent, "tester").allow, ["read_file"]);
});
