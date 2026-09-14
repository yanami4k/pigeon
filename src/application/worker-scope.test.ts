// 会话运行面范围（M5.5 S4，决策 040）：主会话回治理根；worker 会话回自己的工作树与委派策略；
// 父会话记录、派出记录或工作树缺失时拒绝恢复。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { sessionsDirOf } from "./workspace.ts";

function writeHeader(root: string, workerId: SessionId, parentId: SessionId, path: string): void {
  const log = new JsonlEventLog(sessionsDirOf(root), workerId);
  log.appendSessionHeader({
    parentSessionId: parentId,
    worker: { name: "fix-a", role: "implementer" },
    workspace: { kind: "git-worktree", path, branch: "pigeon/fix-a" },
    startedAt: 1,
  });
  log.close();
}

function writeSpawned(root: string, parentId: SessionId, workerId: SessionId, path: string): void {
  const log = new JsonlEventLog(sessionsDirOf(root), parentId);
  log.appendChildSpawned({
    childSessionId: workerId,
    name: "fix-a",
    role: "implementer",
    task: "改",
    policy: { allow: ["read_file"], deny: ["edit_file"], approvalMode: "prompt" },
    limits: { maxTurns: 5, wallClockMs: 1000 },
    workspace: { kind: "git-worktree", path, branch: "pigeon/fix-a" },
    spawnedAt: 1,
  });
  log.close();
}

test("运行面范围：主会话与不存在的会话回治理根；worker 会话回工作树、委派策略与父会话", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-"));
  try {
    const worktree = join(root, ".pigeon", "worktrees", "x-fix-a");
    mkdirSync(worktree, { recursive: true });
    const parentId = newSessionId();
    const workerId = newSessionId();
    writeSpawned(root, parentId, workerId, worktree);
    writeHeader(root, workerId, parentId, worktree);

    assert.deepEqual(sessionRuntimeScope(root, parentId), { workspaceRoot: root });
    assert.deepEqual(sessionRuntimeScope(root, newSessionId()), { workspaceRoot: root });
    assert.deepEqual(sessionRuntimeScope(root, workerId), {
      workspaceRoot: worktree,
      toolPolicy: { allow: ["read_file"], deny: ["edit_file"], approvalMode: "prompt" },
      parentSessionId: parentId,
      worker: { name: "fix-a", role: "implementer" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行面范围：父会话记录缺失、派出记录缺失、工作树被移除一律拒绝恢复", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-"));
  try {
    const worktree = join(root, ".pigeon", "worktrees", "x-fix-a");
    mkdirSync(worktree, { recursive: true });

    const orphanWorker = newSessionId();
    writeHeader(root, orphanWorker, newSessionId(), worktree);
    assert.throws(() => sessionRuntimeScope(root, orphanWorker), /父会话记录不存在/);

    const parentId = newSessionId();
    writeSpawned(root, parentId, newSessionId(), worktree);
    const unlisted = newSessionId();
    writeHeader(root, unlisted, parentId, worktree);
    assert.throws(() => sessionRuntimeScope(root, unlisted), /没有派出/);

    const gone = join(root, "gone");
    const parent2 = newSessionId();
    const worker2 = newSessionId();
    writeSpawned(root, parent2, worker2, gone);
    writeHeader(root, worker2, parent2, gone);
    assert.throws(() => sessionRuntimeScope(root, worker2), /工作树已不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
