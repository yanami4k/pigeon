// M4 S1：Event Log schema / 写盘器 / 冷物化测试。
// fsync 路径说明：治理族 append（intent/decision/receipt）内部走 writeSync + fsyncSync，
// 本文件每个治理族用例都真实经过该路径；耐久性佐证 = 追加后立即用全新 fd 读文件可见内容。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { RuntimeEventKind } from "../pi-runtime/events.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
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
import {
  type DecisionInput,
  EventLogConflictError,
  EventLogCorruptionError,
  EventRecordSchema,
  type IntentInput,
  JsonlEventLog,
  materializeSession,
  readEventLogFile,
} from "./event-log.ts";

function makeIntentInput(
  sessionRun: { runId: RunId },
  overrides: Partial<IntentInput> = {}
): IntentInput {
  return {
    executionId: newExecutionId(),
    toolCallId: "toolu_01ABC",
    toolName: "edit_file",
    rawArgs: { path: "a.ts", edits: [] },
    decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId: sessionRun.runId,
    ...overrides,
  };
}

function makeDecisionInput(
  sessionRun: { runId: RunId },
  overrides: Partial<DecisionInput> = {}
): DecisionInput {
  return {
    executionId: newExecutionId(),
    toolCallId: "toolu_01ABC",
    toolName: "edit_file",
    rawArgs: { path: "a.ts", edits: [] },
    decision: {
      outcome: "rejected",
      approvedBy: "policy:deny",
      reason: "deny 清单精确匹配",
      decidedAt: 1_757_000_000_001,
    },
    at: 1_757_000_000_000,
    runId: sessionRun.runId,
    ...overrides,
  };
}

function makeReceipt(executionId: ExecutionId, overrides: Partial<Receipt> = {}): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId: "toolu_01ABC",
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_000,
    finishedAt: 1_757_000_000_123,
    summary: "编辑 a.ts",
    ...overrides,
  };
}

function makeRuntimeEnvelope(
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

function makeLog(): {
  log: JsonlEventLog;
  dir: string;
  sessionId: SessionId;
  runId: RunId;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  const sessionId = newSessionId();
  return {
    log: new JsonlEventLog(dir, sessionId),
    dir,
    sessionId,
    runId: newRunId(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("schema 往返：八种记录族逐一 parse 后与原值一致；未知 kind 与畸形 payload 被拒", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const envelope = {
    version: 1,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
  };
  const intent = makeIntentInput({ runId });
  const decision = makeDecisionInput({ runId });
  const records: unknown[] = [
    { ...envelope, kind: "turn.started", payload: {} },
    {
      ...envelope,
      kind: "turn.completed",
      payload: { stopReason: "stop", syntheticFailure: false },
    },
    {
      ...envelope,
      kind: "tool.proposed",
      payload: { toolCallId: "toolu_1", toolName: "edit_file", args: { path: "a.ts" } },
    },
    {
      ...envelope,
      kind: "tool.settled",
      payload: { toolCallId: "toolu_1", toolName: "edit_file", isError: false },
    },
    { ...envelope, kind: "run.ended", payload: { messageCount: 3 } },
    { ...envelope, kind: "intent", ...stripRunId(intent) },
    { ...envelope, kind: "decision", ...stripRunId(decision) },
    { ...envelope, kind: "receipt", receipt: makeReceipt(intent.executionId) },
  ];
  for (const record of records) {
    assert.deepEqual(Value.Parse(EventRecordSchema, record), record);
  }
  // 未知 kind 拒绝
  assert.throws(() => Value.Parse(EventRecordSchema, { ...envelope, kind: "grant.issued" }));
  // 畸形 payload 拒绝（tool.settled 缺 isError）
  assert.throws(() =>
    Value.Parse(EventRecordSchema, {
      ...envelope,
      kind: "tool.settled",
      payload: { toolCallId: "toolu_1", toolName: "edit_file" },
    })
  );
});

// IntentInput/DecisionInput 的 runId 不属于落盘行字段，往返用例剔除
function stripRunId(input: IntentInput | DecisionInput): Record<string, unknown> {
  const { runId: _runId, ...rest } = input;
  return rest;
}

test("追加 + 冷启动重开：治理族 fsync 落盘（新 fd 立读可见），重开后幂等索引恢复", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    const intent = makeIntentInput({ runId });
    const decision = makeDecisionInput({ runId });
    log.appendIntent(intent);
    log.appendDecision(decision);
    log.appendReceipt({ receipt: makeReceipt(intent.executionId), runId });
    log.appendRuntimeEvent(makeRuntimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
    // 治理族写后即 fsync：不 close 也能用全新读路径看到全部四行
    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[0] as string).kind, "intent");
    assert.equal(JSON.parse(lines[3] as string).kind, "turn.started");
    log.close();

    // 新实例冷启动：幂等索引从磁盘恢复，重复 intent 仍冲突拒绝
    const revived = new JsonlEventLog(dir, sessionId);
    assert.throws(() => revived.appendIntent(intent), EventLogConflictError);
    revived.appendRuntimeEvent(
      makeRuntimeEnvelope(sessionId, runId, RuntimeEventKind.RunEnded, { messageCount: 2 })
    );
    revived.close();
    assert.equal(readEventLogFile(log.path).length, 5);
  } finally {
    cleanup();
  }
});

