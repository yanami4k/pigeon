// 审批汇聚端到端（M5.5 S3，决策 040）：两个 worker 并发请求审批，经审批队列与 CLI 问答版一次一个；
// 批准与拒绝各自落进对应 worker 的会话文件并绑定其 executionId；worker 的 [a] 放权只活在该 worker
// 会话内；父会话不出现任何工具治理记录。
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
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

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
    const parentLog = new JsonlEventLog(sessionsDir, parentId);

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
      parentLog,
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
    parentLog.close();

    assert.equal(a.status, "completed", JSON.stringify(a));
    assert.equal(b.status, "completed", JSON.stringify(b));
    assert.equal(asked.length, 2);
    assert.equal(maxInFlight, 1, "审批一次一个");
    assert.ok(screen.includes("来源：worker fix-a（implementer）"), screen);
    assert.ok(screen.includes("来源：worker fix-b（implementer）"), screen);

    // fix-a：批准落 intent（绑定 fix-a 自己的 executionId），[a] 放权只在 fix-a 会话
    const workerA = materializeSession(sessionsDir, idA);
    assert.equal(workerA.intents.length, 1);
    assert.equal(workerA.intents[0]?.decision.approvedBy, "human");
    assert.equal(workerA.decisions.length, 0);
    assert.equal(workerA.grants.length, 1);
    assert.equal(workerA.grants[0]?.tool, "edit_file");
    assert.equal(
      readFileSync(join(worktreePathFor(repo, idA, "fix-a"), "a.ts"), "utf8"),
      "alpha\nfix-a\n"
    );

    // fix-b：拒绝理由逐字落 fix-b 自己的 decision，工作树不动，无放权
    const workerB = materializeSession(sessionsDir, idB);
    assert.equal(workerB.intents.length, 0);
    assert.equal(workerB.decisions[0]?.decision.reason, "fix-b 不准改");
    assert.equal(workerB.grants.length, 0);
    const bExecution = workerB.decisions[0]?.executionId;
    assert.ok(bExecution !== undefined);
    assert.equal(
      workerA.intents.some((intent) => intent.executionId === bExecution),
      false
    );
    assert.equal(readFileSync(join(worktreePathFor(repo, idB, "fix-b"), "a.ts"), "utf8"), original);

    // 父会话：只有父子两族，无工具治理记录与放权
    const parent = materializeSession(sessionsDir, parentId);
    assert.equal(parent.children.length, 2);
    assert.equal(parent.intents.length + parent.decisions.length + parent.grantCreateds.length, 0);
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), original);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
