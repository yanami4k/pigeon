// exec 精确命令放权（M5.5 S5，决策 048）：命令串一模一样才命中——前缀、追加参数、改参数、
// 多空格、非命令调用、别的工具一律不命中；固化规则同一判定。
import assert from "node:assert/strict";
import { test } from "vitest";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { matchConfigGrants, scopeMatches } from "./grants.ts";

test("精确命令放权：一模一样才命中，前缀与改动参数一律回落人工审批", () => {
  const match = (args: unknown, tool = "run_command") =>
    scopeMatches(undefined, "run_command", undefined, tool, args, "npm test");
  assert.equal(match({ command: "npm test" }), true);
  assert.equal(match({ command: "npm test --watch" }), false);
  assert.equal(match({ command: "npm tes" }), false);
  assert.equal(match({ command: "npm  test" }), false);
  assert.equal(match({ command: "npm test && rm -rf /" }), false);
  assert.equal(match({ path: "npm test" }), false);
  assert.equal(match({}), false);
  assert.equal(match({ command: "npm test" }, "edit_file"), false);
  // 不带 command 的工具级放权照旧（非 exec 档语义不变）
  assert.equal(scopeMatches(undefined, "read_file", undefined, "read_file", { path: "a" }), true);
});

test("固化规则的精确命令同一判定", () => {
  const rule = {
    tool: "run_command",
    command: "node --test",
    promotedFrom: {
      grantId: newGrantId(),
      sessionId: newSessionId(),
      firstCall: { toolCallId: "toolu_1", args: { command: "node --test" } },
      promotedAt: 1,
    },
  };
  assert.deepEqual(
    matchConfigGrants([rule], undefined, "run_command", { command: "node --test" }),
    {
      source: "config-rule",
      refId: rule.promotedFrom.grantId,
    }
  );
  assert.equal(
    matchConfigGrants([rule], undefined, "run_command", { command: "node --test src/a.test.ts" }),
    null
  );
});
