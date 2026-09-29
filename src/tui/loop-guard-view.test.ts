// 终端界面里的打转检测（决策 305–307）：提醒进模型下一轮、同时在消息区显示成系统消息（不像人输入的话）；第 20 轮叫停——
// 消息区写明检测到打转、重复的调用与轮数，同 Esc 中断本轮（原因为打转）；会话照常可用，下一条输入重新计数。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunResult, StreamTextDelta, TurnRoundNotice } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId } from "../state/ids.ts";
import {
  DEFAULT_LOOP_GUARD_SETTINGS,
  DISABLED_LOOP_GUARD_SETTINGS,
} from "../state/loop-guard-config.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import { guardTuiAgent } from "./loop-guard-view.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";

// 运行面替身：run 挂起到测试放行或被中断；整轮由测试发出
class LoopRuntime implements TuiRuntimeFace {
  readonly inputs: string[] = [];
  readonly notes: string[] = [];
  readonly causes: Array<RunStopCause | undefined> = [];
  readonly #rounds = new Set<(round: TurnRoundNotice) => void>();
  #current: ReturnType<typeof Promise.withResolvers<RunResult>> | undefined;
  #runId: RunId = newRunId();
  #seq = 0;

  run(input: string): Promise<RunResult> {
    this.inputs.push(input);
    this.#runId = newRunId();
    this.#current = Promise.withResolvers<RunResult>();
    return this.#current.promise;
  }
  // 发出 n 轮同样的调用与结果
  rounds(n: number): void {
    for (let index = 0; index < n; index += 1) {
      this.#seq += 1;
      const id = `call-${this.#seq}`;
      for (const listener of [...this.#rounds]) {
        listener({
          runId: this.#runId,
          calls: [{ toolCallId: id, toolName: "run_command", args: { command: "npm test" } }],
          results: [{ toolCallId: id, isError: false, text: "FAIL src/a.test.ts" }],
        });
      }
    }
  }
  subscribeRounds(listener: (round: TurnRoundNotice) => void): () => void {
    this.#rounds.add(listener);
    return () => this.#rounds.delete(listener);
  }
  notify(text: string): string {
    this.notes.push(text);
    return `note-${this.notes.length}`;
  }
  interrupt(cause?: RunStopCause): Promise<void> {
    this.causes.push(cause);
    this.#current?.resolve({
      runId: this.#runId,
      status: "aborted",
      syntheticFailure: false,
      failure: null,
      advertisedTools: [],
    } as unknown as RunResult);
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

async function submit(term: MockTerminal, text: string): Promise<void> {
  term.input(text);
  term.input("\r");
  await settle();
}

function shellWith(runtime: LoopRuntime) {
  const term = new MockTerminal(200, 60);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: newSessionId(),
    logDir: mkdtempSync(join(tmpdir(), "pigeon-tui-loop-")),
  });
  return { term, shell };
}

test("终端界面：提醒显示成系统消息；第 20 轮叫停并在消息区写明，同 Esc 中断本轮；会话照常可用，下一条输入重新计数", async () => {
  const runtime = new LoopRuntime();
  const { term, shell } = shellWith(runtime);
  const detach = guardTuiAgent({
    runtime,
    settings: DEFAULT_LOOP_GUARD_SETTINGS,
    shell: () => shell,
  });
  try {
    shell.start();
    await settle();
    await submit(term, "修测试");
    assert.deepEqual(runtime.inputs, ["修测试"]);
    runtime.rounds(6);
    await settle();
    // 提醒进模型下一轮，同时显示在消息区：是系统消息，不带人输入的回显前缀
    assert.equal(runtime.notes.length, 1);
    const screen = screenFlat(term);
    assert.ok(
      screen.includes("[打转提醒] 最近连续 5 轮，你的工具调用和得到的结果都与上一轮完全相同："),
      screen
    );
    assert.ok(!screen.includes("> [打转提醒]"), screen);
    assert.ok(screen.includes("> 修测试"), screen);
    runtime.rounds(15);
    await settle();
    assert.equal(runtime.notes.length, 2);
    assert.deepEqual(runtime.causes, ["looping"]);
    const stopped = screenFlat(term);
    assert.ok(
      stopped.includes(
        '[打转] 检测到打转：连续 20 轮重复同样的工具调用与结果，本轮已叫停。重复的调用：run_command {"command":"npm test"}。'
      ),
      stopped
    );
    assert.ok(
      stopped.includes("会话照常可用，可以给出下一步的指示；想让它接着做，直接说“继续”。"),
      stopped
    );
    // 同 Esc：走的是同一条中断路径
    assert.ok(stopped.includes("[cancel] interrupt requested"), stopped);
    // 会话照常可用：说"继续"即开下一次运行，重新计数
    await submit(term, "继续");
    assert.deepEqual(runtime.inputs, ["修测试", "继续"]);
    runtime.rounds(5);
    await settle();
    assert.equal(runtime.notes.length, 2);
    runtime.rounds(1);
    await settle();
    assert.equal(runtime.notes.length, 3);
  } finally {
    detach();
    shell.stop();
  }
});

test("终端界面：打转检测关掉时不提醒、不叫停", async () => {
  const runtime = new LoopRuntime();
  const { term, shell } = shellWith(runtime);
  const detach = guardTuiAgent({
    runtime,
    settings: DISABLED_LOOP_GUARD_SETTINGS,
    shell: () => shell,
  });
  try {
    shell.start();
    await settle();
    await submit(term, "修测试");
    runtime.rounds(30);
    await settle();
    assert.deepEqual(runtime.notes, []);
    assert.deepEqual(runtime.causes, []);
    assert.ok(!screenFlat(term).includes("打转"), screenFlat(term));
  } finally {
    detach();
    shell.stop();
  }
});
