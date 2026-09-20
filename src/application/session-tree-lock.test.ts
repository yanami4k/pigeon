// 会话树重建的跨进程保护（并发缺口修复）：重建是"先删整棵树再重导"，
// 而另一个进程的写穿队列可能正在追加同一棵树。树文件本身没有任何跨进程锁，
// 写穿失败又只告警不进账本（决策 080），撞上的结果就是树错乱且无人知晓。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { rebuildSessionTree, runTreeRebuildCommand, treeLockPath } from "./session-tree.ts";
import { sessionsDirOf } from "./workspace.ts";

function ledger(): { root: string; sessionId: SessionId } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tree-lock-"));
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
  log.appendObservation({
    kind: "run.limit-hit",
    runId: newRunId(),
    payload: { limit: "turn-limit" },
  });
  log.close();
  return { root, sessionId };
}

test("树重建：这棵树的锁被占着时，重建明确报错，不删任何东西", async () => {
  const { root, sessionId } = ledger();
  const release = acquireExclusiveLock(
    treeLockPath(root, sessionId),
    "夹具占位：另一个进程在写这棵树"
  );
  try {
    await assert.rejects(
      () => runTreeRebuildCommand({ governanceRoot: root, sessionId }),
      (error: unknown) =>
        error instanceof ExclusiveLockError && /正被另一个进程写入或重建/.test(String(error))
    );
    // 取锁排在删树之前：被拦下时树目录不该被动过
    assert.equal(existsSync(join(root, ".pigeon", "trees")), false, "被拦下时不该碰树文件");
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("树重建：锁放开后照常重建，并且自己用完会放锁", async () => {
  const { root, sessionId } = ledger();
  try {
    const output = await runTreeRebuildCommand({ governanceRoot: root, sessionId });
    assert.match(output, /已由账本重建会话树/);
    assert.equal(existsSync(treeLockPath(root, sessionId)), false, "锁文件不该留下");
    // 连着重建两次不会被自己刚才那把锁挡住
    await rebuildSessionTree({ governanceRoot: root, rootSessionId: sessionId });
    assert.equal(existsSync(treeLockPath(root, sessionId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
