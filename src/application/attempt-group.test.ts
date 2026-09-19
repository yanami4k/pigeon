// 并行同任务派发与自动提炼（M7 S4，决策 069 / 071 / 074）：真实 git 仓库 + 真实装配根 + 假模型。
// - 并行派发同一任务的多个 worker 共享任务标识，写入派出记录；
// - 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令，结果落父会话的通用验证记录；
// - 全部收尾后自动选对并派提炼器（无工作区、预算缺省 16 轮 / 5 分钟 / 80,000 token），候选 v3 落暂存目录；
// - 全成功或全失败时不提炼，留一条带原因的提炼跳过记录；
// - 提炼与 Reviewer 共用全局并发闸：闸忙时等上一个收尾再派；
// - 宿主会话里引用被提炼尝试的记录不凭空造出 Run（不误报崩溃残留）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { createReviewGate } from "../review/scheduler.ts";
import { newSessionId } from "../state/ids.ts";
import { runAttemptGroup } from "./attempt-group.ts";
import { createDistillDispatcher, DEFAULT_DISTILL_BUDGET } from "./distill-runtime.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const NODE = `"${process.execPath}"`;

function repoWithCheck(): { repo: string; home: string; cleanup: () => void } {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-attempts-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-attempts-home-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "old\n");
  writeFileSync(
    join(repo, "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return {
    repo,
    home,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// 按 worker 名给剧本：写对的写 new，写错的写 wrong
function attemptScript(content: string) {
  return createFakeStreamFn({
    replies: [
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
        ],
      },
      { text: "改好了" },
    ],
  });
}

const DISTILLED = JSON.stringify({
  candidates: [
    {
      kind: "skill",
      name: "write-exact-content",
      summary: "按要求逐字写入内容",
      strength: 0.6,
      form: "procedure",
      content:
        "---\nname: write-exact-content\ndescription: 按要求逐字写入\n---\n1. 写入前核对目标文本\n",
      evidence: { successful: [2], failed: [2] },
    },
  ],
});

function setup(repo: string, home: string, scripts: Record<string, string>) {
  const hostId = newSessionId();
  const hostLog = new JsonlEventLog(join(repo, ".pigeon", "sessions"), hostId);
  const factory = createWorkerRuntimeFactory({
    provider: "fake-provider",
    modelId: "fake-model",
    homeDir: home,
    streamFnFor: (request) =>
      request.role === "distiller"
        ? createFakeStreamFn({ replies: [{ text: DISTILLED }] })
        : attemptScript(scripts[request.name] ?? "new\n"),
  });
  const parentPolicy = {
    allow: ["read_file", "edit_file"],
    deny: [],
    approvalMode: "yolo" as const,
  };
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: repo,
    session: { sessionId: hostId },
    parentPolicy,
    parentLog: hostLog,
    createRuntime: factory,
    approvals: async () => ({ approved: true }),
  });
  return { hostId, hostLog, factory, parentPolicy, orchestrator };
}

