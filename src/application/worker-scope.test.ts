// 会话运行面范围（M5.5 S4，决策 040）：主会话回治理根；worker 会话回自己的工作树与委派策略；
// 父会话记录、派出记录或工作树缺失时拒绝恢复。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION } from "../state/session-entries.ts";
import { createFixtureSession, forkFixture } from "./session-store-fixtures.ts";
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

test("运行面范围（新会话存储）：worker 会话的工作树取自文件头、委派策略取自父会话的派出条目；缺父会话、缺派出、工作树被移除一律拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-store-"));
  try {
    const sessionsDir = sessionsDirOf(root);
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    const workerFile = async (workerId: SessionId, parentId: SessionId, path: string) => {
      const worker = createFixtureSession({
        sessionsDir,
        sessionId: workerId,
        cwd: path,
        parentSessionId: parentId,
        metadata: {
          version: SESSION_ENTRY_VERSION,
          worker: {
            name: "fix-a",
            role: "implementer",
            workspace: { kind: "git-worktree", path, branch: "pigeon/fix-a" },
            startedAt: 1,
          },
        },
      });
      worker.startRun({ task: "改" });
      await worker.close();
    };
    const parent = createFixtureSession({ sessionsDir, cwd: root });
    const workerId = newSessionId();
    parent.workerSpawned({ childSessionId: workerId, name: "fix-a", task: "改" });
    const { sessionId: parentId } = await parent.close();
    await workerFile(workerId, parentId, worktree);
    const scope = sessionRuntimeScope(root, workerId);
    assert.equal(scope.workspaceRoot, worktree);
    assert.equal(scope.parentSessionId, parentId);
    assert.deepEqual(scope.worker, { name: "fix-a", role: "implementer" });
    assert.deepEqual(scope.toolPolicy, {
      allow: ["read_file", "edit_file"],
      deny: [],
      approvalMode: "yolo",
    });
    // 主会话在新存储里：治理根、缺省策略
    assert.deepEqual(sessionRuntimeScope(root, parentId), { workspaceRoot: root });

    const orphan = newSessionId();
    await workerFile(orphan, newSessionId(), worktree);
    assert.throws(() => sessionRuntimeScope(root, orphan), /父会话记录不存在/);
    const unspawned = newSessionId();
    await workerFile(unspawned, parentId, worktree);
    assert.throws(() => sessionRuntimeScope(root, unspawned), /没有派出/);
    rmSync(worktree, { recursive: true, force: true });
    assert.throws(() => sessionRuntimeScope(root, workerId), /工作树已不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行面范围（新会话存储）：分支会话回到文件头记的工作树", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-branch-"));
  try {
    const sessionsDir = sessionsDirOf(root);
    const source = createFixtureSession({ sessionsDir, cwd: root });
    const runId = source.startRun({ task: "改" });
    source.assistant({ text: "好" });
    source.endRun();
    const { sessionId } = await source.close();
    const worktree = join(root, "branch-wt");
    mkdirSync(worktree);
    const branch = await forkFixture({
      sessionsDir,
      sourceSessionId: sessionId,
      runId,
      runSeq: 1,
      cwd: worktree,
    });
    const { sessionId: branchId } = await branch.close();
    assert.deepEqual(sessionRuntimeScope(root, branchId), { workspaceRoot: worktree });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
