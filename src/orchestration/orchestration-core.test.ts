// 编排积木（决策 294、297–300、303）：编排器层的专门用例——标签在各事件与结果里带回、生命周期统一发事件、积木可被程序
// 直接调用（派出、等待、发消息、停止、状态、续做）、并发额度只在编排器管（缺省同时 8 个、不设总数上限）、卡住监控与观察者
// 接入点、嵌套缺省拦住与放开后共用额度（等待中借出空位）、审批超时与无人值守即以可恢复错误交回、补批后能续做。
// 运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalDecision } from "../approvals/handler.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import type {
  ChildSettledInput,
  ChildSpawnedInput,
  WorkerWorkspace,
} from "../state/session-payloads.ts";
import {
  type ChildFamilySink,
  WorkerDepthError,
  type WorkerLifecycleEvent,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkspaceProvider,
} from "./workers.ts";

// silent：不发任何事件、等中止；ask：请示一次跑命令，批了即完成、被拒即等中止；spawn-child：再派一个 child 并等它（嵌套）
type Behavior = "complete" | "hang" | "silent" | "ask" | "turns" | "tool";

interface Log {
  spawned: ChildSpawnedInput[];
  settled: ChildSettledInput[];
}

function sink(): ChildFamilySink & Log {
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  return {
    spawned,
    settled,
    appendChildSpawned: (input) => spawned.push(input),
    appendChildSettled: (input) => settled.push(input),
  };
}

class FakeRuntime implements WorkerRuntimeHandle {
  readonly listeners = new Set<(event: EventEnvelope) => void>();
  readonly #stop = Promise.withResolvers<void>();
  readonly #release = Promise.withResolvers<void>();
  #interrupted = false;
  started = false;
  readonly notes: string[] = [];
  readonly childSink = sink();
  decision: ApprovalDecision | undefined;
  readonly request: WorkerRuntimeRequest;
  readonly behavior: Behavior;
  // run 里另做的事（嵌套时派子 worker）
  body?: () => Promise<void>;

  constructor(request: WorkerRuntimeRequest, behavior: Behavior) {
    this.request = request;
    this.behavior = behavior;
  }

