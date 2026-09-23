// M4 S1：Event Log schema / 写盘器 / 冷物化测试。
// fsync 路径说明：治理族 append（intent/decision/receipt）内部走 writeSync + fsyncSync，
// 本文件每个治理族用例都真实经过该路径；耐久性佐证 = 追加后立即用全新 fd 读文件可见内容。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  type BreakerInput,
  type DecisionInput,
  EVENT_LOG_VERSION,
  EventRecordSchema,
  type IntentInput,
  type ResolutionInput,
} from "../state/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  asGrantId,
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
import { detectEntryGaps } from "../state/materialize.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import {
  EventLogConflictError,
  EventLogCorruptionError,
  JsonlEventLog,
  listSessionIds,
  materializeSession,
  readEventLogFile,
  readEventLogFileDetailed,
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

test("schema 往返：清单里的各记录族逐一 parse 后与原值一致；未知 kind 与畸形 payload 被拒", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const envelope = {
    version: EVENT_LOG_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
  };
  const intent = makeIntentInput({ runId });
  const decision = makeDecisionInput({ runId });
  const breaker = makeBreakerInput(runId);
  const resolution = makeResolutionInput(runId, intent.executionId);
  // M4 S5：人工确认确证（resume 交互渠道）——无哈希证据，用户的判断本身就是证据
  const humanResolution = stripRunId(
    makeResolutionInput(runId, newExecutionId(), { method: "human-confirmed" })
  );
  delete humanResolution.evidence;
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
    // M4 S2：settled 携带错误分类（工具域错误 / 环境异常，D7 ToolExecution 级判据）
    {
      ...envelope,
      kind: "tool.settled",
      payload: { toolCallId: "toolu_2", toolName: "edit_file", isError: true, errorKind: "domain" },
    },
    { ...envelope, kind: "run.ended", payload: { messageCount: 3 } },
    { ...envelope, kind: "intent", ...stripRunId(intent) },
    // M4 S2：intent 携带内容哈希三元组（哈希自动确证的比对基准）
    {
      ...envelope,
      kind: "intent",
      ...stripRunId(makeIntentInput({ runId }, { contentHashes: makeContentHashes() })),
    },
    { ...envelope, kind: "decision", ...stripRunId(decision) },
    { ...envelope, kind: "receipt", receipt: makeReceipt(intent.executionId) },
    // M4 S2：熔断落闸记录（治理熔断子类的判据行）
    { ...envelope, kind: "breaker", ...stripRunId(breaker) },
    // M4 S2：哈希自动确证记录
    { ...envelope, kind: "resolution", ...stripRunId(resolution) },
    // M4 S5：entry 族（D3 Pi 消息映射：message_end 时刻分配 EntryId，(runId, runSeq) 权威键，
    // abort 与上游合成失败消息同样占序号）
    { ...envelope, kind: "entry", runSeq: 1, role: "user" },
    { ...envelope, kind: "entry", runSeq: 2, role: "assistant" },
    { ...envelope, kind: "entry", runSeq: 3, role: "toolResult" },
    // M4 S5：人工确认确证记录（evidence 缺省）
    { ...envelope, kind: "resolution", ...humanResolution },
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
  // errorKind 越界拒绝
  assert.throws(() =>
    Value.Parse(EventRecordSchema, {
      ...envelope,
      kind: "tool.settled",
      payload: { toolCallId: "toolu_1", toolName: "edit_file", isError: true, errorKind: "oops" },
    })
  );
  // entry 畸形拒绝：runSeq 必须从 1 起（run 内 message_end 累计序号）
  assert.throws(() =>
    Value.Parse(EventRecordSchema, { ...envelope, kind: "entry", runSeq: 0, role: "user" })
  );
  // entry 畸形拒绝：role 只取三种 transcript 角色
  assert.throws(() =>
    Value.Parse(EventRecordSchema, { ...envelope, kind: "entry", runSeq: 1, role: "system" })
  );
});

