// 注入快照 schema 与迁移链测试（M1 起；M5 S3 升 v3：memory 字段结构化为冻结清单，决策 042；
// M5.5 S5 升 v4：model 段增加推理档位，决策 050；升 v5：model 段增加单轮输出上限，决策 063）。
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
  migrateInjectionSnapshotV3toV4,
  migrateInjectionSnapshotV4toV5,
  migrateInjectionSnapshotV5toV6,
  migrateInjectionSnapshotV6toV7,
  migrateInjectionSnapshotV7toV8,
  migrateInjectionSnapshotV8toV9,
  migrateInjectionSnapshotV9toV10,
  migrateInjectionSnapshotV10toV11,
} from "./snapshot.ts";

const HASH = "a".repeat(64);

// 当前版本快照工厂：memory 为结构化冻结清单（M5 S3）
function makeSnapshot(): InjectionSnapshot {
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
  migrations.register("injection-snapshot", 3, migrateInjectionSnapshotV3toV4);
  migrations.register("injection-snapshot", 4, migrateInjectionSnapshotV4toV5);
  migrations.register("injection-snapshot", 5, migrateInjectionSnapshotV5toV6);
  migrations.register("injection-snapshot", 6, migrateInjectionSnapshotV6toV7);
  migrations.register("injection-snapshot", 7, migrateInjectionSnapshotV7toV8);
  migrations.register("injection-snapshot", 8, migrateInjectionSnapshotV8toV9);
  migrations.register("injection-snapshot", 9, migrateInjectionSnapshotV9toV10);
  migrations.register("injection-snapshot", 10, migrateInjectionSnapshotV10toV11);
  return migrations;
}

test("当前版本快照（结构化 memory 清单 + 可选推理档位 + 可选单轮输出上限）JSON 往返后校验通过", () => {
  assert.equal(INJECTION_SNAPSHOT_VERSION, 11);
  const snapshot = makeSnapshot();
  const revived: unknown = JSON.parse(JSON.stringify(snapshot));
  assert.ok(Value.Check(InjectionSnapshotSchema, revived));
  assert.deepStrictEqual(revived, snapshot);
  const withThinking = { ...snapshot, model: { ...snapshot.model, thinkingLevel: "high" } };
  assert.ok(Value.Check(InjectionSnapshotSchema, withThinking));
  const withOutputLimit = { ...snapshot, model: { ...snapshot.model, maxOutputTokens: 16_384 } };
  assert.ok(Value.Check(InjectionSnapshotSchema, withOutputLimit));
});

test("缺 approvalMode、版本不符、memory 清单条目缺字段、未知推理档位、非正整数输出上限的快照被拒绝", () => {
  const snapshot = makeSnapshot();
  const missingMode = {
    ...snapshot,
    tools: { ...snapshot.tools, policy: { allow: [], deny: [] } },
  };
  assert.ok(!Value.Check(InjectionSnapshotSchema, missingMode));
  assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, version: 3 }));
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
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      model: { ...snapshot.model, thinkingLevel: "turbo" },
    })
  );
  for (const maxOutputTokens of [0, 1.5]) {
    assert.ok(
      !Value.Check(InjectionSnapshotSchema, {
        ...snapshot,
        model: { ...snapshot.model, maxOutputTokens },
      })
    );
  }
});

test("v1 → v2 → … → v8 迁移链：补 approvalMode 默认 prompt，旧快照的空占位数组照过，推理档位、输出上限、验证命令、重试次数与预算缺省", () => {
  const current = { ...makeSnapshot(), memory: [] };
  const { approvalMode: _, ...policyV1 } = current.tools.policy;
  const v1 = { ...current, version: 1, tools: { ...current.tools, policy: policyV1 } };

  const migrated = registry().migrate(
    "injection-snapshot",
    v1,
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.equal(migrated.version, INJECTION_SNAPSHOT_VERSION);
  assert.equal(migrated.repairRounds, undefined);
  assert.equal(migrated.budget, undefined);
  assert.equal(migrated.verify, undefined);
  assert.equal(migrated.retryOnFail, undefined);
  assert.equal(migrated.tools.policy.approvalMode, "prompt");
  assert.equal(migrated.model.thinkingLevel, undefined);
  assert.equal(migrated.model.maxOutputTokens, undefined);
  assert.deepEqual(migrated, current);
});

test("v2 → v3：非结构化的旧 memory 占位不能冒充冻结清单，迁移后校验拒绝", () => {
  const v2 = { ...makeSnapshot(), version: 2, memory: ["一段随手塞的文字"] };
  assert.throws(() =>
    registry().migrate(
      "injection-snapshot",
      v2,
      INJECTION_SNAPSHOT_VERSION,
      InjectionSnapshotSchema
    )
  );
});

// M7 S3 / S6（决策 071 / 079）：v7 顶层加验证命令配置与失败自动分叉重试次数，按会话冻结
test("v7 快照：可选的验证命令配置与失败自动分叉重试次数；缺省合法；v6 快照纯版本推进", () => {
  const snapshot = makeSnapshot();
  assert.ok(
    Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      verify: { command: "npm test", timeoutMs: 1000 },
      retryOnFail: 2,
    })
  );
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, { ...snapshot, verify: { command: "", timeoutMs: 1 } })
  );
  assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, retryOnFail: -1 }));
  const v6 = { ...makeSnapshot(), version: 6 };
  const migrated = registry().migrate(
    "injection-snapshot",
    v6,
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.deepStrictEqual(migrated, { ...v6, version: INJECTION_SNAPSHOT_VERSION });
});

