// Event Log（ROADMAP §3.5 权威状态源，M4 S1）：每 session 一文件 `.pigeon/sessions/sess_<ulid>.jsonl`
// （D1），单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）与治理族
// （intent/decision/receipt，M3 账本归并而来，决策 2：不双写）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 落盘策略（D2）：事件产生即同步写盘（崩溃窗口为零）；治理族写后 fsync（防断电），
// 观察族只写不 fsync（防进程崩溃，延续 M3 现状）。
// 冷物化 = 全量读本 session 文件 + 按 executionId 对账（reconcile），分类语义与 M3 完全一致：
// intent 无 receipt = OutcomeUnknown（只标记留证，§3.2 禁止盲重放）；decision 即闭环（rejected）。
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  RunEndedPayloadSchema,
  RuntimeEventKind,
  ToolProposedPayloadSchema,
  ToolSettledPayloadSchema,
  TurnCompletedPayloadSchema,
  TurnStartedPayloadSchema,
} from "../pi-runtime/events.ts";
import type { EventEnvelope } from "../state/events.ts";
import {
  EntryIdSchema,
  type ExecutionId,
  ExecutionIdSchema,
  newEntryId,
  type RunId,
  RunIdSchema,
  type SessionId,
  SessionIdSchema,
} from "../state/ids.ts";
import { type Receipt, ReceiptSchema } from "../state/receipt.ts";
import { ToolExecutionDecisionSchema } from "../state/tool-execution.ts";

// Event Log 记录格式版本；迁移管线（M0 migration.ts）按 version 字段路由
export const EVENT_LOG_VERSION = 1;

// 记录信封公共字段（D 系列决策：version + ids + sessionId + runId + timestamp）
const ENVELOPE_PROPS = {
  version: Type.Literal(EVENT_LOG_VERSION),
  id: EntryIdSchema,
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  // Unix 毫秒时间戳
  timestamp: Type.Integer({ minimum: 0 }),
} as const;

// 观察族：五种归一化运行时事件（payload schema 唯一事实源在 pi-runtime/events.ts）
export const TurnStartedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(RuntimeEventKind.TurnStarted),
  payload: TurnStartedPayloadSchema,
});
export const TurnCompletedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(RuntimeEventKind.TurnCompleted),
  payload: TurnCompletedPayloadSchema,
});
export const ToolProposedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(RuntimeEventKind.ToolProposed),
  payload: ToolProposedPayloadSchema,
});
export const ToolSettledRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(RuntimeEventKind.ToolSettled),
  payload: ToolSettledPayloadSchema,
});
export const RunEndedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(RuntimeEventKind.RunEnded),
  payload: RunEndedPayloadSchema,
});
export const RuntimeEventRecordSchema = Type.Union([
  TurnStartedRecordSchema,
  TurnCompletedRecordSchema,
  ToolProposedRecordSchema,
  ToolSettledRecordSchema,
  RunEndedRecordSchema,
]);
export type RuntimeEventRecord = Static<typeof RuntimeEventRecordSchema>;

// 治理族公共字段（M3 账本 intent/decision 行形状；行级 kind/version 由信封承接）
const GOVERNANCE_PROPS = {
  executionId: ExecutionIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  // 模型原始参数快照（与 ToolExecution.rawArgs 同源）
  rawArgs: Type.Unknown(),
  // 决定快照（含 approvedBy；decision 族携带逐字拒绝理由，决策 4 证据链）
  decision: ToolExecutionDecisionSchema,
  at: Type.Integer({ minimum: 0 }),
} as const;

// intent：调用前持久化意图（§3.2：副作用 = 稳定 ExecutionId + 调用前意图 + 调用后 Receipt）
export const IntentRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("intent"),
  ...GOVERNANCE_PROPS,
});
export type IntentRecord = Static<typeof IntentRecordSchema>;

// decision：拒绝决定落盘——拒绝发生于 dispatch 前，无副作用可能，理由逐字留证
export const DecisionRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("decision"),
  ...GOVERNANCE_PROPS,
});
export type DecisionRecord = Static<typeof DecisionRecordSchema>;

// receipt：Receipt 是独立版本化文档（state/receipt.ts，自带 id 与迁移链），
// 作为载荷整体嵌入，不在记录层摊平（避免信封 id 与 ReceiptId 撞名、保持 receipt 迁移链单源）
export const ReceiptRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("receipt"),
  receipt: ReceiptSchema,
});
export type ReceiptRecord = Static<typeof ReceiptRecordSchema>;

// Event Log 记录并集（grant 族不在 S1 范围，S6 以新成员加法式扩展）
export const EventRecordSchema = Type.Union([
  RuntimeEventRecordSchema,
  IntentRecordSchema,
  DecisionRecordSchema,
  ReceiptRecordSchema,
]);
export type EventRecord = Static<typeof EventRecordSchema>;

