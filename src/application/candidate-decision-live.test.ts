// 活会话期间也能批（M8 收口修复，决策 089 / 040）：候选的来源会话正被另一个进程写着时，
// 审批动作不能因为抢不到那个文件的写入锁就做不了——决定与激活改写进本次命令自己的会话文件，
// 候选状态由跨会话的三族现算得出，单写者约束因此一字未动。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { sessionLockPath } from "../persistence/session-lock.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { decideCandidate } from "./candidate-decision.ts";
import { buildCandidateIndex } from "./candidate-lookup.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";

function staged(): { root: string; sessionId: SessionId; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-decision-live-"));
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
  return { root, sessionId, contentHash: candidate.contentHash };
}

// 模拟"另一个存活进程正在写这个会话"：真的起一个空转子进程，把它的 pid 写进锁文件。
// 不能用本进程 pid——会话锁把"pid 与本进程相同但本进程并未持有"判为 pid 复用的残留锁并直接接管。
// 返回收尾函数，测试结束时杀掉子进程
function lockAsOtherProcess(root: string, sessionId: SessionId): () => void {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(
    sessionLockPath(sessionsDirOf(root), sessionId),
    JSON.stringify({ pid: child.pid, acquiredAt: Date.now() }),
    "utf8"
  );
  return () => {
    child.kill();
  };
}

test("活会话：来源会话被别的进程写着时，批准照常完成并激活", () => {
  const { root, sessionId, contentHash } = staged();
  let release: (() => void) | undefined;
  try {
    release = lockAsOtherProcess(root, sessionId);
    const result = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "approve",
      reason: "先用起来看看",
      skipStalenessCheck: true,
    });
    assert.equal(result.decision.action, "approve");
    assert.equal(result.activation?.activatedHash, contentHash);
    // 来源会话文件没被动过：它的写入者仍然只有那个活进程
    const source = materializeSession(sessionsDirOf(root), sessionId, { content: false });
    assert.deepEqual(source.candidateDecideds, []);
    assert.deepEqual(source.candidateActivateds, []);
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("活会话：决定落在别的会话文件里，候选状态仍由跨会话的三族现算出来", () => {
  const { root, sessionId, contentHash } = staged();
  let release: (() => void) | undefined;
  try {
    release = lockAsOtherProcess(root, sessionId);
    decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "approve",
      reason: "先用起来看看",
      skipStalenessCheck: true,
    });
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.equal(entry?.status, "Active");
    assert.equal(entry?.activated?.unverified, true);
    assert.notEqual(entry?.decided?.sessionId, sessionId, "决定记录不在来源会话文件里");
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("活会话：撤销同样不需要来源会话的写入锁", () => {
  const { root, sessionId, contentHash } = staged();
  let release: (() => void) | undefined;
  try {
    decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "approve",
      reason: "先用起来看看",
      skipStalenessCheck: true,
    });
    release = lockAsOtherProcess(root, sessionId);
    const result = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "revoke",
      reason: "不再适用",
    });
    assert.equal(result.decision.action, "revoke");
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.equal(entry?.status, "Revoked");
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});
