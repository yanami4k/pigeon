// M2 S4：TUI 会话列表（/sessions）与恢复入口（/resume）离屏测试（同一 Mock Terminal 路径）。
// 断言面：
//   - /sessions 渲染口径与 cli 一致（共享 application/session-list.ts 命令层）：安静行
//     （时间 + Run 数 + sessionId）+ 待对账突出行；空目录如实说明；
//   - /resume 全流程（账本重构 183）：续跑报告（还原的消息条数、未收尾的 Run、悬空的工具调用）渲染进消息区，
//     与 cli 同口径 → 不再有人工对账菜单 → 同 sessionId 换绑运行面续跑（上下文还原在换绑工厂装配运行面时做）；
//   - 双写之前的旧会话（新会话存储里没有文件）明确报错、不换绑；
//   - grant 种子：恢复后 /grants 渲染新会话存储里的生效授权（重启恢复证据）；
//   - 会话不存在/空目录响亮报错，原运行面不受影响；当前会话拒绝重复恢复；
//   - busy 期间 /sessions 与 /resume 不开旁路（027）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { restoreGrantSeed } from "../application/workspace.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { IntentInput } from "../state/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  type ExecutionId,
  newEntryId,
  newExecutionId,
  newGrantId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { PigeonTuiShell, type TuiRuntimeFace, type TuiSessionBinding } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();

// ---------- 假 application 面：记录 run 提交，支持手动发事件（验证换绑退订） ----------
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
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    this.pendingResolvers.push(() => resolve(result));
    return promise;
  }

  finishAll(): void {
    for (const resolve of this.pendingResolvers.splice(0)) resolve();
  }

  listenerCount(): number {
    return this.listeners.size + this.streamListeners.size;
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
      timestamp: 1_757_000_000_000,
      kind,
      payload,
    };
    for (const listener of this.listeners) listener(envelope);
  }
}

// ---------- 会话文件夹具（与 application/session-list.test.ts 同一形状） ----------

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-session-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runtimeEnvelope(
  sessionId: SessionId,
  runId: RunId,
  kind: EventEnvelope["kind"],
  payload: unknown
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
    kind,
    payload,
  };
}

function makeIntentInput(
  runId: RunId,
  toolName: string,
  executionId: ExecutionId,
  contentHashes?: IntentInput["contentHashes"]
): IntentInput {
  return {
    executionId,
    toolCallId: `toolu_${toolName}`,
    toolName,
    rawArgs: { path: "a.ts" },
    decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId,
    ...(contentHashes !== undefined ? { contentHashes } : {}),
  };
}

function makeReceipt(executionId: ExecutionId): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId: "toolu_x",
    approvedBy: "policy:yolo",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_001,
    finishedAt: 1_757_000_000_002,
    summary: "完成",
  };
}

// 健康会话：一轮正常工具调用（turn 起讫 + intent/receipt 配对 + run.ended）
function writeHealthySession(sessionsDir: string, toolName: string): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const runId = newRunId();
  const executionId = newExecutionId();
  log.appendRuntimeEvent(runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
    })
  );
  log.appendIntent(makeIntentInput(runId, toolName, executionId));
  log.appendReceipt({ receipt: makeReceipt(executionId), runId });
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.RunEnded, { messageCount: 0 })
  );
  log.close();
  return sessionId;
}

// 崩溃残留会话：intent 落盘后进程死亡（无 receipt）→ 待对账悬账
function writeCrashedSession(
  sessionsDir: string,
  toolName: string,
  contentHashes?: IntentInput["contentHashes"]
): { sessionId: SessionId; executionId: ExecutionId } {
  const sessionId = newSessionId();
  const executionId = newExecutionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  log.appendIntent(makeIntentInput(newRunId(), toolName, executionId, contentHashes));
  log.close();
  return { sessionId, executionId };
}

