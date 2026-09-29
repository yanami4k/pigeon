// 终端界面里编排一段的三处改动（决策 294、297、303）：agent 派出的 worker 也即时刷新（生命周期事件驱动，修"agent 派出的
// worker 不刷新状态行"；决策 301 起显示在编排面板）；完成通知到来时主 agent 空闲即叫醒跑一轮、在跑时等这一轮结束再接着跑；/tasks 查看任务清单；
// worker 的请示等满时限被撤回时审批面板撤下。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SpawnRequest, WorkerOutcome, WorkerStatus } from "../application/workers-commands.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { APPROVAL_WITHDRAWN } from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace, type TuiWorkersFace } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";

function runResult(): RunResult {
  return {
    runId: newRunId(),
    status: "completed",
    syntheticFailure: false,
    failure: null,
    advertisedTools: [],
  } as unknown as RunResult;
}

// 运行面替身：run 与 runNotices 各自挂起到测试放行；待递通知数由测试设定
class NoticeRuntime implements TuiRuntimeFace {
  pending = 0;
  readonly runs: string[] = [];
  #current: ReturnType<typeof Promise.withResolvers<RunResult>> | undefined;

  run(input: string): Promise<RunResult> {
    this.runs.push(`run:${input}`);
    this.#current = Promise.withResolvers<RunResult>();
    return this.#current.promise;
  }
  pendingNotices(): number {
    return this.pending;
  }
  runNotices(): Promise<RunResult> {
    this.runs.push(`notices:${this.pending}`);
    this.pending = 0;
    this.#current = Promise.withResolvers<RunResult>();
    return this.#current.promise;
  }
  finish(): void {
    this.#current?.resolve(runResult());
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  listenerErrors(): unknown[] {
    return [];
  }
  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }
  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

// 编排面替身：agent 派出时不经 /spawn，只经生命周期事件告知壳
class EventedWorkers implements TuiWorkersFace {
  readonly entries: WorkerStatus[] = [];
  readonly #listeners = new Set<() => void>();

  spawn(request: SpawnRequest): SessionId {
    return this.agentSpawn(request.name ?? "w");
  }
  agentSpawn(name: string): SessionId {
    const sessionId = newSessionId();
    this.entries.push({
      sessionId,
      name,
      role: "explorer",
      state: "running",
      turns: 1,
      branch: `pigeon/${name}`,
      startedAt: 0,
      workspace: { kind: "git-worktree", path: `/wt/${name}`, branch: `pigeon/${name}` },
    });
    this.#emit();
    return sessionId;
  }
  settle(name: string): void {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (entry !== undefined) entry.state = "completed";
    this.#emit();
  }
  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async cancel(): Promise<void> {}
  status(): WorkerStatus[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
  awaitResult(): Promise<WorkerOutcome> {
    return Promise.withResolvers<WorkerOutcome>().promise;
  }
}

async function submit(term: MockTerminal, text: string): Promise<void> {
  term.input(text);
  term.input("\r");
  await settle();
}

function shellWith(options: {
  runtime: NoticeRuntime;
  workers?: EventedWorkers;
  tasks?: () => string | undefined;
}) {
  const term = new MockTerminal(140, 50);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: options.runtime,
    sessionId: newSessionId(),
    logDir: mkdtempSync(join(tmpdir(), "pigeon-tui-orch-")),
    ...(options.workers !== undefined ? { workers: options.workers } : {}),
    ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
    workerRefreshMs: 20,
  });
  return { term, shell };
}

test("agent 派出的 worker：不经 /spawn 也即时出现在编排面板，收尾时那一行跟着变", async () => {
  const workers = new EventedWorkers();
  const { term, shell } = shellWith({ runtime: new NoticeRuntime(), workers });
  try {
    shell.start();
    await settle();
    assert.ok(!screenFlat(term).includes("look-a"), screenFlat(term));
    workers.agentSpawn("look-a");
    await settle();
    assert.match(screenFlat(term), /look-a\s+running\s+\S+\s+1t/);
    workers.settle("look-a");
    await settle();
    assert.match(screenFlat(term), /look-a\s+done\s+/);
  } finally {
    shell.stop();
  }
});

