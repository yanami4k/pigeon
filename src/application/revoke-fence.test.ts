// 撤销的路径围栏（M8 收口补遗）：撤销是不可逆的递归删除，不能拿激活记录里的自由字符串路径直接删。
// 落点按种类与名字重算，与记录不一致即拒绝；写入器另有一道围栏，只许删治理根下的两个装载目录。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { revokeExperience } from "../activation/activate.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newEntryId, newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { CandidateDecisionError, decideCandidate } from "./candidate-decision.ts";
import { buildCandidateIndex } from "./candidate-lookup.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";

function activated(): { root: string; sessionId: SessionId; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-revoke-fence-"));
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
  log.close();
  decideCandidate({
    governanceRoot: root,
    selector: candidate.contentHash,
    action: "approve",
    reason: "先用起来看看",
    skipStalenessCheck: true,
  });
  return { root, sessionId, contentHash: candidate.contentHash };
}

// 往账本里补一条落点被改写过的激活记录：最后一条激活记录胜出，撤销会读到它
function forgeActivationPath(root: string, contentHash: string, path: string): void {
  const log = new JsonlEventLog(sessionsDirOf(root), newSessionId());
  log.appendCandidateActivated({
    candidateKind: "skill",
    name: "read-before-edit",
    contentHash,
    path,
    activatedHash: contentHash,
    unverified: true,
    decisionId: newEntryId(),
    activatedAt: Date.now() + 1000,
  });
  log.close();
}

test("撤销：激活记录里的落点与按种类名字重算的不一致时，拒绝撤销、不删任何东西", () => {
  const { root, contentHash } = activated();
  try {
    const victim = join(root, "important.txt");
    writeFileSync(victim, "别删我", "utf8");
    forgeActivationPath(root, contentHash, "important.txt");
    assert.throws(
      () =>
        decideCandidate({
          governanceRoot: root,
          selector: contentHash,
          action: "revoke",
          reason: "试试",
        }),
      (error: unknown) => error instanceof CandidateDecisionError && /落点/.test(String(error))
    );
    assert.ok(existsSync(victim), "围栏外的文件一个都不能动");
    // 落点判据必须排在落决定记录之前：判据挪到之后时账本会留一条撤销记录而文件仍在，
    // 事后看就是"撤过但没撤掉"，状态也会从已激活退回已撤销
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.equal(entry?.decided?.action, "approve", "最后一条决定仍是批准，没有多出一条撤销记录");
    assert.equal(entry?.status, "Active", "状态仍是已激活");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("撤销：路径穿越形态的落点同样被拒", () => {
  const { root, contentHash } = activated();
  try {
    forgeActivationPath(root, contentHash, "../../etc/passwd");
    assert.throws(
      () =>
        decideCandidate({
          governanceRoot: root,
          selector: contentHash,
          action: "revoke",
          reason: "试试",
        }),
      CandidateDecisionError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("撤销写入器：围栏只放行治理根下的两个装载目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-revoke-writer-"));
  try {
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "别删我", "utf8");
    assert.throws(
      () => revokeExperience({ governanceRoot: dir, path: "outside.md" }),
      (error: unknown) => /装载目录/.test(String(error))
    );
    assert.ok(existsSync(outside));

    mkdirSync(join(dir, ".pigeon", "memory"), { recursive: true });
    const inside = join(dir, ".pigeon", "memory", "note.md");
    writeFileSync(inside, "可以删", "utf8");
    revokeExperience({ governanceRoot: dir, path: ".pigeon/memory/note.md" });
    assert.ok(!existsSync(inside));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("撤销：正常落点照常撤，围栏不挡合法路径", () => {
  const { root, contentHash } = activated();
  try {
    const target = join(root, ".pigeon", "skills", "read-before-edit", "SKILL.md");
    assert.ok(existsSync(target));
    const result = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "revoke",
      reason: "不再适用",
    });
    assert.equal(result.decision.action, "revoke");
    assert.ok(!existsSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
