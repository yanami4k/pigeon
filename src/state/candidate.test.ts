// 候选 schema v2（M6 S3，决策 065 子裁决 ①）：只放写一次即不可变的元数据，状态不入 schema；
// 状态枚举新增"扫描拒收"。v1 从无写入方，迁移不编造正文与哈希：迁成"由 v1 迁移"保留形状。
// v3（M7 S1，决策 075）：v2 字段不变，加法式新增对比来源块；单来源候选该块为空（缺省）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  CANDIDATE_VERSION,
  CandidateSchema,
  CandidateStatusSchema,
  migrateCandidateToCurrent,
  migrateCandidateV1toV2,
} from "./candidate.ts";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";

const HASH = "a".repeat(64);

test("v2 元数据：种类、名字、内容哈希与字节数、来源四项、摘要、判断强度、扫描结果、取代关系", () => {
  assert.equal(CANDIDATE_VERSION, 3);
  const candidate = {
    version: 3,
    origin: "reviewer",
    kind: "skill",
    name: "read-before-edit",
    contentHash: HASH,
    bytes: 42,
    source: {
      sessionId: newSessionId(),
      runId: newRunId(),
      producerSessionId: newSessionId(),
      entryRunSeqs: [1, 2],
      contentDigest: HASH,
    },
    summary: "改之前先读",
    strength: 0.7,
    scan: { scannerVersion: "1", hits: [] },
    supersedes: "b".repeat(64),
    createdAt: 1,
  };
  assert.ok(Value.Check(CandidateSchema, candidate));
  assert.ok(!Value.Check(CandidateSchema, { ...candidate, status: "Active" }), "状态不入 schema");
  assert.ok(!Value.Check(CandidateSchema, { ...candidate, strength: 1.5 }), "判断强度限 0 到 1");
  assert.ok(Value.Check(CandidateStatusSchema, "ScanRejected"), "状态枚举新增扫描拒收");
});

test("v2 元数据 JSON 往返后深度相等且校验通过；来源会话号不得为空（来源必须可回查）", () => {
  const candidate = {
    version: 3,
    origin: "reviewer",
    kind: "memory",
    name: "project-facts",
    contentHash: HASH,
    bytes: 10,
    source: {
      sessionId: newSessionId(),
      runId: newRunId(),
      producerSessionId: newSessionId(),
      entryRunSeqs: [1],
      contentDigest: HASH,
    },
    summary: "从三次失败编辑中提炼：先读后写",
    strength: 0.5,
    scan: { scannerVersion: "1", hits: [] },
    createdAt: 1_757_000_000_000,
  };
  const revived: unknown = JSON.parse(JSON.stringify(candidate));
  assert.ok(Value.Check(CandidateSchema, revived));
  assert.deepStrictEqual(revived, candidate);
  assert.ok(
    !Value.Check(CandidateSchema, { ...candidate, source: { ...candidate.source, sessionId: "" } })
  );
});

test("状态机：现算产出的状态都被接受，已删去的四个旧字面量与状态机外字面量被拒绝", () => {
  for (const status of [
    "SecurityScanned",
    "ScanRejected",
    "ReplayValidated",
    "ReplayInconclusive",
    "ReplayRegressed",
    "Approved",
    "Active",
    "Revoked",
    "Rejected",
    "Superseded",
  ]) {
    assert.ok(Value.Check(CandidateStatusSchema, status), `status ${status} 应合法`);
  }
  for (const removed of ["Proposed", "EvidenceChecked", "ValidationFailed", "AwaitingApproval"]) {
    assert.ok(!Value.Check(CandidateStatusSchema, removed), `status ${removed} 已删去`);
  }
  assert.ok(!Value.Check(CandidateStatusSchema, "AutoActivated"));
});

