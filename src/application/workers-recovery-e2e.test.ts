// worker 崩溃冷恢复端到端（M5.5 S4，决策 040）：worker 写入后进程死于 receipt 与 child.settled 之前——
// 父会话留"派出未收尾"，worker 会话留悬账（会话列表与 trace 的呈现见 cli/trace-workers.test.ts、
// persistence/session-list.test.ts，读新会话存储）；运行面范围把 worker 会话还原到
// 它自己的工作树与委派策略。本例的会话只写了旧账本（新会话存储里没有文件，即双写之前的旧会话形态）：
// 运行面范围过渡期回退旧账本读法；续跑明确报错（187，旧会话由只读的旧版代码读；哈希对账随 183 删除）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addWorktree } from "../orchestration/worktree.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolGovernance } from "./governance.ts";
import { runResumeFlow } from "./resume.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("worker 崩溃冷恢复（旧账本会话）：父会话标注未收尾，运行面范围回到自己的工作树，续跑明确报错", async () => {
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
    const sessionsDir = join(repo, ".pigeon", "sessions");

    // 父会话派出 worker，进程随后死亡：只有 child.spawned
    const parentId = newSessionId();
    const workerId = newSessionId();
    const worktree = addWorktree({ repoRoot: repo, sessionId: workerId, name: "fix-a" });
    const policy = { allow: ["edit_file"], deny: [], approvalMode: "yolo" as const };
    const workspace = {
      kind: "git-worktree" as const,
      path: worktree.path,
      branch: worktree.branch,
    };
    const parentLog = new JsonlEventLog(sessionsDir, parentId);
    parentLog.appendChildSpawned({
      childSessionId: workerId,
      name: "fix-a",
      role: "implementer",
      task: "改 beta",
      policy,
      limits: { maxTurns: 5, wallClockMs: 60_000 },
      workspace,
      spawnedAt: Date.now(),
    });
    parentLog.close();

    // worker 写入成功，进程死于 receipt 落盘前
    const workerLog = new JsonlEventLog(sessionsDir, workerId);
    workerLog.appendSessionHeader({
      parentSessionId: parentId,
      worker: { name: "fix-a", role: "implementer" },
      workspace,
      startedAt: Date.now(),
    });
    const dying = {
      appendRuntimeEvent: workerLog.appendRuntimeEvent.bind(workerLog),
      appendEntry: workerLog.appendEntry.bind(workerLog),
      appendIntent: workerLog.appendIntent.bind(workerLog),
      appendDecision: workerLog.appendDecision.bind(workerLog),
      appendReceipt: () => {
        throw new Error("进程死于 receipt 落盘前");
      },
      appendBreaker: workerLog.appendBreaker.bind(workerLog),
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
      eventLog: dying,
    });
    await adapter.run("改 beta");
    await adapter.dispose();
    workerLog.close();
    assert.equal(readFileSync(join(worktree.path, "a.ts"), "utf8"), "alpha\nBETA\n");
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);

    // 冷侧可见：父会话未收尾、worker 会话一条悬账
    assert.equal(materializeSession(sessionsDir, parentId).children[0]?.settled, undefined);
    assert.equal(materializeSession(sessionsDir, workerId).reconcile.unknown.length, 1);

    // 运行面范围：worker 会话回到自己的工作树与委派策略
    const scope = sessionRuntimeScope(repo, workerId);
    assert.equal(scope.workspaceRoot, worktree.path);
    assert.deepEqual(scope.toolPolicy, policy);
    assert.equal(scope.parentSessionId, parentId);

    // resume：新会话存储里没有这个会话的文件，明确报错，不进入续会话、不写任何记录
    let entered = false;
    await assert.rejects(
      runResumeFlow({
        root: repo,
        sessionId: workerId,
        write: () => {},
        enterRepl: async () => {
          entered = true;
        },
      }),
      /创建于新会话存储启用之前，不能续跑/
    );
    assert.equal(entered, false);
    assert.equal(materializeSession(sessionsDir, workerId).reconcile.unknown.length, 1);
    assert.equal(materializeSession(sessionsDir, parentId).records.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