  release(): void {
    this.#release.resolve();
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(kind: string): void {
    for (const listener of [...this.listeners]) {
      listener({ kind, payload: {} } as unknown as EventEnvelope);
    }
  }

  async run() {
    this.started = true;
    const runId = newRunId();
    if (this.body !== undefined) {
      await this.body();
    }
    switch (this.behavior) {
      case "complete":
        this.emit("turn.completed");
        return { status: "completed" as const, runId };
      case "turns":
        while (!this.#interrupted) {
          this.emit("turn.completed");
          await new Promise((resolve) => setImmediate(resolve));
        }
        return { status: "aborted" as const, runId };
      case "silent":
        await this.#stop.promise;
        return { status: "aborted" as const, runId };
      case "tool": {
        const payload = { toolCallId: "call-t", toolName: this.toolName, args: {} };
        for (const listener of [...this.listeners]) {
          listener({ kind: "tool.proposed", payload } as unknown as EventEnvelope);
        }
        await Promise.race([this.#release.promise, this.#stop.promise]);
        if (this.#interrupted) return { status: "aborted" as const, runId };
        for (const listener of [...this.listeners]) {
          listener({ kind: "tool.settled", payload } as unknown as EventEnvelope);
        }
        this.emit("turn.completed");
        return { status: "completed" as const, runId };
      }
      case "hang":
        await Promise.race([this.#release.promise, this.#stop.promise]);
        if (this.#interrupted) return { status: "aborted" as const, runId };
        this.emit("turn.completed");
        return { status: "completed" as const, runId };
      case "ask": {
        this.decision = await this.request.approvalHandler({
          toolName: "run_command",
          toolCallId: "call-1",
          args: { command: "npm test" },
          tier: "exec",
          command: "npm test",
        });
        if (this.decision.approved) {
          this.emit("turn.completed");
          return { status: "completed" as const, runId };
        }
        await this.#stop.promise;
        return { status: "aborted" as const, runId };
      }
    }
  }

  async interrupt(): Promise<void> {
    this.#interrupted = true;
    this.#stop.resolve();
  }

  notify(text: string): string {
    this.notes.push(text);
    return `note-${this.notes.length}`;
  }

  // 工具调用的工具名（tool 行为）
  toolName = "run_command";

  async transcript(): Promise<string> {
    return `/sessions/${this.request.sessionId}.jsonl`;
  }

  childLog(): ChildFamilySink {
    return this.childSink;
  }

  summary(): string {
    return `${this.request.name} 的结论`;
  }

  async dispose(): Promise<void> {}
}

function setup(
  options: Partial<WorkerOrchestratorOptions> & {
    behaviorFor?: (request: WorkerRuntimeRequest) => Behavior;
  } = {}
) {
  const log = sink();
  const runtimes = new Map<string, FakeRuntime[]>();
  const requests: WorkerRuntimeRequest[] = [];
  const events: WorkerLifecycleEvent[] = [];
  const workspaces: WorkspaceProvider = {
    plan: ({ sessionId, name }): WorkerWorkspace => ({
      kind: "git-worktree",
      path: `/virtual/${sessionId}-${name}`,
      branch: `pigeon/${name}`,
    }),
    create: () => {},
    changedFiles: () => ["a.ts"],
  };
  const { behaviorFor, ...rest } = options;
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command", "spawn_worker", "wait_workers"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: log,
    createRuntime: (request) => {
      requests.push(request);
      const runtime = new FakeRuntime(request, behaviorFor?.(request) ?? "hang");
      runtimes.set(request.name, [...(runtimes.get(request.name) ?? []), runtime]);
      return runtime;
    },
    approvals: async () => ({ approved: true }),
    workspaces,
    ...rest,
  });
  orchestrator.subscribe((event) => events.push(event));
  const rt = (name: string, index = -1) => {
    const list = runtimes.get(name) ?? [];
    const runtime = list.at(index);
    assert.ok(runtime !== undefined, name);
    return runtime;
  };
  return { orchestrator, log, runtimes, requests, events, rt };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 4000 && !check(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), "等待的条件没有成立");
}

test("标签与生命周期事件：派出、开跑、收尾各发一次事件，标签在事件、派出记录与结构化结果里原样带回", async () => {
  const { orchestrator, log, events, rt } = setup({ maxConcurrent: 1 });
  const first = orchestrator.spawn({
    role: "explorer",
    task: "一",
    name: "one",
    label: "T1",
    origin: "agent",
  });
  const second = orchestrator.spawn({ role: "explorer", task: "二", name: "two", label: "T2" });
  assert.deepEqual(
    events.map((event) => [event.kind, event.worker.name, event.worker.label]),
    [
      ["worker.spawned", "one", "T1"],
      ["worker.started", "one", "T1"],
      ["worker.spawned", "two", "T2"],
    ]
  );
  assert.equal(events[2]?.kind === "worker.spawned" ? events[2].queued : undefined, true);
  assert.deepEqual(
    log.spawned.map((record) => record.label),
    ["T1", "T2"]
  );
  rt("one").release();
  const outcome = await orchestrator.awaitResult(first);
  await until(() =>
    events.some((event) => event.kind === "worker.started" && event.worker.name === "two")
  );
  const settled = events.find((event) => event.kind === "worker.settled");
  assert.ok(settled?.kind === "worker.settled");
  assert.equal(settled.outcome, outcome);
  assert.equal(outcome.label, "T1");
  assert.equal(outcome.origin, "agent");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.errorKind, undefined);
  assert.equal(outcome.transcript, `/sessions/${first}.jsonl`);
  assert.deepEqual(outcome.result?.changedFiles, ["a.ts"]);
  assert.equal(outcome.result?.summary, "one 的结论");
  assert.equal(typeof outcome.durationMs, "number");
  assert.equal(
    orchestrator.status().find((worker) => worker.sessionId === second)?.origin,
    "program"
  );
  await orchestrator.cancel(second);
  const cancelled = await orchestrator.awaitResult(second);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorKind, "cancelled");
  assert.equal(log.settled.at(-1)?.errorKind, "cancelled");
});

test("程序直接调用积木：不经模型工具即可派出、发消息、查状态、等任一与全部（带超时）、停止", async () => {
  const { orchestrator, rt } = setup();
  const a = orchestrator.spawn({ role: "explorer", task: "a", name: "a" });
  const b = orchestrator.spawn({ role: "explorer", task: "b", name: "b" });
  orchestrator.send(a, "补充一句");
  assert.deepEqual(rt("a").notes, ["补充一句"]);
  const timedOut = await orchestrator.wait([a, b], { mode: "all", timeoutMs: 20 });
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(timedOut.settled, []);
  assert.deepEqual(
    timedOut.pending.map((worker) => worker.state),
    ["running", "running"]
  );
  const anyWait = orchestrator.wait([a, b], { mode: "any", timeoutMs: 5000 });
  rt("b").release();
  const any = await anyWait;
  assert.equal(any.timedOut, false);
  assert.deepEqual(
    any.settled.map((outcome) => outcome.name),
    ["b"]
  );
  assert.deepEqual(
    any.pending.map((worker) => worker.name),
    ["a"]
  );
  await orchestrator.cancel(a);
  const all = await orchestrator.wait([a, b], { mode: "all", timeoutMs: 5000 });
  assert.deepEqual(
    all.settled.map((outcome) => outcome.status),
    ["cancelled", "completed"]
  );
  assert.throws(() => orchestrator.send(a, "晚了"), /已收尾，收不到消息/);
});

test("同时在跑缺省 8 个、不设总数上限：派 20 个，8 个在跑、12 个排队，逐个接上", async () => {
  const { orchestrator, rt } = setup();
  assert.equal(orchestrator.maxConcurrent, 8);
  const ids = Array.from({ length: 20 }, (_, index) =>
    orchestrator.spawn({ role: "explorer", task: `第 ${index}`, name: `w-${index}` })
  );
  const count = (state: string) =>
    orchestrator.status().filter((worker) => worker.state === state).length;
  assert.equal(count("running"), 8);
  assert.equal(count("queued"), 12);
  for (let round = 0; round < 20; round += 1) {
    for (let index = 0; index < 20; index += 1) {
      const list = orchestrator.status();
      if (list[index]?.state === "running") rt(`w-${index}`).release();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await until(() =>
    ids.every(
      (id) => orchestrator.status().find((worker) => worker.sessionId === id)?.outcome !== undefined
    )
  );
  assert.equal(count("completed"), 20);
});

test("卡住监控：长时间没有新的模型回复或工具结果即中断、报卡住；等审批期间不计", async () => {
  const stalled = setup({ stallMs: 40, behaviorFor: () => "silent" });
  const id = stalled.orchestrator.spawn({ role: "tester", task: "跑", name: "quiet" });
  const outcome = await stalled.orchestrator.awaitResult(id);
  assert.equal(outcome.status, "stalled");
  assert.equal(outcome.errorKind, "stalled");
  assert.equal(stalled.log.settled[0]?.status, "stalled");
  // 等审批 150 毫秒（远超卡住时限 40 毫秒）：不算卡住，批了照常完成
  const waiting = setup({
    stallMs: 40,
    behaviorFor: () => "ask",
    approvals: () => new Promise((resolve) => setTimeout(() => resolve({ approved: true }), 150)),
  });
  const asked = waiting.orchestrator.spawn({ role: "tester", task: "跑", name: "asker" });
  assert.equal((await waiting.orchestrator.awaitResult(asked)).status, "completed");
});

test("观察者接入点（留给打转检测）：观察者看到运行事件，叫停即以失败收尾、错误类型照给出的记", async () => {
  const seen: string[] = [];
  const { orchestrator } = setup({
    behaviorFor: () => "turns",
    watchers: [
      (worker, control) => ({
        observe: (event) => {
          seen.push(`${worker.name}:${event.kind}`);
          if (seen.length === 3) control.stop("looping", "同一调用连续重复");
        },
      }),
    ],
  });
  const id = orchestrator.spawn({ role: "explorer", task: "转", name: "spin" });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorKind, "looping");
  assert.equal(outcome.error, "同一调用连续重复");
  assert.ok(seen.length >= 3);
});

test("嵌套缺省拦住：worker 不能再派，委派策略里也没有派出的工具", async () => {
  const { orchestrator, requests } = setup();
  const parent = orchestrator.spawn({ role: "implementer", task: "改", name: "parent" });
  assert.equal(orchestrator.maxDepth, 1);
  assert.equal(orchestrator.canSpawnFrom(parent), false);
  assert.throws(
    () => orchestrator.spawn({ role: "explorer", task: "再派", name: "child", from: parent }),
    WorkerDepthError
  );
  assert.equal(requests[0]?.depth, 1);
  assert.ok(!requests[0]?.policy.allow.includes("spawn_worker"));
  await orchestrator.cancel(parent);
});

test("放开嵌套：各层共用同一个编排器与并发额度；等下层的 worker 借出空位，不会互相卡死；到底层即拦住", async () => {
  const { orchestrator, requests, rt, log, events } = setup({ maxDepth: 2, maxConcurrent: 1 });
  const parent = orchestrator.spawn({ role: "implementer", task: "拆", name: "parent" });
  const parentRuntime = rt("parent");
  // 第一层的 worker 带上派出的工具
  assert.ok(requests[0]?.policy.allow.includes("spawn_worker"));
  assert.ok(requests[0]?.policy.allow.includes("wait_workers"));
  // 在跑的第一层 worker 派下一层并等它：额度只有 1，靠借出空位让下一层开跑
  const child = orchestrator.spawn({
    role: "explorer",
    task: "查",
    name: "child",
    from: parent,
    origin: "agent",
  });
  assert.equal(orchestrator.status().find((worker) => worker.sessionId === child)?.state, "queued");
  const waited = orchestrator.wait([child], { mode: "all", timeoutMs: 5000, waiter: parent });
  await until(
    () => orchestrator.status().find((worker) => worker.sessionId === child)?.state === "running"
  );
  // 下层的派出记录写进上层 worker 自己的会话，不写主会话
  assert.deepEqual(
    parentRuntime.childSink.spawned.map((record) => record.name),
    ["child"]
  );
  assert.deepEqual(
    log.spawned.map((record) => record.name),
    ["parent"]
  );
  assert.equal(requests[1]?.depth, 2);
  assert.ok(!requests[1]?.policy.allow.includes("spawn_worker"));
  const childRef = events.find(
    (event) => event.kind === "worker.spawned" && event.worker.name === "child"
  );
  assert.equal(childRef?.worker.parentSessionId, parent);
  assert.equal(childRef?.worker.depth, 2);
  // 第二层已到底：再往下派即拦住
  assert.throws(
    () =>
      orchestrator.spawn({ role: "explorer", task: "再下一层", name: "grandchild", from: child }),
    WorkerDepthError
  );
  rt("child").release();
  const result = await waited;
  assert.deepEqual(
    result.settled.map((outcome) => outcome.name),
    ["child"]
  );
  assert.equal(parentRuntime.childSink.settled[0]?.status, "completed");
  // 上层收回空位接着跑
  assert.equal(
    orchestrator.status().find((worker) => worker.sessionId === parent)?.state,
    "running"
  );
  parentRuntime.release();
  assert.equal((await orchestrator.awaitResult(parent)).status, "completed");
});

test("审批等满时限无人批：撤回请求，这个 worker 以可恢复错误交回，其余 worker 照常", async () => {
  const signals: AbortSignal[] = [];
  const { orchestrator, events, rt } = setup({
    approvalTimeoutMs: 40,
    behaviorFor: ({ name }) => (name === "asker" ? "ask" : "hang"),
    approvals: (request) => {
      if (request.signal !== undefined) signals.push(request.signal);
      return new Promise(() => {});
    },
  });
  const asker = orchestrator.spawn({ role: "tester", task: "跑测试", name: "asker", label: "T3" });
  const other = orchestrator.spawn({ role: "explorer", task: "看", name: "other" });
  const outcome = await orchestrator.awaitResult(asker);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorKind, "approval-timeout");
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.blocked?.action, "跑命令 npm test");
  assert.equal(outcome.label, "T3");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(rt("asker").decision?.approved, false);
  const blocked = events.find((event) => event.kind === "worker.blocked");
  assert.ok(blocked?.kind === "worker.blocked");
  assert.equal(blocked.errorKind, "approval-timeout");
  // 其余 worker 照常在跑、照常完成
  assert.equal(
    orchestrator.status().find((worker) => worker.sessionId === other)?.state,
    "running"
  );
  rt("other").release();
  assert.equal((await orchestrator.awaitResult(other)).status, "completed");
});

test("无人值守：worker 需请示即不等，直接以可恢复错误交回（审批回调不被调用）", async () => {
  let asked = 0;
  const { orchestrator } = setup({
    unattended: true,
    behaviorFor: () => "ask",
    approvals: async () => {
      asked += 1;
      return { approved: true };
    },
  });
  const id = orchestrator.spawn({ role: "tester", task: "跑", name: "night" });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.errorKind, "approval-unattended");
  assert.equal(outcome.recoverable, true);
  assert.equal(asked, 0);
});