// 治理族追加输入：业务字段 + runId；信封其余字段（version/id/sessionId/timestamp）由日志盖章
export type IntentInput = Omit<IntentRecord, "version" | "id" | "sessionId" | "kind" | "timestamp">;
export type DecisionInput = Omit<
  DecisionRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export interface ReceiptInput {
  receipt: Receipt;
  runId: RunId;
}

export class EventLogConflictError extends Error {}
export class EventLogCorruptionError extends Error {}

// 治理族 kind（幂等索引按族分立：跨族同 executionId 合法，同族重复一律冲突拒绝——M3 语义）；
// 键是静态字面量，索引容器用 Record 而非 Map
type GovernanceKind = "intent" | "decision" | "receipt";

// 对账报告：pairing 按 executionId（分类语义与 M3 账本逐字一致）
export interface ReconcileEntry {
  intent: IntentRecord;
  receipt?: Receipt;
}
export interface RejectedEntry {
  decision: DecisionRecord;
  receipt?: Receipt;
}
export interface ReconcileReport {
  // intent + receipt 配对完成
  settled: ReconcileEntry[];
  // intent 无 receipt：死于 dispatch/execute/receipt 任一窗口——副作用是否发生未知（OutcomeUnknown）
  unknown: ReconcileEntry[];
  // decision（拒绝）：闭环——拒绝发生于 dispatch 前，无副作用可能，永不入 OutcomeUnknown
  rejected: RejectedEntry[];
  // receipt 既无 intent 也无 decision：日志损坏或手写——如实报告，不猜测
  orphanReceipts: Receipt[];
}

// 冷物化结果：一个 session 的完整派生状态（D5：派生不落库，视图是投影）
export interface MaterializedSession {
  sessionId: SessionId;
  path: string;
  // 全量记录（按文件顺序）
  records: EventRecord[];
  runtimeEvents: RuntimeEventRecord[];
  intents: IntentRecord[];
  decisions: DecisionRecord[];
  receipts: Receipt[];
  reconcile: ReconcileReport;
}

