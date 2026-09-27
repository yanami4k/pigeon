// 并行 worker 端到端（M5.5 S2，决策 040）：真实 git 仓库 + 真实装配根 + fake streamFn。
// 两个 implementer 各在自己的工作树写入，主仓库工作区零改动；父会话两族配对；
// worker 会话头记父会话，写操作 intent / receipt 齐全；审批请求带来源标签。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import { type WorkerApprovalRequest, WorkerOrchestrator } from "../orchestration/workers.ts";
import { worktreePathFor } from "../orchestration/worktree.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("并行 worker：两个 implementer 各写自己的工作树，主工作区零改动，父子两族与 worker 证据链齐全", async () => {
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
    const sessionsDir = join(repo, ".pigeon", "sessions");
    const parentLog = new JsonlEventLog(sessionsDir, parentId);
    const approvals: WorkerApprovalRequest[] = [];
    const orchestrator = new WorkerOrchestrator({
      governanceRoot: repo,
      session: { sessionId: parentId },
      parentPolicy: {
        allow: ["read_file", "edit_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
        deny: [],
        approvalMode: "prompt",
      },
      parentLog,
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
    parentLog.close();

    for (const [outcome, id, name] of [
      [a, first, "fix-a"],
      [b, second, "fix-b"],
    ] as const) {
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      assert.deepEqual(outcome.result?.changedFiles, ["a.ts"]);
      // 收尾结果不再带回执号（Q4：回执随 184 停写后失去来源）
      assert.equal(outcome.result?.receiptIds, undefined);
      assert.equal(outcome.result?.summary, `${name} 完成`);
      assert.equal(
        readFileSync(join(worktreePathFor(repo, id, name), "a.ts"), "utf8"),
        `alpha\n${name}\n`
      );
      // worker 会话：会话头记父会话；写操作 intent / receipt 齐全，无悬账
      const worker = materializeSession(sessionsDir, id);
      assert.equal(worker.sessionHeader?.parentSessionId, parentId);
      const workerWorkspace = worker.sessionHeader?.workspace;
      assert.equal(
        workerWorkspace?.kind === "git-worktree" ? workerWorkspace.branch : undefined,
        `pigeon/${name}`
      );
      assert.equal(worker.intents.length, 1);
      assert.equal(worker.receipts.length, 1);
      assert.equal(worker.reconcile.unknown.length, 0);
    }
    // 主仓库工作区零改动
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);
    assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=no"]), "");
    // 审批请求区分来源
    assert.deepEqual(approvals.map((request) => request.worker.name).sort(), ["fix-a", "fix-b"]);
    assert.deepEqual(
      new Set(approvals.map((request) => request.sessionId)),
      new Set([first, second])
    );
    // 父会话：两族配对
    const parent = materializeSession(sessionsDir, parentId);
    assert.equal(parent.children.length, 2);
    assert.ok(parent.children.every((child) => child.settled?.status === "completed"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
