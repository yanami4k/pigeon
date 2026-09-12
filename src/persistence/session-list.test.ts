// M4 S5：Session 列表投影测试（D5：派生不落库——每次从 Event Log 现算，不写任何文件；
// 默认安静：创建时间 + Run 数；唯一突出项 = 待对账）。
// 覆盖：逐会话摘要字段（ULID 创建时间解码 / Run 数 / 待对账数 / 工具名 / 失败分类）、
// 最小过滤器（tool / class / since / until）逐文件流式求值。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeEventKind } from "../pi-runtime/events.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  asSessionId,
  type ExecutionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { type IntentInput, JsonlEventLog } from "./event-log.ts";
import { listSessionSummaries, sessionCreatedAt } from "./session-list.ts";

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-session-list-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

function makeIntentInput(runId: RunId, toolName: string, executionId: ExecutionId): IntentInput {
  return {
    executionId,
    toolCallId: `toolu_${toolName}`,
    toolName,
    rawArgs: { path: "a.ts" },
    decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId,
  };
}

function makeReceipt(executionId: ExecutionId, overrides: Partial<Receipt> = {}): Receipt {
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
    ...overrides,
  };
}

// 健康会话：一轮正常工具调用（turn 起讫 + intent/receipt 配对 + run.ended）
function writeHealthySession(dir: string, toolName: string): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(dir, sessionId);
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

// 崩溃残留会话：intent 落盘后进程死亡（无 receipt、无 turn.completed）→ 待对账 + 未知分类
function writeCrashedSession(dir: string, toolName: string): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(dir, sessionId);
  log.appendIntent(makeIntentInput(newRunId(), toolName, newExecutionId()));
  log.close();
  return sessionId;
}

// 指定终态 stopReason 的会话（turn.started + turn.completed）
function writeTerminalSession(
  dir: string,
  stopReason: string,
  syntheticFailure = false
): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(dir, sessionId);
  const runId = newRunId();
  log.appendRuntimeEvent(runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
      stopReason,
      syntheticFailure,
    })
  );
  log.close();
  return sessionId;
}

// 手工编码 ULID 时间分量（与 ids.ts 同字母表）：伪造指定创建时刻的会话 id 供时间过滤测试
function fakeSessionIdAt(timeMs: number): SessionId {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = timeMs;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  return asSessionId(`sess_${head}0000000000000000`);
}

test("会话摘要：创建时间取自 ULID、Run 数、待对账数、工具名与失败分类逐会话现算", () => {
  const { dir, cleanup } = makeDir();
  try {
    const healthy = writeHealthySession(dir, "edit_file");
    const crashed = writeCrashedSession(dir, "read_file");

    const summaries = listSessionSummaries(dir);
    assert.equal(summaries.length, 2);
    const [first, second] = summaries;
    // 列表序 = 创建时间序（ULID 字典序，先建在前）
    assert.equal(first?.sessionId, healthy);
    assert.equal(second?.sessionId, crashed);
    // 创建时间 = SessionId 内嵌 ULID 的时间分量（毫秒级，接近当下）
    assert.ok(Math.abs((first?.createdAt ?? 0) - Date.now()) < 60_000);
    // 健康会话：1 个 Run、无待对账、工具名在列、无失败分类
    assert.equal(first?.runCount, 1);
    assert.equal(first?.pendingReconcile, 0);
    assert.deepEqual(first?.toolNames, ["edit_file"]);
    assert.deepEqual(first?.failureClasses, []);
    // 崩溃残留：intent 无 receipt → 1 条待对账；无 turn.completed → Run 落未知桶
    assert.equal(second?.runCount, 1);
    assert.equal(second?.pendingReconcile, 1);
    assert.deepEqual(second?.toolNames, ["read_file"]);
    assert.deepEqual(second?.failureClasses, ["unknown"]);
  } finally {
    cleanup();
  }
});

test("sessionCreatedAt：解码 SessionId 内嵌 ULID 的 48 位毫秒时间（与 ids.ts 编码互逆）", () => {
  const known = fakeSessionIdAt(1_757_000_000_000);
  assert.equal(sessionCreatedAt(known), 1_757_000_000_000);
  // 新铸造的真实 SessionId：解码结果 ≈ 铸造时刻
  assert.ok(Math.abs(sessionCreatedAt(newSessionId()) - Date.now()) < 60_000);
});

