// 候选列表与详情（M8 S6，决策 088 / 089）：审批要看的材料在详情里一次给全——
// 候选正文、与落点的 diff、来源链、扫描结果、四组回执；状态行只给待审数量。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { decideCandidate } from "./candidate-decision.ts";
import {
  diffSection,
  PENDING_STATUSES,
  pendingApprovalCount,
  runCandidateShowCommand,
  runCandidatesCommand,
} from "./candidates-list.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "第一行\n第二行\n第三行\n";

function fixture(
  options: { verified?: boolean; conclusion?: "passed" | "inconclusive" | "regressed" } = {}
): { root: string; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-candidates-view-"));
  const sessionId = newSessionId();
  const runId = newRunId();
  const failedSession = newSessionId();
  const successfulSession = newSessionId();
  const candidate = stageCandidate({
    governanceRoot: root,
    kind: "skill",
    name: "read-before-edit",
    content: BODY,
    build: (facts) => ({
      version: CANDIDATE_VERSION,
      origin: "distiller",
      kind: "skill",
      name: "read-before-edit",
      contentHash: facts.contentHash,
      bytes: facts.bytes,
      source: {
        sessionId,
        runId,
        producerSessionId: newSessionId(),
        entryRunSeqs: [3, 5],
        contentDigest: "d".repeat(64),
      },
      summary: "改之前先读",
      strength: 0.6,
      scan: facts.scan,
      createdAt: 1,
      contrast: {
        form: "lesson",
        successful: [
          {
            governanceRoot: root,
            sessionId: successfulSession,
            runId,
            entryRange: { from: 1, to: 9 },
            label: "Passed",
            verification: { sessionId: successfulSession, recordId: newEntryId() },
          },
        ],
        failed: [
          {
            governanceRoot: root,
            sessionId: failedSession,
            runId,
            entryRange: { from: 1, to: 7 },
            label: "Failed",
          },
        ],
      },
    }),
  });
  if (candidate === undefined) {
    throw new Error("候选落盘失败");
  }
  const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
  log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
  log.appendCandidateScreened({
    runId,
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: candidate.contentHash,
    scannerVersion: candidate.scan.scannerVersion,
    hits: [],
  });
  if (options.verified === true) {
    log.appendCandidateVerified({
      runId,
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: candidate.contentHash,
      conclusion: options.conclusion ?? "passed",
      n: 3,
      effectThreshold: 0.4,
      positiveDelta: 0.67,
      negativeDelta: 0,
      arms: [
        {
          arm: "failed-baseline",
          runs: 3,
          passes: 0,
          passRate: 0,
          passAtK: [0, 0, 0],
          passPowK: [0, 0, 0],
          wilson: { low: 0, high: 0.56 },
        },
        {
          arm: "failed-with",
          runs: 3,
          passes: 2,
          passRate: 0.67,
          passAtK: [0.67, 1, 1],
          passPowK: [0.67, 0.33, 0],
          wilson: { low: 0.21, high: 0.94 },
        },
        {
          arm: "successful-baseline",
          runs: 3,
          passes: 3,
          passRate: 1,
          passAtK: [1, 1, 1],
          passPowK: [1, 1, 1],
          wilson: { low: 0.44, high: 1 },
        },
        {
          arm: "successful-with",
          runs: 3,
          passes: 3,
          passRate: 1,
          passAtK: [1, 1, 1],
          passPowK: [1, 1, 1],
          wilson: { low: 0.44, high: 1 },
        },
      ],
      runs: [
        {
          arm: "failed-with",
          index: 1,
          sessionId: newSessionId(),
          governanceRoot: join(root, "wt"),
          verdict: "pass",
          status: "completed",
          turns: 4,
          totalTokens: 900,
          durationMs: 10,
        },
      ],
      environment: {
        model: { provider: "anthropic", id: "claude-x", maxOutputTokens: 16_384 },
        harness: { commit: "abc1234", dirty: false },
        runtime: { node: "v22.19.0", platform: "win32" },
        budget: { maxTurns: 8, wallClockMs: 60_000 },
        verify: { command: "npm test", timeoutMs: 1000, source: "project" },
        experienceSetHash: "e".repeat(64),
        experiences: [
          {
            kind: "skill",
            name: "read-before-edit",
            contentHash: candidate.contentHash,
            bytes: candidate.bytes,
            candidate: true,
          },
        ],
      },
      verifiedAt: 2,
    });
  }
  log.close();
  return { root, contentHash: candidate.contentHash };
}

