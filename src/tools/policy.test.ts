import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
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

// M4 S6（决策 3）排律：deny 清单 → 会话 grant → 配置 grant → yolo → read 自动 → prompt。
// grant 出处由 adapter 的 grant 匹配注入（第 4 参），policy 层只负责排律位置与理由
test("排律：grant 命中压过 yolo / read 自动 / prompt，回指出场", () => {
  const registry = makeRegistry();
  const sessionHit = {
    source: "session-grant" as const,
    refId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
  };
  const configHit = { source: "config-rule" as const, refId: "config:grants.json#0" };

  // prompt 模式：write 层本需人工——grant 命中即免审
  const promptPolicy = makePolicy({ approvalMode: "prompt" });
  const granted = evaluateToolPolicy(registry, "edit_file", promptPolicy, sessionHit);
  assert.equal(granted.kind, "auto-allow");
  assert.deepEqual(granted.grant, sessionHit);
  assert.match(granted.reason, /会话放权/);

  // grant 压过 read 层自动放行（grant 出处优先于 policy:auto）
  const readGranted = evaluateToolPolicy(registry, "read_file", promptPolicy, configHit);
  assert.equal(readGranted.kind, "auto-allow");
  assert.deepEqual(readGranted.grant, configHit);
  assert.match(readGranted.reason, /固化规则/);

  // grant 压过 yolo（出处记 grant 而非 policy:yolo——可审计"凭什么没问人"）
  const yoloGranted = evaluateToolPolicy(
    registry,
    "run_tests",
    makePolicy({ approvalMode: "yolo" }),
    configHit
  );
  assert.equal(yoloGranted.kind, "auto-allow");
  assert.deepEqual(yoloGranted.grant, configHit);
});

test("排律：deny 清单绝对压过 grant（约束 1：grant 与配置规则均不豁免 deny）", () => {
  const registry = makeRegistry();
  const policy = makePolicy({ deny: ["edit_file"], approvalMode: "prompt" });
  const hit = { source: "session-grant" as const, refId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS" };
  const decision = evaluateToolPolicy(registry, "edit_file", policy, hit);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.grant, undefined);
});

test("排律：未注册工具 fail-closed 压过 grant（授权不扩大未注册面）", () => {
  const registry = makeRegistry();
  const hit = { source: "session-grant" as const, refId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS" };
  const decision = evaluateToolPolicy(registry, "rm_rf", makePolicy(), hit);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.grant, undefined);
});
