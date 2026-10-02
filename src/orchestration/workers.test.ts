// worker 生命周期（M5.5 S2，决策 040）：四动作与审批回调的编排语义——证据顺序、结构化结果、
// 委派子集、深度 1、轮次与墙钟上限、取消、派出失败配对。运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type {
  ChildSettledInput,
  ChildSpawnedInput,
  WorkerWorkspace,
} from "../state/session-payloads.ts";
import {
  WorkerDepthError,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  WorkerSpawnError,
  type WorkspaceProvider,
} from "./workers.ts";

type Behavior = "complete" | "hang" | "endless-turns" | "complete-at-limit" | "slow-abort";

class FakeRuntime implements WorkerRuntimeHandle {
  readonly listeners = new Set<(event: EventEnvelope) => void>();
  interrupted = false;
  disposed = false;
  // 每次中止请求带的原因（决策 072 / 182：撞上限的原因随中止请求交给运行面，由 Run 收尾条目记下；取消不带）
  readonly interruptCauses: Array<string | undefined> = [];
  readonly runId: RunId = newRunId();
  readonly #interrupt = Promise.withResolvers<void>();
  // slow-abort：中止请求到达后运行不立即收尾，等测试放行
  readonly #release = Promise.withResolvers<void>();
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

  async run(): Promise<{ status: "completed" | "aborted"; runId: RunId }> {
    this.journal.push("run");
    const runId = this.runId;
    if (this.behavior === "complete") {
      this.#emitTurn();
      return { status: "completed", runId };
    }
    // 第三轮恰好用满上限：中止请求到达时模型已自然收尾，终态仍是完成
    if (this.behavior === "complete-at-limit") {
      this.#emitTurn();
      this.#emitTurn();
      this.#emitTurn();
      return { status: "completed", runId };
    }
    if (this.behavior === "slow-abort") {
      await this.#interrupt.promise;
      await this.#release.promise;
      return { status: "aborted", runId };
    }
    if (this.behavior === "hang") {
      await this.#interrupt.promise;
      return { status: "aborted", runId };
    }
    while (!this.interrupted) {
      this.#emitTurn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { status: "aborted", runId };
  }

  async interrupt(cause?: string): Promise<void> {
    this.journal.push(cause === undefined ? "interrupt" : `interrupt:${cause}`);
    this.interruptCauses.push(cause);
    this.interrupted = true;
    this.#interrupt.resolve();
  }

  // 等第一次中止请求到达
  interruptRequested(): Promise<void> {
    return this.#interrupt.promise;
  }

  // 放行 slow-abort 的运行，以中止收尾
  finishAbort(): void {
    this.#release.resolve();
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
  const { orchestrator, journal, spawned, settled } = setup();
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
  const { orchestrator, journal, runtimes } = setup({ behavior: "endless-turns" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { maxTurns: 3 } });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "turn-limit");
  assert.equal(outcome.turns >= 3, true);
  assert.equal(runtimes.get(id)?.interrupted, true);
  assert.equal(runtimes.get(id)?.disposed, true);
  // M7（决策 072 / 182）：撞上限的原因随中止请求交给运行面（Run 收尾条目据此记撞上限，标签判失败而非放弃）；
  // 中止请求在运行返回之前、释放运行面之前发出
  assert.deepEqual(runtimes.get(id)?.interruptCauses, ["turn-limit"]);
  assert.deepEqual(
    journal.filter((entry) => ["run", "interrupt:turn-limit", "dispose"].includes(entry)),
    ["run", "interrupt:turn-limit", "dispose"]
  );
});

test("轮次上限恰好用满而自然收尾：以 completed 收尾（中止原因只在运行确以中止收尾时生效）", async () => {
  const { orchestrator } = setup({ behavior: "complete-at-limit" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { maxTurns: 3 } });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.turns, 3);
});

test("墙钟上限中止同样把原因交给运行面", async () => {
  const { orchestrator, runtimes } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { wallClockMs: 30 } });
  await orchestrator.awaitResult(id);
  assert.deepEqual(runtimes.get(id)?.interruptCauses, ["wall-clock-limit"]);
});

test("墙钟上限：超时中止，以 wall-clock-limit 收尾", async () => {
  const { orchestrator } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { wallClockMs: 30 } });
  assert.equal((await orchestrator.awaitResult(id)).status, "wall-clock-limit");
});