test("列表：一候选一行，带状态、回放结论与来源", () => {
  const { root, contentHash } = fixture({ verified: true });
  try {
    const listed = runCandidatesCommand({ root });
    assert.match(listed, /skill ｜ read-before-edit/);
    assert.match(listed, /回放通过/);
    assert.match(listed, new RegExp(contentHash.slice(0, 12)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("待审数量：已扫描与三值结论都算待审，做完决定就不算", () => {
  const { root, contentHash } = fixture({ verified: true });
  try {
    assert.equal(pendingApprovalCount(root), 1);
    decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "reject",
      reason: "不要",
    });
    assert.equal(pendingApprovalCount(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// M8 收口补遗：回归的候选永不可批准，不该出现在待审数量里
test("待审数量：结论为回归的候选不计入——它永不可批准", () => {
  const { root, contentHash } = fixture({ verified: true, conclusion: "regressed" });
  try {
    assert.equal(pendingApprovalCount(root), 0);
    assert.match(runCandidatesCommand({ root }), /回放回归/);
    assert.equal(PENDING_STATUSES.includes("ReplayRegressed"), false);
    void contentHash;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("详情：正文、来源链、扫描结果与四组回执一次给全", () => {
  const { root, contentHash } = fixture({ verified: true });
  try {
    const detail = runCandidateShowCommand({ root, selector: contentHash.slice(0, 8) });
    assert.match(detail, /# skill\/read-before-edit/);
    assert.match(detail, /## 来源链/);
    assert.match(detail, /成功侧：会话/);
    assert.match(detail, /失败侧：会话/);
    assert.match(detail, /## 扫描结果/);
    assert.match(detail, /无命中/);
    assert.match(detail, /## 四组回放回执/);
    assert.match(detail, /失败侧·带经验：2\/3 通过/);
    assert.match(detail, /pass@1=0\.67/);
    assert.match(detail, /pass\^2=0\.33/);
    assert.match(detail, /Wilson \[0\.21, 0\.94\]（只作参考，不参与判定）/);
    assert.match(detail, /经验集合哈希/);
    assert.match(detail, /各次运行会话号/);
    assert.match(detail, /## 与当前落点的差异/);
    assert.match(detail, /## 候选正文/);
    assert.match(detail, /第二行/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("详情：尚未验证时明说没验过，并给出怎么验", () => {
  const { root, contentHash } = fixture();
  try {
    const detail = runCandidateShowCommand({ root, selector: contentHash });
    assert.match(detail, /尚未验证（pigeon verify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("详情：激活后再看，diff 显示与落点逐字相同；人改过后显示行级差异", () => {
  const { root, contentHash } = fixture({ verified: true });
  try {
    decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "approve",
      skipStalenessCheck: true,
    });
    assert.match(
      runCandidateShowCommand({ root, selector: contentHash }),
      /落点内容与候选正文逐字相同/
    );
    writeFileSync(
      join(root, ".pigeon", "skills", "read-before-edit", "SKILL.md"),
      "第一行\n改过的第二行\n第三行\n",
      "utf8"
    );
    const detail = runCandidateShowCommand({ root, selector: contentHash });
    assert.match(detail, /已脱离批准版本/);
    assert.match(detail, /-改过的第二行/);
    assert.match(detail, /\+第二行/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("差异：落点还没有同名文件时说清楚本次是新增", () => {
  assert.match(diffSection(undefined, "新内容\n"), /新增/);
  assert.equal(diffSection("一样\n", "一样\n").includes("逐字相同"), true);
  const diff = diffSection("a\nb\nc\n", "a\nx\nc\n");
  assert.match(diff, /-b/);
  assert.match(diff, /\+x/);
  assert.match(diff, / a/);
});
