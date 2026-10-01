// 并行同任务派发（M7 S4，决策 069 / 071）：真实 git 仓库 + 真实装配根 + 假模型。
// - 并行派发同一任务的多个 worker 共享任务标识（派出请求里带同一个标识），父会话写 worker 派出条目；
// - 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令，结果落父会话的验证记录条目；
// - 全部收尾后从会话存储现算各尝试的标签交回；
// - 宿主会话里引用尝试的记录不凭空造出 Run（不误报崩溃残留）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { StoreSessionView } from "../state/session-judge.ts";
import { runAttemptGroup } from "./attempt-group.ts";
import { childFamilySink, openSessionStore } from "./session-store.ts";
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
  // 宿主会话的会话存储写者：worker 派出与收尾、验证记录都写在这里
  const faults: unknown[] = [];
  const hostStore = openSessionStore({
    sessionsDir: join(repo, ".pigeon", "state", "sessions"),
    sessionId: hostId,
    cwd: repo,
    onFault: (fault) => faults.push(fault),
  });
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
    parentLog: childFamilySink(hostStore),
    createRuntime: factory,
    approvals: async () => ({ approved: true }),
  });
  // 记下每次派出请求带的任务标识（任务标识不再写进派出条目）
  const taskKeys: Array<string | undefined> = [];
  const spawn = orchestrator.spawn.bind(orchestrator);
  orchestrator.spawn = (request) => {
    taskKeys.push(request.taskKey);
    return spawn(request);
  };
  return { hostId, hostLog: { sessionId: hostId }, hostStore, orchestrator, faults, taskKeys };
}

function hostView(repo: string, hostId: string): StoreSessionView {
  const loaded = loadStoreSession(join(repo, ".pigeon", "state", "sessions"), hostId);
  assert.ok(loaded !== undefined, "宿主会话在会话存储里有文件");
  return loaded.view;
}

test("一成一败：共享任务标识、各自工作树里独立验证、从会话存储现算标签；宿主会话不误报崩溃残留", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, hostStore, orchestrator, faults, taskKeys } = setup(repo, home, {
      "implementer-1": "new\n",
      "implementer-2": "wrong\n",
    });
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      hostStore,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
    });
    await hostStore.close();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(faults, []);
    assert.deepEqual(result.attempts.map((attempt) => attempt.label).sort(), ["Failed", "Passed"]);

    const host = hostView(repo, hostId);
    const attempts = host.workers.flatMap((record) =>
      record.data.event === "spawned" && record.data.role === "implementer" ? [record.data] : []
    );
    assert.equal(attempts.length, 2);
    assert.ok(result.taskKey.length > 0);
    assert.deepEqual(taskKeys, [result.taskKey, result.taskKey], "共享任务标识");
    assert.equal(host.verifications.length, 2);
    const verdicts = host.verifications.map((record) => record.data.verdict).sort();
    assert.deepEqual(verdicts, ["fail", "pass"]);
    for (const { data: record } of host.verifications) {
      const spawned = attempts.find((item) => item.childSessionId === record.target.sessionId);
      assert.ok(spawned !== undefined && spawned.workspace.kind === "git-worktree");
      assert.equal(record.workspace, spawned.workspace.path, "在该尝试的工作树里执行");
    }
    assert.deepEqual(host.runs, [], "引用型记录不凭空造 Run");
  } finally {
    cleanup();
  }
});

test("全成功：各尝试的标签随结果交回", async () => {
  const { repo, home, cleanup } = repoWithCheck();
  try {
    const { hostId, hostLog, hostStore, orchestrator } = setup(repo, home, {});
    const result = await runAttemptGroup({
      orchestrator,
      governanceRoot: repo,
      hostLog,
      hostStore,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
    });
    await hostStore.close();
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.label),
      ["Passed", "Passed"]
    );
    const host = hostView(repo, hostId);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.verification?.sessionId),
      [hostId, hostId],
      "验证记录落在宿主会话里，标签据此现算"
    );
    assert.equal(host.verifications.length, 2);
  } finally {
    cleanup();
  }
});
