// 打转检测在 worker 上（决策 307）：经编排器的观察者接入点挂上；提醒递进 worker 的下一轮，第 20 轮叫停，以错误类型 looping
// 失败交回（中止原因为打转，Run 收尾据此记结束方式），通知文字写明重复的调用、分支上可能有部分改动；不自动重试。
// 运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WorkerOrchestrator,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkspaceProvider,
} from "../orchestration/workers.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId } from "../state/ids.ts";
import type { LoopRound } from "../state/loop-guard.ts";
import {
  DEFAULT_LOOP_GUARD_SETTINGS,
  DISABLED_LOOP_GUARD_SETTINGS,
} from "../state/loop-guard-config.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import type { WorkerWorkspace } from "../state/session-payloads.ts";
import { LOOP_REMINDER_PREFIX, loopGuardWatcher } from "./loop-guard.ts";
import { workerNoticeText } from "./spawn-worker-tool.ts";

// 每轮同一条调用与同一结果，直到被中止；撞 maxRounds 即正常收尾
class LoopingRuntime implements WorkerRuntimeHandle {
  readonly listeners = new Set<(event: EventEnvelope) => void>();
  readonly roundListeners = new Set<(round: LoopRound & { runId: RunId }) => void>();
  readonly notes: string[] = [];
  causes: Array<RunStopCause | undefined> = [];
  rounds = 0;
  #interrupted = false;
  readonly maxRounds: number;

  constructor(maxRounds: number) {
    this.maxRounds = maxRounds;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeRounds(listener: (round: LoopRound & { runId: RunId }) => void): () => void {
    this.roundListeners.add(listener);
    return () => this.roundListeners.delete(listener);
  }

  async run() {
    const runId = newRunId();
    while (!this.#interrupted && this.rounds < this.maxRounds) {
      this.rounds += 1;
      for (const listener of [...this.listeners]) {
        listener({ kind: "turn.completed", payload: {} } as unknown as EventEnvelope);
      }
      const id = `call-${this.rounds}`;
      for (const listener of [...this.roundListeners]) {
        listener({
          runId,
          calls: [{ toolCallId: id, toolName: "run_command", args: { command: "npm test" } }],
          results: [
            { toolCallId: id, isError: false, text: "FAIL src/a.test.ts\nTests: 1 failed" },
          ],
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return this.#interrupted
      ? { status: "aborted" as const, runId }
      : { status: "completed" as const, runId };
  }

  async interrupt(cause?: RunStopCause): Promise<void> {
    this.causes.push(cause);
    this.#interrupted = true;
  }

  notify(text: string): string {
    this.notes.push(text);
    return `note-${this.notes.length}`;
  }

  summary(): string {
    return "还在跑测试";
  }

  async dispose(): Promise<void> {}
}

function setup(settings = DEFAULT_LOOP_GUARD_SETTINGS, maxRounds = 200) {
  const runtimes: LoopingRuntime[] = [];
  const workspaces: WorkspaceProvider = {
    plan: ({ sessionId, name }): WorkerWorkspace => ({
      kind: "git-worktree",
      path: `/virtual/${sessionId}-${name}`,
      branch: `pigeon/${name}`,
    }),
    create: () => {},
    changedFiles: () => ["a.ts"],
  };
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: { allow: ["read_file", "run_command"], deny: [], approvalMode: "prompt" },
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    createRuntime: (_request: WorkerRuntimeRequest) => {
      const runtime = new LoopingRuntime(maxRounds);
      runtimes.push(runtime);
      return runtime;
    },
    approvals: async () => ({ approved: true }),
    workspaces,
    // 轮数与时间上限放宽：只看打转检测
    defaultLimits: { maxTurns: 1000, wallClockMs: 60_000 },
    watchers: [loopGuardWatcher(settings)],
  });
  return { orchestrator, runtimes };
}

test("worker 打转：提醒递进它的下一轮，第 20 轮叫停，以 looping 失败交回、中止原因为打转；不自动重试", async () => {
  const { orchestrator, runtimes } = setup();
  const id = orchestrator.spawn({ role: "implementer", task: "修测试", name: "spin" });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorKind, "looping");
  assert.equal(
    outcome.error,
    '打转，连续 20 轮重复同样的工具调用与结果，已被叫停。重复的调用：run_command {"command":"npm test"}'
  );
  assert.equal(runtimes.length, 1);
  const runtime = runtimes[0];
  assert.ok(runtime !== undefined);
  assert.equal(runtime.rounds, 21);
  assert.deepEqual(runtime.causes, ["looping"]);
  assert.equal(runtime.notes.length, 2);
  assert.ok(runtime.notes.every((note) => note.startsWith(LOOP_REMINDER_PREFIX)));
  assert.match(runtime.notes[1] ?? "", /如果再重复 10 轮，本次运行将被叫停/);
  // 通知主 agent：套失败文字，写明重复的调用与分支上可能有部分改动
  assert.equal(
    workerNoticeText(outcome),
    'worker spin（implementer）失败：打转，连续 20 轮重复同样的工具调用与结果，已被叫停。重复的调用：run_command {"command":"npm test"}。' +
      "分支 pigeon/spin 上可能有部分改动。"
  );
});

test("worker：打转检测关掉时不挂观察者，跑到自己收尾", async () => {
  const { orchestrator, runtimes } = setup(DISABLED_LOOP_GUARD_SETTINGS, 30);
  const outcome = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "explorer", task: "看", name: "calm" })
  );
  assert.equal(outcome.status, "completed");
  assert.equal(runtimes[0]?.rounds, 30);
  assert.deepEqual(runtimes[0]?.notes, []);
});
