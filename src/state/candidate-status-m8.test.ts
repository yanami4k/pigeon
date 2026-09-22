// 候选状态投影（M8 S2，决策 089 / 092 / 093）：验证、决定与激活三族进来后的状态现算。
// 状态仍不落候选目录：任何一条状态都必须能由账本重放出来。
// 决策 128：扫描结论只读候选提出记录内嵌的扫描结果，不再有单独的筛查族。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewerCandidate } from "./candidate.ts";
import {
  type CandidateProjectionSource,
  collectSupersededHashes,
  projectCandidates,
} from "./candidate-status.ts";
import type {
  CandidateActivatedRecord,
  CandidateDecidedRecord,
  CandidateProposedRecord,
  CandidateVerifiedRecord,
  VerificationConclusion,
} from "./event-log.ts";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";

const SESSION = newSessionId();
const RUN = newRunId();
const hashOf = (seed: string): string => seed.repeat(64).slice(0, 64);

type ScanHits = ReviewerCandidate["scan"]["hits"];

function candidate(hash: string, supersedes?: string, hits: ScanHits = []): ReviewerCandidate {
  return {
    version: 3,
    origin: "reviewer",
    kind: "skill",
    name: "read-before-edit",
    contentHash: hash,
    bytes: 10,
    source: {
      sessionId: SESSION,
      runId: RUN,
      producerSessionId: newSessionId(),
      entryRunSeqs: [1],
      contentDigest: hashOf("d"),
    },
    summary: "改之前先读",
    strength: 0.5,
    scan: { scannerVersion: "1", hits },
    ...(supersedes !== undefined ? { supersedes } : {}),
    createdAt: 1,
  };
}

const envelope = () => ({
  version: 14 as const,
  id: newEntryId(),
  sessionId: SESSION,
  runId: RUN,
  timestamp: 1,
});

function proposed(hash: string, supersedes?: string, hits: ScanHits = []): CandidateProposedRecord {
  return {
    ...envelope(),
    kind: "candidate.proposed",
    candidate: candidate(hash, supersedes, hits),
    model: { provider: "p", id: "m" },
  };
}

function verified(hash: string, conclusion: VerificationConclusion): CandidateVerifiedRecord {
  return {
    ...envelope(),
    kind: "candidate.verified",
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: hash,
    conclusion,
    n: 5,
    effectThreshold: 0.4,
    positiveDelta: 0.6,
    negativeDelta: 0,
    arms: [],
    runs: [],
    environment: {
      model: { provider: "p", id: "m" },
      harness: { commit: "abc1234", dirty: false },
      runtime: { node: "v22", platform: "win32" },
      budget: {},
      verify: { command: "npm test", timeoutMs: 1 },
      experienceSetHash: hashOf("e"),
      experiences: [],
    },
    verifiedAt: 1,
  };
}

function decided(
  hash: string,
  action: CandidateDecidedRecord["action"],
  extra: Partial<CandidateDecidedRecord> = {}
): CandidateDecidedRecord {
  return {
    ...envelope(),
    kind: "candidate.decided",
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: hash,
    action,
    reason: "人写理由",
    reasonSource: "human",
    decidedAt: 2,
    ...extra,
  };
}

function activated(hash: string, unverified = false): CandidateActivatedRecord {
  return {
    ...envelope(),
    kind: "candidate.activated",
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: hash,
    path: ".pigeon/skills/read-before-edit/SKILL.md",
    activatedHash: hash,
    unverified,
    decisionId: newEntryId(),
    activatedAt: 3,
  };
}

function source(partial: Partial<CandidateProjectionSource>): CandidateProjectionSource {
  return {
    candidateProposeds: [],
    candidateVerifieds: [],
    candidateDecideds: [],
    candidateActivateds: [],
    ...partial,
  };
}

const A = hashOf("a");
const B = hashOf("b");

test("状态机：三值验证结论各自现算成一个状态", () => {
  const cases: Array<[VerificationConclusion, string]> = [
    ["passed", "ReplayValidated"],
    ["inconclusive", "ReplayInconclusive"],
    ["regressed", "ReplayRegressed"],
  ];
  for (const [conclusion, expected] of cases) {
    const projected = projectCandidates(
      source({
        candidateProposeds: [proposed(A)],
        candidateVerifieds: [verified(A, conclusion)],
      })
    );
    assert.equal(projected[0]?.status, expected);
    assert.equal(projected[0]?.verified?.conclusion, conclusion);
  }
});

test("状态机：批准后未激活是已批准，激活后是已激活；撤销与拒绝各自成态", () => {
  const approved = source({
    candidateProposeds: [proposed(A)],
    candidateVerifieds: [verified(A, "passed")],
    candidateDecideds: [decided(A, "approve")],
  });
  assert.equal(projectCandidates(approved)[0]?.status, "Approved");
  assert.equal(
    projectCandidates({ ...approved, candidateActivateds: [activated(A)] })[0]?.status,
    "Active"
  );
  assert.equal(
    projectCandidates({ ...approved, candidateDecideds: [decided(A, "reject")] })[0]?.status,
    "Rejected"
  );
  // 撤销是批准之后的动作：取最后一条决定
  assert.equal(
    projectCandidates({
      ...approved,
      candidateDecideds: [decided(A, "approve"), decided(A, "revoke")],
      candidateActivateds: [activated(A)],
    })[0]?.status,
    "Revoked"
  );
});

test("状态机：同名新候选带取代关系时旧候选现算为已取代，取代动作同构", () => {
  const byNewCandidate = source({
    candidateProposeds: [proposed(A), proposed(B, A)],
  });
  const projected = projectCandidates(byNewCandidate, {
    supersededHashes: collectSupersededHashes([byNewCandidate]),
  });
  assert.equal(projected[0]?.status, "Superseded", "被新候选取代的旧候选");
  assert.equal(projected[1]?.status, "SecurityScanned", "新候选自身不受影响");
  // 取代也可由决定族直接表达（093：与 065 的候选取代同构）
  const byDecision = source({
    candidateProposeds: [proposed(A)],
    candidateDecideds: [decided(A, "supersede", { supersededBy: B })],
  });
  assert.equal(projectCandidates(byDecision)[0]?.status, "Superseded");
});

test("状态机：扫描拒收压过一切后续记录——永不参与激活", () => {
  const projected = projectCandidates(
    source({
      candidateProposeds: [proposed(A, undefined, [{ rule: "injection", detail: "命中" }])],
      candidateVerifieds: [verified(A, "passed")],
      candidateDecideds: [decided(A, "approve")],
      candidateActivateds: [activated(A)],
    })
  );
  assert.equal(projected[0]?.status, "ScanRejected");
});

test("状态机：未测出经人工批准激活时带未经回放证实标记", () => {
  const projected = projectCandidates(
    source({
      candidateProposeds: [proposed(A)],
      candidateVerifieds: [verified(A, "inconclusive")],
      candidateDecideds: [decided(A, "approve")],
      candidateActivateds: [activated(A, true)],
    })
  );
  assert.equal(projected[0]?.status, "Active");
  assert.equal(projected[0]?.activated?.unverified, true);
});

test("状态机：只有提出记录时按内嵌扫描结果现算——无命中即已扫描，有命中即扫描拒收", () => {
  assert.equal(
    projectCandidates(source({ candidateProposeds: [proposed(A)] }))[0]?.status,
    "SecurityScanned"
  );
  assert.equal(
    projectCandidates(
      source({
        candidateProposeds: [proposed(A, undefined, [{ rule: "exfiltration", detail: "命中" }])],
      })
    )[0]?.status,
    "ScanRejected"
  );
});