// M8 S1 / S3（决策 081 / 087）：v8 顶层加本次尝试的预算，验证命令加来源字段
test("v8 快照：预算三项与验证命令来源可选；非正整数预算被拒；v7 快照纯版本推进", () => {
  const snapshot = makeSnapshot();
  assert.ok(
    Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      budget: { maxTurns: 40, wallClockMs: 1_800_000, maxTokens: 100_000 },
      verify: { command: "npm test", timeoutMs: 1000, source: "project" },
    })
  );
  assert.ok(Value.Check(InjectionSnapshotSchema, { ...snapshot, budget: {} }));
  for (const budget of [{ maxTurns: 0 }, { wallClockMs: -1 }, { maxTokens: 1.5 }]) {
    assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, budget }));
  }
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      verify: { command: "npm test", timeoutMs: 1, source: "guess" },
    })
  );
  const v7 = { ...makeSnapshot(), version: 7 };
  const migrated = registry().migrate(
    "injection-snapshot",
    v7,
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.deepStrictEqual(migrated, { ...v7, version: INJECTION_SNAPSHOT_VERSION });
});

test("v9 快照：采样温度可选、取值 0 到 2；v8 快照纯版本推进", () => {
  const snapshot = makeSnapshot();
  for (const temperature of [0, 0.7, 2]) {
    assert.ok(
      Value.Check(InjectionSnapshotSchema, {
        ...snapshot,
        model: { ...snapshot.model, temperature },
      })
    );
  }
  for (const temperature of [-0.1, 2.1, "0"]) {
    assert.ok(
      !Value.Check(InjectionSnapshotSchema, {
        ...snapshot,
        model: { ...snapshot.model, temperature },
      })
    );
  }
  const v8 = { ...makeSnapshot(), version: 8 };
  const migrated = registry().migrate(
    "injection-snapshot",
    v8,
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.deepStrictEqual(migrated, { ...v8, version: INJECTION_SNAPSHOT_VERSION });
});

// 决策 142 / 143：v10 顶层加回炉轮数，只在开启时在场（至少 1）
test("v10 快照：回炉轮数可选、至少 1；v9 快照纯版本推进", () => {
  const snapshot = makeSnapshot();
  assert.ok(Value.Check(InjectionSnapshotSchema, { ...snapshot, repairRounds: 3 }));
  for (const repairRounds of [0, -1, 1.5]) {
    assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, repairRounds }));
  }
  const v9 = { ...makeSnapshot(), version: 9 };
  const migrated = registry().migrate(
    "injection-snapshot",
    v9,
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.deepStrictEqual(migrated, { ...v9, version: INJECTION_SNAPSHOT_VERSION });
});

// 决策 137：v11 从快照 schema 删除审阅配置字段；对象非严格，v6 至 v10 快照里的该字段读取时忽略
test("v11 快照：审阅配置字段已删除，带该字段的 v6 至 v10 旧快照照常通过迁移链；v10 → v11 纯版本推进", () => {
  const review = { enabled: true, everyTurns: 4 };
  const withReview = { ...makeSnapshot(), review };
  assert.ok(Value.Check(InjectionSnapshotSchema, withReview), "当前版本快照带旧字段仍合法");
  const v10 = { ...makeSnapshot(), version: 10, review };
  const migrated = registry().migrate(
    "injection-snapshot",
    structuredClone(v10),
    INJECTION_SNAPSHOT_VERSION,
    InjectionSnapshotSchema
  );
  assert.equal(migrated.version, 11);
  assert.deepEqual(migrated.model, v10.model, "其余字段逐字不变");
  assert.deepEqual(migrated.context, v10.context);
  for (const version of [6, 9, 10]) {
    const old = { ...makeSnapshot(), version, review };
    assert.doesNotThrow(
      () =>
        registry().migrate(
          "injection-snapshot",
          structuredClone(old),
          INJECTION_SNAPSHOT_VERSION,
          InjectionSnapshotSchema
        ),
      `v${version} 快照带审阅配置仍可迁到当前版本`
    );
  }
});
