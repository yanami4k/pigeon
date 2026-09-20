// 启动告警（M8 S7 / S8，决策 091 / 093）：漂移与批准失效都说出来，都不阻止使用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { activationStartupWarnings, type StartupEnvironment } from "./activation-notes.ts";
import { decideCandidate } from "./candidate-decision.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";
const ENVIRONMENT: StartupEnvironment = {
  model: { provider: "anthropic", id: "claude-x" },
  budget: { maxTurns: 5 },
  verify: { command: "npm test", timeoutMs: 1 },
};

// 一个已批准并激活的候选（回放通过）
function activated(): { root: string; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-activation-notes-"));
  const sessionId = newSessionId();
  const runId = newRunId();
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
        entryRunSeqs: [1],
        contentDigest: "d".repeat(64),
      },
      summary: "改之前先读",
      strength: 0.6,
      scan: facts.scan,
      createdAt: 1,
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
  log.appendCandidateVerified({
    runId,
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash: candidate.contentHash,
    conclusion: "passed",
    n: 5,
    effectThreshold: 0.4,
    positiveDelta: 0.6,
    negativeDelta: 0,
    arms: [],
    runs: [],
    environment: {
      model: { provider: "anthropic", id: "claude-x" },
      harness: { commit: "abc1234", dirty: false },
      runtime: { node: "v22", platform: "win32" },
      budget: { maxTurns: 5 },
      verify: { command: "npm test", timeoutMs: 1 },
      experienceSetHash: "e".repeat(64),
      experiences: [],
    },
    verifiedAt: 2,
  });
  log.close();
  decideCandidate({
    governanceRoot: root,
    selector: candidate.contentHash,
    action: "approve",
    skipStalenessCheck: true,
  });
  return { root, contentHash: candidate.contentHash };
}

test("启动告警：环境没变、落点没被动过时不说话", () => {
  const { root } = activated();
  try {
    assert.deepEqual(activationStartupWarnings(root, ENVIRONMENT), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：落点被人改过标注已脱离批准版本，被删标注文件已不在，都不阻止使用", () => {
  const { root } = activated();
  try {
    const target = join(root, ".pigeon", "skills", "read-before-edit", "SKILL.md");
    writeFileSync(target, "人改过了", "utf8");
    const drifted = activationStartupWarnings(root, ENVIRONMENT);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0] ?? "", /已脱离批准版本/);
    assert.match(drifted[0] ?? "", /不阻止使用/);
    rmSync(join(root, ".pigeon", "skills", "read-before-edit"), { recursive: true, force: true });
    const missing = activationStartupWarnings(root, ENVIRONMENT);
    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? "", /已不在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：封闭四项清单里的项变了就报批准失效并指名是哪一项", () => {
  const { root } = activated();
  try {
    const cases: Array<[string, StartupEnvironment]> = [
      ["model", { ...ENVIRONMENT, model: { provider: "anthropic", id: "claude-y" } }],
      ["budget", { ...ENVIRONMENT, budget: { maxTurns: 40 } }],
      ["verifyCommand", { ...ENVIRONMENT, verify: { command: "npm run verify", timeoutMs: 1 } }],
    ];
    for (const [key, current] of cases) {
      const notes = activationStartupWarnings(root, current);
      assert.equal(notes.length, 1, key);
      assert.match(notes[0] ?? "", new RegExp(key));
      assert.match(notes[0] ?? "", /不阻止使用/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：清单外的项变了不报（超时、平台只记录不判定）", () => {
  const { root } = activated();
  try {
    assert.deepEqual(
      activationStartupWarnings(root, {
        ...ENVIRONMENT,
        verify: { command: "npm test", timeoutMs: 999_999 },
      }),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：不给当下环境时只做漂移检查，不猜环境", () => {
  const { root } = activated();
  try {
    assert.deepEqual(activationStartupWarnings(root), []);
    writeFileSync(join(root, ".pigeon", "skills", "read-before-edit", "SKILL.md"), "改了", "utf8");
    assert.equal(activationStartupWarnings(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：未经回放证实的经验每次启动都说一次", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-activation-notes-unverified-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const candidate = stageCandidate({
      governanceRoot: root,
      kind: "memory",
      name: "note",
      content: "一条备忘",
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "reviewer",
        kind: "memory",
        name: "note",
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId,
          runId,
          producerSessionId: newSessionId(),
          entryRunSeqs: [1],
          contentDigest: "d".repeat(64),
        },
        summary: "备忘",
        strength: 0.3,
        scan: facts.scan,
        createdAt: 1,
      }),
    });
    if (candidate === undefined) {
      throw new Error("候选落盘失败");
    }
    const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
    log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
    log.appendCandidateScreened({
      runId,
      candidateKind: "memory",
      name: "note",
      contentHash: candidate.contentHash,
      scannerVersion: candidate.scan.scannerVersion,
      hits: [],
    });
    log.close();
    decideCandidate({
      governanceRoot: root,
      selector: candidate.contentHash,
      action: "approve",
      reason: "先用起来看看",
      skipStalenessCheck: true,
    });
    const notes = activationStartupWarnings(root, ENVIRONMENT);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /未经回放证实/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
