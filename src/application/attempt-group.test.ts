// 并行同任务派发（M7 S4，决策 069 / 071；验证与标签随决策 322 删除）：真实 git 仓库 + 真实装配根 + 假模型。
// - 并行派发同一任务的多个 worker 共享任务标识（派出请求里带同一个标识），父会话写 worker 派出条目；
// - 全部收尾后交回各份的结果（状态、工作树、改动与摘要），各份的对错由主 agent 或人比较；
// - 宿主会话里引用尝试的记录不凭空造出 Run（不误报崩溃残留）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function repo(): { repo: string; home: string; cleanup: () => void } {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-attempts-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-attempts-home-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "old\n");
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

// 按 worker 名给剧本：各份写各的内容
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
  // 宿主会话的会话存储写者：worker 派出与收尾都写在这里
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
  return { hostId, hostStore, orchestrator, faults, taskKeys };
}

function hostView(repo: string, hostId: string): StoreSessionView {
  const loaded = loadStoreSession(join(repo, ".pigeon", "state", "sessions"), hostId);
  assert.ok(loaded !== undefined, "宿主会话在会话存储里有文件");
  return loaded.view;
}

test("两份各改各的：共享任务标识、各份在自己的工作树里改，全部收尾后交回各份结果；宿主会话不误报崩溃残留", async () => {
  const { repo: dir, home, cleanup } = repo();
  try {
    const contentByName: Record<string, string> = {
      "implementer-1": "new\n",
      "implementer-2": "wrong\n",
    };
    const { hostId, hostStore, orchestrator, faults, taskKeys } = setup(dir, home, contentByName);
    const result = await runAttemptGroup({
      orchestrator,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
    });
    await hostStore.close();
    assert.deepEqual(faults, []);
    assert.equal(result.outcomes.length, 2);
    assert.ok(result.outcomes.every((outcome) => outcome.status === "completed"));

    const host = hostView(dir, hostId);
    const spawned = host.workers.flatMap((record) =>
      record.data.event === "spawned" && record.data.role === "implementer" ? [record.data] : []
    );
    assert.equal(spawned.length, 2);
    assert.ok(result.taskKey.length > 0);
    assert.deepEqual(taskKeys, [result.taskKey, result.taskKey], "共享任务标识");
    // 各份在自己的工作树里改：交回的工作树与派出记录一一对应，内容各是各的剧本
    for (const outcome of result.outcomes) {
      const record = spawned.find((item) => item.childSessionId === outcome.sessionId);
      assert.ok(record !== undefined && record.workspace.kind === "git-worktree");
      assert.deepEqual(outcome.workspace, record.workspace);
      if (outcome.workspace.kind === "git-worktree") {
        assert.equal(
          readFileSync(join(outcome.workspace.path, "a.txt"), "utf8"),
          contentByName[outcome.name]
        );
      }
      assert.equal(outcome.result?.summary, "改好了");
    }
    assert.deepEqual(host.runs, [], "引用型记录不凭空造 Run");
  } finally {
    cleanup();
  }
});

test("全做完：各份的结果随收尾全部交回", async () => {
  const { repo: dir, home, cleanup } = repo();
  try {
    const { hostId, hostStore, orchestrator } = setup(dir, home, {});
    const result = await runAttemptGroup({
      orchestrator,
      role: "implementer",
      task: "把 a.txt 的内容改成 new",
      count: 2,
    });
    await hostStore.close();
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.status),
      ["completed", "completed"]
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.result?.summary),
      ["改好了", "改好了"]
    );
    const host = hostView(dir, hostId);
    assert.deepEqual(
      host.workers
        .filter((record) => record.data.event === "settled")
        .map((record) => record.data.childSessionId)
        .sort(),
      result.outcomes.map((outcome) => outcome.sessionId).sort(),
      "各份的收尾记录都写进宿主会话"
    );
  } finally {
    cleanup();
  }
});