// 新会话存储里的崩溃会话：任务消息与带工具调用的助手消息之后进程死亡（无工具结果、无 Run 收尾）
async function writeStoreCrashedSession(
  sessionsDir: string,
  root: string,
  toolName: string
): Promise<SessionId> {
  const session = createFixtureSession({ sessionsDir, cwd: root });
  session.startRun({ task: "改 a.ts" });
  session.assistant({ text: "先改", toolCalls: [{ name: toolName, args: { path: "a.ts" } }] });
  return (await session.close()).sessionId;
}

// 带会话 grant 的健康会话（旧账本形状）
function _writeGrantedSession(sessionsDir: string): { sessionId: SessionId; grantId: string } {
  const sessionId = writeHealthySession(sessionsDir, "read_file");
  const grantId = newGrantId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  log.appendGrantCreated({
    grantId,
    tool: "read_file",
    createdAt: 1_757_000_000_002,
    firstCall: { toolCallId: "toolu_read_file", args: { path: "a.ts" } },
    runId: newRunId(),
  });
  log.close();
  return { sessionId, grantId };
}

// 换绑工厂夹具：记录收到的 sessionId 与给出的新运行面
function makeRebindTracker(binding?: (sessionId: SessionId) => TuiSessionBinding): {
  rebinds: SessionId[];
  runtimes: FakeRuntime[];
  rebind: (sessionId: SessionId) => TuiSessionBinding;
} {
  const rebinds: SessionId[] = [];
  const runtimes: FakeRuntime[] = [];
  return {
    rebinds,
    runtimes,
    rebind: (sessionId) => {
      rebinds.push(sessionId);
      if (binding !== undefined) {
        const produced = binding(sessionId);
        if (produced.runtime instanceof FakeRuntime) runtimes.push(produced.runtime);
        return produced;
      }
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return { runtime };
    },
  };
}

// ---------- 测试 ----------

