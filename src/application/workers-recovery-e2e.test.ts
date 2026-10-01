// worker 崩溃冷恢复端到端（M5.5 S4，决策 040）：worker 写入后进程死于工具结果与 worker 收尾落盘之前——
// 父会话留"派出未收尾"，worker 会话留没有结果的工具调用与没有收尾的 Run（会话列表与 trace 的呈现见
// cli/trace-workers.test.ts、persistence/session-list.test.ts）；运行面范围把 worker 会话还原到它自己的工作树与
// 委派策略；续跑报告将补"结果未知"的悬空调用后进入续会话入口（决策 183）。
// 旧格式会话（迁移之前创建、会话根下平铺的文件）不能续跑，明确报错（187 / 211）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addWorktree } from "../orchestration/worktree.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter, type SessionStoreSink } from "../pi-runtime/session-store.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION } from "../state/session-entries.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolGovernance } from "./governance.ts";
import { runResumeFlow } from "./resume.ts";
import { childFamilySink } from "./session-store.ts";
import { writeLegacySessionFile } from "./session-view-fixtures.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("worker 崩溃冷恢复：父会话标注未收尾，worker 会话留悬空调用，运行面范围回到自己的工作树，续跑报告悬空调用", async () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-worker-recovery-")));
  try {
    const original = "alpha\nbeta\n";
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.ts"), original);
    git(repo, ["add", "a.ts"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const sessionsDir = join(repo, ".pigeon", "state", "sessions");

    // 父会话派出 worker，进程随后死亡：父会话文件里只有派出条目
    const parentId = newSessionId();
    const workerId = newSessionId();
    const worktree = addWorktree({ repoRoot: repo, sessionId: workerId, name: "fix-a" });
    const policy = { allow: ["edit_file"], deny: [], approvalMode: "yolo" as const };
    const workspace = {
      kind: "git-worktree" as const,
      path: worktree.path,
      branch: worktree.branch,
    };
    const faults: unknown[] = [];
    const parentStore = openSessionStoreWriter({
      sessionsRoot: sessionsDir,
      sessionId: parentId,
      cwd: repo,
      lock: acquireSessionFileLock,
      onFault: (fault) => faults.push(fault),
    });
    childFamilySink(parentStore).appendChildSpawned({
      childSessionId: workerId,
      name: "fix-a",
      role: "implementer",
      task: "改 beta",
      policy,
      limits: { maxTurns: 5, wallClockMs: 60_000 },
      workspace,
      spawnedAt: Date.now(),
    });
    await parentStore.close();

    // worker 写入成功，进程死于工具结果落盘前：工具结果及其后的写入全部丢失
    const workerStore = openSessionStoreWriter({
      sessionsRoot: sessionsDir,
      sessionId: workerId,
      cwd: worktree.path,
      lock: acquireSessionFileLock,
      parentSessionId: parentId,
      metadata: {
        version: SESSION_ENTRY_VERSION,
        worker: { name: "fix-a", role: "implementer", workspace, startedAt: Date.now() },
      },
      onFault: (fault) => faults.push(fault),
    });
    let dead = false;
    const dying: SessionStoreSink = {
      appendMessage: (message) => {
        dead ||= message.role === "toolResult";
        if (!dead) {
          workerStore.appendMessage(message);
        }
      },
      append: (entry) => {
        if (!dead) {
          workerStore.append(entry);
        }
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "edit_file",
      description: "hashline 锚定稀疏编辑",
      parameters: EditFileParamsSchema,
      tier: "write",
      pathConfinement: { kind: "workspace" },
      executionMode: "sequential",
    });
    const adapter = new PiRuntimeAdapter({
      snapshot: {
        version: INJECTION_SNAPSHOT_VERSION,
        model: { provider: "fake-provider", id: "fake-model-1" },
        tools: { policy, advertised: policy.allow },
        context: { systemPrompt: "测试" },
        memory: [],
        skills: [],
        createdAt: 1,
      },
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [
              {
                name: "edit_file",
                args: {
                  path: "a.ts",
                  snapshot: snapshotTag(original),
                  edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
                },
              },
            ],
          },
          { text: "完成" },
        ],
      }),
      tools: [createEditFileTool(worktree.path)],
      governance: createToolGovernance({ registry, workspaceRoot: worktree.path }),
      sessionId: workerId,
      sessionStore: dying,
    });
    await adapter.run("改 beta");
    await adapter.dispose();
    await workerStore.close();
    assert.deepEqual(faults, []);
    assert.equal(dead, true, "剧本应走到工具结果");
    assert.equal(readFileSync(join(worktree.path, "a.ts"), "utf8"), "alpha\nBETA\n");
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);

    // 冷侧可见：父会话派出一个、未收尾；worker 会话一个 Run 没有收尾，唯一的工具调用没有结果
    const parent = loadSessionView(sessionsDir, parentId);
    assert.equal(parent?.children.length, 1);
    assert.equal(parent?.children[0]?.spawned.childSessionId, workerId);
    assert.equal(parent?.children[0]?.settled, undefined);
    const worker = loadSessionView(sessionsDir, workerId);
    assert.equal(worker?.parentSessionId, parentId);
    assert.equal(worker?.worker?.name, "fix-a");
    assert.equal(worker?.runs.length, 1);
    assert.equal(worker?.runs[0]?.end, undefined);
    assert.deepEqual(
      worker?.runs[0]?.toolCalls.map((call) => [call.toolName, call.result]),
      [["edit_file", undefined]]
    );

    // 运行面范围：worker 会话回到自己的工作树与委派策略
    const scope = sessionRuntimeScope(repo, workerId);
    assert.equal(scope.workspaceRoot, worktree.path);
    assert.deepEqual(scope.toolPolicy, policy);
    assert.equal(scope.parentSessionId, parentId);

    // resume：报告未收尾的 Run 与悬空调用后进入续会话入口（真正补结果在装配运行面时，这里入口是桩，不写文件）
    const output: string[] = [];
    let entered = false;
    await runResumeFlow({
      root: repo,
      sessionId: workerId,
      write: (text) => output.push(text),
      enterRepl: async () => {
        entered = true;
      },
    });
    assert.equal(entered, true);
    const report = output.join("");
    assert.ok(report.includes(`会话 ${workerId} 续跑：还原对话上下文 2 条消息。`), report);
    assert.ok(report.includes("1 个 Run 没有收尾记录（进程死于中途）"), report);
    assert.ok(report.includes("末条助手消息有 1 个工具调用没有结果（edit_file）"), report);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("旧格式会话续跑：明确报错并指向只读的旧版代码，不进入续会话、不在会话存储里建文件", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pigeon-worker-recovery-legacy-"));
  try {
    const sessionsDir = join(repo, ".pigeon", "state", "sessions");
    const legacyId = writeLegacySessionFile(sessionsDir);
    let entered = false;
    await assert.rejects(
      runResumeFlow({
        root: repo,
        sessionId: legacyId,
        write: () => {},
        enterRepl: async () => {
          entered = true;
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `会话 ${legacyId} 是旧格式会话（迁移之前创建），不能续跑；旧格式会话请用只读的旧版代码 455d88d 读取`
    );
    assert.equal(entered, false);
    assert.deepEqual(listSessionFiles(sessionsDir), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