test("一成一败：共享任务标识、各自工作树里独立验证、自动派提炼器产出 v3 候选；宿主会话不误报崩溃残留", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, factory, parentPolicy, orchestrator } = setup(repo, home, {
      "implementer-1": "new\n",
      "implementer-2": "wrong\n",
    });
    const gate = createReviewGate();
    const dispatcher = createDistillDispatcher({
      governanceRoot: repo,
      hostSessionId: hostId,
      hostLog,
      parentPolicy,
      createRuntime: factory,
      gate,
    });
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
      distill: dispatcher,
    });
    hostLog.close();
    assert.equal(result.skip, undefined);
    assert.equal(result.distill?.status, "completed");
    assert.equal(result.distill?.persisted?.written.length, 1);

    const host = materializeSession(join(repo, ".pigeon", "sessions"), hostId);
    const attempts = host.childSpawneds.filter((record) => record.role === "implementer");
    assert.equal(attempts.length, 2);
    assert.ok(result.taskKey.length > 0);
    assert.ok(
      attempts.every((record) => record.taskKey === result.taskKey),
      "共享任务标识"
    );
    assert.equal(host.attemptVerifieds.length, 2);
    const verdicts = host.attemptVerifieds.map((record) => record.verdict).sort();
    assert.deepEqual(verdicts, ["fail", "pass"]);
    for (const record of host.attemptVerifieds) {
      const spawned = attempts.find((item) => item.childSessionId === record.target.sessionId);
      assert.ok(spawned !== undefined && spawned.workspace.kind === "git-worktree");
      assert.equal(record.workspace, spawned.workspace.path, "在该尝试的工作树里执行");
    }
    const distiller = host.childSpawneds.find((record) => record.role === "distiller");
    assert.ok(distiller !== undefined);
    assert.deepEqual(distiller.workspace, { kind: "none" });
    assert.deepEqual(distiller.limits, DEFAULT_DISTILL_BUDGET);
    assert.equal(DEFAULT_DISTILL_BUDGET.maxTurns, 16);
    assert.equal(DEFAULT_DISTILL_BUDGET.wallClockMs, 300_000);
    assert.equal(DEFAULT_DISTILL_BUDGET.maxTokens, 80_000);
    const distillSession = materializeSession(
      join(repo, ".pigeon", "sessions"),
      distiller.childSessionId
    );
    assert.deepEqual(
      distillSession.runStarteds[0]?.payload.advertisedTools.sort(),
      ["distill_entry", "distill_snapshot"],
      "提炼器会话只广告两个只读工具"
    );
    const candidate = host.candidateProposeds[0]?.candidate;
    assert.equal(candidate?.origin, "distiller");
    assert.equal(candidate?.contrast?.successful[0]?.label, "Passed");
    assert.equal(candidate?.contrast?.failed[0]?.label, "Failed");
    assert.equal(host.candidateScreeneds[0]?.hits.length, 0);
    assert.deepEqual(host.unfinishedRuns, [], "引用型记录不凭空造 Run");
    assert.equal(readdirSync(join(repo, ".pigeon", "candidates", "skill")).length, 1);
  } finally {
    cleanup();
  }
});

test("全成功：不提炼，留一条带原因的提炼跳过记录", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, factory, parentPolicy, orchestrator } = setup(repo, home, {});
    const dispatcher = createDistillDispatcher({
      governanceRoot: repo,
      hostSessionId: hostId,
      hostLog,
      parentPolicy,
      createRuntime: factory,
      gate: createReviewGate(),
    });
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
      distill: dispatcher,
    });
    hostLog.close();
    assert.equal(result.skip, "all-passed");
    assert.equal(result.distill, undefined);
    const host = materializeSession(join(repo, ".pigeon", "sessions"), hostId);
    assert.equal(host.distillSkippeds[0]?.reason, "all-passed");
    assert.equal(host.distillSkippeds[0]?.taskKey, result.taskKey);
    assert.equal(host.distillSkippeds[0]?.attempts.length, 2);
    assert.equal(host.childSpawneds.filter((record) => record.role === "distiller").length, 0);
  } finally {
    cleanup();
  }
});

test("共用全局并发闸：闸被占用时提炼等上一个收尾再派", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, factory, parentPolicy, orchestrator } = setup(repo, home, {
      "implementer-1": "new\n",
      "implementer-2": "wrong\n",
    });
    const gate = createReviewGate();
    assert.ok(gate.tryAcquire(), "模拟一个在跑的审阅占住闸");
    const dispatcher = createDistillDispatcher({
      governanceRoot: repo,
      hostSessionId: hostId,
      hostLog,
      parentPolicy,
      createRuntime: factory,
      gate,
    });
    const pending = runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
      distill: dispatcher,
    });
    // 等两个尝试收尾与验证落盘，提炼应仍在等闸
    for (let i = 0; i < 200; i++) {
      const host = materializeSession(join(repo, ".pigeon", "sessions"), hostId);
      if (host.attemptVerifieds.length === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiting = materializeSession(join(repo, ".pigeon", "sessions"), hostId);
    assert.equal(
      waiting.childSpawneds.filter((record) => record.role === "distiller").length,
      0,
      "闸忙时不派"
    );
    gate.release();
    const result = await pending;
    hostLog.close();
    assert.equal(result.distill?.status, "completed");
    assert.equal(gate.busy(), false, "提炼收尾后释放闸");
  } finally {
    cleanup();
  }
});
