// 启动告警按生产接线走（M8 收口修复，决策 091）：交互会话不往账本写预算，
// 拿不到预算就不判这一项——拿"不设限"去和回执里的真实数字比，必然每次开会话都报一次假失效。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { activationStartupWarnings, startupEnvironmentOf } from "./activation-notes.ts";
import { decideCandidate } from "./candidate-decision.ts";
import { parseLaunchFlags } from "./launch-flags.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";
// 被验证那次尝试的真实预算：回执里记的是这组数字
const APPROVED_BUDGET = { maxTurns: 9, wallClockMs: 240_000 };

// 一个验过并已激活的候选，治理根里另放一份与回执一致的验证命令配置
function activated(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-startup-notes-"));
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
      budget: APPROVED_BUDGET,
      verify: { command: "npm test", timeoutMs: 300_000, source: "project" },
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
  writeFileSync(
    join(root, ".pigeon", "verify.json"),
    JSON.stringify({ version: 1, command: "npm test" }),
    "utf8"
  );
  return { root };
}

const flagsOf = (root: string, extra: string[] = []) =>
  parseLaunchFlags(["--root", root, "--provider", "anthropic", "--model", "claude-x", ...extra], {
    usage: "u",
    verify: true,
  });

test("启动告警：交互会话没有预算可比时不判这一项——不报假失效", () => {
  const { root } = activated();
  try {
    const notes = activationStartupWarnings(root, startupEnvironmentOf(flagsOf(root), root));
    assert.deepEqual(notes, [], "模型、验证命令与经验集合都没变，不该报任何失效");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：同一条接线下换了模型仍然报失效——不判预算不等于不判别的", () => {
  const { root } = activated();
  try {
    const notes = activationStartupWarnings(
      root,
      startupEnvironmentOf(flagsOf(root, ["--model", "claude-y"]), root)
    );
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /model/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：同一条接线下换了验证命令仍然报失效", () => {
  const { root } = activated();
  try {
    const notes = activationStartupWarnings(
      root,
      startupEnvironmentOf(flagsOf(root, ["--verify-command", "npm run verify"]), root)
    );
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /verifyCommand/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动告警：预算在场时照常判——无人值守入口给得出预算", () => {
  const { root } = activated();
  try {
    const same = startupEnvironmentOf(flagsOf(root), root);
    assert.deepEqual(
      activationStartupWarnings(root, { ...same, budget: APPROVED_BUDGET }),
      [],
      "与回执一致的预算不该报"
    );
    const widened = activationStartupWarnings(root, { ...same, budget: { maxTurns: 40 } });
    assert.equal(widened.length, 1);
    assert.match(widened[0] ?? "", /budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
