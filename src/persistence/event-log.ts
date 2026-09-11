// Event Log（ROADMAP §3.5 权威状态源，M4 S1/S2）：每 session 一文件 `.pigeon/sessions/sess_<ulid>.jsonl`
// （D1），单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）与治理族
// （intent/decision/receipt，M3 账本归并而来，决策 2：不双写；S2 新增 breaker/resolution）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 落盘策略（D2）：事件产生即同步写盘（崩溃窗口为零）；治理族写后 fsync（防断电），
// 观察族只写不 fsync（防进程崩溃，延续 M3 现状）。
// 冷物化 = 全量读本 session 文件 + 按 executionId 对账（reconcile），分类语义与 M3 完全一致：
// intent 无 receipt = OutcomeUnknown（只标记留证，§3.2 禁止盲重放）；decision 即闭环（rejected）；
// S2 新增：resolution（哈希自动确证，D5）与悬账配对归 resolved，不再滞留 unknown。
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
  type ToolSettledPayload,
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
import { MigrationRegistry } from "../state/migration.ts";
import { migrateReceiptToCurrent, type Receipt, ReceiptSchema } from "../state/receipt.ts";
import { ToolExecutionDecisionSchema } from "../state/tool-execution.ts";
import { snapshotTag } from "../tools/hashline.ts";
import { resolveWorkspacePath } from "../tools/paths.ts";
import {
  classifyRunOutcome,
  classifyToolOutcome,
  type FailureClass,
  type RunOutcomeFacts,
  type ToolOutcomeFacts,
} from "./classification.ts";

// Event Log 记录格式版本；迁移管线（M0 migration.ts）按 version 字段路由。
// v2（M4 S2）：intent 增 contentHashes、tool.settled 增 errorKind、新增 breaker/resolution 族——
// 全部加法式（可缺省/新成员），v1 旧记录经读路径迁移链升级（见 eventLogMigrations）
export const EVENT_LOG_VERSION = 2;

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

// intent：调用前持久化意图（§3.2：副作用 = 稳定 ExecutionId + 调用前意图 + 调用后 Receipt）。
// M4 S2（D5）：写工具 intent 增 contentHashes——dispatch 准备期实测的改前哈希 +
// 由编辑规约确定性推出的预期改后哈希（snapshotTag 格式，16 位十六进制），
// 供冷恢复三方比对自动确证；探针不可得时缺省（缺省 = 该悬账只能留人确认）
export const IntentContentHashesSchema = Type.Object({
  // 工作区相对路径（模型参数原样）
  path: Type.String({ minLength: 1 }),
  beforeHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
  expectedAfterHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
});
export type IntentContentHashes = Static<typeof IntentContentHashesSchema>;

export const IntentRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("intent"),
  ...GOVERNANCE_PROPS,
  contentHashes: Type.Optional(IntentContentHashesSchema),
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

// breaker（M4 S2，D7 治理熔断子类的判据行）：熔断落闸时刻的持久化留证。
// 独立于 decision 族的原因：事件级熔断兜底的「上游拦截」调用 hook 从未运行，
// 没有 ToolExecution 账本/executionId 可挂靠；熔断是 Run 级治理动作而非单次审批决定。
// 不进 executionId 幂等索引（无此键），同一 Run 多次落闸各自留行
export const BreakerRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("breaker"),
  toolName: Type.String({ minLength: 1 }),
  // 触发落闸的那次调用
  toolCallId: Type.String({ minLength: 1 }),
  // 计数粒度：tool = policy:deny 系绝对拒绝按工具名；fingerprint = 人工拒绝/闸内异常按参数指纹；
  // intercepted = 事件级上游拦截连击（幽灵工具名/参数畸形）
  scope: Type.Union([
    Type.Literal("tool"),
    Type.Literal("fingerprint"),
    Type.Literal("intercepted"),
  ]),
  // 落闸时的连击数与阈值
  count: Type.Integer({ minimum: 1 }),
  threshold: Type.Integer({ minimum: 1 }),
  at: Type.Integer({ minimum: 0 }),
});
export type BreakerRecord = Static<typeof BreakerRecordSchema>;

