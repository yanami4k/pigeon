import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { evaluateToolPolicy, type ToolPolicyLike } from "./policy.ts";
import { ToolRegistry, type ToolRiskTier } from "./registry.ts";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tiers: Array<[string, ToolRiskTier]> = [
    ["read_file", "read"],
    ["edit_file", "write"],
    ["run_tests", "exec"],
  ];
  for (const [name, tier] of tiers) {
    registry.register({
      name,
      description: `${name} 测试占位`,
      parameters: Type.Object({}),
      tier,
      pathConfinement: { kind: "workspace" },
      executionMode: "parallel",
    });
  }
  return registry;
}

function makePolicy(overrides: Partial<ToolPolicyLike> = {}): ToolPolicyLike {
  return {
    allow: ["read_file", "edit_file", "run_tests"],
    deny: [],
    approvalMode: "prompt",
    ...overrides,
  };
}

test("deny 清单绝对：prompt 模式下精确匹配即拒（连 read 层也不豁免）", () => {
  const registry = makeRegistry();
  const policy = makePolicy({ deny: ["read_file"], approvalMode: "prompt" });
  const decision = evaluateToolPolicy(registry, "read_file", policy);
  assert.equal(decision.kind, "deny");
});

test("deny 清单绝对：yolo 模式不豁免", () => {
  const registry = makeRegistry();
  const policy = makePolicy({ deny: ["run_tests"], approvalMode: "yolo" });
  const decision = evaluateToolPolicy(registry, "run_tests", policy);
  assert.equal(decision.kind, "deny");
});

test("prompt 模式按风险分层：read 自动放行，write / exec 必须人工批准", () => {
  const registry = makeRegistry();
  const policy = makePolicy({ approvalMode: "prompt" });
  assert.equal(evaluateToolPolicy(registry, "read_file", policy).kind, "auto-allow");
  assert.equal(evaluateToolPolicy(registry, "edit_file", policy).kind, "prompt");
  assert.equal(evaluateToolPolicy(registry, "run_tests", policy).kind, "prompt");
});

test("yolo 模式：非 deny 全放行（人事先批发授权）", () => {
  const registry = makeRegistry();
  const policy = makePolicy({ approvalMode: "yolo" });
  assert.equal(evaluateToolPolicy(registry, "read_file", policy).kind, "auto-allow");
  assert.equal(evaluateToolPolicy(registry, "edit_file", policy).kind, "auto-allow");
  assert.equal(evaluateToolPolicy(registry, "run_tests", policy).kind, "auto-allow");
});

test("未注册工具一律 deny（fail-closed），两种模式同罪", () => {
  const registry = makeRegistry();
  for (const approvalMode of ["prompt", "yolo"] as const) {
    const decision = evaluateToolPolicy(registry, "rm_rf", makePolicy({ approvalMode }));
    assert.equal(decision.kind, "deny");
    assert.match(decision.reason, /未注册工具/);
  }
});

test("每次判定都带人读理由", () => {
  const registry = makeRegistry();
  for (const approvalMode of ["prompt", "yolo"] as const) {
    for (const name of ["read_file", "edit_file", "run_tests", "rm_rf"]) {
      const decision = evaluateToolPolicy(registry, name, makePolicy({ approvalMode }));
      assert.ok(decision.reason.length > 0, `${approvalMode}/${name} 缺理由`);
    }
  }
});