// 全量读 + 校验：进程死于写盘中途会留下半截末行——按"未持久化"容忍（torn tail）；
// 非末行损坏说明日志被外部破坏，响亮失败
export function readEventLogFile(path: string): EventRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const records: EventRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        break; // torn tail：半截末行视为未写入
      }
      throw new EventLogCorruptionError(`事件日志损坏：${path} 第 ${index + 1} 行不是合法 JSON`);
    }
    let record: EventRecord;
    try {
      record = Value.Parse(EventRecordSchema, raw);
    } catch (error) {
      throw new EventLogCorruptionError(
        `事件日志损坏：${path} 第 ${index + 1} 行校验失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    records.push(record);
  }
  return records;
}

// 治理族记录的幂等键（executionId）；receipt 的键在载荷里
function governanceKey(record: IntentRecord | DecisionRecord | ReceiptRecord): ExecutionId {
  return record.kind === "receipt" ? record.receipt.executionId : record.executionId;
}

export class JsonlEventLog {
  readonly sessionId: SessionId;
  readonly path: string;
  // 治理族幂等索引；构造时从磁盘恢复，崩溃后重开追加仍幂等
  readonly #governanceIds: Record<GovernanceKind, Set<string>> = {
    intent: new Set<string>(),
    decision: new Set<string>(),
    receipt: new Set<string>(),
  };
  // 常驻 append 句柄：治理族 fsync 与观察族写盘共用（fsync 按文件刷脏页，无需逐次重开）
  readonly #fd: number;
  #closed = false;

  constructor(dir: string, sessionId: SessionId) {
    this.sessionId = sessionId;
    this.path = JsonlEventLog.filePathFor(dir, sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // 冷启动恢复幂等索引（torn tail 容忍同 M3）；重复记录 = 外部破坏，响亮失败
    for (const record of readEventLogFile(this.path)) {
      if (record.kind === "intent" || record.kind === "decision" || record.kind === "receipt") {
        const key = governanceKey(record);
        if (this.#governanceIds[record.kind].has(key)) {
          throw new EventLogCorruptionError(
            `事件日志损坏：${this.path} 重复 ${record.kind} ${key}`
          );
        }
        this.#governanceIds[record.kind].add(key);
      }
    }
    this.#fd = openSync(this.path, "a");
  }

  static filePathFor(dir: string, sessionId: SessionId): string {
    return join(dir, `${sessionId}.jsonl`);
  }

  // 观察族落盘：归一化事件信封直接转记录（D2：appendFileSync 级耐久，不 fsync）。
  // 信封 version 被记录版本覆盖：内存信封版本（state/events.ts）与落盘格式版本（本文件）
  // 当前同为 1，将来演进以 EVENT_LOG_VERSION 为准
  appendRuntimeEvent(event: EventEnvelope): RuntimeEventRecord {
    const record = Value.Parse(RuntimeEventRecordSchema, {
      ...event,
      version: EVENT_LOG_VERSION,
    });
    this.#append(record, false);
    return record;
  }

  appendIntent(input: IntentInput): IntentRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(IntentRecordSchema, {
      ...this.#envelope(runId),
      kind: "intent",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  appendDecision(input: DecisionInput): DecisionRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(DecisionRecordSchema, {
      ...this.#envelope(runId),
      kind: "decision",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  appendReceipt(input: ReceiptInput): ReceiptRecord {
    const record = Value.Parse(ReceiptRecordSchema, {
      ...this.#envelope(input.runId),
      kind: "receipt",
      receipt: input.receipt,
    });
    this.#append(record, true);
    return record;
  }

  // 迁移/外部构造记录的直通入口：全量校验 + 幂等判定 + 按族耐久写盘
  appendRecord(record: EventRecord): void {
    const parsed = Value.Parse(EventRecordSchema, record);
    this.#append(
      parsed,
      parsed.kind === "intent" || parsed.kind === "decision" || parsed.kind === "receipt"
    );
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    closeSync(this.#fd);
  }

  #envelope(runId: RunId) {
    return {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      runId,
      timestamp: Date.now(),
    };
  }

  // 唯一写盘路径：逐条同步写（D2），治理族写后 fsync；写失败原样上抛，
  // 语义由调用方裁决（intent fail-closed / decision、receipt 进 listenerErrors）。
  // 幂等：同一 executionId 同族重复写一律冲突拒绝（可检测，不静默去重）——
  // ExecutionId 由 Pigeon 生成且唯一，重复出现即逻辑错误或重放嫌疑（§3.2 不盲重放）
  #append(record: EventRecord, durable: boolean): void {
    if (this.#closed) {
      throw new EventLogCorruptionError("事件日志已关闭，拒绝追加");
    }
    if (record.kind === "intent" || record.kind === "decision" || record.kind === "receipt") {
      const key = governanceKey(record);
      if (this.#governanceIds[record.kind].has(key)) {
        throw new EventLogConflictError(`重复 ${record.kind}：${key}`);
      }
      writeSync(this.#fd, `${JSON.stringify(record)}\n`);
      fsyncSync(this.#fd);
      this.#governanceIds[record.kind].add(key);
      return;
    }
    writeSync(this.#fd, `${JSON.stringify(record)}\n`);
    if (durable) {
      fsyncSync(this.#fd);
    }
  }
}

// 冷物化：读 session 事件文件 → 重建派生状态 + 对账报告。
// 文件不存在 = 全新 session，返回空态（不是损坏）
export function materializeSession(dir: string, sessionId: SessionId): MaterializedSession {
  const path = JsonlEventLog.filePathFor(dir, sessionId);
  const records = readEventLogFile(path);
  const runtimeEvents: RuntimeEventRecord[] = [];
  const intents: IntentRecord[] = [];
  const decisions: DecisionRecord[] = [];
  const receipts: Receipt[] = [];
  for (const record of records) {
    if (record.kind === "intent") {
      intents.push(record);
    } else if (record.kind === "decision") {
      decisions.push(record);
    } else if (record.kind === "receipt") {
      receipts.push(record.receipt);
    } else {
      runtimeEvents.push(record);
    }
  }
  return {
    sessionId,
    path,
    records,
    runtimeEvents,
    intents,
    decisions,
    receipts,
    reconcile: reconcileRecords(intents, decisions, receipts),
  };
}

// 冷启动对账（与 M3 账本 reconcile 逐字同语义）：intent 无 receipt → OutcomeUnknown
// （只留证，不重放）；decision（拒绝）即闭环——与 receipt 配对后归 rejected
export function reconcileRecords(
  intents: IntentRecord[],
  decisions: DecisionRecord[],
  receipts: Receipt[]
): ReconcileReport {
  const receiptByExecution = new Map(receipts.map((r) => [r.executionId, r]));
  const rejected: RejectedEntry[] = [];
  for (const decision of decisions) {
    const receipt = receiptByExecution.get(decision.executionId);
    receiptByExecution.delete(decision.executionId);
    rejected.push(receipt === undefined ? { decision } : { decision, receipt });
  }
  const settled: ReconcileEntry[] = [];
  const unknown: ReconcileEntry[] = [];
  for (const intent of intents) {
    const receipt = receiptByExecution.get(intent.executionId);
    receiptByExecution.delete(intent.executionId);
    if (receipt === undefined) {
      unknown.push({ intent });
    } else {
      settled.push({ intent, receipt });
    }
  }
  return { settled, unknown, rejected, orphanReceipts: [...receiptByExecution.values()] };
}
