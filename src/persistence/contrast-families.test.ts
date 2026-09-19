// M7 S1 落盘面：通用验证记录、分叉记录、分支会话头、提炼跳过记录经 JsonlEventLog 写入并冷物化分拣；
// 快照观察与撞上限观察走观察族入口；派出记录的共享任务标识随 child.spawned 落盘。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newRunId, newSessionId } from "../state/ids.ts";
import { checkpointAtOrBefore } from "../state/materialize.ts";
import { JsonlEventLog, materializeSession } from "./event-log.ts";

const COMMIT = "a".repeat(40);

test("通用验证、分叉、分支会话头、提炼跳过四族落盘并冷物化；快照与撞上限走观察族", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-contrast-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const branchSessionId = newSessionId();
    const log = new JsonlEventLog(dir, sessionId);
    log.appendChildSpawned({
      childSessionId: newSessionId(),
      name: "implementer-1",
      role: "implementer",
      task: "修复",
      taskKey: "task_01",
      policy: { allow: [], deny: [], approvalMode: "yolo" },
      limits: { maxTurns: 1, wallClockMs: 1 },
      workspace: { kind: "git-worktree", path: "/w", branch: "b" },
      spawnedAt: 1,
    });
    log.appendObservation({
      kind: "workspace.checkpoint",
      runId,
      payload: {
        ref: `refs/pigeon/checkpoints/${sessionId}/1`,
        commit: COMMIT,
        tree: "b".repeat(40),
        toolCallId: "tc-1",
        afterRunSeq: 3,
      },
    });
    log.appendObservation({
      kind: "workspace.checkpoint",
      runId,
      payload: {
        ref: `refs/pigeon/checkpoints/${sessionId}/2`,
        commit: "e".repeat(40),
        tree: "f".repeat(40),
        baseCommit: COMMIT,
        toolCallId: "tc-2",
        afterRunSeq: 7,
      },
    });
    log.appendObservation({ kind: "run.limit-hit", runId, payload: { limit: "wall-clock-limit" } });
    log.appendAttemptVerified({
      target: { sessionId, runId },
      command: ["node", "verify.mjs"],
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      outputBytes: 2,
      outputHash: "0".repeat(64),
      output: "ok",
      truncated: false,
      workspace: dir,
      verdict: "pass",
      verifiedAt: 2,
    });
    log.appendSessionForked({
      runId,
      forkPoint: { runId, runSeq: 5 },
      branchSessionId,
      checkpoint: { ref: `refs/pigeon/checkpoints/${sessionId}/1`, commit: COMMIT },
      trigger: "retry-on-fail",
      forkedAt: 3,
    });
    log.appendDistillSkipped({
      taskKey: "task_01",
      reason: "all-failed",
      attempts: [{ sessionId, runId, label: "Failed" }],
    });
    log.close();

    const branchLog = new JsonlEventLog(dir, branchSessionId);
    branchLog.appendBranchHeader({
      sourceSessionId: sessionId,
      forkPoint: { runId, runSeq: 5 },
      checkpoint: { ref: `refs/pigeon/checkpoints/${sessionId}/1`, commit: COMMIT },
      workspace: { kind: "git-worktree", path: "/w2", branch: "b2" },
      trigger: "retry-on-fail",
      startedAt: 4,
    });
    branchLog.close();

    const session = materializeSession(dir, sessionId);
    assert.equal(session.childSpawneds[0]?.taskKey, "task_01");
    assert.equal(session.checkpoints.length, 2);
    assert.equal(session.limitHits.length, 1);
    assert.equal(session.attemptVerifieds.length, 1);
    assert.equal(session.attemptVerifieds[0]?.verdict, "pass");
    assert.equal(session.sessionForkeds[0]?.branchSessionId, branchSessionId);
    assert.equal(session.distillSkippeds[0]?.reason, "all-failed");
    assert.equal(session.classification.runs.length, 1, "无信封 Run 的新族不凭空造 Run");

    // 快照与条目号的对应可从账本查到：分叉点之前（含）最近的快照
    assert.equal(checkpointAtOrBefore(session, runId, 5)?.commit, COMMIT);
    assert.equal(checkpointAtOrBefore(session, runId, 7)?.commit, "e".repeat(40));
    assert.equal(checkpointAtOrBefore(session, runId, 2), undefined, "首个快照之前没有快照");

    const branch = materializeSession(dir, branchSessionId);
    assert.equal(branch.branchHeader?.sourceSessionId, sessionId);
    assert.equal(branch.sessionHeader, undefined, "分支会话头不是 worker 会话头");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