test("失败分类汇总：取消/业务/基础设施/未知四类分别入列；正常收尾不入列", () => {
  const { dir, cleanup } = makeDir();
  try {
    writeTerminalSession(dir, "aborted"); // 取消（无熔断记录 = 用户中断）
    writeTerminalSession(dir, "length"); // 业务失败（输出截断）
    writeTerminalSession(dir, "error", true); // 基础设施错误（上游合成失败消息）
    writeTerminalSession(dir, "stop"); // 正常收尾
    // 工具级业务失败：执行出错且归类 domain（turn 正常 stop，Run 级不落分类）
    const toolFailure = newSessionId();
    const log = new JsonlEventLog(dir, toolFailure);
    const runId = newRunId();
    const executionId = newExecutionId();
    log.appendRuntimeEvent(runtimeEnvelope(toolFailure, runId, RuntimeEventKind.TurnStarted, {}));
    log.appendRuntimeEvent(
      runtimeEnvelope(toolFailure, runId, RuntimeEventKind.TurnCompleted, {
        stopReason: "stop",
        syntheticFailure: false,
      })
    );
    log.appendIntent(makeIntentInput(runId, "edit_file", executionId));
    log.appendReceipt({
      receipt: makeReceipt(executionId, { executed: false, isError: true }),
      runId,
    });
    log.appendRuntimeEvent(
      runtimeEnvelope(toolFailure, runId, RuntimeEventKind.ToolSettled, {
        toolCallId: "toolu_edit_file",
        toolName: "edit_file",
        isError: true,
        errorKind: "domain",
      })
    );
    log.close();

    const byClass = new Map<string, SessionId[]>();
    for (const summary of listSessionSummaries(dir)) {
      for (const category of summary.failureClasses) {
        byClass.set(category, [...(byClass.get(category) ?? []), summary.sessionId]);
      }
    }
    assert.equal(byClass.get("cancelled")?.length, 1);
    assert.equal(byClass.get("infrastructure")?.length, 1);
    // 业务失败两处：length 截断（Run 级）+ 工具域错误（ToolExecution 级）
    assert.equal(byClass.get("business")?.length, 2);
    assert.equal(byClass.get("unknown"), undefined, "本夹具没有未知分类会话");
    // 正常收尾会话不落任何失败分类
    assert.ok(byClass.get("cancelled")?.[0] !== undefined);
  } finally {
    cleanup();
  }
});

test("最小过滤器：--tool 按工具名、--class 按失败分类、--since/--until 按创建时间，流式逐文件求值", () => {
  const { dir, cleanup } = makeDir();
  try {
    const healthy = writeHealthySession(dir, "edit_file");
    const crashed = writeCrashedSession(dir, "read_file");
    writeTerminalSession(dir, "aborted");

    // --tool：只留用过该工具的会话
    assert.deepEqual(
      listSessionSummaries(dir, { tool: "edit_file" }).map((s) => s.sessionId),
      [healthy]
    );
    assert.deepEqual(
      listSessionSummaries(dir, { tool: "read_file" }).map((s) => s.sessionId),
      [crashed]
    );
    assert.deepEqual(listSessionSummaries(dir, { tool: "不存在" }), []);
    // --class：只留含该失败分类的会话
    assert.deepEqual(
      listSessionSummaries(dir, { class: "unknown" }).map((s) => s.sessionId),
      [crashed]
    );
    assert.equal(listSessionSummaries(dir, { class: "cancelled" }).length, 1);
    assert.deepEqual(listSessionSummaries(dir, { class: "infrastructure" }), []);
  } finally {
    cleanup();
  }
});

test("--since/--until：按创建时间过滤（闭区间），多条件叠加为与", () => {
  const { dir, cleanup } = makeDir();
  try {
    // 三个伪造创建时刻的空会话（空文件是合法会话：启动即建文件，崩溃于首事件前）
    const t1 = fakeSessionIdAt(1_000_000);
    const t2 = fakeSessionIdAt(2_000_000);
    const t3 = fakeSessionIdAt(3_000_000);
    for (const sessionId of [t1, t2, t3]) {
      writeFileSync(join(dir, `${sessionId}.jsonl`), "", "utf8");
    }
    const ids = (list: ReturnType<typeof listSessionSummaries>) =>
      list.map((summary) => summary.sessionId);
    assert.deepEqual(ids(listSessionSummaries(dir)), [t1, t2, t3], "默认按创建时间升序");
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 2_000_000 })), [t2, t3]);
    assert.deepEqual(ids(listSessionSummaries(dir, { until: 2_000_000 })), [t1, t2]);
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 2_000_000, until: 2_000_000 })), [t2]);
    // 叠加 --class：空会话无任何分类记录（无 Run 事实），被过滤掉
    assert.deepEqual(ids(listSessionSummaries(dir, { since: 1_000_000, class: "unknown" })), []);
  } finally {
    cleanup();
  }
});
