// 决定动作的互斥：批准、拒绝、撤销、取代与验证共用同一把按候选哈希取的锁。
// 此前决定动作全程不取锁，而同一条候选的验证是取锁的——两个进程同时批准与撤销同一条候选时，
// 账本里两条决定记录的先后随机，落点文件可能被删除那一方赢在最后，而状态投影按"最后一条决定"
// 算出已激活：文件没了，状态却说它激活着。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { decideCandidate } from "./candidate-decision.ts";
import { candidateLockPath } from "./candidate-lookup.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";

function staged(): { root: string; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-decision-lock-"));
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
  log.close();
  return { root, contentHash: candidate.contentHash };
}

const ACTIONS = ["approve", "reject", "revoke", "supersede"] as const;

test("决定互斥：这条候选的锁被占着时，四个决定动作一律被拒", () => {
  const { root, contentHash } = staged();
  const release = acquireExclusiveLock(
    candidateLockPath(root, contentHash),
    "夹具占位：另一件事在跑"
  );
  try {
    for (const action of ACTIONS) {
      assert.throws(
        () =>
          decideCandidate({
            governanceRoot: root,
            selector: contentHash,
            action,
            reason: "试试",
            supersededBy: "b".repeat(64),
            skipStalenessCheck: true,
          }),
        ExclusiveLockError,
        `${action} 应当被互斥拦下`
      );
    }
    // 取锁要排在任何写入之前：被拦下时不得留下任何痕迹
    assert.equal(
      existsSync(join(root, ".pigeon", "skills", "read-before-edit")),
      false,
      "被互斥拦下时不该写落点"
    );
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("决定互斥：锁放开后照常走通，并且自己用完会放锁", () => {
  const { root, contentHash } = staged();
  try {
    const result = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "approve",
      reason: "先用起来看看",
      skipStalenessCheck: true,
    });
    assert.equal(result.decision.action, "approve");
    assert.equal(result.activation?.activatedHash, contentHash);
    // 用完即放：紧接着的撤销不该被自己刚才那把锁挡住
    const revoked = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "revoke",
      reason: "不再适用",
    });
    assert.equal(revoked.decision.action, "revoke");
    assert.equal(existsSync(candidateLockPath(root, contentHash)), false, "锁文件不该留下");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("决定互斥：异常路径同样放锁——被拦下的批准不会把锁留给后面的人", () => {
  const { root, contentHash } = staged();
  try {
    // 未经回放验证且不给理由：批准会被拒
    assert.throws(() =>
      decideCandidate({
        governanceRoot: root,
        selector: contentHash,
        action: "approve",
        skipStalenessCheck: true,
      })
    );
    assert.equal(existsSync(candidateLockPath(root, contentHash)), false, "抛出之后锁要放掉");
    assert.doesNotThrow(() =>
      decideCandidate({
        governanceRoot: root,
        selector: contentHash,
        action: "reject",
        reason: "算了",
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
