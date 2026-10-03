// 决策 323 / 324：终端界面接钩子的离屏测试（与 shell.test.ts 同一 Mock Terminal 路径）。
// 断言面：
//   - /hooks 只读列出生效的钩子（事件、matcher、命令、来自哪一层、在哪执行、超时秒数）与
//     disableAllHooks 开关；
//   - SessionStart 补的上下文只前缀给下一条输入（且只一次）；
//   - Stop 拦住即把理由作为新一轮输入接着跑，连续拦到上限（stopHookBlockCap）后不再跑；
//   - Notification：审批面板出现记 permission_prompt，worker 的请示另记 worker_approval。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookEventReport } from "../application/hooks.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { HookEventName, LayeredHook } from "../state/hooks.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { renderHooksView, type TuiHooksFace } from "./hooks-view.ts";
import { askApprovalPanel } from "./modal.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();
const RUN_ID: RunId = newRunId();

// 最小 application 面：记录 run 提交（RunResult 立即决议）
class FakeRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    return Promise.resolve({
      runId: RUN_ID,
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
}

// 假钩子面：按事件登记逐次返回的报告（队列空了即空报告）；记录每次调用的目标与字段
class FakeHooks implements TuiHooksFace {
  readonly calls: Array<{
    event: HookEventName;
    target: string;
    fields: Record<string, unknown>;
  }> = [];
  readonly script = new Map<string, HookEventReport[]>();
  disabled = false;
  hooks: readonly LayeredHook[];

  constructor(hooks: readonly LayeredHook[] = []) {
    this.hooks = hooks;
  }

  runEvent(
    event: HookEventName,
    target: string,
    fields: Record<string, unknown>
  ): Promise<HookEventReport> {
    this.calls.push({ event, target, fields });
    const next = this.script.get(event)?.shift();
    return Promise.resolve(
      next ?? { runs: [], additionalContext: [], systemMessages: [], ran: false }
    );
  }

  list(): readonly LayeredHook[] {
    return this.disabled ? [] : this.hooks;
  }
}

function report(partial: Partial<HookEventReport> = {}): HookEventReport {
  return { runs: [], additionalContext: [], systemMessages: [], ran: true, ...partial };
}

function makeShell(hooks?: FakeHooks, stopHookCap?: number) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-hooks-"));
  const term = new MockTerminal(100, 24);
  const runtime = new FakeRuntime();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: SESSION_ID,
    logDir,
    ...(hooks !== undefined ? { hooks } : {}),
    ...(stopHookCap !== undefined ? { stopHookCap: () => stopHookCap } : {}),
  });
  return { shell, runtime, term, logDir };
}

const STOP_HOOK: LayeredHook = {
  event: "Stop",
  command: "node stop.mjs",
  host: false,
  layer: "project",
};
const TOOL_HOOK: LayeredHook = {
  event: "PreToolUse",
  matcher: "edit_file",
  command: "audit.sh",
  timeoutMs: 5000,
  host: true,
  layer: "user",
};

test("决策 324：/hooks 列出生效的钩子（事件、matcher、命令、层、执行位置、超时）与停用开关", () => {
  const hooks = new FakeHooks([STOP_HOOK, TOOL_HOOK]);
  const text = renderHooksView(hooks);
  assert.ok(text.startsWith("== 钩子 ==\n"), text);
  assert.ok(text.includes("disableAllHooks：未生效"), text);
  assert.ok(
    text.includes("- Stop | node stop.mjs | 项目共享 | 在工作区所在处执行 | 超时 600 秒"),
    text
  );
  assert.ok(
    text.includes(
      "- PreToolUse（matcher：edit_file） | audit.sh | 用户级 | 在宿主执行 | 超时 5 秒"
    ),
    text
  );
  assert.ok(text.includes("共 2 条"), text);
  // 停用（--no-hooks 或设置里的 disableAllHooks）：开关写明，清单为空
  const off = new FakeHooks([STOP_HOOK]);
  off.disabled = true;
  const disabledText = renderHooksView(off);
  assert.ok(disabledText.includes("disableAllHooks：生效"), disabledText);
  assert.ok(disabledText.includes("生效的钩子：无"), disabledText);
  assert.ok(!disabledText.includes("node stop.mjs"), disabledText);
});

