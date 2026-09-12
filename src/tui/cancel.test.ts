// M2 S5：取消入口与错误/终止原因展示的离屏测试（同一 Mock Terminal + 虚拟屏幕路径）。
// 断言面：
//   - 运行中 Esc 触发 interrupt 且只一次（中断飞行中重复 Esc 不 double-abort、不悬挂）；
//   - 取消后终态行渲染：stopReason=aborted + 四分类「取消」徽章（措辞与 cli trace 同口径）；
//   - 模态键控优先（决策 029/031，S5 裁决 032）：审批面板挂起期间 Esc 吞掉，不取消 Run；
//   - 四分类徽章五档渲染（取消/治理熔断/业务失败/基础设施错误/未知）+ errorMessage +
//     syntheticFailure 标注；
//   - listenerErrors 增量警告（D2 可见化的 TUI 投影，措辞与增量报数口径同 cli repl）；
//   - 集成：真实 PiRuntimeAdapter 取消链路不悬挂（Esc → interrupt 固定姿势 → 终态 aborted）。
// abort → waitForIdle 姿势本身的单元断言在 pi-runtime 层（adapter.test.ts「流式中途 abort」），
// 本切片断言 TUI 触发链不悬挂、不 double-abort。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { PiRuntimeAdapter, type RunResult, type StreamTextDelta } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn, createGate } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

// ---------- 假 application 面：可控 run 终态、interrupt 计数与门闩、listenerErrors 观察口 ----------
class FakeRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];
  interruptCalls = 0;
  readonly errors: unknown[] = [];
  readonly runId: RunId = newRunId();
  autoResolve = true;
  autoInterrupt = true;
  // 下一次 run 决议的终态覆盖（逐键覆盖进基础形状；显式 undefined 可抹掉 stopReason——
  // 逐键映射加 | undefined，exactOptionalPropertyTypes 下 Partial 不收显式 undefined）
  nextResult: { [K in keyof RunResult]?: RunResult[K] | undefined } = {};
  private pendingRun: (() => void) | null = null;
  private pendingInterrupt: (() => void) | null = null;

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    const overrides = this.nextResult;
    const result: RunResult = {
      runId: this.runId,
      status: overrides.status ?? "completed",
      syntheticFailure: overrides.syntheticFailure ?? false,
      failure: overrides.failure ?? null,
      advertisedTools: [],
      toolExecutions: [],
    };
    // stopReason 逐键处理：显式 undefined = 本 Run 无 stopReason（键不存在）——
    // exactOptionalPropertyTypes 下 spread 无法逐字表达这一语义
    const stopReason = "stopReason" in overrides ? overrides.stopReason : "stop";
    if (stopReason !== undefined) result.stopReason = stopReason;
    if (overrides.errorMessage !== undefined) result.errorMessage = overrides.errorMessage;
    if (this.autoResolve) return Promise.resolve(result);
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    this.pendingRun = () => resolve(result);
    return promise;
  }

  finishRun(): void {
    this.pendingRun?.();
    this.pendingRun = null;
  }

  interrupt(): Promise<void> {
    this.interruptCalls++;
    if (this.autoInterrupt) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.pendingInterrupt = resolve;
    return promise;
  }

  finishInterrupt(): void {
    this.pendingInterrupt?.();
    this.pendingInterrupt = null;
  }

  listenerErrors(): unknown[] {
    return this.errors.slice();
  }

  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }

  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

function makeShell(width: number, height: number) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-cancel-"));
  const term = new MockTerminal(width, height);
  const runtime = new FakeRuntime();
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId: SESSION_ID, logDir });
  return { shell, runtime, term, logDir };
}

// ---------- 测试 ----------