test("完成通知：空闲即叫醒跑一轮只带通知的运行；在跑时不打断，这一轮结束后接着处理", async () => {
  const runtime = new NoticeRuntime();
  const { term, shell } = shellWith({ runtime });
  try {
    shell.start();
    await settle();
    // 空闲：通知到来即叫醒
    runtime.pending = 1;
    shell.addSystem("[worker 通知] worker a（explorer）已完成。");
    shell.runNotices();
    await settle();
    assert.deepEqual(runtime.runs, ["notices:1"]);
    assert.ok(screenFlat(term).includes("[worker 通知] worker a（explorer）已完成。"));
    assert.ok(screenFlat(term).includes("state: running"), screenFlat(term));
    // 在跑：又来一条，不另起运行
    runtime.pending = 1;
    shell.runNotices();
    await settle();
    assert.deepEqual(runtime.runs, ["notices:1"]);
    // 这一轮结束：还有待递的通知，接着跑
    runtime.finish();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    assert.deepEqual(runtime.runs, ["notices:1", "notices:1"]);
    runtime.finish();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    assert.equal(runtime.runs.length, 2);
    assert.ok(screenFlat(term).includes("state: idle"), screenFlat(term));
    // 人提交输入：照常一轮（待递的通知由运行面连同输入带上）
    await submit(term, "继续");
    assert.deepEqual(runtime.runs.at(-1), "run:继续");
    runtime.finish();
    await settle();
  } finally {
    shell.stop();
  }
});

test("/tasks：清单开着显示当前清单，关着如实说明", async () => {
  let text: string | undefined = "1. [待办] 查 a";
  const { term, shell } = shellWith({ runtime: new NoticeRuntime(), tasks: () => text });
  try {
    shell.start();
    await settle();
    await submit(term, "/tasks");
    assert.ok(screenFlat(term).includes("1. [待办] 查 a"), screenFlat(term));
    text = undefined;
    await submit(term, "/tasks");
    assert.ok(screenFlat(term).includes("任务清单没有开"), screenFlat(term));
  } finally {
    shell.stop();
  }
});

test("worker 的请示等满时限被撤回：审批面板撤下，按取消收口，输入恢复", async () => {
  const { term, shell } = shellWith({ runtime: new NoticeRuntime() });
  try {
    shell.start();
    await settle();
    const controller = new AbortController();
    const answer = shell.askApproval({
      toolName: "run_command",
      toolCallId: "c1",
      args: { command: "npm test" },
      tier: "exec",
      command: "npm test",
      worker: { name: "runner", role: "tester" },
      signal: controller.signal,
    });
    await settle();
    assert.ok(screenFlat(term).includes("state: approval"), screenFlat(term));
    controller.abort();
    assert.deepEqual(await answer, { key: "cancel", reason: APPROVAL_WITHDRAWN });
    await settle();
    assert.ok(screenFlat(term).includes(APPROVAL_WITHDRAWN), screenFlat(term));
    assert.ok(screenFlat(term).includes("state: idle"), screenFlat(term));
  } finally {
    shell.stop();
  }
});

test("通知与排队输入同一个出口：有排队的输入先发输入（这一轮开头由运行面带上通知），没有才单独跑通知；/tasks 运行中可用", async () => {
  const runtime = new NoticeRuntime();
  const { term, shell } = shellWith({ runtime, tasks: () => "1. [进行中] 改 a" });
  try {
    shell.start();
    await settle();
    await submit(term, "第一句");
    assert.deepEqual(runtime.runs, ["run:第一句"]);
    // 运行中：人又输入一句（进队列），同时来了一条通知
    await submit(term, "第二句");
    runtime.pending = 1;
    shell.runNotices();
    await settle();
    assert.deepEqual(runtime.runs, ["run:第一句"]);
    // 运行中 /tasks 照常可用
    await submit(term, "/tasks");
    assert.ok(screenFlat(term).includes("1. [进行中] 改 a"), screenFlat(term));
    // 这一轮结束：先发排队的输入（通知由运行面在这一轮开头带上），不另跑通知
    runtime.finish();
    await settle();
    assert.deepEqual(runtime.runs, ["run:第一句", "run:第二句"]);
    // 未知命令的提示里有 /tasks
    runtime.pending = 0;
    runtime.finish();
    await settle();
    await submit(term, "/nope");
    assert.ok(screenFlat(term).includes("/tasks"), screenFlat(term));
  } finally {
    shell.stop();
  }
});