test("sessions 目录不存在时递归创建（mkdir -p）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const nested = join(dir, "a", "b", "sessions");
    const sessionId = newSessionId();
    const log = new JsonlEventLog(nested, sessionId);
    log.appendRuntimeEvent(
      makeRuntimeEnvelope(sessionId, newRunId(), RuntimeEventKind.TurnStarted, {})
    );
    log.close();
    assert.equal(readEventLogFile(join(nested, `${sessionId}.jsonl`)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等：同一 executionId 同族重复写一律冲突拒绝；跨族同 executionId 合法", () => {
  const { log, runId, cleanup } = makeLog();
  try {
    const intent = makeIntentInput({ runId });
    log.appendIntent(intent);
    // 跨族合法：intent + receipt 共享 executionId 是正常配对
    log.appendReceipt({ receipt: makeReceipt(intent.executionId), runId });
    const decision = makeDecisionInput({ runId });
    log.appendDecision(decision);

    assert.throws(() => log.appendIntent(intent), EventLogConflictError);
    assert.throws(
      () => log.appendReceipt({ receipt: makeReceipt(intent.executionId), runId }),
      EventLogConflictError
    );
    assert.throws(() => log.appendDecision(decision), EventLogConflictError);
    // 冲突拒绝不产生新行
    assert.equal(readFileSync(log.path, "utf8").trim().split("\n").length, 3);
    log.close();
  } finally {
    cleanup();
  }
});

test("torn tail 容忍：半截末行按「未持久化」处理；中间坏行响亮失败", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    log.appendIntent(makeIntentInput({ runId }));
    log.close();
    // 模拟进程死于写盘中途：半截 receipt 行
    appendFileSync(log.path, '{"version":1,"id":"entry_', "utf8");
    // 半截行视为未写入：intent 无 receipt → OutcomeUnknown
    const materialized = materializeSession(dir, sessionId);
    assert.equal(materialized.receipts.length, 0);
    assert.equal(materialized.reconcile.unknown.length, 1);

    // 中间坏行 = 外部破坏，响亮失败
    appendFileSync(log.path, "这不是 JSON\n", "utf8");
    appendFileSync(log.path, `${JSON.stringify({ version: 1 })}\n`, "utf8");
    assert.throws(() => readEventLogFile(log.path), EventLogCorruptionError);
  } finally {
    cleanup();
  }
});

test("冷物化对账：settled / OutcomeUnknown / rejected / 孤立 receipt 分类与 M3 逐字同语义", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    // ① intent + receipt 配对 → settled
    const paired = makeIntentInput({ runId });
    log.appendIntent(paired);
    log.appendReceipt({ receipt: makeReceipt(paired.executionId), runId });
    // ② 孤立 intent（进程死于 dispatch/execute 窗口）→ OutcomeUnknown
    const crashed = makeIntentInput({ runId });
    log.appendIntent(crashed);
    // ③ decision 单行 + ④ decision + receipt 配对 → rejected（闭环，永不入 unknown）
    const lone = makeDecisionInput({ runId });
    log.appendDecision(lone);
    const pairedDecision = makeDecisionInput({ runId });
    log.appendDecision(pairedDecision);
    const rejectedReceipt = makeReceipt(pairedDecision.executionId, { executed: false });
    log.appendReceipt({ receipt: rejectedReceipt, runId });
    // ⑤ 孤立 receipt（既无 intent 也无 decision）→ 如实报告
    const orphan = makeReceipt(newExecutionId());
    log.appendReceipt({ receipt: orphan, runId });
    log.close();

    const { reconcile } = materializeSession(dir, sessionId);
    assert.equal(reconcile.settled.length, 1);
    assert.equal(reconcile.settled[0]?.intent.executionId, paired.executionId);
    assert.equal(reconcile.unknown.length, 1);
    assert.equal(reconcile.unknown[0]?.intent.executionId, crashed.executionId);
    assert.equal(reconcile.unknown[0]?.receipt, undefined);
    assert.equal(reconcile.rejected.length, 2);
    assert.deepEqual(reconcile.rejected[1]?.receipt, rejectedReceipt);
    assert.equal(reconcile.orphanReceipts.length, 1);
    assert.deepEqual(reconcile.orphanReceipts[0], orphan);
  } finally {
    cleanup();
  }
});

test("冷物化缺失文件 = 全新 session 空态（不是损坏）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const materialized = materializeSession(dir, newSessionId());
    assert.equal(materialized.records.length, 0);
    assert.equal(materialized.reconcile.settled.length, 0);
    assert.equal(materialized.reconcile.unknown.length, 0);
    assert.equal(materialized.reconcile.rejected.length, 0);
    assert.equal(materialized.reconcile.orphanReceipts.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
