// 注入快照 schema 与迁移链测试（M1 起；M5 S3 升 v3：memory 字段结构化为冻结清单，决策 042）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { MigrationRegistry } from "../state/migration.ts";
import {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
  migrateInjectionSnapshotV1toV2,
  migrateInjectionSnapshotV2toV3,
} from "./snapshot.ts";

const HASH = "a".repeat(64);

// v3 快照工厂：memory 为结构化冻结清单（M5 S3）
function makeSnapshotV3(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [
      { path: ".pigeon/memory/a.md", hash: HASH, bytes: 12, truncated: false, included: true },
    ],
    skills: [],
    createdAt: 1_700_000_000_000,
  };
}

function registry(): MigrationRegistry {
  const migrations = new MigrationRegistry();
  migrations.register("injection-snapshot", 1, migrateInjectionSnapshotV1toV2);
  migrations.register("injection-snapshot", 2, migrateInjectionSnapshotV2toV3);
  return migrations;
}

test("v3 快照（结构化 memory 清单）JSON 往返后校验通过", () => {
  assert.equal(INJECTION_SNAPSHOT_VERSION, 3);
  const snapshot = makeSnapshotV3();
  const revived: unknown = JSON.parse(JSON.stringify(snapshot));
  assert.ok(Value.Check(InjectionSnapshotSchema, revived));
  assert.deepStrictEqual(revived, snapshot);
});

test("缺 approvalMode、版本不符、memory 清单条目缺字段的快照被拒绝", () => {
  const snapshot = makeSnapshotV3();
  const missingMode = {
    ...snapshot,
    tools: { ...snapshot.tools, policy: { allow: [], deny: [] } },
  };
  assert.ok(!Value.Check(InjectionSnapshotSchema, missingMode));
  assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, version: 2 }));
  const badMode = {
    ...snapshot,
    tools: { ...snapshot.tools, policy: { allow: [], deny: [], approvalMode: "auto" } },
  };
  assert.ok(!Value.Check(InjectionSnapshotSchema, badMode));
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      memory: [{ path: ".pigeon/memory/a.md" }],
    })
  );
});

test("v1 → v2 → v3 迁移链：补 approvalMode 默认 prompt，旧快照的空占位数组照过", () => {
  const v3 = { ...makeSnapshotV3(), memory: [] };
  const { approvalMode: _, ...policyV1 } = v3.tools.policy;
  const v1 = { ...v3, version: 1, tools: { ...v3.tools, policy: policyV1 } };

  const migrated = registry().migrate("injection-snapshot", v1, 3, InjectionSnapshotSchema);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.tools.policy.approvalMode, "prompt");
  assert.deepEqual(migrated, v3);
});

test("v2 → v3：非结构化的旧 memory 占位不能冒充冻结清单，迁移后校验拒绝", () => {
  const v2 = { ...makeSnapshotV3(), version: 2, memory: ["一段随手塞的文字"] };
  assert.throws(() => registry().migrate("injection-snapshot", v2, 3, InjectionSnapshotSchema));
});
