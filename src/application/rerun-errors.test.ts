// 内部故障不吞（M8 收口补遗）：回放收尾时编排器自己攒的故障（工作树清理失败之类）要进错误清单，
// 包括 awaitResult 抛出的那条路径——此前只在正常返回后收集，抛出时整批丢掉。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerOutcome } from "../orchestration/workers.ts";
import type { AttemptPlan } from "../replay/plan.ts";
import { newSessionId } from "../state/ids.ts";
import { createRerunDispatcher } from "./rerun.ts";

// 一次性 git 仓库：回放要从起点提交开独立工作树
function repo(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-rerun-errors-"));
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "a\n", "utf8");
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n", "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@localhost");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { root, commit: git("rev-parse", "HEAD").trim() };
}

function planOf(commit: string): AttemptPlan {
  return {
    sessionId: newSessionId(),
    runId: "run_x" as AttemptPlan["runId"],
    task: "重跑",
    startCommit: commit,
    startSource: "given",
    budget: { maxTurns: 3, wallClockMs: 1000 },
    budgetSource: "run-started",
    model: { provider: "p", id: "m", thinkingLevel: "off" },
    approvalMode: "yolo",
    tools: ["read_file"],
  };
}

const CONTENT_HASH = "a".repeat(64);

test("回放收尾：awaitResult 抛出时，编排器自己攒的故障仍然进错误清单", async () => {
  const { root, commit } = repo();
  try {
    const orchestratorError = new Error("工作树清理失败（夹具）");
    const dispatcher = createRerunDispatcher({
      governanceRoot: root,
      repoRoot: root,
      hostSessionId: newSessionId(),
      hostLog: { appendChildSpawned: () => undefined, appendChildSettled: () => undefined },
      nameSeed: CONTENT_HASH,
      runtimeFactoryFor: () => {
        throw new Error("不该装配运行面");
      },
      verify: { command: 'node -e ""', timeoutMs: 1000 },
      orchestratorFor: () => ({
        spawn: () => newSessionId(),
        awaitResult: () => Promise.reject(new Error("派出失败（夹具）")),
        errors: () => [orchestratorError],
      }),
    });
    await assert.rejects(
      () => dispatcher.rerun({ arm: "failed-baseline", index: 1, plan: planOf(commit) }),
      /派出失败/
    );
    assert.ok(
      dispatcher.errors().includes(orchestratorError),
      `编排器的内部故障应进错误清单，实际：${dispatcher.errors().map(String).join("；")}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回放收尾：正常返回时同样收集编排器的内部故障，不重复收", async () => {
  const { root, commit } = repo();
  try {
    const orchestratorError = new Error("收尾写盘失败（夹具）");
    const outcome: WorkerOutcome = {
      sessionId: newSessionId(),
      name: "verify-aaaaaaaa-fb-1",
      role: "verifier",
      status: "completed",
      turns: 1,
      workspace: { kind: "none" },
    };
    const dispatcher = createRerunDispatcher({
      governanceRoot: root,
      repoRoot: root,
      hostSessionId: newSessionId(),
      hostLog: { appendChildSpawned: () => undefined, appendChildSettled: () => undefined },
      nameSeed: CONTENT_HASH,
      runtimeFactoryFor: () => {
        throw new Error("不该装配运行面");
      },
      verify: { command: 'node -e ""', timeoutMs: 1000 },
      orchestratorFor: () => ({
        spawn: () => outcome.sessionId,
        awaitResult: () => Promise.resolve(outcome),
        errors: () => [orchestratorError],
      }),
    });
    const result = await dispatcher.rerun({
      arm: "failed-baseline",
      index: 1,
      plan: planOf(commit),
    });
    // 回放会话没有 Run（运行面是夹具），判决按未定
    assert.equal(result.run.verdict, "undetermined");
    assert.deepEqual(dispatcher.errors(), [orchestratorError]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
