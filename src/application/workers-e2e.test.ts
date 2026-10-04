// 并行 worker 端到端（M5.5 S2，决策 040）：真实 git 仓库 + 真实装配根 + fake streamFn。
// 两个 implementer 各在自己的工作树写入，主仓库工作区零改动；父会话文件里 worker 派出与收尾配对；
// worker 会话文件头记父会话与来历，写操作的工具调用有结果、审批闸决定挂在结果上；审批请求带来源标签。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import { type WorkerApprovalRequest, WorkerOrchestrator } from "../orchestration/workers.ts";
import { worktreePathFor } from "../orchestration/worktree.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { childFamilySink } from "./session-store.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("并行 worker：两个 implementer 各写自己的工作树，主工作区零改动，父会话派出与收尾配对、worker 会话来历与写操作齐全", async () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-workers-")));
  const homeDir = mkdtempSync(join(tmpdir(), "pigeon-home-"));
  try {
    const original = "alpha\nbeta\n";
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.ts"), original);
    git(repo, ["add", "a.ts"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const parentId = newSessionId();
    const sessionsDir = join(repo, ".pigeon", "state", "sessions");
    const faults: unknown[] = [];
    const parentStore = openSessionStoreWriter({
      sessionsRoot: sessionsDir,
      sessionId: parentId,
      cwd: repo,
      lock: acquireSessionFileLock,
      onFault: (fault) => faults.push(fault),
    });
    const approvals: WorkerApprovalRequest[] = [];
    const orchestrator = new WorkerOrchestrator({
      governanceRoot: repo,
      session: { sessionId: parentId },
      parentPolicy: {
        allow: ["read_file", "edit_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
        deny: [],
        approvalMode: "prompt",
      },
      parentLog: childFamilySink(parentStore),
      createRuntime: createWorkerRuntimeFactory({
        provider: "fake-provider",
        modelId: "fake-model-1",
        homeDir,
        // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
        editMode: "hashline",
        streamFnFor: (request) =>
          createFakeStreamFn({
            replies: [
              {
                text: "改",
                toolCalls: [
                  {
                    name: "edit_file",
                    args: {
                      path: "a.ts",
                      snapshot: snapshotTag(original),
                      edits: [
                        { op: "replace", anchor: `2#${lineTag("beta")}`, lines: [request.name] },
                      ],
                    },
                  },
                ],
              },
              { text: `${request.name} 完成` },
            ],
          }),
      }),
      approvals: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
    });

    const first = orchestrator.spawn({ role: "implementer", task: "把 beta 改掉", name: "fix-a" });
    const second = orchestrator.spawn({ role: "implementer", task: "把 beta 改掉", name: "fix-b" });
    assert.equal(orchestrator.status().filter((worker) => worker.state === "running").length, 2);
    const [a, b] = await Promise.all([
      orchestrator.awaitResult(first),
      orchestrator.awaitResult(second),
    ]);
    await parentStore.close();
    assert.deepEqual(faults, []);

    for (const [outcome, id, name] of [
      [a, first, "fix-a"],
      [b, second, "fix-b"],
    ] as const) {
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      assert.deepEqual(outcome.result?.changedFiles, ["a.ts"]);
      assert.equal(outcome.result?.summary, `${name} 完成`);
      assert.equal(
        readFileSync(join(worktreePathFor(repo, id, name), "a.ts"), "utf8"),
        `alpha\n${name}\n`
      );
      // worker 会话：文件头记父会话与来历；唯一的写操作有结果、未出错、经人工批准，Run 正常收尾
      const worker = loadSessionView(sessionsDir, id);
      assert.ok(worker !== undefined, `worker 会话 ${name} 应在会话存储里`);
      assert.equal(worker.parentSessionId, parentId);
      assert.equal(worker.worker?.name, name);
      assert.equal(worker.worker?.role, "implementer");
      const workerWorkspace = worker.worker?.workspace;
      assert.equal(
        workerWorkspace?.kind === "git-worktree" ? workerWorkspace.branch : undefined,
        `pigeon/${name}`
      );
      const calls = worker.runs.flatMap((run) => run.toolCalls);
      assert.deepEqual(
        calls.map((call) => [call.toolName, call.result?.isError]),
        [["edit_file", false]]
      );
      const result = calls[0]?.result;
      assert.deepEqual(
        result !== undefined ? toolResultMark(result.raw as unknown as StoreMessage) : undefined,
        // 决策 302：worker 改自己工作树内的文件默认放行（不问人，记 policy:auto）
        {
          gate: { outcome: "approved", approvedBy: "policy:auto" },
        }
      );
      assert.equal(worker.runs.length, 1);
      assert.equal(worker.runs[0]?.end?.ending, "completed");
    }
    // 主仓库工作区零改动
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);
    assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=no"]), "");
    // 决策 302：改自己工作树不请示（请求区分来源另见 workers-approvals-e2e.test.ts）
    assert.deepEqual(approvals, []);
    assert.ok(first !== second);
    // 父会话：派出与收尾配对（两个 worker 各一对，没有孤立的收尾）
    const parent = loadSessionView(sessionsDir, parentId);
    assert.ok(parent !== undefined);
    assert.deepEqual(
      parent.children.map((child) => child.spawned.childSessionId).sort(),
      [first, second].sort()
    );
    assert.ok(
      parent.children.every(
        (child) =>
          child.settled?.status === "completed" &&
          child.settled.childSessionId === child.spawned.childSessionId
      )
    );
    assert.deepEqual(parent.orphanSettleds, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