// M4 S2：intent 的内容哈希三元组（dispatch 前实测改前 + 确定性推出改后）
function makeContentHashes() {
  return {
    path: "a.ts",
    beforeHash: "aaaaaaaaaaaaaaaa",
    expectedAfterHash: "bbbbbbbbbbbbbbbb",
  };
}

function makeBreakerInput(runId: RunId, overrides: Partial<BreakerInput> = {}): BreakerInput {
  return {
    toolName: "edit_file",
    toolCallId: "toolu_01ABC",
    scope: "tool",
    count: 3,
    threshold: 3,
    at: 1_757_000_000_002,
    runId,
    ...overrides,
  };
}

function makeResolutionInput(
  runId: RunId,
  executionId: ExecutionId,
  overrides: Partial<ResolutionInput> = {}
): ResolutionInput {
  return {
    executionId,
    toolCallId: "toolu_01ABC",
    toolName: "edit_file",
    outcome: "executed",
    method: "hash-auto",
    evidence: { ...makeContentHashes(), observedHash: "bbbbbbbbbbbbbbbb" },
    at: 1_757_000_000_003,
    runId,
    ...overrides,
  };
}

// IntentInput/DecisionInput/BreakerInput/ResolutionInput 的 runId 不属于落盘行字段，往返用例剔除
function stripRunId(
  input: IntentInput | DecisionInput | BreakerInput | ResolutionInput
): Record<string, unknown> {
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

test("torn tail 可见化：detailed 读取与冷物化如实报告半截末行的存在（replay 标注用）", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    log.appendIntent(makeIntentInput({ runId }));
    log.close();
    // 无撕裂：协议保证每条记录以 \n 结尾，正常文件 tornTail=false
    assert.equal(readEventLogFileDetailed(log.path).tornTail, false);
    assert.equal(materializeSession(dir, sessionId).tornTail, false);

    // 模拟进程死于写盘中途：半截 receipt 行
    appendFileSync(log.path, '{"version":2,"id":"entry_', "utf8");
    const detailed = readEventLogFileDetailed(log.path);
    assert.equal(detailed.tornTail, true, "半截末行必须可见而非静默丢弃");
    assert.equal(detailed.records.length, 1, "半截行仍按「未持久化」丢弃，不进记录集");
    assert.equal(materializeSession(dir, sessionId).tornTail, true);
  } finally {
    cleanup();
  }
});

test("listSessionIds：列目录得会话清单（D1：ULID 字典序即时间序），忽略非会话文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    // 空目录 / 不存在目录 → 空清单
    assert.deepEqual(listSessionIds(dir), []);
    assert.deepEqual(listSessionIds(join(dir, "不存在")), []);
    const first = new JsonlEventLog(dir, newSessionId());
    const second = new JsonlEventLog(dir, newSessionId());
    second.close();
    first.close();
    // 旧账本退役文件与无关文件不进清单
    writeFileSync(join(dir, "sess_01LEGACY0000000000000000.legacy.jsonl"), "", "utf8");
    writeFileSync(join(dir, "README.txt"), "", "utf8");
    assert.deepEqual(listSessionIds(dir), [first.sessionId, second.sessionId]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    assert.equal(materialized.reconcile.resolved.length, 0);
    assert.equal(materialized.reconcile.orphanReceipts.length, 0);
    assert.equal(materialized.reconcile.orphanResolutions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolution 幂等：同一 executionId 重复确证冲突拒绝；breaker 不按 executionId 去重", () => {
  const { log, runId, cleanup } = makeLog();
  try {
    const intent = makeIntentInput({ runId });
    log.appendIntent(intent);
    log.appendResolution(makeResolutionInput(runId, intent.executionId));
    assert.throws(
      () => log.appendResolution(makeResolutionInput(runId, intent.executionId)),
      EventLogConflictError
    );
    // breaker 以 Run 内连击为语义（无 executionId 幂等键），同一 Run 多次落闸各自留行
    log.appendBreaker(makeBreakerInput(runId));
    log.appendBreaker(makeBreakerInput(runId, { toolCallId: "toolu_other" }));
    assert.equal(readEventLogFile(log.path).filter((r) => r.kind === "breaker").length, 2);
    log.close();
  } finally {
    cleanup();
  }
});

test("冷物化对账：intent + resolution 配对归 resolved（不再滞留 unknown）；孤儿 resolution 如实报告", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    const resolvedIntent = makeIntentInput({ runId });
    log.appendIntent(resolvedIntent);
    log.appendResolution(
      makeResolutionInput(runId, resolvedIntent.executionId, { outcome: "not-executed" })
    );
    // 无 resolution 的悬账仍滞留 unknown（哈希缺省或三方比对不符）
    const stillUnknown = makeIntentInput({ runId });
    log.appendIntent(stillUnknown);
    // 孤儿 resolution：对应的 intent 不存在（日志损坏或手写）
    log.appendResolution(makeResolutionInput(runId, newExecutionId()));
    log.close();

    const { reconcile } = materializeSession(dir, sessionId);
    assert.equal(reconcile.resolved.length, 1);
    assert.equal(reconcile.resolved[0]?.intent.executionId, resolvedIntent.executionId);
    assert.equal(reconcile.resolved[0]?.resolution.outcome, "not-executed");
    assert.equal(reconcile.unknown.length, 1);
    assert.equal(reconcile.unknown[0]?.intent.executionId, stillUnknown.executionId);
    assert.equal(reconcile.orphanResolutions.length, 1);
  } finally {
    cleanup();
  }
});

