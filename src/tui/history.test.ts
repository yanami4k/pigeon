// M5 S2（决策 045）：TUI thinking 流式分段弱化渲染；/resume 换绑后渲染全部历史（正文、thinking、
// 治理投影时序交织），历史上限可配、超出折叠为一行提示；全部内容仍经 036 净化边界。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedToolRun } from "../application/history-fixtures.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type RunId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

class FakeRuntime implements TuiRuntimeFace {
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly streamListeners = new Set<(delta: StreamTextDelta) => void>();
  readonly runId: RunId = newRunId();
  private release: (() => void) | null = null;

  run(): Promise<RunResult> {
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    this.release = () =>
      resolve({
        runId: this.runId,
        status: "completed",
        stopReason: "stop",
        syntheticFailure: false,
        failure: null,
        advertisedTools: [],
        toolExecutions: [],
      });
    return promise;
  }
  finish(): void {
    this.release?.();
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  listenerErrors(): unknown[] {
    return [];
  }
  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }
  emit(kind: RuntimeEventKind, payload: unknown): void {
    const envelope: EventEnvelope = {
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: newSessionId(),
      runId: this.runId,
      timestamp: 1,
      kind,
      payload,
    };
    for (const listener of this.listeners) listener(envelope);
  }
  emitDelta(kind: StreamTextDelta["kind"], delta: string): void {
    for (const listener of this.streamListeners) listener({ runId: this.runId, kind, delta });
  }
}

test("thinking 流式单独一段并视觉弱化（~ 前缀 + 暗色），正文另起一段；控制序列照样净化", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-thinking-"));
  const term = new MockTerminal(80, 24);
  const runtime = new FakeRuntime();
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId: newSessionId(), logDir });
  try {
    shell.start();
    await settle();
    term.input("想一想");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emitDelta("thinking", "先看");
    runtime.emitDelta("thinking", "锚点\x1b[2J");
    runtime.emitDelta("text", "结论是改");
    await settle();

    const lines = term.screen.contentLines();
    const thinkingRow = lines.findIndex((line) => line.includes("~ 先看锚点"));
    const textRow = lines.findIndex((line) => line.includes("结论是改"));
    assert.ok(thinkingRow >= 0, screenText(term));
    assert.ok(textRow > thinkingRow, "正文段在 thinking 段之后另起");
    assert.ok(!lines[textRow]?.includes("~"), "正文段不带 thinking 前缀");
    assert.ok(screenText(term).includes("␛[2J"), "thinking 内容同样经 036 净化");
    const raw = term.writes.join("");
    assert.ok(raw.includes("\x1b[2m"), "thinking 段带暗色弱化");
    assert.ok(!raw.includes("\x1b[2J"), "模型内容里的控制序列不写往终端");
    runtime.finish();
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume 换绑后渲染全部历史：正文、thinking、工具行与折叠的 toolResult；历史上限可配", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-history-"));
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const target = newSessionId();
  await seedToolRun(sessionsDir, target);
  const render = async (historyLimit?: number): Promise<string> => {
    const term = new MockTerminal(100, 60);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: new FakeRuntime(),
      sessionId: newSessionId(),
      logDir: join(root, ".pigeon"),
      resume: { root, rebind: () => ({ runtime: new FakeRuntime() }) },
      ...(historyLimit !== undefined ? { historyLimit } : {}),
    });
    try {
      shell.start();
      await settle();
      term.input(`/resume ${target}`);
      term.input("\r");
      await settle(200);
      return screenText(term);
    } finally {
      shell.stop();
    }
  };
  try {
    const screen = await render();
    for (const expected of [
      "> 把 beta 改成大写",
      "~ 先确认锚点",
      "我来改",
      '$ edit_file {"path":"a.ts"} -> ok',
      "[result] edit_file ok（7 字符，已折叠）",
      "改好了",
      "== run ended | 分类：正常 ==",
    ]) {
      assert.ok(screen.includes(expected), `历史应包含「${expected}」：\n${screen}`);
    }
    const folded = await render(2);
    assert.ok(folded.includes("[更早 7 条未展开，/search 可查]"), folded);
    assert.ok(!folded.includes("> 把 beta 改成大写"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