test("补批后能续做：同一个会话与工作树重新装运行面，放行它重新发起的同一个调用一次，接着做完", async () => {
  let asked = 0;
  const { orchestrator, requests, events, log, rt } = setup({
    unattended: true,
    behaviorFor: () => "ask",
    approvals: async () => {
      asked += 1;
      return { approved: false };
    },
  });
  const id = orchestrator.spawn({ role: "tester", task: "跑", name: "later", label: "T4" });
  assert.equal((await orchestrator.awaitResult(id)).errorKind, "approval-unattended");
  orchestrator.resume(id, { approve: true });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.label, "T4");
  assert.equal(outcome.recoverable, undefined);
  // 续做的运行面：同一个会话号，按续做装配；放行来自补批，不经审批回调
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.sessionId, id);
  assert.equal(requests[1]?.resume, true);
  assert.equal(rt("later").decision?.approved, true);
  assert.equal(asked, 0);
  assert.ok(events.some((event) => event.kind === "worker.resumed" && event.approved));
  assert.deepEqual(
    log.settled.map((record) => record.status),
    ["failed", "completed"]
  );
  // 放行只一次：同一调用再请示照常走（无人值守即再搁下）
  assert.throws(() => orchestrator.resume(newSessionId() as SessionId), /未知 worker/);
});

