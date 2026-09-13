// M2 S5+：退出三层形态的离屏测试（裁决 033，omp 键位模型；同一 Mock Terminal + 虚拟屏幕路径）。
// 断言面：
//   - 单击 Ctrl+C（\x03，非模态）：清空输入缓冲 + 消息区留 [cleared] 提示行；清空不提交；
//   - 双击 Ctrl+C（窗口内两次，任意模式含模态）：优雅退出——注入的 onExit 恰好一次，
//     且 stop()（dispose 对称）先于 onExit；退出后重复按键不再触发；
//   - 窗口过期：两次按键间隔超过窗口 = 两次单击（各自清缓冲留提示），不退出，第二次重新布防；
//   - 模态单击 Ctrl+C：不清缓冲、不留提示，但仍计退出布防第一次（窗口内第二次即退出）；
//   - 退出时挂起审批 fail-closed：APPROVAL_CANCEL_CLOSED 逐字理由决议（stop() 既有路径，
//     证据链不断），stop 先于退出回调；
//   - /quit 斜杠命令与双击 Ctrl+C 同一优雅退出路径；
//   - Esc 取消行为不变（032 不动）——由 cancel.test.ts 全绿承载。
// onExit 注入使测试绝不真退进程（main.ts 注入 dispose + process.exit 的真实回调）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { APPROVAL_CANCEL_CLOSED, type ApprovalPanelResult } from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

// 最小 application 面：记录 run 提交（退出键路径不得漏进 run）
class StubRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    // 挂起不决议：退出键测试只断言「提交未发生」，终态不消费
    const { promise } = Promise.withResolvers<RunResult>();
    return promise;
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

const REQUEST: ApprovalRequest = {
  toolName: "edit_file",
  toolCallId: "tc-1",
  args: { path: "src/a.ts", edits: [{ op: "replace" }] },
  runId: newRunId(),
};

// 壳 + 退出观察口：exitCalls 记次数，stoppedAtExit 记「onExit 时壳已停止」（stop 先于退出）
function makeShell(options?: { exitWindowMs?: number }) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-exit-"));
  const term = new MockTerminal(80, 24);
  const runtime = new StubRuntime();
  const probe = { exitCalls: 0, stoppedAtExit: null as boolean | null };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: SESSION_ID,
    logDir,
    ...(options?.exitWindowMs !== undefined ? { exitWindowMs: options.exitWindowMs } : {}),
    onExit: () => {
      probe.exitCalls++;
      probe.stoppedAtExit = term.stopped;
    },
  });
  return {
    shell,
    term,
    runtime,
    probe,
    cleanup: () => rmSync(logDir, { recursive: true, force: true }),
  };
}

test("单击 Ctrl+C 清空输入缓冲并留 [cleared] 提示；清空不提交", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("草稿内容");
    await settle();
    assert.ok(screenFlat(term).includes("草稿内容"), "输入行应显示草稿");

    term.input("\x03");
    await settle();
    const text = screenText(term);
    assert.ok(
      text.includes("[cleared] 输入已清空（再按一次 Ctrl+C 退出）"),
      "单击必须留 [cleared] 提示行"
    );
    assert.ok(!screenFlat(term).includes("草稿内容"), "缓冲清空后输入行不得再显示草稿");

    // 清空不是提交：回车后不得有 run 发生
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [], "清空缓冲不得提交 run");
  } finally {
    shell.stop();
    cleanup();
  }
});

test("双击 Ctrl+C：注入退出恰好一次，stop() 先于退出回调；退出后重复按键不再触发", async () => {
  const { shell, term, probe, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("\x03");
    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 1, "窗口内双击必须触发恰好一次退出");
    assert.ok(probe.stoppedAtExit === true, "stop() 必须先于退出回调");
    assert.ok(term.stopped, "双击后壳应已停止");

    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 1, "退出后重复 Ctrl+C 不得再次触发");
  } finally {
    cleanup();
  }
});

test("窗口过期：两次按键间隔超过窗口 = 两次单击，不退出；第二次重新布防", async () => {
  const { shell, term, probe, cleanup } = makeShell({ exitWindowMs: 200 });
  try {
    shell.start();
    await settle();
    term.input("\x03");
    await settle(300); // 超过 200ms 窗口
    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 0, "窗口过期的两次按键不得触发退出");
    assert.ok(screenText(term).includes("[cleared]"), "两次单击各自留提示行");

    // 第二次单击已重新布防：窗口内再来一次即退出
    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 1, "重新布防后窗口内按键必须退出");
  } finally {
    cleanup();
  }
});

test("模态期间单击 Ctrl+C 不清缓冲不留提示，但仍计退出布防第一次", async () => {
  const { shell, term, probe, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("面板前草稿");
    await settle();
    const approval = shell.askApproval(REQUEST);
    await settle();

    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 0, "模态单击不得退出");
    assert.ok(!screenText(term).includes("[cleared]"), "模态单击不得留清缓冲提示");
    assert.ok(screenFlat(term).includes("面板前草稿"), "模态单击不得清输入缓冲");

    // 已布防：窗口内第二次 Ctrl+C（仍在模态）即优雅退出
    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 1, "模态下窗口内双击必须退出");
    const result = await approval;
    assert.equal(result.key, "cancel", "壳停止时挂起审批必须 fail-closed");
  } finally {
    cleanup();
  }
});

test("退出时挂起审批 fail-closed：APPROVAL_CANCEL_CLOSED 逐字理由决议，stop 先于退出", async () => {
  const { shell, term, probe, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    const approval = shell.askApproval(REQUEST);
    await settle();

    term.input("\x03");
    term.input("\x03");
    await settle();
    assert.equal(probe.exitCalls, 1);
    assert.ok(probe.stoppedAtExit === true, "stop()（含审批 fail-closed）必须先于退出回调");
    const result: ApprovalPanelResult = await approval;
    assert.deepEqual(result, { key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
  } finally {
    cleanup();
  }
});

test("/quit 与双击 Ctrl+C 同一优雅退出路径", async () => {
  const { shell, term, probe, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("/quit");
    term.input("\r");
    await settle();
    assert.equal(probe.exitCalls, 1, "/quit 必须触发优雅退出");
    assert.ok(probe.stoppedAtExit === true, "stop() 必须先于退出回调");
    assert.ok(term.stopped, "/quit 后壳应已停止");
  } finally {
    cleanup();
  }
});
