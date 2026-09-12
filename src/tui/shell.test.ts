// M2 S2：Application Shell 离屏测试（5a 第 4 件：Mock Terminal + 虚拟屏幕仿真器路径，
// 仿 tmp/spike-pi-tui/part-a-mock.mjs，不启动真实终端）。
// 断言面：
//   - 流式增量逐帧落地（text_delta → 当前 assistant 消息生长），CJK 混合文本宽度不错位；
//   - turn 标记、工具调用行（工具名+参数摘要+结果状态）、run 终态摘要；
//   - user 消息提交回显；输入提交只经 application API（TuiRuntimeFace.run）；
//   - 空输入静默忽略；运行中提交走 busy 语义（决策 027：拒绝提交、保留缓冲、提示可见）；
//   - dispose 对称：stop 后订阅退订，迟到事件/增量安全无效果。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRuntimeAdapter, type RunResult, type StreamTextDelta } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import {
  assertWidthsWithin,
  MockTerminal,
  screenFlat,
  screenText,
  settle,
  squashSpaces,
} from "./testing.ts";

// ---------- 假 application 面：记录 run 提交，手动发事件/增量 ----------
class FakeRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly streamListeners = new Set<(delta: StreamTextDelta) => void>();
  private readonly pendingResolvers: Array<() => void> = [];
  readonly runId: RunId = newRunId();
  autoResolve = true;

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    const result: RunResult = {
      runId: this.runId,
      status: "completed",
      stopReason: "stop",
      syntheticFailure: false,
      failure: null,
      advertisedTools: [],
      toolExecutions: [],
    };
    if (this.autoResolve) return Promise.resolve(result);
    return new Promise((resolve) => this.pendingResolvers.push(() => resolve(result)));
  }

  // 放行所有挂起的 run（busy 测试的闸门）
  finishAll(): void {
    for (const resolve of this.pendingResolvers.splice(0)) resolve();
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  listenerErrors(): unknown[] {
    return [];
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  emit(kind: RuntimeEventKind, payload: unknown): void {
    const envelope: EventEnvelope = {
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: SESSION_ID,
      runId: this.runId,
      timestamp: 1700000000000,
      kind,
      payload,
    };
    for (const listener of this.listeners) listener(envelope);
  }

  emitDelta(delta: string, runId: RunId = this.runId): void {
    for (const listener of this.streamListeners) listener({ runId, delta });
  }
}

// ---------- 夹具 ----------
const SESSION_ID: SessionId = newSessionId();

function makeShell(
  width: number,
  height: number
): { shell: PigeonTuiShell; runtime: FakeRuntime; term: MockTerminal; logDir: string } {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-test-"));
  const term = new MockTerminal(width, height);
  const runtime = new FakeRuntime();
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId: SESSION_ID, logDir });
  return { shell, runtime, term, logDir };
}

// ---------- 测试 ----------