// resolution（M4 S2，D5 哈希自动确证）：悬账（intent 无 receipt）的确证记录。
// 冷启动对账时读目标文件现状哈希三方比对：== 预期改后 → executed；== 改前 → not-executed；
// 都不符（撕裂写/第三方改动）不留记录、继续滞留 OutcomeUnknown 等人工。
// 确证只销账，系统永不自动重新执行（§3.2）；按 executionId 幂等（同族重复冲突拒绝）
export const ResolutionRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("resolution"),
  executionId: ExecutionIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  outcome: Type.Union([Type.Literal("executed"), Type.Literal("not-executed")]),
  // 确证渠道：hash-auto = 哈希三方比对自动确证；将来人工确认渠道以新字面量加入
  method: Type.Literal("hash-auto"),
  // 比对证据四方留证：路径 + 改前/预期改后/实测现状哈希
  evidence: Type.Object({
    path: Type.String({ minLength: 1 }),
    beforeHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
    expectedAfterHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
    observedHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
  }),
  at: Type.Integer({ minimum: 0 }),
});
export type ResolutionRecord = Static<typeof ResolutionRecordSchema>;

// Event Log 记录并集（grant 族不在 S2 范围，S6 以新成员加法式扩展）
export const EventRecordSchema = Type.Union([
  RuntimeEventRecordSchema,
  IntentRecordSchema,
  DecisionRecordSchema,
  ReceiptRecordSchema,
  BreakerRecordSchema,
  ResolutionRecordSchema,
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
export type BreakerInput = Omit<BreakerRecord, "version" | "id" | "sessionId" | "kind" | "timestamp">;
export type ResolutionInput = Omit<
  ResolutionRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;

export class EventLogConflictError extends Error {}
export class EventLogCorruptionError extends Error {}

// 治理族 kind（幂等索引按族分立：跨族同 executionId 合法，同族重复一律冲突拒绝——M3 语义）；
// 键是静态字面量，索引容器用 Record 而非 Map。
// resolution 按 executionId 幂等（一次悬账只确证一次）；breaker 无 executionId 键，不进索引
type GovernanceKind = "intent" | "decision" | "receipt" | "resolution";

// 对账报告：pairing 按 executionId（分类语义与 M3 账本逐字一致）
export interface ReconcileEntry {
  intent: IntentRecord;
  receipt?: Receipt;
}
export interface RejectedEntry {
  decision: DecisionRecord;
  receipt?: Receipt;
}
// M4 S2：悬账与确证记录的配对（D5 哈希自动确证销账）
export interface ResolvedEntry {
  intent: IntentRecord;
  resolution: ResolutionRecord;
}
export interface ReconcileReport {
  // intent + receipt 配对完成
  settled: ReconcileEntry[];
  // intent 无 receipt 且无 resolution：死于 dispatch/execute/receipt 任一窗口——
  // 副作用是否发生未知（OutcomeUnknown）
  unknown: ReconcileEntry[];
  // decision（拒绝）：闭环——拒绝发生于 dispatch 前，无副作用可能，永不入 OutcomeUnknown
  rejected: RejectedEntry[];
  // intent 无 receipt 但有 resolution：哈希自动确证已销账（executed / not-executed）
  resolved: ResolvedEntry[];
  // receipt 既无 intent 也无 decision：日志损坏或手写——如实报告，不猜测
  orphanReceipts: Receipt[];
  // resolution 找不到对应 intent：同上，如实报告
  orphanResolutions: ResolutionRecord[];
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
  breakers: BreakerRecord[];
  resolutions: ResolutionRecord[];
  reconcile: ReconcileReport;
  // 失败四分类（M4 S2，D7）：从本 session 事件现算（派生不落库；判据纯函数在 classification.ts）
  classification: SessionClassification;
}

// Run 级失败分类（D7 左列判据）；failure=null 表示正常收尾
export interface RunClassification {
  runId: RunId;
  failure: FailureClass | null;
}
// ToolExecution 级失败分类（D7 右列判据）；executionId=null 表示上游拦截调用（无账本记录）
export interface ToolExecutionClassification {
  executionId: ExecutionId | null;
  toolCallId: string;
  toolName: string;
  failure: FailureClass | null;
}
export interface SessionClassification {
  runs: RunClassification[];
  toolExecutions: ToolExecutionClassification[];
}

// Event Log 记录格式的迁移链（M0 管线）：v1 → v2 为加法式演进（intent 增 contentHashes、
// settled 增 errorKind、新增 breaker/resolution 族——旧记录逐字有效，纯版本推进）；
// receipt 载荷自带独立迁移链（state/receipt.ts），此处一并升级
const eventLogMigrations = new MigrationRegistry();
eventLogMigrations.register("event-log", 1, (doc) => ({
  ...doc,
  version: 2,
  ...(doc.kind === "receipt" ? { receipt: migrateReceiptToCurrent(doc.receipt) } : {}),
}));

// 全量读 + 校验：进程死于写盘中途会留下半截末行——按"未持久化"容忍（torn tail）；
// 非末行损坏说明日志被外部破坏，响亮失败。
// 读路径迁移（M0 管线）：version 低于当前格式的记录先经 eventLogMigrations 逐级升级再校验
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
      record =
        typeof raw === "object" && raw !== null && "version" in raw && raw.version !== EVENT_LOG_VERSION
          ? eventLogMigrations.migrate("event-log", raw, EVENT_LOG_VERSION, EventRecordSchema)
          : Value.Parse(EventRecordSchema, raw);
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
function governanceKey(
  record: IntentRecord | DecisionRecord | ReceiptRecord | ResolutionRecord
): ExecutionId {
  return record.kind === "receipt" ? record.receipt.executionId : record.executionId;
}

// 按 executionId 幂等的治理族集合——构造器索引恢复 / appendRecord / #append 三处判定
// 必须恒同（漏一处 = 崩溃重开后幂等失守或写盘不 fsync），故收口为唯一类型谓词
function isExecutionKeyedGovernance(
  record: EventRecord
): record is IntentRecord | DecisionRecord | ReceiptRecord | ResolutionRecord {
  return (
    record.kind === "intent" ||
    record.kind === "decision" ||
    record.kind === "receipt" ||
    record.kind === "resolution"
  );
}

export class JsonlEventLog {
  readonly sessionId: SessionId;
  readonly path: string;
  // 治理族幂等索引；构造时从磁盘恢复，崩溃后重开追加仍幂等
  readonly #governanceIds: Record<GovernanceKind, Set<string>> = {
    intent: new Set<string>(),
    decision: new Set<string>(),
    receipt: new Set<string>(),
    resolution: new Set<string>(),
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
      if (isExecutionKeyedGovernance(record)) {
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

  // 熔断落闸留证（M4 S2，D7 治理熔断判据行）：治理族耐久（fsync），无 executionId 幂等键
  appendBreaker(input: BreakerInput): BreakerRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(BreakerRecordSchema, {
      ...this.#envelope(runId),
      kind: "breaker",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 悬账确证落盘（M4 S2，D5）：治理族耐久（fsync）+ 按 executionId 幂等（重复确证冲突拒绝）
  appendResolution(input: ResolutionInput): ResolutionRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(ResolutionRecordSchema, {
      ...this.#envelope(runId),
      kind: "resolution",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 迁移/外部构造记录的直通入口：全量校验 + 幂等判定 + 按族耐久写盘
  appendRecord(record: EventRecord): void {
    const parsed = Value.Parse(EventRecordSchema, record);
    this.#append(parsed, isExecutionKeyedGovernance(parsed));
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
    if (isExecutionKeyedGovernance(record)) {
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
  const breakers: BreakerRecord[] = [];
  const resolutions: ResolutionRecord[] = [];
  for (const record of records) {
    if (record.kind === "intent") {
      intents.push(record);
    } else if (record.kind === "decision") {
      decisions.push(record);
    } else if (record.kind === "receipt") {
      receipts.push(record.receipt);
    } else if (record.kind === "breaker") {
      breakers.push(record);
    } else if (record.kind === "resolution") {
      resolutions.push(record);
    } else {
      runtimeEvents.push(record);
    }
  }
  const reconcile = reconcileRecords(intents, decisions, receipts, resolutions);
  return {
    sessionId,
    path,
    records,
    runtimeEvents,
    intents,
    decisions,
    receipts,
    breakers,
    resolutions,
    reconcile,
    classification: classifySessionRecords(records, runtimeEvents, breakers, reconcile),
  };
}

// 冷启动对账（与 M3 账本 reconcile 逐字同语义 + S2 确证配对）：intent 无 receipt →
// OutcomeUnknown（只留证，不重放）；decision（拒绝）即闭环——与 receipt 配对后归 rejected；
// intent 无 receipt 但有 resolution（哈希自动确证）→ resolved（销账，不再滞留 unknown）
export function reconcileRecords(
  intents: IntentRecord[],
  decisions: DecisionRecord[],
  receipts: Receipt[],
  resolutions: ResolutionRecord[]
): ReconcileReport {
  const receiptByExecution = new Map(receipts.map((r) => [r.executionId, r]));
  const resolutionByExecution = new Map(resolutions.map((r) => [r.executionId, r]));
  const rejected: RejectedEntry[] = [];
  for (const decision of decisions) {
    const receipt = receiptByExecution.get(decision.executionId);
    receiptByExecution.delete(decision.executionId);
    rejected.push(receipt === undefined ? { decision } : { decision, receipt });
  }
  const settled: ReconcileEntry[] = [];
  const unknown: ReconcileEntry[] = [];
  const resolved: ResolvedEntry[] = [];
  for (const intent of intents) {
    const receipt = receiptByExecution.get(intent.executionId);
    receiptByExecution.delete(intent.executionId);
    const resolution = resolutionByExecution.get(intent.executionId);
    resolutionByExecution.delete(intent.executionId);
    if (receipt !== undefined) {
      settled.push({ intent, receipt });
    } else if (resolution !== undefined) {
      resolved.push({ intent, resolution });
    } else {
      unknown.push({ intent });
    }
  }
  return {
    settled,
    unknown,
    rejected,
    resolved,
    orphanReceipts: [...receiptByExecution.values()],
    orphanResolutions: [...resolutionByExecution.values()],
  };
}

// 失败四分类装配（M4 S2，D7）：判据纯函数在 classification.ts（活适配器 RunResult 共用），
// 此处只做「事件日志 → 事实」映射。Run 事实按 runId 聚合；同 Run 多次 turn.completed 以末条
// 为准（与活适配器 judgeTerminal 取末条 assistant 消息同口径）
function classifySessionRecords(
  records: EventRecord[],
  runtimeEvents: RuntimeEventRecord[],
  breakers: BreakerRecord[],
  reconcile: ReconcileReport
): SessionClassification {
  const runOrder: RunId[] = [];
  const runFacts = new Map<RunId, RunOutcomeFacts>();
  const runFactsOf = (runId: RunId): RunOutcomeFacts => {
    let facts = runFacts.get(runId);
    if (facts === undefined) {
      facts = { syntheticFailure: false, breakerTripped: false, hasTurnCompleted: false };
      runFacts.set(runId, facts);
      runOrder.push(runId);
    }
    return facts;
  };
  for (const record of records) {
    runFactsOf(record.runId);
  }
  const settledByToolCall = new Map<string, ToolSettledPayload>();
  for (const event of runtimeEvents) {
    if (event.kind === "turn.completed") {
      const facts = runFactsOf(event.runId);
      facts.stopReason = event.payload.stopReason;
      facts.syntheticFailure = event.payload.syntheticFailure;
      facts.hasTurnCompleted = true;
    } else if (event.kind === "tool.settled") {
      settledByToolCall.set(event.payload.toolCallId, event.payload);
    }
  }
  for (const breaker of breakers) {
    runFactsOf(breaker.runId).breakerTripped = true;
  }
  const runs: RunClassification[] = runOrder.map((runId) => ({
    runId,
    failure: classifyRunOutcome(runFactsOf(runId)),
  }));

  const toolExecutions: ToolExecutionClassification[] = [];
  const pushTool = (
    executionId: ExecutionId | null,
    toolCallId: string,
    toolName: string,
    runId: RunId,
    outcome: Omit<ToolOutcomeFacts, "runAborted" | "runBreakerTripped">
  ): void => {
    const facts = runFacts.get(runId);
    toolExecutions.push({
      executionId,
      toolCallId,
      toolName,
      failure: classifyToolOutcome({
        ...outcome,
        runAborted: facts?.stopReason === "aborted",
        runBreakerTripped: facts?.breakerTripped ?? false,
      }),
    });
  };
  for (const { intent, receipt } of reconcile.settled) {
    const settled = settledByToolCall.get(intent.toolCallId);
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: true,
      executed: receipt?.executed ?? false,
      isError: receipt?.isError ?? false,
      ...(settled?.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
      intercepted: false,
    });
  }
  for (const { decision } of reconcile.rejected) {
    pushTool(decision.executionId, decision.toolCallId, decision.toolName, decision.runId, {
      rejected: true,
      hasReceipt: false,
      executed: false,
      isError: false,
      intercepted: false,
    });
  }
  for (const { intent, resolution } of reconcile.resolved) {
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: false,
      executed: false,
      isError: false,
      resolved: resolution.outcome,
      intercepted: false,
    });
  }
  for (const { intent } of reconcile.unknown) {
    const settled = settledByToolCall.get(intent.toolCallId);
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: false,
      executed: false,
      isError: settled?.isError ?? false,
      ...(settled?.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
      intercepted: false,
    });
  }
  const ledgeredToolCalls = new Set<string>();
  for (const intent of reconcile.settled.concat(reconcile.unknown, reconcile.resolved)) {
    ledgeredToolCalls.add(intent.intent.toolCallId);
  }
  for (const { decision } of reconcile.rejected) {
    ledgeredToolCalls.add(decision.toolCallId);
  }
  for (const event of runtimeEvents) {
    if (
      event.kind === "tool.settled" &&
      event.payload.isError &&
      !ledgeredToolCalls.has(event.payload.toolCallId)
    ) {
      pushTool(null, event.payload.toolCallId, event.payload.toolName, event.runId, {
        rejected: false,
        hasReceipt: false,
        executed: false,
        isError: true,
        intercepted: true,
      });
    }
  }
  return { runs, toolExecutions };
}


// 冷启动恢复（M4 S2，D5 对账流程的自动确证环节）：物化 → 对悬账（intent 无 receipt）做
// 哈希三方比对——读目标文件现状：== 预期改后 → 确证 executed；== 改前 → 确证 not-executed
// （模型之后可正常重提，系统永不重新执行，§3.2）；两头都不符（撕裂写/第三方改动）、
// 目标不可读、或 intent 无哈希 → 原样滞留 OutcomeUnknown 留人确认。
// 每次确证写一条 resolution 治理族记录（fsync 耐久 + 按 executionId 幂等），不是静默销账；
// 写盘失败向上抛（启动期一次性动作，响亮失败由调用方裁决）
export interface RecoveryResult {
  // 确证写入后的最终物化态
  materialized: MaterializedSession;
  // 本次新写入的确证记录（按文件顺序）
  resolutions: ResolutionRecord[];
}

export function recoverSession(
  dir: string,
  sessionId: SessionId,
  workspaceRoot: string
): RecoveryResult {
  const log = new JsonlEventLog(dir, sessionId);
  try {
    const before = materializeSession(dir, sessionId);
    const resolutions: ResolutionRecord[] = [];
    for (const entry of before.reconcile.unknown) {
      const hashes = entry.intent.contentHashes;
      if (hashes === undefined) {
        continue;
      }
      let observedHash: string;
      try {
        observedHash = snapshotTag(
          readFileSync(resolveWorkspacePath(workspaceRoot, hashes.path), "utf8")
        );
      } catch {
        continue; // 目标不存在/不可读/越界 → 滞留 unknown
      }
      // 三方比对：先比改后（已执行），再比改前（未执行），都不符不留记录
      const outcome =
        observedHash === hashes.expectedAfterHash
          ? "executed"
          : observedHash === hashes.beforeHash
            ? "not-executed"
            : undefined;
      if (outcome === undefined) {
        continue;
      }
      resolutions.push(
        log.appendResolution({
          executionId: entry.intent.executionId,
          toolCallId: entry.intent.toolCallId,
          toolName: entry.intent.toolName,
          outcome,
          method: "hash-auto",
          evidence: {
            path: hashes.path,
            beforeHash: hashes.beforeHash,
            expectedAfterHash: hashes.expectedAfterHash,
            observedHash,
          },
          at: Date.now(),
          runId: entry.intent.runId,
        })
      );
    }
    // 重新物化：返回的确证后状态与磁盘一致（resolved 配对已生效）
    return { materialized: materializeSession(dir, sessionId), resolutions };
  } finally {
    log.close();
  }
}