test("v1 → v2：只保留 v1 原有的名字、摘要、来源引用与时间，不编造种类与哈希，状态丢弃", () => {
  const v1 = {
    version: 1,
    id: "cand-1",
    status: "Proposed",
    sourceRef: "sess",
    summary: "旧候选",
    createdAt: 5,
    updatedAt: 6,
  };
  const migrated = migrateCandidateV1toV2(v1) as Record<string, unknown>;
  assert.equal(migrated.version, 2);
  assert.equal(migrated.origin, "migrated-v1");
  assert.equal(migrated.kind, undefined);
  assert.equal(migrated.status, undefined);
  assert.ok(Value.Check(CandidateSchema, migrateCandidateToCurrent(v1)));
});

// ---- v3 对比来源块（决策 075）----

const attempt = (label: string, from: number, to: number) => ({
  governanceRoot: "/repo",
  sessionId: newSessionId(),
  runId: newRunId(),
  entryRange: { from, to },
  label,
});

test("v3 对比来源块：成败两侧的尝试引用（治理根、会话、Run、条目范围）、共享前缀、各侧标签与验证记录引用、产物形态", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const candidate = {
    version: 3,
    origin: "distiller",
    kind: "skill",
    name: "run-tests-before-done",
    contentHash: HASH,
    bytes: 42,
    source: {
      sessionId,
      runId,
      producerSessionId: newSessionId(),
      entryRunSeqs: [1, 2],
      contentDigest: HASH,
    },
    summary: "收工前先跑测试",
    strength: 0.6,
    scan: { scannerVersion: "1", hits: [] },
    createdAt: 1,
    contrast: {
      form: "procedure",
      successful: [
        {
          ...attempt("Passed", 1, 9),
          verification: { sessionId, recordId: newEntryId() },
        },
      ],
      failed: [attempt("Failed", 1, 6)],
      sharedPrefix: { sessionId, runId, from: 1, to: 3 },
      others: [attempt("Failed", 1, 4)],
    },
  };
  assert.ok(Value.Check(CandidateSchema, candidate));
  assert.ok(
    !Value.Check(CandidateSchema, {
      ...candidate,
      contrast: { ...candidate.contrast, form: "summary" },
    }),
    "产物形态只有教训、流程、步骤集"
  );
  assert.ok(
    !Value.Check(CandidateSchema, {
      ...candidate,
      contrast: { ...candidate.contrast, failed: [{ ...attempt("Failed", 1, 6), label: "Maybe" }] },
    }),
    "标签只有五个"
  );
  const { contrast: _contrast, ...single } = candidate;
  assert.ok(
    Value.Check(CandidateSchema, { ...single, origin: "reviewer" }),
    "单来源候选不带对比来源块"
  );
});

// 决策 065 修订：来源里记产出会话的字段改中性命名，v2 → v3 迁移一并改写，值不变
test("v2 → v3：其余字段原样保留、版本推进，来源里的产出会话字段改名且值不变，旧候选迁移后能读", () => {
  const producer = newSessionId();
  const v2 = {
    version: 2,
    origin: "reviewer",
    kind: "memory",
    name: "project-facts",
    contentHash: HASH,
    bytes: 10,
    source: {
      sessionId: newSessionId(),
      runId: newRunId(),
      reviewSessionId: producer,
      entryRunSeqs: [1],
      contentDigest: HASH,
    },
    summary: "先读后写",
    strength: 0.5,
    scan: { scannerVersion: "1", hits: [] },
    createdAt: 1,
  };
  const migrated = migrateCandidateToCurrent(v2) as Record<string, unknown>;
  assert.deepStrictEqual(migrated, {
    ...v2,
    version: 3,
    source: {
      sessionId: v2.source.sessionId,
      runId: v2.source.runId,
      entryRunSeqs: [1],
      contentDigest: HASH,
      producerSessionId: producer,
    },
  });
  assert.ok(!("reviewSessionId" in (migrated.source as object)), "旧名不再保留");
  assert.ok(Value.Check(CandidateSchema, migrated), "迁移后通过当前 schema 校验");
});
