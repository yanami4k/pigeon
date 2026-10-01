// 注入快照 schema 测试（M1 起；M5 S3 升 v3：memory 字段结构化为冻结清单，决策 042；
// M5.5 S5 升 v4：model 段增加推理档位，决策 050；升 v5：model 段增加单轮输出上限，决策 063）。
// 快照只在运行面内存里冻结、不整份落盘，读旧版本快照的迁移链随旧格式读取一并删除（187）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
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

test("当前版本快照（结构化 memory 清单 + 可选推理档位 + 可选单轮输出上限）JSON 往返后校验通过", () => {
  assert.equal(INJECTION_SNAPSHOT_VERSION, 14);
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

// 决策 322：v14 顶层删除验证命令、失败自动分叉重试与回炉轮数；对象非严格，带这三个字段的旧快照照常通过校验
test("v14：verify、retryOnFail、repairRounds 已删除，带这三个字段的旧快照照常通过校验", () => {
  const legacy = {
    ...makeSnapshot(),
    verify: { command: "npm test", timeoutMs: 1000 },
    retryOnFail: 2,
    repairRounds: 3,
  };
  assert.ok(Value.Check(InjectionSnapshotSchema, legacy));
});

// M8（决策 087）：v8 顶层加本次尝试的预算
test("v8 字段：预算三项可选；非正整数预算被拒", () => {
  const snapshot = makeSnapshot();
  assert.ok(
    Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      budget: { maxTurns: 40, wallClockMs: 1_800_000, maxTokens: 100_000 },
    })
  );
  assert.ok(Value.Check(InjectionSnapshotSchema, { ...snapshot, budget: {} }));
  for (const budget of [{ maxTurns: 0 }, { wallClockMs: -1 }, { maxTokens: 1.5 }]) {
    assert.ok(!Value.Check(InjectionSnapshotSchema, { ...snapshot, budget }));
  }
});

test("v9 字段：采样温度可选、取值 0 到 2", () => {
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
});

// 决策 137：v11 从快照 schema 删除审阅配置字段；对象非严格，带该字段的快照照常通过
test("v11：审阅配置字段已删除，带该字段的快照照常通过校验", () => {
  const withReview = { ...makeSnapshot(), review: { enabled: true, everyTurns: 4 } };
  assert.ok(Value.Check(InjectionSnapshotSchema, withReview));
});

// 决策 191、192、207：v13 顶层加推送的记忆与复盘标记（复盘标记不叫 review，与 v11 删掉的旧字段不撞名）
test("v13 字段：推送的记忆与复盘标记可选；旧的审阅字段照常通过", () => {
  const snapshot = makeSnapshot();
  const withMemory = {
    ...snapshot,
    learnedMemory: {
      path: ".pigeon/state/learned/MEMORY.md",
      hash: HASH,
      bytes: 10,
      entries: 1,
      limitChars: 12_000,
    },
    memoryReview: { kind: "pre-compaction", template: "v1" },
    review: { enabled: true, everyTurns: 4 },
  };
  assert.ok(Value.Check(InjectionSnapshotSchema, withMemory));
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      memoryReview: { kind: "other", template: "v1" },
    })
  );
});

// 决策 134 / 157：v12 顶层加结构化记忆的开局留痕
test("v12 字段：结构化记忆留痕可选", () => {
  const snapshot = makeSnapshot();
  assert.ok(
    Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      structuredMemory: { enabled: true, selection: "auto", opening: ["mem_1"] },
    })
  );
  assert.ok(
    !Value.Check(InjectionSnapshotSchema, {
      ...snapshot,
      structuredMemory: { enabled: true, selection: "other", opening: [] },
    })
  );
});
