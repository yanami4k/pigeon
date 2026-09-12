// M2 S4：TUI 会话列表（/sessions）与恢复入口（/resume）离屏测试（同一 Mock Terminal 路径）。
// 断言面：
//   - /sessions 渲染口径与 cli 一致（共享 application/session-list.ts 命令层）：安静行
//     （时间 + Run 数 + sessionId）+ 待对账突出行；空目录如实说明；
//   - /resume 全流程：自动确证报告渲染进消息区 → 人工确认走面板式单键（决策 031）→
//     human-confirmed resolution 落盘（写盘路径 = application/resume.ts）→ 同 sessionId
//     换绑运行面续跑；「模型对话上下文重新建立」说明与 cli 同口径；
//   - 哈希自动确证命中：报告呈现且无需人工菜单直接续跑；
//   - restoredGrants 种子：恢复后 /grants 渲染物化的治理投影（重启恢复证据）；
//   - 会话不存在/空目录响亮报错，原运行面不受影响；当前会话拒绝重复恢复；
//   - 菜单期间普通输入吞掉（029 同款语义）；busy 期间 /sessions 与 /resume 不开旁路（027）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
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
import { snapshotTag } from "../tools/hashline.ts";
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

// 带会话 grant 的健康会话（restoredGrants 种子测试用）
function writeGrantedSession(sessionsDir: string): { sessionId: SessionId; grantId: string } {
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

test("/sessions：安静行（时间 + Run 数 + sessionId）+ 待对账突出行；空目录如实说明", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const crashed = writeCrashedSession(sessionsDir, "read_file");
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
      assert.ok(
        text.includes("1 条待对账（上次会话异常中断，用 resume 处理）"),
        `待对账突出行应与 cli 同口径\n${text}`
      );
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

test("/resume 全流程：自动确证报告 → 人工确认单键 → resolution 落盘 → 同 sessionId 换绑续跑", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    // 无 contentHashes 的悬账：哈希确证不可得，只能留人确认
    const crashed = writeCrashedSession(sessionsDir, "edit_file");
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
      term.input(`/resume ${crashed.sessionId}`);
      term.input("\r");
      await settle();

      // 自动确证报告渲染进消息区（cli 同口径措辞）
      const menuScreen = screenText(term);
      assert.ok(menuScreen.includes("冷恢复对账"), menuScreen);
      assert.ok(menuScreen.includes("本次自动确证（哈希比对）：无"), menuScreen);
      assert.ok(menuScreen.includes("待对账 1/1：edit_file"), menuScreen);
      assert.ok(menuScreen.includes("[1] 我看过了，实际已执行"), menuScreen);
      assert.ok(menuScreen.includes("请选择 [1/2/3]："), menuScreen);

      // 面板式单键：按 2 = 实际未执行
      term.input("2");
      await settle();
      const done = screenText(term);
      assert.ok(done.includes("已记录：实际未执行。"), done);
      assert.ok(
        done.includes("模型对话上下文重新建立（Pi transcript 不恢复）"),
        `上下文重建说明应与 cli 同口径\n${done}`
      );

      // resolution 落盘（写盘路径 = application/resume.ts）：悬账销账、human-confirmed 留证
      const materialized = materializeSession(sessionsDir, crashed.sessionId);
      assert.equal(materialized.reconcile.unknown.length, 0, "人工确认后悬账应销账");
      const resolution = materialized.records.find((record) => record.kind === "resolution");
      assert.ok(resolution !== undefined && resolution.kind === "resolution");
      assert.equal(resolution.method, "human-confirmed");
      assert.equal(resolution.outcome, "not-executed");

      // 同 sessionId 换绑：rebind 收到目标会话；旧运行面退订；后续提交只走新运行面
      assert.deepEqual(tracker.rebinds, [crashed.sessionId]);
      assert.equal(tracker.runtimes.length, 1);
      assert.equal(oldRuntime.listenerCount(), 0, "换绑后旧运行面必须退订");
      assert.ok(done.includes(`session ${crashed.sessionId}`), "chrome 应切到恢复会话");
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

test("/resume 哈希自动确证命中：报告呈现、无人工菜单、直接换绑续跑", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    // 目标文件现状 == 预期改后 → 自动确证 executed
    writeFileSync(join(root, "a.ts"), "after content\n", "utf8");
    const crashed = writeCrashedSession(sessionsDir, "edit_file", {
      path: "a.ts",
      beforeHash: snapshotTag("before content\n"),
      expectedAfterHash: snapshotTag("after content\n"),
    });
    const tracker = makeRebindTracker();
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
      term.input(`/resume ${crashed.sessionId}`);
      term.input("\r");
      await settle();
      const text = screenText(term);
      assert.ok(text.includes("本次自动确证（哈希比对）1 条："), text);
      assert.ok(text.includes("edit_file：已执行"), text);
      // 悬账清零但崩溃残留（无 run.ended）是既往缺口——按 021/023 口径不说"证据链完整"
      assert.ok(text.includes("剩余待对账：无。"), text);
      assert.ok(!text.includes("证据链完整"), text);
      assert.ok(text.includes("崩溃残留：1 个 Run 无 run.ended"), text);
      assert.ok(!text.includes("请选择 [1/2/3]"), "无悬账不得出现人工菜单");
      assert.ok(text.includes("模型对话上下文重新建立"), text);
      assert.deepEqual(tracker.rebinds, [crashed.sessionId], "无菜单也应完成换绑");
      const materialized = materializeSession(sessionsDir, crashed.sessionId);
      const resolution = materialized.records.find((record) => record.kind === "resolution");
      assert.ok(resolution !== undefined && resolution.kind === "resolution");
      assert.equal(resolution.method, "hash-auto");
      assert.equal(resolution.outcome, "executed");
    } finally {
      shell.stop();
    }
  } finally {
    cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("/resume restoredGrants 种子：恢复后 /grants 渲染物化的治理投影（重启恢复证据）", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const granted = writeGrantedSession(sessionsDir);
    // 与 tui/main.ts 同一换绑配方：物化目标会话的生效 grant（created − revoked）做种子
    const tracker = makeRebindTracker((sessionId) => {
      const restored = materializeSession(sessionsDir, sessionId).grants;
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
      term.input(`/resume ${granted.sessionId}`);
      term.input("\r");
      await settle();
      assert.deepEqual(tracker.rebinds, [granted.sessionId]);
      // 恢复后治理投影可渲染：物化的会话 grant 出现在 /grants 视图
      term.input("/grants");
      term.input("\r");
      await settle();
      const text = screenText(term);
      assert.ok(text.includes("会话放权（1）："), `物化的 grant 应进入新治理上下文\n${text}`);
      assert.ok(text.includes(granted.grantId), text);
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

test("菜单期间普通输入吞掉：非 1/2/3 键不决议、不提交、不回显；busy 期间 /sessions 与 /resume 不开旁路", async () => {
  const { root, cleanup } = makeRoot();
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const crashed = writeCrashedSession(sessionsDir, "read_file");
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
      term.input(`/resume ${crashed.sessionId}`);
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

      // 菜单期间：字母键吞掉——不决议、不提交、消息区无变化
      term.input(`/resume ${crashed.sessionId}`);
      term.input("\r");
      await settle();
      const menuBefore = screenText(term);
      assert.ok(menuBefore.includes("请选择 [1/2/3]："), menuBefore);
      term.input("x");
      await settle();
      assert.equal(screenText(term), menuBefore, "非菜单键必须吞掉（029 同款语义）");
      assert.deepEqual(runtime.runs, ["任务一"], "菜单期间不得产生提交");

      // 数字键决议：按 1 = 实际已执行
      term.input("1");
      await settle();
      assert.ok(screenText(term).includes("已记录：实际已执行。"), screenText(term));
      const materialized = materializeSession(sessionsDir, crashed.sessionId);
      const resolution = materialized.records.find((record) => record.kind === "resolution");
      assert.ok(resolution !== undefined && resolution.kind === "resolution");
      assert.equal(resolution.outcome, "executed");
      assert.deepEqual(tracker.rebinds, [crashed.sessionId]);
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
    const crashed = writeCrashedSession(sessionsDir, "read_file");
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
      term.input(`/resume ${crashed.sessionId}`);
      term.input("\r");
      await settle();
      term.input("3");
      await settle();
      assert.deepEqual(tracker.rebinds, [crashed.sessionId]);
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
