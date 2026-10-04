// 会话运行面范围（M5.5 S4，决策 040）：主会话回治理根；worker 会话回自己的工作树与委派策略；
// 父会话记录、派出记录或工作树缺失时拒绝恢复。会话事实一律读会话存储（worker 来历在文件头，委派策略在父会话的派出条目）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION } from "../state/session-entries.ts";
import { createFixtureSession, forkFixture } from "./session-store-fixtures.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { sessionsDirOf } from "./workspace.ts";

test("运行面范围：worker 会话的工作树取自文件头、委派策略取自父会话的派出条目；主会话与不存在的会话回治理根；缺父会话、缺派出、工作树被移除一律拒绝", async () => {
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
    // 主会话：治理根、缺省策略；会话存储里没有的会话同样回治理根
    assert.deepEqual(sessionRuntimeScope(root, parentId), { workspaceRoot: root });
    assert.deepEqual(sessionRuntimeScope(root, newSessionId()), { workspaceRoot: root });

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

test("运行面范围：分支会话回到文件头记的工作树", async () => {
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

test("决策 325：旧会话记着旧位置的工作树（.pigeon/worktrees/…）——按旧前缀到新前缀映射，回到 .pigeon/state/worktrees 下的同名工作树", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-legacy-"));
  try {
    const sessionsDir = sessionsDirOf(root);
    const legacyPath = join(root, ".pigeon", "worktrees", "sess-fix-a");
    const moved = join(root, ".pigeon", "state", "worktrees", "sess-fix-a");
    mkdirSync(moved, { recursive: true });
    const parent = createFixtureSession({ sessionsDir, cwd: root });
    const workerId = newSessionId();
    parent.workerSpawned({ childSessionId: workerId, name: "fix-a", task: "改" });
    const { sessionId: parentId } = await parent.close();
    const worker = createFixtureSession({
      sessionsDir,
      sessionId: workerId,
      cwd: legacyPath,
      parentSessionId: parentId,
      metadata: {
        version: SESSION_ENTRY_VERSION,
        worker: {
          name: "fix-a",
          role: "implementer",
          workspace: { kind: "git-worktree", path: legacyPath, branch: "pigeon/fix-a" },
          startedAt: 1,
        },
      },
    });
    worker.startRun({ task: "改" });
    await worker.close();
    assert.equal(sessionRuntimeScope(root, workerId).workspaceRoot, moved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