test("/sessions：安静行（时间 + Run 数 + sessionId），与 cli 同一命令层；空目录如实说明", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const seed = async (crashedRun: boolean): Promise<SessionId> => {
      const session = createFixtureSession({ sessionsDir });
      session.startRun({ task: "t" });
      session.toolTurn({ name: crashedRun ? "read_file" : "edit_file" });
      if (!crashedRun) session.endRun();
      return (await session.close()).sessionId;
    };
    const healthy = await seed(false);
    const crashed = { sessionId: await seed(true) };
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: new FakeRuntime(),
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
    });
    try {
      shell.start();
      await settle();
      term.input("/sessions");
      term.input("\r");
      await settle();
      const text = screenText(term);
      assert.ok(text.includes("> /sessions"), "命令应回显");
      // 安静行：1 个 Run + 完整 sessionId（cli 同口径，共享命令层保证）
      const healthyLine = text.split("\n").find((line) => line.includes(healthy));
      assert.ok(healthyLine?.includes("1 个 Run"), `安静行应含 Run 数：${healthyLine}`);
      const crashedLine = text.split("\n").find((line) => line.includes(crashed.sessionId));
      assert.ok(crashedLine?.includes("1 个 Run"), `安静行应含 Run 数：${crashedLine}`);
      assert.ok(!text.includes("待对账"), `新存储没有待对账突出行\n${text}`);
    } finally {
      shell.stop();
    }

    // 空目录：如实说明
    const empty = makeRoot();
    try {
      const term2 = new MockTerminal(90, 30);
      const shell2 = new PigeonTuiShell({
        terminal: term2,
        runtime: new FakeRuntime(),
        sessionId: SESSION_ID,
        logDir,
        sessions: { root: empty.root },
      });
      try {
        shell2.start();
        await settle();
        term2.input("/sessions");
        term2.input("\r");
        await settle();
        assert.ok(screenText(term2).includes("尚无会话记录。"));
      } finally {
        shell2.stop();
      }
    } finally {
      empty.cleanup();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume 全流程：报告将还原的上下文与悬空的工具调用 → 无对账菜单 → 同 sessionId 换绑续跑", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const crashed = await writeStoreCrashedSession(sessionsDir, root, "edit_file");
    const tracker = makeRebindTracker();
    const oldRuntime = new FakeRuntime();
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: oldRuntime,
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();
      term.input(`/resume ${crashed}`);
      term.input("\r");
      await settle();

      // 续跑报告渲染进消息区（cli 同口径措辞）：还原的消息条数、未收尾的 Run、悬空的工具调用
      const done = screenText(term);
      assert.ok(done.includes("续跑：还原对话上下文 2 条消息"), done);
      assert.ok(done.includes("1 个 Run 没有收尾记录"), done);
      assert.ok(done.includes("1 个工具调用没有结果（edit_file）"), done);
      assert.ok(!done.includes("请选择 [1/2/3]"), "不再有人工对账菜单");

      // 同 sessionId 换绑：rebind 收到目标会话；旧运行面退订；后续提交只走新运行面
      assert.deepEqual(tracker.rebinds, [crashed]);
      assert.equal(tracker.runtimes.length, 1);
      assert.equal(oldRuntime.listenerCount(), 0, "换绑后旧运行面必须退订");
      assert.ok(done.includes(`session ${crashed}`), "chrome 应切到恢复会话");
      term.input("继续任务");
      term.input("\r");
      await settle();
      assert.deepEqual(tracker.runtimes[0]?.runs, ["继续任务"], "续跑提交必须走新运行面");
      assert.deepEqual(oldRuntime.runs, [], "旧运行面不得再收到提交");
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume 双写之前的旧会话：明确报错、不换绑，原运行面不受影响", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const legacy = writeCrashedSession(sessionsDir, "edit_file");
    const tracker = makeRebindTracker();
    const runtime = new FakeRuntime();
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime,
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();
      term.input(`/resume ${legacy.sessionId}`);
      term.input("\r");
      await settle();
      const text = screenText(term);
      assert.ok(text.includes("创建于新会话存储启用之前"), text);
      assert.deepEqual(tracker.rebinds, [], "失败不得换绑");
      term.input("还活着");
      term.input("\r");
      await settle();
      assert.deepEqual(runtime.runs, ["还活着"]);
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume grant 种子：恢复后 /grants 渲染新会话存储里的生效授权（重启恢复证据）", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const granted = createFixtureSession({ sessionsDir, cwd: root });
    granted.startRun({ task: "读" });
    const grantId = granted.grantCreated({ tool: "read_file" });
    granted.assistant({ text: "读完了" });
    granted.endRun();
    const { sessionId } = await granted.close();
    // 与 tui/main.ts 同一换绑配方：目标会话的生效 grant（created − revoked）做种子
    const tracker = makeRebindTracker((target) => {
      const restored = restoreGrantSeed(root, target);
      const store = new SessionGrantStore({ workspaceRoot: root, restored });
      return { runtime: new FakeRuntime(), grants: { root, store, configRules: [] } };
    });
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: new FakeRuntime(),
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();
      term.input(`/resume ${sessionId}`);
      term.input("\r");
      await settle();
      assert.deepEqual(tracker.rebinds, [sessionId]);
      term.input("/grants");
      term.input("\r");
      await settle();
      const text = screenText(term);
      assert.ok(text.includes("会话放权（1）："), `生效授权应进入新治理上下文\n${text}`);
      assert.ok(text.includes(grantId), text);
      assert.ok(text.includes("read_file"), text);
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume 会话不存在与空目录响亮报错；原运行面不受影响；当前会话拒绝重复恢复", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    writeHealthySession(sessionsDir, "read_file");
    const tracker = makeRebindTracker();
    const runtime = new FakeRuntime();
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime,
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();

      // 当前会话：拒绝重复恢复（恢复自己会让恢复流程与运行中日志同文件双写）
      term.input(`/resume ${SESSION_ID}`);
      term.input("\r");
      await settle();
      assert.ok(screenText(term).includes("已在会话"), screenText(term));
      assert.deepEqual(tracker.rebinds, []);

      // 会话不存在（格式合法的陌生 id）：响亮报错并列出已有会话
      const missing = `sess_${"Z".repeat(26)}`;
      term.input(`/resume ${missing}`);
      term.input("\r");
      await settle();
      const missingText = screenText(term);
      assert.ok(missingText.includes("会话不存在"), missingText);
      assert.deepEqual(tracker.rebinds, [], "失败不得换绑");

      // 报错后原运行面不受影响：提交仍走旧 runtime，状态回 idle
      term.input("还活着");
      term.input("\r");
      await settle();
      assert.deepEqual(runtime.runs, ["还活着"]);
      assert.ok(screenText(term).includes("state: idle"), screenText(term));
    } finally {
      shell.stop();
    }

    // 空目录：无 .pigeon/sessions 时如实说明尚无会话记录
    const empty = makeRoot();
    try {
      const term2 = new MockTerminal(90, 30);
      const shell2 = new PigeonTuiShell({
        terminal: term2,
        runtime: new FakeRuntime(),
        sessionId: SESSION_ID,
        logDir,
        sessions: { root: empty.root },
        resume: { root: empty.root, rebind: tracker.rebind },
      });
      try {
        shell2.start();
        await settle();
        term2.input(`/resume ${`sess_${"Y".repeat(26)}`}`);
        term2.input("\r");
        await settle();
        assert.ok(screenText(term2).includes("尚无会话记录"), screenText(term2));
      } finally {
        shell2.stop();
      }
    } finally {
      empty.cleanup();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("busy 期间 /sessions 与 /resume 不开旁路；收尾后 /resume 直接换绑，不进菜单", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const crashed = await writeStoreCrashedSession(sessionsDir, root, "read_file");
    const tracker = makeRebindTracker();
    const runtime = new FakeRuntime();
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime,
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();

      // busy：运行中 /sessions 与 /resume 同样被拒绝（决策 027 不开旁路）
      runtime.autoResolve = false;
      term.input("任务一");
      term.input("\r");
      await settle();
      term.input("/sessions");
      term.input("\r");
      term.input(`/resume ${crashed}`);
      term.input("\r");
      await settle();
      const busyText = screenText(term);
      assert.ok(busyText.includes("[busy]"), busyText);
      assert.ok(!busyText.includes("个 Run"), "busy 期间不得渲染会话列表");
      assert.deepEqual(tracker.rebinds, []);
      runtime.finishAll();
      runtime.autoResolve = true;
      await settle();
      // 冲刷 busy 期间保留的输入缓冲（027：缓冲保留、重提时机交还人——两次拒绝的
      // 文本首尾相接仍在缓冲里，一次回车作为未知命令提交掉，后续测试从空缓冲开始）
      term.input("\r");
      await settle();

      term.input(`/resume ${crashed}`);
      term.input("\r");
      await settle();
      assert.ok(!screenText(term).includes("请选择 [1/2/3]"), screenText(term));
      assert.deepEqual(tracker.rebinds, [crashed]);
      assert.deepEqual(runtime.runs, ["任务一"], "续跑流程本身不产生提交");
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("换绑后旧运行面迟到事件不进消息区（退订彻底）", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const crashed = await writeStoreCrashedSession(sessionsDir, root, "read_file");
    const tracker = makeRebindTracker();
    const oldRuntime = new FakeRuntime();
    const term = new MockTerminal(90, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: oldRuntime,
      sessionId: SESSION_ID,
      logDir,
      sessions: { root },
      resume: { root, rebind: tracker.rebind },
    });
    try {
      shell.start();
      await settle();
      term.input(`/resume ${crashed}`);
      term.input("\r");
      await settle();
      assert.deepEqual(tracker.rebinds, [crashed]);
      const before = screenText(term);
      oldRuntime.emit(RuntimeEventKind.TurnStarted, {});
      oldRuntime.emit(RuntimeEventKind.TurnCompleted, {
        stopReason: "stop",
        syntheticFailure: false,
      });
      await settle();
      assert.equal(screenText(term), before, "旧运行面的迟到事件不得改变消息区");
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});