test("流式增量逐帧落地；CJK 混合文本宽度不错位；user 提交回显且只经 application API", async () => {
  const WIDTH = 60;
  const { shell, runtime, term, logDir } = makeShell(WIDTH, 20);
  try {
    shell.start();
    await settle();

    // 输入区提交：经聚焦 Input 组件 → onSubmit → application API（runtime.run）
    term.input("讲个故事");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["讲个故事"], "提交必须且只能经 application API run()");
    assert.ok(screenText(term).includes("> 讲个故事"), "user 消息提交时应回显");

    // 流式生长：turn.started 开出 assistant 消息后，text_delta 逐帧落地（决策 024 观察口）
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    const chunks = [
      "终端渲染的正确性，",
      "取决于渲染器与终端的宽度共识；",
      "mixed agent、session 混排 abc。",
    ];
    let accumulated = "";
    for (const chunk of chunks) {
      accumulated += chunk;
      runtime.emitDelta(chunk);
      await settle();
      assert.ok(
        squashSpaces(screenFlat(term)).includes(squashSpaces(accumulated)),
        `本帧屏幕应包含累计文本「${accumulated}」，实际：\n${screenText(term)}`
      );
      assertWidthsWithin(term, WIDTH);
    }

    runtime.emit(RuntimeEventKind.TurnCompleted, { stopReason: "stop", syntheticFailure: false });
    runtime.emit(RuntimeEventKind.RunEnded, { messageCount: 2 });
    await settle();
    assertWidthsWithin(term, WIDTH);
    assert.ok(screenText(term).includes("-- turn: stop --"), "turn.completed 应渲染轮次标记");
    assert.ok(screenText(term).includes("== run: completed"), "run 结束应渲染终态摘要");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("工具调用行：工具名+参数摘要+结果状态；settled 原位更新；stale runId 增量被忽略", async () => {
  const { shell, runtime, term, logDir } = makeShell(80, 24);
  try {
    shell.start();
    await settle();
    term.input("读一下文件");
    term.input("\r");
    await settle();

    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emit(RuntimeEventKind.ToolProposed, {
      toolCallId: "tc-1",
      toolName: "read_file",
      args: { path: "src/甲.ts" },
    });
    await settle();
    assert.ok(
      screenText(term).includes('$ read_file {"path":"src/甲.ts"}'),
      "tool.proposed 应渲染工具名+参数摘要"
    );

    runtime.emit(RuntimeEventKind.ToolSettled, {
      toolCallId: "tc-1",
      toolName: "read_file",
      isError: false,
    });
    await settle();
    const settledLine = term.screen.contentLines().find((line) => line.includes("$ read_file"));
    assert.ok(settledLine?.includes("-> ok"), "tool.settled 应在原工具行追加结果状态");
    assert.ok(!settledLine?.includes("-> error"), "成功调用不得标 error");

    // 失败调用：isError + errorKind 落分类标签
    runtime.emit(RuntimeEventKind.ToolProposed, {
      toolCallId: "tc-2",
      toolName: "edit_file",
      args: { path: "src/乙.ts" },
    });
    runtime.emit(RuntimeEventKind.ToolSettled, {
      toolCallId: "tc-2",
      toolName: "edit_file",
      isError: true,
      errorKind: "domain",
    });
    await settle();
    const errorLine = term.screen.contentLines().find((line) => line.includes("$ edit_file"));
    assert.ok(errorLine?.includes("-> error [domain]"), "失败调用应标 error 与错误分类");

    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "toolUse",
      syntheticFailure: false,
    });
    await settle();
    assert.ok(screenText(term).includes("-- turn: toolUse --"));

    // stale 增量：非本 Run 的 text_delta 不进消息区（024：增量只认 runId 出处）
    runtime.emitDelta("幽灵增量不应出现", newRunId());
    await settle();
    assert.ok(!screenText(term).includes("幽灵增量不应出现"));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("空输入静默忽略；运行中提交走 busy 语义：拒绝提交、保留缓冲、提示可见（决策 027）", async () => {
  const { shell, runtime, term, logDir } = makeShell(80, 24);
  runtime.autoResolve = false; // run 挂起，制造「运行中」窗口
  try {
    shell.start();
    await settle();

    // 空输入：不回显、不提交、不提示
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [], "空输入不得触发 run()");
    assert.ok(!screenText(term).includes("[busy]"));

    // 第一次提交进入运行中
    term.input("任务一");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["任务一"]);
    assert.ok(screenText(term).includes("state: running"), "运行中状态行应可见");

    // 运行中第二次提交：拒绝（不再调 run），保留输入缓冲，busy 提示可见
    term.input("任务二");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["任务一"], "busy 期间不得再次提交");
    assert.ok(screenText(term).includes("[busy]"), "busy 拒绝必须在消息区留可见提示");
    assert.ok(screenText(term).includes("任务二"), "busy 拒绝后输入缓冲必须保留");

    // Run 结束后缓冲仍在，再按回车即提交
    runtime.finishAll();
    await settle();
    assert.ok(screenText(term).includes("state: idle"), "run 结束后状态行应回 idle");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["任务一", "任务二"], "缓冲保留的输入应可再次提交");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("dispose 对称：stop 退订全部监听并停 tui；迟到事件与增量安全无效果", async () => {
  const { shell, runtime, term, logDir } = makeShell(60, 20);
  try {
    shell.start();
    await settle();
    term.input("你好");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["你好"]);
    const before = screenText(term);

    shell.stop();
    assert.ok(term.stopped, "stop 必须停掉底层 tui/terminal");
    // 迟到事件与增量：不得抛、不得改变屏幕（上游 abort 竞态的防护）
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emitDelta("迟到增量");
    runtime.emit(RuntimeEventKind.TurnCompleted, { stopReason: "stop", syntheticFailure: false });
    await settle();
    assert.equal(screenText(term), before, "stop 后渲染面不得再变化");
    // 幂等：重复 stop 安全
    shell.stop();
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("集成：真实 PiRuntimeAdapter + fake streamFn 全链路——提交、流式、turn 标记、终态摘要", async () => {
  const reply = "真实链路中文回复，混合 agent 词汇，逐字流出。";
  const snapshot: InjectionSnapshot = {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: [], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
  const adapter = new PiRuntimeAdapter({
    snapshot,
    streamFn: createFakeStreamFn({ replies: [{ text: reply, chunkSize: 3 }] }),
  });
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-test-"));
  const term = new MockTerminal(70, 24);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: adapter,
    sessionId: SESSION_ID,
    logDir,
  });
  try {
    shell.start();
    await settle();
    term.input("你好");
    term.input("\r");
    // 等 run 终态摘要出现（真实 adapter 异步跑循环）
    let text = "";
    for (let waited = 0; waited < 5000 && !text.includes("== run:"); waited += 50) {
      await settle(50);
      text = screenText(term);
    }
    assert.ok(text.includes("> 你好"), "user 回显");
    assert.ok(
      squashSpaces(screenFlat(term)).includes(squashSpaces(reply)),
      `assistant 全文应落地，实际：\n${text}`
    );
    assert.ok(text.includes("-- turn: stop --"), "turn 标记");
    assert.ok(text.includes("== run: completed"), "run 终态摘要");
    assertWidthsWithin(term, 70);
  } finally {
    shell.stop();
    await adapter.dispose();
    rmSync(logDir, { recursive: true, force: true });
  }
});
