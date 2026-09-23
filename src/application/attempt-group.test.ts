// 并行同任务派发（M7 S4，决策 069 / 071）：真实 git 仓库 + 真实装配根 + 假模型。
// - 并行派发同一任务的多个 worker 共享任务标识，写入派出记录；
// - 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令，结果落父会话的通用验证记录；
// - 全部收尾后按账本现算各尝试的标签交回；
// - 宿主会话里引用尝试的记录不凭空造出 Run（不误报崩溃残留）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runAttemptGroup } from "./attempt-group.ts";
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

function setup(repo: string, home: string, scripts: Record<string, string>) {
  const hostId = newSessionId();
  const hostLog = new JsonlEventLog(join(repo, ".pigeon", "sessions"), hostId);
  const factory = createWorkerRuntimeFactory({
    provider: "fake-provider",
    modelId: "fake-model",
    homeDir: home,
    streamFnFor: (request) => attemptScript(scripts[request.name] ?? "new\n"),
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
  return { hostId, hostLog, orchestrator };
}

test("一成一败：共享任务标识、各自工作树里独立验证、按账本现算标签；宿主会话不误报崩溃残留", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, orchestrator } = setup(repo, home, {
      "implementer-1": "new\n",
      "implementer-2": "wrong\n",
    });
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
    });
    hostLog.close();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.attempts.map((attempt) => attempt.label).sort(), ["Failed", "Passed"]);

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
    assert.deepEqual(host.unfinishedRuns, [], "引用型记录不凭空造 Run");
  } finally {
    cleanup();
  }
});

test("全成功：各尝试的标签随结果交回", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, orchestrator } = setup(repo, home, {});
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
    });
    hostLog.close();
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.label),
      ["Passed", "Passed"]
    );
    const host = materializeSession(join(repo, ".pigeon", "sessions"), hostId);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.verification?.sessionId),
      [hostId, hostId],
      "验证记录落在宿主会话里，标签据此现算"
    );
    assert.equal(host.attemptVerifieds.length, 2);
  } finally {
    cleanup();
  }
});
