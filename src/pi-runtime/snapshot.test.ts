import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { MigrationRegistry } from "../state/migration.ts";
import {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
  migrateInjectionSnapshotV1toV2,
} from "./snapshot.ts";

// v2 快照工厂：ToolPolicy 增加 approvalMode（M3 决策 4）
function makeSnapshotV2(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1_700_000_000_000,
  };
}

test("v2 快照（含 approvalMode）JSON 往返后校验通过", () => {
  const snapshot = makeSnapshotV2();
  const revived: unknown = JSON.parse(JSON.stringify(snapshot));
  assert.ok(Value.Check(InjectionSnapshotSchema, revived));
  assert.deepStrictEqual(revived, snapshot);
});

test("缺 approvalMode 或版本不符的快照被拒绝", () => {
  const snapshot = makeSnapshotV2();
  const missingMode = {
    ...snapshot,
    tools: { ...snapshot.tools, policy: { allow: [], deny: [] } },
  };
  assert.ok(!Value.Check(InjectionSnapshotSchema, missingMode));
  assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, version: 1 }));
  const badMode = {
    ...snapshot,
    tools: { ...snapshot.tools, policy: { allow: [], deny: [], approvalMode: "auto" } },
  };
  assert.ok(!Value.Check(InjectionSnapshotSchema, badMode));
});

test("v1 → v2 迁移：补 approvalMode 默认 prompt，其余字段不变，经迁移管线校验通过", () => {
  const v2 = makeSnapshotV2();
  // 构造 v1 文档：v2 去掉 approvalMode、版本回退
  const { approvalMode: _, ...policyV1 } = v2.tools.policy;
  const v1 = {
    ...v2,
    version: 1,
    tools: { ...v2.tools, policy: policyV1 },
  };

  const registry = new MigrationRegistry();
  registry.register("injection-snapshot", 1, migrateInjectionSnapshotV1toV2);
  const migrated = registry.migrate("injection-snapshot", v1, 2, InjectionSnapshotSchema);

  assert.equal(migrated.version, 2);
  assert.equal(migrated.tools.policy.approvalMode, "prompt");
  assert.deepEqual(migrated, v2);
});
