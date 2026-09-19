// worker 生命周期（M5.5 S2，决策 040）：四动作与审批回调的编排语义——证据顺序、结构化结果、
// 委派子集、深度 1、轮次与墙钟上限、取消、派出失败配对。运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildSettledInput, ChildSpawnedInput, WorkerWorkspace } from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newReceiptId, newSessionId, type ReceiptId, type SessionId } from "../state/ids.ts";
import {
  WorkerDepthError,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  WorkerSpawnError,
  type WorkspaceProvider,
} from "./workers.ts";

type Behavior = "complete" | "hang" | "endless-turns";

class FakeRuntime implements WorkerRuntimeHandle {
  readonly listeners = new Set<(event: EventEnvelope) => void>();
  readonly receipt: ReceiptId = newReceiptId();
  interrupted = false;
  disposed = false;
  // M7（决策 072）：上限中止前经运行面写进 worker 自己账本的上限
  readonly limitHits: string[] = [];
  readonly #interrupt = Promise.withResolvers<void>();
  readonly behavior: Behavior;
  readonly journal: string[];

  constructor(behavior: Behavior, journal: string[]) {
    this.behavior = behavior;
    this.journal = journal;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emitTurn(): void {
    for (const listener of this.listeners) {
      listener({ kind: "turn.completed" } as EventEnvelope);
    }
  }

  async run(): Promise<{ status: "completed" | "aborted" }> {
    this.journal.push("run");
    if (this.behavior === "complete") {
      this.#emitTurn();
      return { status: "completed" };
    }
    if (this.behavior === "hang") {
      await this.#interrupt.promise;
      return { status: "aborted" };
    }
    while (!this.interrupted) {
      this.#emitTurn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { status: "aborted" };
  }

  recordLimitHit(limit: string): void {
    this.limitHits.push(limit);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.#interrupt.resolve();
  }

  receiptIds(): ReceiptId[] {
    return [this.receipt];
  }

  summary(): string {
    return "已完成任务";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.journal.push("dispose");
  }
}

function setup(
  overrides: Partial<WorkerOrchestratorOptions> & {
    behavior?: Behavior;
    failCreate?: boolean;
  } = {}
) {
  const journal: string[] = [];
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  const requests: WorkerRuntimeRequest[] = [];
  const runtimes = new Map<SessionId, FakeRuntime>();
  const workspaces: WorkspaceProvider = {
    plan: ({ sessionId, name }): WorkerWorkspace => ({
      kind: "git-worktree",
      path: `/virtual/${sessionId}-${name}`,
      branch: `pigeon/${name}`,
    }),
    create: (workspace) => {
      journal.push(`create ${workspace.kind === "git-worktree" ? workspace.branch : "none"}`);
      if (overrides.failCreate === true) {
        throw new Error("工作树建不起来");
      }
    },
    changedFiles: () => ["a.ts"],
  };
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
    parentLog: {
      appendChildSpawned: (input) => {
        journal.push(`spawned ${input.name}`);
        spawned.push(input);
      },
      appendChildSettled: (input) => {
        journal.push(`settled ${input.name}`);
        settled.push(input);
      },
    },
    createRuntime: (request) => {
      journal.push(`runtime ${request.name}`);
      requests.push(request);
      const runtime = new FakeRuntime(overrides.behavior ?? "complete", journal);
      runtimes.set(request.sessionId, runtime);
      return runtime;
    },
    approvals: async () => ({ approved: true }),
    workspaces,
    ...overrides,
  });
  return { orchestrator, journal, spawned, settled, requests, runtimes };
}

test("spawn：child.spawned 先于工作区与运行面落盘；收尾先释放运行面再写带结构化结果的 child.settled", async () => {
  const { orchestrator, journal, spawned, settled, runtimes } = setup();
  const id = orchestrator.spawn({ role: "implementer", task: "改 a.ts", name: "fix-a" });
  const outcome = await orchestrator.awaitResult(id);

  assert.deepEqual(journal, [
    "spawned fix-a",
    "create pigeon/fix-a",
    "runtime fix-a",
    "run",
    "dispose",
    "settled fix-a",
  ]);
  assert.equal(spawned[0]?.childSessionId, id);
  assert.equal(spawned[0]?.task, "改 a.ts");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.turns, 1);
  assert.deepEqual(outcome.result, {
    branch: "pigeon/fix-a",
    changedFiles: ["a.ts"],
    receiptIds: [runtimes.get(id)?.receipt],
    summary: "已完成任务",
    summaryTruncated: false,
  });
  assert.deepEqual(settled[0]?.result, outcome.result);
  assert.equal(orchestrator.status()[0]?.state, "completed");
});