test("取消键：运行中 Esc 触发 interrupt 且只一次；取消后终态行带 stopReason=aborted 与「取消」徽章", async () => {
  const { shell, runtime, term, logDir } = makeShell(80, 24);
  runtime.autoResolve = false; // run 挂起，制造「运行中」窗口
  runtime.autoInterrupt = false; // interrupt 挂起，制造「中断飞行中」窗口
  runtime.nextResult = {
    status: "aborted",
    stopReason: "aborted",
    failure: { category: "cancelled", breaker: false },
  };
  try {
    shell.start();
    await settle();
    term.input("长任务");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["长任务"]);
    assert.ok(screenText(term).includes("state: running"), "运行中状态行应可见");

    // Esc（裸 "\x1b"）：触发 interrupt，消息区留取消痕迹，状态行进 cancelling
    term.input("\x1b");
    assert.equal(runtime.interruptCalls, 1, "Esc 必须触发一次 interrupt()");
    await settle();
    assert.ok(screenText(term).includes("[cancel]"), "取消请求必须在消息区留可见痕迹");
    assert.ok(screenText(term).includes("state: cancelling"), "中断等待期间状态行应可见");

    // 中断飞行中重复 Esc：不再触发（不 double-abort、不悬挂）
    term.input("\x1b");
    term.input("\x1b");
    assert.equal(runtime.interruptCalls, 1, "中断飞行中重复 Esc 不得再次 interrupt()");

    // 中断与 run 先后收尾：终态行 = stopReason=aborted + 四分类「取消」徽章（trace 同口径）
    runtime.finishInterrupt();
    runtime.finishRun();
    await settle();
    const text = screenText(term);
    assert.ok(text.includes("== run: aborted"), "取消后应渲染 aborted 终态行");
    assert.ok(text.includes("stop: aborted"), "终态行应带 stopReason=aborted");
    assert.ok(text.includes("分类：取消"), "终态行应带四分类「取消」徽章");
    assert.ok(text.includes("state: idle"), "run 收尾后状态行应回 idle");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("模态键控优先：审批面板挂起期间 Esc 吞掉不取消 Run；面板决议后 Esc 才触发 interrupt", async () => {
  const { shell, runtime, term, logDir } = makeShell(80, 24);
  runtime.autoResolve = false;
  const request: ApprovalRequest = {
    toolName: "edit_file",
    toolCallId: "tc-1",
    args: { path: "src/a.ts", edits: [{ op: "replace" }] },
    diffPreview: "@@ -1 +1 @@ -alpha +STEP1",
    runId: newRunId(),
  };
  try {
    shell.start();
    await settle();
    term.input("改文件");
    term.input("\r");
    await settle();

    // 审批面板挂起（Run 阻塞在 beforeToolCall 的人工决议上）
    const panel = shell.askApproval(request);
    await settle();
    assert.ok(screenText(term).includes("state: approval"), "面板期间状态行应可见");

    // Esc 与面板非决议键同待遇：吞掉——此时 interrupt 的 waitForIdle 会吊在挂起
    // Promise 上直到人按键，「取消」名不副实；模态先决议再 Esc 是唯一次序（裁决 032）
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interruptCalls, 0, "面板期间 Esc 不得触发 interrupt");

    // 四键决议后面板关闭；再按 Esc 才轮到取消 Run
    term.input("y");
    const verdict = await panel;
    assert.deepEqual(verdict, { key: "y" });
    await settle();
    term.input("\x1b");
    assert.equal(runtime.interruptCalls, 1, "面板关闭后 Esc 应触发 interrupt");

    runtime.finishRun();
    await settle();
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("四分类徽章五档渲染：取消/治理熔断/业务失败/基础设施错误/未知 + errorMessage + syntheticFailure 标注", async () => {
  const { shell, runtime, term, logDir } = makeShell(100, 30);
  try {
    shell.start();
    await settle();

    const cases: Array<{ result: FakeRuntime["nextResult"]; expect: string[] }> = [
      {
        result: {
          status: "aborted",
          stopReason: "aborted",
          failure: { category: "cancelled", breaker: false },
        },
        expect: ["== run: aborted", "stop: aborted", "分类：取消"],
      },
      {
        // 治理熔断是取消的子类（D7：与用户取消必须一眼可分）
        result: {
          status: "aborted",
          stopReason: "aborted",
          failure: { category: "cancelled", breaker: true },
        },
        expect: ["分类：治理熔断"],
      },
      {
        result: { status: "failed", stopReason: "length", failure: { category: "business" } },
        expect: ["== run: failed", "stop: length", "分类：业务失败"],
      },
      {
        result: {
          status: "failed",
          stopReason: "error",
          syntheticFailure: true,
          errorMessage: "provider boom",
          failure: { category: "infrastructure" },
        },
        expect: ["分类：基础设施错误", "(synthetic failure)", "error: provider boom"],
      },
      {
        // 未知默认桶：无 stopReason 时终态行不带 stop 段
        result: { status: "unknown", stopReason: undefined, failure: { category: "unknown" } },
        expect: ["== run: unknown", "分类：未知"],
      },
    ];
    for (const [index, item] of cases.entries()) {
      runtime.nextResult = item.result;
      term.input(`任务${index}`);
      term.input("\r");
      await settle();
      for (const expected of item.expect) {
        assert.ok(
          screenText(term).includes(expected),
          `第 ${index + 1} 档终态行应包含「${expected}」，实际：\n${screenText(term)}`
        );
      }
    }
    // 未知档：无 stopReason → 同行不得出现 stop 段
    const unknownLine = term.screen.contentLines().find((line) => line.includes("== run: unknown"));
    assert.ok(
      unknownLine !== undefined && !unknownLine.includes("stop:"),
      "无 stopReason 不带 stop 段"
    );
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("listenerErrors 增量警告：启动即查 + run 收尾复查；同批故障不重复刷屏，新故障以累计数提醒", async () => {
  const { shell, runtime, term, logDir } = makeShell(80, 24);
  runtime.errors.push(new Error("模拟磁盘故障"));
  try {
    shell.start();
    await settle();
    const warnings = (): string[] =>
      screenText(term)
        .split("\n")
        .filter((line) => line.includes("证据链不完整"));
    assert.deepEqual(warnings().length, 1, "启动即查一次：已有故障应立即警告");
    assert.ok(warnings()[0]?.includes("1 条"), "警告措辞与 repl 同口径（累计条数）");

    // 同批故障：run 收尾后不再重复警告
    term.input("任务一");
    term.input("\r");
    await settle();
    assert.deepEqual(warnings().length, 1, "同批故障不得重复刷屏");

    // 新故障出现：以累计数再提醒
    runtime.errors.push(new Error("故障二"), new Error("故障三"));
    term.input("任务二");
    term.input("\r");
    await settle();
    assert.deepEqual(warnings().length, 2, "新故障应再次警告");
    assert.ok(warnings()[1]?.includes("3 条"), "再警告报累计条数");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("集成：真实 Adapter 取消链路不悬挂——Esc 触发 interrupt，终态 aborted 渲染，状态回 idle", async () => {
  const snapshot: InjectionSnapshot = {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: [], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
  // 门闩把模型流停在「已开始但未结束」的确定时间点，Esc 后再放行收尾（同 adapter.test.ts 姿势）
  const gate = createGate();
  const streamFn = createFakeStreamFn({
    replies: [{ text: "这是一段足够长的流式回复，门闩停在中途。", chunkSize: 2, chunkGate: gate }],
  });
  const adapter = new PiRuntimeAdapter({ snapshot, streamFn });
  // run.ended 真实信号：订阅等待，不猜时间
  const runEnded = Promise.withResolvers<void>();
  const unsubscribe = adapter.subscribe((event) => {
    if (event.kind === "run.ended") {
      unsubscribe();
      runEnded.resolve();
    }
  });
  const turnStarted = Promise.withResolvers<void>();
  const unsubscribeTurn = adapter.subscribe((event) => {
    if (event.kind === "turn.started") {
      unsubscribeTurn();
      turnStarted.resolve();
    }
  });

  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-cancel-"));
  const term = new MockTerminal(80, 24);
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
    await turnStarted.promise;
    assert.ok(adapter.isRunning(), "门闩期间 Run 应在运行中");

    term.input("\x1b");
    // abort 同步生效后放行门闩，让流以 error{reason:"aborted"} 收尾
    gate.open();
    await runEnded.promise;
    await settle();
    const text = screenText(term);
    assert.ok(text.includes("[cancel]"), "取消请求应留可见痕迹");
    assert.ok(text.includes("== run: aborted"), "取消后应渲染 aborted 终态行");
    assert.ok(text.includes("stop: aborted"), "终态行应带 stopReason=aborted");
    assert.ok(text.includes("分类：取消"), "终态行应带「取消」徽章");
    assert.ok(text.includes("state: idle"), "run 收尾后状态行应回 idle");
    assert.equal(adapter.isRunning(), false, "interrupt 固定姿势收尾后不得悬挂");
    assert.equal(streamFn.calls.length, 1, "取消不得引发重试/二次调用");
  } finally {
    shell.stop();
    await adapter.dispose();
    rmSync(logDir, { recursive: true, force: true });
  }
});