test("v1 事件文件读路径迁移：版本升到当前格式，内嵌 receipt 载荷经 receipt 链升到 v3", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const executionId = newExecutionId();
    // 手工构造 v1 格式行（S1 落盘形状：无 contentHashes/errorKind，receipt 载荷为 v2）
    const v1Envelope = {
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
    };
    const v1Intent = {
      ...v1Envelope,
      kind: "intent",
      executionId,
      toolCallId: "toolu_01ABC",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
      at: 1_757_000_000_000,
    };
    const v1Receipt = {
      ...v1Envelope,
      kind: "receipt",
      receipt: { ...makeReceipt(executionId), version: 2 },
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v1Intent)}\n${JSON.stringify(v1Receipt)}\n`, "utf8");

    const records = readEventLogFile(path);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    const receipt = records[1];
    assert.equal(receipt?.kind, "receipt");
    assert.equal(receipt?.kind === "receipt" && receipt.receipt.version, RECEIPT_VERSION);

    // 冷物化经同一路径：迁移后照常对账（settled 配对成功）
    const { reconcile } = materializeSession(dir, sessionId);
    assert.equal(reconcile.settled.length, 1);
    assert.equal(reconcile.unknown.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entry 族：appendEntry 落盘并读回；信封 id 即分配的 EntryId；不进治理幂等索引", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    const first = log.appendEntry({ runSeq: 1, role: "user", runId });
    const second = log.appendEntry({ runSeq: 2, role: "assistant", runId });
    log.close();
    // 读回：kind/runSeq/role 原样；信封 id 就是分配给该条 transcript 消息的 EntryId
    const records = readEventLogFile(log.path);
    assert.deepEqual(records, [first, second]);
    assert.match(first.id, /^entry_/);
    // entry 无 executionId：同 runSeq 重写不触发幂等冲突（序号连续性由写入方 adapter 保证）
    const revived = new JsonlEventLog(dir, sessionId);
    revived.appendEntry({ runSeq: 1, role: "user", runId });
    revived.close();
    assert.equal(readEventLogFile(log.path).filter((r) => r.kind === "entry").length, 3);

    // 冷物化：entries 单列成族，不混入 runtimeEvents（五种归一化事件之外）
    const materialized = materializeSession(dir, sessionId);
    assert.equal(materialized.entries.length, 3);
    assert.equal(materialized.runtimeEvents.length, 0);
  } finally {
    cleanup();
  }
});

test("resolution 人工确认渠道：method=human-confirmed 无哈希证据，配对悬账归 resolved", () => {
  const { log, dir, sessionId, runId, cleanup } = makeLog();
  try {
    const intent = makeIntentInput({ runId });
    log.appendIntent(intent);
    // resume 交互的人工确认：没有哈希三方比对证据（intent 探针缺省/文件已被第三方改动）
    log.appendResolution({
      executionId: intent.executionId,
      toolCallId: intent.toolCallId,
      toolName: intent.toolName,
      outcome: "executed",
      method: "human-confirmed",
      at: 1_757_000_000_004,
      runId,
    });
    log.close();

    const { reconcile } = materializeSession(dir, sessionId);
    assert.equal(reconcile.unknown.length, 0);
    assert.equal(reconcile.resolved.length, 1);
    assert.equal(reconcile.resolved[0]?.resolution.method, "human-confirmed");
    assert.equal(reconcile.resolved[0]?.resolution.evidence, undefined);
  } finally {
    cleanup();
  }
});

test("v2 事件文件读路径迁移：版本逐级升到当前格式（v3 加法式演进，旧记录逐字有效）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const executionId = newExecutionId();
    // 手工构造 v2 格式行（S2 落盘形状：resolution.method 仅 hash-auto、evidence 必填）
    const v2Envelope = {
      version: 2,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
    };
    const v2Resolution = {
      ...v2Envelope,
      kind: "resolution",
      executionId,
      toolCallId: "toolu_01ABC",
      toolName: "edit_file",
      outcome: "executed",
      method: "hash-auto",
      evidence: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
        observedHash: "bbbbbbbbbbbbbbbb",
      },
      at: 1_757_000_000_003,
    };
    const v2Settled = {
      ...v2Envelope,
      kind: "tool.settled",
      payload: { toolCallId: "toolu_1", toolName: "edit_file", isError: true, errorKind: "domain" },
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v2Resolution)}\n${JSON.stringify(v2Settled)}\n`, "utf8");

    const records = readEventLogFile(path);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    assert.equal(records[0]?.kind, "resolution");
    assert.equal(records[1]?.kind, "tool.settled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v3 事件文件读路径迁移：纯版本推进到 v4（S6 加法式演进，旧记录逐字有效）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    // 手工构造 v3 格式行（S5 落盘形状：entry 族 + human-confirmed resolution）
    const v3Envelope = {
      version: 3,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
    };
    const v3Entry = { ...v3Envelope, kind: "entry", runSeq: 1, role: "assistant" };
    const v3Resolution = {
      ...v3Envelope,
      kind: "resolution",
      executionId: newExecutionId(),
      toolCallId: "toolu_01ABC",
      toolName: "edit_file",
      outcome: "not-executed",
      method: "human-confirmed",
      at: 1_757_000_000_003,
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v3Entry)}\n${JSON.stringify(v3Resolution)}\n`, "utf8");

    const records = readEventLogFile(path);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    assert.equal(records[0]?.kind, "entry");
    assert.equal(records[1]?.kind, "resolution");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v4 事件文件读路径迁移：逐级纯版本推进到当前版本（加法式演进，旧记录逐字有效）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const v4Entry = {
      version: 4,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind: "entry",
      runSeq: 1,
      role: "user",
    };
    const v4Grant = {
      version: 4,
      id: newEntryId(),
      sessionId,
      timestamp: 1_757_000_000_001,
      kind: "grant.created",
      grantId: newGrantId(),
      tool: "edit_file",
      createdAt: 1_757_000_000_001,
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v4Entry)}\n${JSON.stringify(v4Grant)}\n`, "utf8");
    const records = readEventLogFile(path);
    assert.equal(records.length, 2);
    assert.equal(EVENT_LOG_VERSION, 14);
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    assert.equal(records[0]?.kind, "entry");
    assert.equal(records[1]?.kind, "grant.created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entry runSeq 断号冷检测（M4 收口决策 ③）：中段空洞 + run.ended.messageCount 揭示的末尾缺失", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runA = newRunId();
    const runB = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    // runA：1、2、4 落盘（第 3 条写盘失败，D3 不占位重试），run.ended 报 6 条 → 末尾缺 5、6
    log.appendEntry({ runSeq: 1, role: "user", runId: runA });
    log.appendEntry({ runSeq: 2, role: "assistant", runId: runA });
    log.appendEntry({ runSeq: 4, role: "assistant", runId: runA });
    log.appendRuntimeEvent(
      makeRuntimeEnvelope(sessionId, runA, RuntimeEventKind.RunEnded, { messageCount: 6 })
    );
    // runB：完整连续，无 run.ended（崩溃残留）——不因缺 run.ended 而误报
    log.appendEntry({ runSeq: 1, role: "user", runId: runB });
    log.appendEntry({ runSeq: 2, role: "assistant", runId: runB });
    log.close();

    const materialized = materializeSession(dir, sessionId);
    assert.deepEqual(materialized.entryGaps, [{ runId: runA, missingSeqs: [3, 5, 6] }]);
    // 纯函数直测：无 entry 无事件 = 无缺口；messageCount 与 entry 数相等 = 无缺口
    assert.deepEqual(detectEntryGaps([], []), []);
    const complete = materializeSession(dir, newSessionId());
    assert.deepEqual(complete.entryGaps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grant 族（M4 S6，决策 3）：grant.created / grant.revoked 落盘、冷物化还原生效 grant", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-eventlog-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const createdA = log.appendGrantCreated({
      grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
      tool: "edit_file",
      pathPrefix: "src",
      createdAt: 1_757_000_000_000,
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "src/a.ts" } },
      runId,
    });
    const createdB = log.appendGrantCreated({
      grantId: newGrantId(),
      tool: "read_file",
      createdAt: 1_757_000_000_001,
      firstCall: { toolCallId: "toolu_01DEF", args: { path: "b.ts" } },
      runId,
    });
    const revokedB = log.appendGrantRevoked({
      grantId: createdB.grantId,
      revokedAt: 1_757_000_000_002,
      runId,
    });
    // REPL 时段的 /revoke 无活动 Run：runId 缺省合法（grant 是 session 级治理状态）
    const createdC = log.appendGrantCreated({
      grantId: newGrantId(),
      tool: "edit_file",
      createdAt: 1_757_000_000_003,
      firstCall: { toolCallId: "toolu_01GHI", args: { path: "c.ts" } },
      runId,
    });
    const revokedC = log.appendGrantRevoked({
      grantId: createdC.grantId,
      revokedAt: 1_757_000_000_004,
    });
    log.close();

    // 耐久性佐证：全新读路径可见（治理族 writeSync + fsync 路径）
    const lines = readFileSync(log.path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ["grant.created", "grant.created", "grant.revoked", "grant.created", "grant.revoked"]
    );
    assert.equal(lines[0]?.version, EVENT_LOG_VERSION);
    assert.equal(lines[4]?.runId, undefined, "REPL 时段撤销无 runId");

    // 冷物化：生效 grant = created − revoked；被撤的 read_file grant 不在列
    const materialized = materializeSession(dir, sessionId);
    assert.equal(materialized.grantCreateds.length, 3);
    assert.equal(materialized.grantRevokeds.length, 2);
    assert.equal(revokedC.grantId, createdC.grantId);
    assert.equal(materialized.grants.length, 1);
    assert.deepEqual(
      materialized.grants.map((grant) => [grant.grantId, grant.tool, grant.pathPrefix]),
      [[createdA.grantId, "edit_file", "src"]]
    );
    assert.equal(revokedB.grantId, createdB.grantId);
    assert.equal(materialized.grants[0]?.firstCall.toolCallId, "toolu_01ABC");
    assert.equal(materialized.grants[0]?.createdAt, 1_757_000_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