test("人主动取消的中止请求不带撞上限原因（取消算放弃，上限才算失败）", async () => {
  const { orchestrator, runtimes } = setup({ behavior: "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看" });
  await orchestrator.cancel(id);
  await orchestrator.awaitResult(id);
  assert.deepEqual(runtimes.get(id)?.interruptCauses, [undefined]);
});

test("撞上限后又被人主动取消：以 cancelled 收尾；先到的撞上限原因已随第一次中止请求交出", async () => {
  const { orchestrator, runtimes } = setup({ behavior: "slow-abort" });
  const id = orchestrator.spawn({ role: "explorer", task: "看看", limits: { wallClockMs: 10 } });
  const runtime = runtimes.get(id);
  assert.ok(runtime);
  // 墙钟上限先触发并发出中止请求；运行收尾之前人又取消
  await runtime.interruptRequested();
  await orchestrator.cancel(id);
  runtime.finishAbort();
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(runtime.interruptCauses, ["wall-clock-limit", undefined]);
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
      // 决策 303：请求另带撤回用的 signal（等满时限即撤回），比对时去掉
      const { signal, ...rest } = request;
      assert.ok(signal instanceof AbortSignal);
      seen.push(rest);
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

// 决策 279：worker 从主工作目录的快照开工——起点由装配根注入
test("起点提供者在场：派出前先拍快照，派出记录的工作区形状记 baseCommit、建工作区以它为起点，状态与结果带起点", async () => {
  const base = "a".repeat(40);
  const journal: string[] = [];
  const workspaces: WorkspaceProvider = {
    plan: ({ sessionId, name }): WorkerWorkspace => ({
      kind: "git-worktree",
      path: `/virtual/${sessionId}-${name}`,
      branch: `pigeon/${name}`,
    }),
    create: (workspace, input) => {
      journal.push(
        `create ${workspace.kind === "git-worktree" ? workspace.baseCommit : "none"} ${input.baseRef}`
      );
    },
    changedFiles: () => [],
  };
  const { orchestrator, spawned } = setup({
    workspaces,
    startPoint: ({ name }) => {
      journal.push(`snapshot ${name}`);
      return { commit: base, snapshot: true, files: ["x.ts", "y.ts"] };
    },
  });
  const id = orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" });
  const outcome = await orchestrator.awaitResult(id);
  assert.deepEqual(
    journal,
    ["snapshot fix-a", `create ${base} ${base}`],
    "先拍快照再建工作区，起点即快照"
  );
  assert.equal(
    spawned[0]?.workspace.kind === "git-worktree" ? spawned[0].workspace.baseCommit : undefined,
    base,
    "派出记录记下起点"
  );
  assert.deepEqual(outcome.start, { commit: base, snapshot: true, files: ["x.ts", "y.ts"] });
  assert.deepEqual(orchestrator.status()[0]?.start, outcome.start);
  assert.equal(
    outcome.workspace.kind === "git-worktree" ? outcome.workspace.baseCommit : undefined,
    base
  );
});

test("起点拍不成（如不是 git 工作区）：不派——没有派出记录、零工作区零运行面，错误写明原因", () => {
  const { orchestrator, spawned, journal } = setup({
    startPoint: () => {
      throw new Error("不是 git 工作区");
    },
  });
  assert.throws(
    () => orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" }),
    (error: unknown) =>
      error instanceof WorkerSpawnError && /拍工作目录快照失败：不是 git 工作区/.test(error.message)
  );
  assert.equal(spawned.length, 0);
  assert.deepEqual(journal, []);
  assert.deepEqual(orchestrator.status(), []);
});

test("没有起点提供者：与从前一样（工作区形状不带 baseCommit，结果不带起点）", async () => {
  const { orchestrator, spawned } = setup();
  const id = orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal("baseCommit" in (spawned[0]?.workspace ?? {}), false);
  assert.equal(outcome.start, undefined);
});

// 决策 279 修订：起点引用只护住"拍好快照到建好工作树"一段——建好（或建失败）即调 release；release 出错不改变派出结果
test("起点的 release：建好工作区后调一次；建工作区失败也调；release 抛错只进内部故障清单", async () => {
  const calls: string[] = [];
  const point = { commit: "b".repeat(40), snapshot: true, files: ["x.ts"] };
  const ok = setup({
    startPoint: () => ({ ...point, release: () => calls.push("release") }),
  });
  const id = ok.orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" });
  assert.deepEqual(calls, ["release"]);
  const outcome = await ok.orchestrator.awaitResult(id);
  assert.deepEqual(outcome.start, point, "结果里的起点不带 release");

  const failed = setup({
    failCreate: true,
    startPoint: () => ({ ...point, release: () => calls.push("release-after-failure") }),
  });
  assert.throws(
    () => failed.orchestrator.spawn({ role: "implementer", task: "改" }),
    WorkerSpawnError
  );
  assert.deepEqual(calls, ["release", "release-after-failure"]);

  const throwing = setup({
    startPoint: () => ({
      ...point,
      release: () => {
        throw new Error("删不掉");
      },
    }),
  });
  const other = throwing.orchestrator.spawn({ role: "implementer", task: "改" });
  assert.equal((await throwing.orchestrator.awaitResult(other)).status, "completed");
  assert.equal(throwing.orchestrator.errors().length, 1);
});

// 续接时登记的上次运行的 worker（权威链审计 ②）：一个已收尾、一个中断
function previousWorkers(parentSessionId: SessionId) {
  const workspace = (name: string): WorkerWorkspace => ({
    kind: "git-worktree",
    path: `/virtual/prev-${name}`,
    branch: `pigeon/${name}`,
  });
  const settledId = newSessionId();
  const interruptedId = newSessionId();
  const base = { role: "implementer" as const, turns: 2, startedAt: 1, depth: 1, parentSessionId };
  return {
    settledId,
    interruptedId,
    statuses: [
      {
        ...base,
        sessionId: settledId,
        name: "implementer-1",
        state: "completed" as const,
        workspace: workspace("implementer-1"),
        previousRun: "settled" as const,
        outcome: {
          sessionId: settledId,
          name: "implementer-1",
          role: "implementer" as const,
          status: "completed" as const,
          turns: 2,
          workspace: workspace("implementer-1"),
        },
      },
      {
        ...base,
        sessionId: interruptedId,
        name: "half",
        state: "aborted" as const,
        workspace: workspace("half"),
        previousRun: "interrupted" as const,
        outcome: {
          sessionId: interruptedId,
          name: "half",
          role: "implementer" as const,
          status: "aborted" as const,
          turns: 0,
          workspace: workspace("half"),
        },
      },
    ],
  };
}

test("上次运行的 worker：查询与等结果照常；取消、发消息、补批续做给出明确说明，不报找不到", async () => {
  const { orchestrator } = setup();
  const prev = previousWorkers(newSessionId());
  orchestrator.restorePrevious(prev.statuses);
  assert.deepEqual(
    orchestrator.status().map((status) => [status.name, status.state, status.previousRun]),
    [
      ["implementer-1", "completed", "settled"],
      ["half", "aborted", "interrupted"],
    ]
  );
  assert.equal((await orchestrator.awaitResult(prev.settledId)).status, "completed");
  const waited = await orchestrator.wait([prev.settledId, prev.interruptedId], {
    mode: "all",
    timeoutMs: 1000,
  });
  assert.deepEqual(
    waited.settled.map((outcome) => outcome.name),
    ["implementer-1", "half"]
  );
  assert.equal(waited.timedOut, false);
  await assert.rejects(orchestrator.cancel(prev.interruptedId), (error: unknown) => {
    assert.ok(error instanceof WorkerSpawnError);
    assert.equal(
      error.message,
      "worker half 是上次运行派出的，随上次进程退出而中断，不在运行，无需取消。"
    );
    return true;
  });
  assert.throws(
    () => orchestrator.send(prev.settledId, "接着"),
    /worker implementer-1 是上次运行派出的，已在上次运行中收尾，不在运行，收不到消息。$/
  );
  assert.throws(
    () => orchestrator.resume(prev.settledId, { approve: true }),
    /续接后不能对它补批续做，要接着做请另派一个 worker。/
  );
});

test("上次运行的 worker 不计入同时在跑的上限，新派的不与它们重名", async () => {
  const { orchestrator } = setup({ maxConcurrent: 1, behavior: "hang" });
  const prev = previousWorkers(newSessionId());
  orchestrator.restorePrevious(prev.statuses);
  const id = orchestrator.spawn({ role: "implementer", task: "新活" });
  const fresh = orchestrator.status().find((status) => status.sessionId === id);
  assert.equal(fresh?.state, "running", "上限 1 时新派的仍直接开跑（重建的记录不占空位）");
  assert.equal(fresh?.name, "implementer-2", "名字跳过上次运行的 implementer-1");
  assert.throws(
    () => orchestrator.spawn({ role: "implementer", task: "同名", name: "half" }),
    /worker 名已被占用：half/
  );
  await orchestrator.cancel(id);
  await orchestrator.awaitResult(id);
});