test("自带超时的工具执行期间暂停卡住计时：命令超时配成大于卡住时限、命令跑满也不判卡住", async () => {
  const { orchestrator, rt } = setup({ stallMs: 40, behaviorFor: () => "tool" });
  const id = orchestrator.spawn({ role: "tester", task: "跑长命令", name: "long-run" });
  // 命令跑了卡住时限的 5 倍（其超时由工具自己兜底）
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(orchestrator.status().find((worker) => worker.sessionId === id)?.state, "running");
  rt("long-run").release();
  assert.equal((await orchestrator.awaitResult(id)).status, "completed");
});

test("没有自带超时的工具执行期间照常计时：静默超过卡住时限即判卡住", async () => {
  // 替身在开跑时才取工具名：先让它排队、改成不自带超时的工具，再放它开跑
  const slow = setup({
    stallMs: 40,
    maxConcurrent: 1,
    behaviorFor: () => "tool",
  });
  const blocker = slow.orchestrator.spawn({ role: "explorer", task: "占位", name: "blocker" });
  const target = slow.orchestrator.spawn({ role: "explorer", task: "读", name: "reader" });
  slow.rt("reader").toolName = "read_file";
  await slow.orchestrator.cancel(blocker);
  const outcome = await slow.orchestrator.awaitResult(target);
  assert.equal(outcome.status, "stalled");
  assert.equal(outcome.errorKind, "stalled");
});

test("send 交回是否送达：进了它的下一轮为 delivered；它在那之前结束为 undelivered，没递出的撤回", async () => {
  const { orchestrator, rt } = setup({ behaviorFor: () => "hang" });
  const id = orchestrator.spawn({ role: "explorer", task: "一", name: "w" });
  const runtime = rt("w");
  let delivered = false;
  const withdrawn: string[] = [];
  Object.assign(runtime, {
    noticeDelivered: () => delivered,
    withdrawNotice: (key: string) => {
      withdrawn.push(key);
      return true;
    },
  });
  const first = orchestrator.send(id, "第一句");
  delivered = true;
  runtime.emit("turn.completed");
  assert.equal(await first, "delivered");
  delivered = false;
  const second = orchestrator.send(id, "第二句");
  runtime.release();
  assert.equal(await second, "undelivered");
  assert.deepEqual(withdrawn, ["note-2"]);
});
