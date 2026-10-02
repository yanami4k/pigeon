// TUI 一轮收尾后的钩子（决策 324 复审）：出错收尾的 Run 跑 StopFailure 而不是 Stop；
// Stop 钩子的 continue:false 压过拦截，整个会话停止处理、不再开新一轮。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookEventReport } from "../application/hooks.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { HookEventName } from "../state/hooks.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import type { TuiHooksFace } from "./hooks-view.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

class StubRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];

  private readonly result: RunResult;

  constructor(result: RunResult) {
    this.result = result;
  }

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    return Promise.resolve(this.result);
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

// 记录收到的事件；按事件名回预置的报告（Stop 可配 continue:false）
class StubHooks implements TuiHooksFace {
  readonly events: HookEventName[] = [];

  private readonly reports: Partial<Record<HookEventName, HookEventReport>>;

  constructor(reports: Partial<Record<HookEventName, HookEventReport>> = {}) {
    this.reports = reports;
  }

  runEvent(event: HookEventName): Promise<HookEventReport> {
    this.events.push(event);
    return Promise.resolve(
      this.reports[event] ?? { runs: [], additionalContext: [], systemMessages: [], ran: true }
    );
  }

  list(): [] {
    return [];
  }

  get disabled(): boolean {
    return false;
  }
}

function makeShell(
  result: RunResult,
  hooks: StubHooks
): { shell: PigeonTuiShell; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-stop-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-stop-log-"));
  const term = new MockTerminal(80, 24);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(result),
    sessionId: SESSION_ID,
    logDir,
    hooks,
  });
  return {
    shell,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("出错收尾的 Run 跑 StopFailure 而不是 Stop（复审 P2 回归）", async () => {
  const hooks = new StubHooks();
  const result: RunResult = {
    runId: newRunId(),
    status: "failed",
    errorMessage: "模拟 provider 故障",
    turns: 1,
    failure: null,
  } as unknown as RunResult;
  const { shell, cleanup } = makeShell(result, hooks);
  try {
    shell.start();
    await settle();
    shell.submitInput("干活");
    await settle();
    await settle();
    assert.ok(hooks.events.includes("StopFailure"), JSON.stringify(hooks.events));
    assert.ok(!hooks.events.includes("Stop"), JSON.stringify(hooks.events));
  } finally {
    shell.stop();
    cleanup();
  }
});

test("Stop 钩子 continue:false：不再开新一轮（复审 P2 回归）", async () => {
  const hooks = new StubHooks({
    Stop: {
      runs: [],
      additionalContext: ["接着干"],
      systemMessages: [],
      ran: true,
      continueFalse: { stopReason: "收工" },
    },
  });
  const result: RunResult = {
    runId: newRunId(),
    status: "completed",
    turns: 1,
    failure: null,
  } as unknown as RunResult;
  const { shell, cleanup } = makeShell(result, hooks);
  try {
    shell.start();
    await settle();
    shell.submitInput("干活");
    await settle();
    await settle();
    assert.deepEqual(
      hooks.events.filter((event) => event === "Stop"),
      ["Stop"],
      "continue:false 只跑那一次 Stop"
    );
  } finally {
    shell.stop();
    cleanup();
  }
});
