// 候选 schema v2（M6 S3，决策 065 子裁决 ①）：只放写一次即不可变的元数据，状态不入 schema；
// 状态枚举新增"扫描拒收"。v1 从无写入方，迁移不编造正文与哈希：迁成 v2 的"由 v1 迁移"保留形状。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  CANDIDATE_VERSION,
  CandidateSchema,
  CandidateStatusSchema,
  migrateCandidateV1toV2,
} from "./candidate.ts";
import { newRunId, newSessionId } from "./ids.ts";

const HASH = "a".repeat(64);

test("v2 元数据：种类、名字、内容哈希与字节数、来源四项、摘要、判断强度、扫描结果、取代关系", () => {
  assert.equal(CANDIDATE_VERSION, 2);
  const candidate = {
    version: 2,
    origin: "reviewer",
    kind: "skill",
    name: "read-before-edit",
    contentHash: HASH,
    bytes: 42,
    source: {
      sessionId: newSessionId(),
      runId: newRunId(),
      reviewSessionId: newSessionId(),
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
    version: 2,
    origin: "reviewer",
    kind: "memory",
    name: "project-facts",
    contentHash: HASH,
    bytes: 10,
    source: {
      sessionId: newSessionId(),
      runId: newRunId(),
      reviewSessionId: newSessionId(),
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

test("状态机：原有 9 个字面量与新增的扫描拒收都被接受，状态机外字面量被拒绝", () => {
  for (const status of [
    "Proposed",
    "SecurityScanned",
    "ScanRejected",
    "EvidenceChecked",
    "ReplayValidated",
    "ValidationFailed",
    "AwaitingApproval",
    "Active",
    "Rejected",
    "Superseded",
  ]) {
    assert.ok(Value.Check(CandidateStatusSchema, status), `status ${status} 应合法`);
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
  assert.ok(Value.Check(CandidateSchema, migrated));
});
