import assert from "node:assert/strict";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import * as candidateModule from "./candidate.ts";

const { CANDIDATE_VERSION, CandidateSchema } = candidateModule;

function makeCandidate(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CANDIDATE_VERSION,
    id: "cand-eval-001",
    status: "EvidenceChecked",
    sourceRef: "run_/reviewer",
    summary: "先读后写",
    createdAt: 1_757_000_000_000,
    updatedAt: 1_757_000_000_000,
    ...extra,
  };
}

test("版本保持 1，不带 evidenceRefs 的既有 Candidate 仍合法", () => {
  assert.equal(CANDIDATE_VERSION, 1);
  assert.ok(Value.Check(CandidateSchema, makeCandidate()));
});

test("导出 CandidateEvidenceRefsSchema：非空、非空串、无重复", () => {
  const schema = (candidateModule as Record<string, unknown>).CandidateEvidenceRefsSchema as
    | TSchema
    | undefined;
  assert.ok(schema !== undefined, "candidate.ts 应导出 CandidateEvidenceRefsSchema");
  assert.ok(Value.Check(schema, ["run_a"]));
  assert.ok(Value.Check(schema, ["run_a", "sess_b"]));
  assert.ok(!Value.Check(schema, []));
  assert.ok(!Value.Check(schema, [""]));
  assert.ok(!Value.Check(schema, ["run_a", "run_a"]));
});

test("合法 evidenceRefs 通过并可 JSON 往返", () => {
  const candidate = makeCandidate({ evidenceRefs: ["run_01", "sess_02", "entry_03"] });
  const revived: unknown = JSON.parse(JSON.stringify(candidate));
  assert.ok(Value.Check(CandidateSchema, revived));
  assert.deepStrictEqual(revived, candidate);
});

test("非法 evidenceRefs 使 Candidate 校验失败", () => {
  const bad: unknown[] = [[], [""], ["a", "a"], "a", [1], null, [["nested"]]];
  for (const value of bad) {
    assert.ok(
      !Value.Check(CandidateSchema, makeCandidate({ evidenceRefs: value })),
      `evidenceRefs=${JSON.stringify(value)} 应被拒绝`
    );
  }
});

test("既有约束不受影响", () => {
  assert.ok(!Value.Check(CandidateSchema, makeCandidate({ sourceRef: "", evidenceRefs: ["a"] })));
  assert.ok(!Value.Check(CandidateSchema, makeCandidate({ status: "AutoActivated" })));
});