test("决策 324：/hooks 在壳里可用（只读，命令表放行）并落消息区", async () => {
  const hooks = new FakeHooks([STOP_HOOK]);
  const { shell, term, logDir } = makeShell(hooks);
  try {
    shell.start();
    await settle();
    term.input("/hooks");
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.ok(screen.includes("== 钩子 =="), screen);
    assert.ok(screen.includes("disableAllHooks：未生效"), screen);
    assert.ok(screen.includes("node stop.mjs"), screen);
    assert.ok(screen.includes("项目共享"), screen);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 323：SessionStart 补的上下文前缀给下一条输入（只一次），并在消息区提示一行", async () => {
  const hooks = new FakeHooks();
  hooks.script.set("SessionStart", [
    report({ additionalContext: ["开局上下文甲"], systemMessages: ["钩子系统提示"] }),
  ]);
  const { shell, runtime, term, logDir } = makeShell(hooks);
  try {
    shell.start();
    await settle();
    await shell.beginSession("startup");
    await settle();
    const screen = screenText(term);
    assert.ok(screen.includes("钩子系统提示"), screen);
    assert.ok(screen.includes("SessionStart 补的上下文将在下一条输入带上"), screen);
    assert.equal(hooks.calls[0]?.event, "SessionStart");
    assert.equal(hooks.calls[0]?.target, "startup", "matcher 目标为 source");

    term.input("问题一");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["开局上下文甲\n\n问题一"], "上下文前缀给第一条输入");

    term.input("问题二");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["开局上下文甲\n\n问题一", "问题二"], "上下文只前缀一次");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 323：Stop 拦住把理由作为新一轮输入接着跑；撞上限后不再跑", async () => {
  const hooks = new FakeHooks();
  hooks.script.set("Stop", [
    report({ blocked: { reason: "再检查一遍" } }),
    // 第二次未拦住：循环结束
  ]);
  const { shell, runtime, term, logDir } = makeShell(hooks);
  try {
    shell.start();
    await settle();
    term.input("干活");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["干活", "再检查一遍"], "拦下的理由作为新一轮输入");
    const screen = screenText(term);
    assert.ok(screen.includes("Stop 拦下，理由作为新一轮输入继续：再检查一遍"), screen);
    // stop_hook_active：首次 false，继续后 true
    const stops = hooks.calls.filter((call) => call.event === "Stop");
    assert.deepEqual(
      stops.map((call) => call.fields.stop_hook_active),
      [false, true]
    );
    assert.equal(stops[0]?.target, "", "Stop 的 matcher 目标为空串");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 323：Stop 连续拦到上限（stopHookBlockCap）后不再跑并提示一行", async () => {
  const hooks = new FakeHooks();
  // 每次都拦：上限 2 → 最多继续 2 轮，第 3 次拦下不再理会
  const alwaysBlock = (): Promise<HookEventReport> =>
    Promise.resolve(report({ blocked: { reason: "再来" } }));
  hooks.runEvent = (event, target, fields) => {
    hooks.calls.push({ event, target, fields });
    return event === "Stop" ? alwaysBlock() : Promise.resolve(report());
  };
  const { shell, runtime, term, logDir } = makeShell(hooks, 2);
  try {
    shell.start();
    await settle();
    term.input("干活");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["干活", "再来", "再来"], "到上限即不再继续");
    assert.ok(
      screenText(term).includes("Stop 钩子连续拦下 2 次，已到上限，不再接着跑"),
      screenText(term)
    );
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 323：外部取消（Esc）后的这一轮不跑 Stop 钩子", async () => {
  const hooks = new FakeHooks();
  hooks.script.set("Stop", [report({ blocked: { reason: "不该被用上" } })]);
  const { shell, runtime, term, logDir } = makeShell(hooks);
  // run 挂起：Esc 取消后本轮才决议（模拟外部取消）
  let finish: (() => void) | undefined;
  runtime.run = (input: string): Promise<RunResult> => {
    runtime.runs.push(input);
    return new Promise((resolve) => {
      finish = () =>
        resolve({
          runId: RUN_ID,
          status: "aborted",
          stopReason: "aborted",
          syntheticFailure: false,
          failure: null,
          advertisedTools: [],
          toolExecutions: [],
        });
    });
  };
  try {
    shell.start();
    await settle();
    term.input("干活");
    term.input("\r");
    await settle();
    shell.requestInterrupt();
    finish?.();
    await settle();
    assert.deepEqual(runtime.runs, ["干活"], "取消过的一轮不再接着跑");
    assert.equal(
      hooks.calls.some((call) => call.event === "Stop"),
      false,
      "取消过的一轮不跑 Stop 钩子"
    );
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 323/324：审批面板出现记 permission_prompt；worker 的请示另记 worker_approval", async () => {
  const hooks = new FakeHooks();
  const { shell, term, logDir } = makeShell(hooks);
  const notificationTypes = (): string[] =>
    hooks.calls.filter((call) => call.event === "Notification").map((call) => call.target);
  try {
    shell.start();
    await settle();
    const mainRequest: ApprovalRequest = {
      toolName: "run_command",
      toolCallId: "tc-1",
      args: { command: "ls" },
    };
    void askApprovalPanel(shell, mainRequest);
    await settle();
    assert.deepEqual(notificationTypes(), ["permission_prompt"]);
    term.input("y");
    await settle();

    const workerRequest: ApprovalRequest = {
      toolName: "edit_file",
      toolCallId: "tc-2",
      args: { path: "a.ts" },
      sessionId: newSessionId(),
      worker: { name: "w1", role: "coder" },
    };
    void askApprovalPanel(shell, workerRequest);
    await settle();
    assert.deepEqual(notificationTypes(), [
      "permission_prompt",
      "permission_prompt",
      "worker_approval",
    ]);
    term.input("n");
    await settle();
    // message 用面板提示原文
    const workerCall = hooks.calls.find((call) => call.target === "worker_approval");
    assert.ok(
      typeof workerCall?.fields.message === "string" &&
        (workerCall.fields.message as string).includes("edit_file"),
      JSON.stringify(workerCall?.fields)
    );
    assert.equal(workerCall?.fields.notification_type, "worker_approval");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