test("委派子集：派给运行面的策略只从父策略挑，父没有的工具 worker 拿不到", async () => {
  const { orchestrator, requests, spawned } = setup({
    parentPolicy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
  });
  const id = orchestrator.spawn({ role: "implementer", task: "改 a.ts" });
  await orchestrator.awaitResult(id);
  assert.deepEqual(requests[0]?.policy.allow, ["read_file"]);
  assert.deepEqual(spawned[0]?.policy.allow, ["read_file"]);
});

test("深度 1：worker 会话里的编排器拒绝再派，零落盘零工作区", () => {
  const { orchestrator, journal } = setup({
    session: { sessionId: newSessionId(), parentSessionId: newSessionId() },
  });
  assert.throws(() => orchestrator.spawn({ role: "explorer", task: "看看" }), WorkerDepthError);
  assert.deepEqual(journal, []);
});

test("轮次上限：达到上限中止，以 turn-limit 收尾", async () => {
  const { orchestrator, runtimes } = setup({ behavior: "endless-turns" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { maxTurns: 3 } });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "turn-limit");
  assert.equal(outcome.turns >= 3, true);
  assert.equal(runtimes.get(id)?.interrupted, true);
  assert.equal(runtimes.get(id)?.disposed, true);
  // M7（决策 072）：撞上限先留痕（写进 worker 自己的账本），标签据此判失败而非放弃
  assert.deepEqual(runtimes.get(id)?.limitHits, ["turn-limit"]);
});

test("墙钟上限：超时中止，以 wall-clock-limit 收尾", async () => {
  const { orchestrator } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { wallClockMs: 30 } });
  assert.equal((await orchestrator.awaitResult(id)).status, "wall-clock-limit");
});

test("人主动取消不留撞上限痕迹（取消算放弃，上限才算失败）", async () => {
  const { orchestrator, runtimes } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看" });
  await orchestrator.cancel(id);
  await orchestrator.awaitResult(id);
  assert.deepEqual(runtimes.get(id)?.limitHits, []);
});

test("cancel：走 interrupt，以 cancelled 收尾；已收尾再取消无操作", async () => {
  const { orchestrator, settled } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看" });
  assert.equal(orchestrator.status()[0]?.state, "running");
  await orchestrator.cancel(id);
  assert.equal((await orchestrator.awaitResult(id)).status, "cancelled");
  await orchestrator.cancel(id);
  assert.equal(settled.length, 1);
});

test("审批回调：worker 的审批请求带来源会话与 worker 标签", async () => {
  const seen: unknown[] = [];
  const { orchestrator, requests } = setup({
    approvals: async (request) => {
      seen.push(request);
      return { approved: false, reason: "不准" };
    },
  });
  const id = orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" });
  await orchestrator.awaitResult(id);
  const decision = await requests[0]?.approvalHandler({
    toolName: "edit_file",
    toolCallId: "toolu_1",
    args: { path: "a.ts" },
  });
  assert.deepEqual(decision, { approved: false, reason: "不准" });
  assert.deepEqual(seen, [
    {
      toolName: "edit_file",
      toolCallId: "toolu_1",
      args: { path: "a.ts" },
      sessionId: id,
      worker: { name: "fix-a", role: "implementer" },
    },
  ]);
});

test("派出失败：工作区建不起来时 spawn 抛错，spawned 与 spawn-failed settled 配对", () => {
  const { orchestrator, spawned, settled } = setup({ failCreate: true });
  assert.throws(
    () => orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" }),
    WorkerSpawnError
  );
  assert.equal(spawned.length, 1);
  assert.equal(settled[0]?.childSessionId, spawned[0]?.childSessionId);
  assert.equal(settled[0]?.status, "spawn-failed");
  assert.match(settled[0]?.error ?? "", /工作树建不起来/);
});

test("入参校验：未知角色、空任务、重名在落盘前拒绝", async () => {
  const { orchestrator, spawned } = setup();
  assert.throws(() => orchestrator.spawn({ role: "admin", task: "x" }), WorkerSpawnError);
  assert.throws(() => orchestrator.spawn({ role: "explorer", task: "  " }), WorkerSpawnError);
  const id = orchestrator.spawn({ role: "explorer", task: "x", name: "dup" });
  assert.throws(
    () => orchestrator.spawn({ role: "explorer", task: "y", name: "dup" }),
    WorkerSpawnError
  );
  await orchestrator.awaitResult(id);
  assert.equal(spawned.length, 1);
});
