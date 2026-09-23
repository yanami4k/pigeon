// 候选三族落盘与读回（M8 S2，决策 089）：验证回执、决定与激活写进候选的来源会话文件，
// 读回后原样物化；v11 旧文件经迁移链升到当前版本仍逐字有效。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CandidateActivatedInput,
  type CandidateDecidedInput,
  type CandidateVerifiedInput,
  EVENT_LOG_VERSION,
} from "../state/event-log.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { JsonlEventLog, materializeSession, readEventLogFile } from "./event-log.ts";

const HASH = "a".repeat(64);

function verifiedInput(): CandidateVerifiedInput {
  return {
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: HASH,
    conclusion: "passed",
    n: 5,
    effectThreshold: 0.4,
    positiveDelta: 0.6,
    negativeDelta: 0,
    arms: [
      {
        arm: "failed-with",
        runs: 5,
        passes: 4,
        passRate: 0.8,
        passAtK: [0.8, 1, 1, 1, 1],
        passPowK: [0.8, 0.6, 0.4, 0.2, 0],
        wilson: { low: 0.375, high: 0.964 },
      },
    ],
    runs: [
      {
        arm: "failed-with",
        index: 1,
        sessionId: newSessionId(),
        governanceRoot: "/tmp/wt",
        verdict: "pass",
        status: "completed",
        turns: 3,
        totalTokens: 100,
        durationMs: 10,
      },
    ],
    environment: {
      model: { provider: "p", id: "m", maxOutputTokens: 16_384 },
      harness: { commit: "abc1234", dirty: false },
      runtime: { node: "v22.19.0", platform: "win32" },
      budget: { maxTurns: 40, wallClockMs: 1_800_000 },
      verify: { command: "npm test", timeoutMs: 300_000, source: "project" },
      experienceSetHash: "b".repeat(64),
      experiences: [
        { kind: "skill", name: "read-before-edit", contentHash: HASH, bytes: 10, candidate: true },
      ],
    },
    verifiedAt: 7,
  };
}

test("候选三族：落盘后读回原样，并进入物化结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-candidate-families-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const verified = log.appendCandidateVerified({ runId, ...verifiedInput() });
    const decision: CandidateDecidedInput = {
      runId,
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      action: "approve",
      reason: "回放通过",
      reasonSource: "human",
      verification: { recordId: verified.id, conclusion: "passed" },
      decidedAt: 8,
    };
    const decided = log.appendCandidateDecided(decision);
    const activation: CandidateActivatedInput = {
      runId,
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      path: ".pigeon/skills/read-before-edit/SKILL.md",
      activatedHash: HASH,
      unverified: false,
      decisionId: decided.id,
      activatedAt: 9,
    };
    log.appendCandidateActivated(activation);
    log.close();

    const records = readEventLogFile(JsonlEventLog.filePathFor(dir, sessionId));
    assert.equal(records.length, 3);
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    assert.deepEqual(
      records.map((record) => record.kind),
      ["candidate.verified", "candidate.decided", "candidate.activated"]
    );

    const session = materializeSession(dir, sessionId, { content: false });
    assert.equal(session.candidateVerifieds.length, 1);
    assert.equal(session.candidateVerifieds[0]?.conclusion, "passed");
    assert.equal(session.candidateVerifieds[0]?.environment.experiences[0]?.candidate, true);
    assert.equal(session.candidateDecideds[0]?.action, "approve");
    assert.equal(session.candidateActivateds[0]?.activatedHash, HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("候选三族：信封 Run 可缺省——审批发生在任何 Run 之外", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-candidate-families-norun-"));
  try {
    const sessionId = newSessionId();
    const log = new JsonlEventLog(dir, sessionId);
    const decided = log.appendCandidateDecided({
      candidateKind: "memory",
      name: "note",
      contentHash: HASH,
      action: "reject",
      reason: "与现有约定冲突",
      reasonSource: "human",
      decidedAt: 1,
    });
    log.close();
    assert.equal(decided.runId, undefined);
    const session = materializeSession(dir, sessionId, { content: false });
    assert.equal(session.candidateDecideds[0]?.action, "reject");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("候选三族：v11 会话文件经迁移链升到当前版本，旧记录逐字有效", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-candidate-families-v11-"));
  try {
    const sessionId = newSessionId();
    const v11 = {
      version: 11,
      id: newEntryId(),
      sessionId,
      timestamp: 1,
      kind: "attempt.verified",
      target: { sessionId, runId: newRunId() },
      command: ["sh", "-c", "npm test"],
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputBytes: 0,
      outputHash: HASH,
      output: "",
      truncated: false,
      workspace: "/tmp/w",
      verdict: "pass",
      verifiedAt: 1,
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v11)}\n`, "utf8");
    const records = readEventLogFile(path);
    assert.equal(EVENT_LOG_VERSION, 15);
    assert.equal(records[0]?.version, EVENT_LOG_VERSION);
    assert.equal(records[0]?.kind, "attempt.verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
