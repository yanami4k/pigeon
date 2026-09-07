import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  CANDIDATE_VERSION,
  type Candidate,
  CandidateSchema,
  type CandidateStatus,
  CandidateStatusSchema,
} from "./candidate.ts";

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    version: CANDIDATE_VERSION,
    id: "cand-001",
    status: "Proposed",
    sourceRef: "run_/reviewer 产出",
    summary: "从三次失败编辑中提炼：先读后写",
    createdAt: 1_757_000_000_000,
    updatedAt: 1_757_000_000_000,
    ...overrides,
  };
}

test("Candidate JSON 往返后深度相等且校验通过", () => {
  const candidate = makeCandidate({ status: "AwaitingApproval" });
  const revived: unknown = JSON.parse(JSON.stringify(candidate));
  assert.ok(Value.Check(CandidateSchema, revived));
  assert.deepStrictEqual(revived, candidate);
});

test("状态机全部 9 个字面量都被接受", () => {
  const statuses: CandidateStatus[] = [
    "Proposed",
    "SecurityScanned",
    "EvidenceChecked",
    "ReplayValidated",
    "ValidationFailed",
    "AwaitingApproval",
    "Active",
    "Rejected",
    "Superseded",
  ];
  for (const status of statuses) {
    assert.ok(Value.Check(CandidateStatusSchema, status), `status ${status} 应合法`);
    assert.ok(Value.Check(CandidateSchema, makeCandidate({ status })));
  }
});

test("状态机外字面量被拒绝", () => {
  assert.ok(!Value.Check(CandidateSchema, makeCandidate({ status: "AutoActivated" as never })));
});

test("空 sourceRef 被拒绝（来源必须可回查）", () => {
  assert.ok(!Value.Check(CandidateSchema, makeCandidate({ sourceRef: "" })));
});
