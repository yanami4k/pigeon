// 上下文压缩的 TUI 投影（决策 189）：/compact [重点] 经 application API 发起手动压缩，重点原样交出；每次压缩
// （自动或手动）在消息区提示一行压缩前后的 token 数；没有压成时说明原因；压缩进行中不接受提交。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CompactionNotice,
  ManualCompactionOutcome,
  RunResult,
  StreamTextDelta,
} from "../pi-runtime/index.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";

class FakeRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];
  readonly compacts: Array<string | undefined> = [];
  readonly listeners = new Set<(notice: CompactionNotice) => void>();
  nextOutcome: ManualCompactionOutcome = {
    kind: "compacted",
    trigger: "manual",
    tokensBefore: 12_000,
    tokensAfter: 900,
    messages: [],
  };
  pending: (() => void) | null = null;
  hold = false;

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    return Promise.resolve({
      runId: newRunId(),
      status: "completed",
      stopReason: "stop",
      syntheticFailure: false,
      failure: null,
      advertisedTools: [],
      toolExecutions: [],
    });
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

  subscribeCompaction(listener: (notice: CompactionNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notice: CompactionNotice): void {
    for (const listener of this.listeners) listener(notice);
  }

  compact(customInstructions?: string): Promise<ManualCompactionOutcome> {
    this.compacts.push(customInstructions);
    const outcome = this.nextOutcome;
    if (outcome.kind === "compacted") {
      this.emit({
        kind: "compacted",
        trigger: outcome.trigger,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
      });
    }
    if (!this.hold) return Promise.resolve(outcome);
    const { promise, resolve } = Promise.withResolvers<ManualCompactionOutcome>();
    this.pending = () => resolve(outcome);
    return promise;
  }
}

function makeShell() {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-compact-"));
  const term = new MockTerminal(100, 24);
  const runtime = new FakeRuntime();
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId: newSessionId(), logDir });
  return { shell, runtime, term, logDir };
}

test("/compact 重点：经 application API 发起手动压缩，重点原样交出；消息区提示一行压缩前后的 token 数", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("/compact 保留 a.ts 的改动");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.compacts, ["保留 a.ts 的改动"]);
    const text = screenFlat(term);
    assert.ok(text.includes("上下文已压缩（手动）：约 12000 → 900 token"), text);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/compact 不带重点：不给附加说明", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("/compact");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.compacts, [undefined]);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("自动压缩：运行面发出压缩提示时，消息区同样提示一行（注明是 Run 内还是 Run 开始前）", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  try {
    shell.start();
    await settle();
    runtime.emit({
      kind: "compacted",
      trigger: "turn",
      tokensBefore: 990_000,
      tokensAfter: 21_000,
    });
    runtime.emit({
      kind: "compacted",
      trigger: "run-start",
      tokensBefore: 985_000,
      tokensAfter: 20_500,
    });
    await settle();
    const text = screenFlat(term);
    assert.ok(text.includes("上下文已压缩（自动，轮间）：约 990000 → 21000 token"), text);
    assert.ok(text.includes("上下文已压缩（自动，Run 开始前）：约 985000 → 20500 token"), text);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/compact 没有压成：说明原因（没有可压缩的内容）", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  runtime.nextOutcome = { kind: "skipped", reason: "nothing-to-summarize" };
  try {
    shell.start();
    await settle();
    term.input("/compact");
    term.input("\r");
    await settle();
    assert.ok(screenFlat(term).includes("没有可压缩的内容"), screenFlat(term));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("压缩进行中：提交被拒绝（busy 语义），压缩完成后恢复", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  runtime.hold = true;
  try {
    shell.start();
    await settle();
    term.input("/compact");
    term.input("\r");
    await settle();
    term.input("新任务");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, []);
    runtime.pending?.();
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["新任务"]);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("自动压缩没压成与压缩前回调失败：消息区各提示一行，说明原因与后果", async () => {
  const { shell, runtime, term, logDir } = makeShell();
  try {
    shell.start();
    await settle();
    runtime.emit({
      kind: "incomplete",
      trigger: "turn",
      outcome: { kind: "failed", stage: "summary", error: new Error("网关拒绝：花费上限") },
    });
    runtime.emit({
      kind: "incomplete",
      trigger: "run-start",
      outcome: { kind: "skipped", reason: "nothing-to-summarize" },
    });
    runtime.emit({ kind: "hook-failed", trigger: "turn", error: new Error("复盘失败") });
    await settle();
    const text = screenFlat(term);
    assert.ok(
      text.includes("上下文压缩未完成（自动，轮间）：网关拒绝：花费上限；本轮按原上下文继续"),
      text
    );
    assert.ok(text.includes("上下文压缩未完成（自动，Run 开始前）："), text);
    assert.ok(text.includes("压缩前回调失败：复盘失败；压缩照常进行"), text);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 340：/reload 交给装配方的重载入口，参数原样交出、结果逐行进消息区；没给重载入口即未知命令", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-reload-"));
  const term = new MockTerminal(100, 24);
  const calls: string[][] = [];
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new FakeRuntime(),
    sessionId: newSessionId(),
    logDir,
    reload: async (args) => {
      calls.push([...args]);
      return ["已重读设置，自下一轮起生效：改了 permissions 节"];
    },
  });
  try {
    shell.start();
    await settle();
    term.input("/reload confirm");
    term.input("\r");
    await settle();
    assert.deepEqual(calls, [["confirm"]]);
    assert.ok(screenFlat(term).includes("改了 permissions 节"), screenFlat(term));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
  const { shell: plain, term: plainTerm, logDir: plainLog } = makeShell();
  try {
    plain.start();
    await settle();
    plainTerm.input("/reload");
    plainTerm.input("\r");
    await settle();
    assert.ok(screenFlat(plainTerm).includes("未知命令：/reload"), screenFlat(plainTerm));
  } finally {
    plain.stop();
    rmSync(plainLog, { recursive: true, force: true });
  }
});
