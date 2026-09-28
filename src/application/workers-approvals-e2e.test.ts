// 审批汇聚端到端（M5.5 S3，决策 040）：两个 worker 并发请求审批，经审批队列与 CLI 问答版一次一个；
// 批准与拒绝各自挂在对应 worker 会话文件里那次调用的工具结果上（审批闸标记，拒绝理由在结果正文里）；
// worker 的 [a] 放权只记在该 worker 会话内；父会话只有 worker 派出与收尾，没有工具调用与放权。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createApprovalQueue } from "../approvals/queue.ts";
import { createCliApprovalHandler } from "../cli/approval-ui.ts";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { worktreePathFor } from "../orchestration/worktree.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import type { SessionView } from "../state/session-view.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { childFamilySink } from "./session-store.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

// 会话里每次工具调用：工具名、结果是否出错、审批闸标记、结果正文
function callsOf(view: SessionView) {
  return view.runs
    .flatMap((run) => run.toolCalls)
    .map((call) => ({
      toolName: call.toolName,
      isError: call.result?.isError,
      gate:
        call.result !== undefined
          ? toolResultMark(call.result.raw as unknown as StoreMessage)?.gate
          : undefined,
      text: JSON.stringify(call.result?.blocks ?? []),
    }));
}

function grantsOf(view: SessionView) {
  return view.items.flatMap((item) => (item.kind === "grant" ? [item.data] : []));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("审批汇聚：两个 worker 并发审批一次一个，决定与放权各落各的 worker 会话", async () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-worker-approvals-")));
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
    const faults: unknown[] = [];
    const parentStore = openSessionStoreWriter({
      sessionsRoot: sessionsDir,
      sessionId: parentId,
      cwd: repo,
      lock: acquireSessionFileLock,
      onFault: (fault) => faults.push(fault),
    });

    // 人：看最近一个审批块的来源行作答——fix-a 给 [a]，fix-b 拒绝并给理由
    let screen = "";
    const cli = createCliApprovalHandler(
      async (prompt) => {
        if (prompt.startsWith("拒绝理由")) {
          return "fix-b 不准改";
        }
        // 留出时间让另一个 worker 的请求并发到达
        await new Promise((resolve) => setTimeout(resolve, 20));
        const source = screen.slice(screen.lastIndexOf("来源：worker "));
        return source.startsWith("来源：worker fix-a") ? "a" : "n";
      },
      (text) => {
        screen += text;
      }
    );
    const queue = createApprovalQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const asked: ApprovalRequest[] = [];
    const approvals = queue.wrap(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      asked.push(request);
      try {
        return await cli(request);
      } finally {
        inFlight -= 1;
      }
    });

    const orchestrator = new WorkerOrchestrator({
      governanceRoot: repo,
      session: { sessionId: parentId },
      parentPolicy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
      parentLog: childFamilySink(parentStore),
      approvals,
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
              { text: `${request.name} 结束` },
            ],
          }),
      }),
    });

    const idA = orchestrator.spawn({ role: "implementer", task: "改 beta", name: "fix-a" });
    const idB = orchestrator.spawn({ role: "implementer", task: "改 beta", name: "fix-b" });
    const [a, b] = await Promise.all([
      orchestrator.awaitResult(idA),
      orchestrator.awaitResult(idB),
    ]);
    await parentStore.close();
    assert.deepEqual(faults, []);

    assert.equal(a.status, "completed", JSON.stringify(a));
    assert.equal(b.status, "completed", JSON.stringify(b));
    assert.equal(asked.length, 2);
    assert.equal(maxInFlight, 1, "审批一次一个");
    assert.ok(screen.includes("来源：worker fix-a（implementer）"), screen);
    assert.ok(screen.includes("来源：worker fix-b（implementer）"), screen);

    // fix-a：唯一的调用经人工批准、执行成功；[a] 放权只记在 fix-a 会话
    const workerA = loadSessionView(sessionsDir, idA);
    assert.ok(workerA !== undefined);
    const callsA = callsOf(workerA);
    assert.deepEqual(
      callsA.map(({ toolName, isError, gate }) => ({ toolName, isError, gate })),
      [
        {
          toolName: "edit_file",
          isError: false,
          gate: { outcome: "approved", approvedBy: "human" },
        },
      ]
    );
    const grantsA = grantsOf(workerA);
    assert.equal(grantsA.length, 1);
    assert.equal(grantsA[0]?.event, "created");
    assert.equal(grantsA[0]?.event === "created" ? grantsA[0].tool : undefined, "edit_file");
    assert.equal(
      readFileSync(join(worktreePathFor(repo, idA, "fix-a"), "a.ts"), "utf8"),
      "alpha\nfix-a\n"
    );

    // fix-b：唯一的调用被人工拒绝，拒绝理由逐字在 fix-b 自己的工具结果里；工作树不动，无放权
    const workerB = loadSessionView(sessionsDir, idB);
    assert.ok(workerB !== undefined);
    const callsB = callsOf(workerB);
    assert.deepEqual(
      callsB.map(({ toolName, isError, gate }) => ({ toolName, isError, gate })),
      [{ toolName: "edit_file", isError: true, gate: { outcome: "rejected", approvedBy: "human" } }]
    );
    assert.ok(callsB[0]?.text.includes("fix-b 不准改"), callsB[0]?.text);
    assert.equal(
      callsA.some((call) => call.text.includes("fix-b 不准改")),
      false,
      "fix-b 的拒绝不落进 fix-a 的会话"
    );
    assert.deepEqual(grantsOf(workerB), []);
    assert.equal(readFileSync(join(worktreePathFor(repo, idB, "fix-b"), "a.ts"), "utf8"), original);

    // 父会话：只有两个 worker 的派出与收尾，没有消息（工具调用）与放权
    const parent = loadSessionView(sessionsDir, parentId);
    assert.ok(parent !== undefined);
    assert.equal(parent.children.length, 2);
    assert.deepEqual(
      parent.items.map((item) => item.kind),
      ["worker", "worker", "worker", "worker"]
    );
    assert.equal(parent.messages.length, 0);
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
