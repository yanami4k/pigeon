// Event Log（ROADMAP §3.5 权威状态源，M4 S1/S2/S5）：每 session 一文件 `.pigeon/sessions/sess_<ulid>.jsonl`
// （D1），单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）、entry 族
// （D3 Pi transcript 消息映射，S5）与治理族（intent/decision/receipt，M3 账本归并而来，
// 决策 2：不双写；S2 新增 breaker/resolution，S5 resolution 增人工确认渠道）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 落盘策略（D2）：事件产生即同步写盘（崩溃窗口为零）；治理族写后 fsync（防断电），
// 观察族（运行时事件 + entry）只写不 fsync（防进程崩溃，延续 M3 现状）。
// 冷物化 = 全量读本 session 文件 + 按 executionId 对账（reconcile），分类语义与 M3 完全一致：
// intent 无 receipt = OutcomeUnknown（只标记留证，§3.2 禁止盲重放）；decision 即闭环（rejected）；
// S2 新增：resolution（哈希自动确证，D5）与悬账配对归 resolved，不再滞留 unknown。
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
  type ToolSettledPayload,
  ToolSettledPayloadSchema,
  TurnCompletedPayloadSchema,
  TurnStartedPayloadSchema,
} from "../pi-runtime/events.ts";
import type { EventEnvelope } from "../state/events.ts";
import {
  asSessionId,
  EntryIdSchema,
  type ExecutionId,
  ExecutionIdSchema,
  GrantIdSchema,
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
// v2（M4 S2）：intent 增 contentHashes、tool.settled 增 errorKind、新增 breaker/resolution 族；
// v3（M4 S5）：新增 entry 族（D3 Pi transcript 消息映射）、resolution 增 human-confirmed
// 人工确认渠道且 evidence 改可选；
// v4（M4 S6）：新增 grant.created / grant.revoked 族（决策 3 Grant 体系）；
// v5（M4 收口决策 ①）：新增 grant.promoted / grant.config-removed 族（固化规则升格/移除留痕）——
// 全部加法式（可缺省/新成员），旧记录经读路径迁移链逐级升级（见 eventLogMigrations）
export const EVENT_LOG_VERSION = 5;

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

// entry（M4 S5，D3 Pi entry 映射）：每条 message_end 事件落地时刻由 Pigeon 分配 EntryId——
// 记录信封的 id 即分配给该条 transcript 消息的 EntryId。权威键是 (runId, runSeq)：
// runSeq = run 内 message_end 累计序号（append-only 双实证保证，spike Q2/Q4）；
// abort 与上游合成失败消息（handleRunFailure）同样占序号，冷物化重放必须计入，
// 否则序号错位。禁忌：timestamp 永不当键（同毫秒撞车实证）；流式阶段（message_start/
export const EntryRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("entry"),
  runSeq: Type.Integer({ minimum: 1 }),
  // 当前 core Agent 只产生 user/assistant/toolResult 三种（spike Q2）；其余四个是
  // 上游 harness 层消息类型（pi-agent-core AgentMessage），一并收进字面量集合：
  // 未来启用 harness Session/compaction 时映射如实记录，不在落盘口径上造假（D3 扩展点）
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("toolResult"),
    Type.Literal("custom"),
    Type.Literal("bashExecution"),
    Type.Literal("branchSummary"),
    Type.Literal("compactionSummary"),
  ]),
});
export type EntryRecord = Static<typeof EntryRecordSchema>;

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

// resolution（M4 S2，D5 哈希自动确证 + S5 人工确认渠道）：悬账（intent 无 receipt）的
// 确证记录。hash-auto：冷启动对账读目标文件现状哈希三方比对——== 预期改后 → executed，
// == 改前 → not-executed，都不符不留记录；human-confirmed（S5 resume 交互）：哈希证据
// 不可得时由用户确认收口——用户确认 = 第三种确证渠道，对齐 ToolExecution Verified 语义。
// 确证只销账，系统永不自动重新执行（§3.2）；按 executionId 幂等（同族重复冲突拒绝）
export const ResolutionRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("resolution"),
  executionId: ExecutionIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  outcome: Type.Union([Type.Literal("executed"), Type.Literal("not-executed")]),
  // 确证渠道：hash-auto = 哈希三方比对自动确证；human-confirmed = resume 交互人工确认
  method: Type.Union([Type.Literal("hash-auto"), Type.Literal("human-confirmed")]),
  // 哈希确证的四方比对证据（路径 + 改前/预期改后/实测现状）；human-confirmed 渠道
  // 没有哈希证据——人的判断即证据，字段缺省
  evidence: Type.Optional(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      beforeHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
      expectedAfterHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
      observedHash: Type.String({ pattern: "^[0-9a-f]{16}$" }),
    })
  ),
  at: Type.Integer({ minimum: 0 }),
});
export type ResolutionRecord = Static<typeof ResolutionRecordSchema>;

// grant 族信封（M4 S6）：version + id + sessionId + 时间戳与全局信封一致，runId 可选——
// grant 是 session 级治理状态（决策 3），不是 run 级证据；创建发生在 Run 内
// （审批提示 [a]/[d]）时带上出处 run，REPL 时段的 /revoke 无活动 Run 则缺省
const GRANT_ENVELOPE_PROPS = {
  version: Type.Literal(EVENT_LOG_VERSION),
  id: EntryIdSchema,
  sessionId: SessionIdSchema,
  runId: Type.Optional(RunIdSchema),
  timestamp: Type.Integer({ minimum: 0 }),
} as const;

// grant.created（M4 S6，决策 3）：会话级放权的持久化留证——审批提示 [a]/[d] 键或
// /grants save 升格动作的出处。firstCall 记录触发创建的那次调用（toolCallId + 模型原始参数），
// /grants 展示与 promotedFrom 出处共用。治理族耐久（fsync），无 executionId 幂等键
// （grantId 自带唯一性；revoke 以新事件表达，不删 created 行——事件日志 append-only）
export const GrantCreatedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("grant.created"),
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  // 决策 3a 目录限定：工作区相对目录（如 src）；缺省 = 工具级（不限路径）
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  createdAt: Type.Integer({ minimum: 0 }),
  firstCall: Type.Object({
    toolCallId: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
});
export type GrantCreatedRecord = Static<typeof GrantCreatedRecordSchema>;

// grant.revoked（M4 S6）：/revoke <id> 的持久化留证——撤销立即生效（运行态删除 + 事件留证）。
// 冷物化以 created − revoked 还原生效 grant 集（决策 3b：崩溃恢复静默继续有效）
export const GrantRevokedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("grant.revoked"),
  grantId: GrantIdSchema,
  revokedAt: Type.Integer({ minimum: 0 }),
});
export type GrantRevokedRecord = Static<typeof GrantRevokedRecordSchema>;

// grant.promoted（M4 收口决策 ①）：/grants save 升格的持久化留证——固化规则的稳定身份是
// promotedFrom.grantId（与本记录 grantId 同值），intent 的 grantRef 回指它而非位置序号
// （位置随 /revoke config#N 前移，身份不随）。扩权动作先留证后写配置（fail-closed 同 grant.created）
export const GrantPromotedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("grant.promoted"),
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  promotedAt: Type.Integer({ minimum: 0 }),
});
export type GrantPromotedRecord = Static<typeof GrantPromotedRecordSchema>;

// grant.config-removed（M4 收口决策 ①）：/revoke config#N 移除固化规则的持久化留证——
// 事后可查"曾有一条规则、后来被撤了"。index 是移除时刻的展示序号，仅供人读对照；
// 身份是 grantId。缩权动作先生效（改配置）后留证：留证失败只留下"少一条痕迹"的缺口，
// 反过来（留证成功配置未改）会让审计者误以为规则已不生效
export const GrantConfigRemovedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("grant.config-removed"),
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  index: Type.Integer({ minimum: 0 }),
  removedAt: Type.Integer({ minimum: 0 }),
});
export type GrantConfigRemovedRecord = Static<typeof GrantConfigRemovedRecordSchema>;

// Event Log 记录并集（M4 S5 新增 entry 族；M4 S6 新增 grant.created / grant.revoked 族；
// M4 收口新增 grant.promoted / grant.config-removed 族）
export const EventRecordSchema = Type.Union([
  RuntimeEventRecordSchema,
  EntryRecordSchema,
  IntentRecordSchema,
  DecisionRecordSchema,
  ReceiptRecordSchema,
  BreakerRecordSchema,
  ResolutionRecordSchema,
  GrantCreatedRecordSchema,
  GrantRevokedRecordSchema,
  GrantPromotedRecordSchema,
  GrantConfigRemovedRecordSchema,
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
export type BreakerInput = Omit<
  BreakerRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
// entry 族追加输入：业务字段（runSeq/role）+ runId；信封 id（= 分配的 EntryId）由日志盖章
export type EntryInput = Omit<EntryRecord, "version" | "id" | "sessionId" | "kind" | "timestamp">;
export type ResolutionInput = Omit<
  ResolutionRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
// grant 族追加输入：业务字段 + runId；信封其余字段由日志盖章
export type GrantCreatedInput = Omit<
  GrantCreatedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type GrantRevokedInput = Omit<
  GrantRevokedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type GrantPromotedInput = Omit<
  GrantPromotedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type GrantConfigRemovedInput = Omit<
  GrantConfigRemovedRecord,
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
// 生效 grant（决策 3b 冷恢复还原面）：grant.created 减去 grant.revoked 的纯派生
export interface ActiveGrant {
  grantId: GrantCreatedRecord["grantId"];
  tool: string;
  pathPrefix?: string;
  createdAt: number;
  firstCall: GrantCreatedRecord["firstCall"];
}
export interface MaterializedSession {
  sessionId: SessionId;
  path: string;
  // 全量记录（按文件顺序）
  records: EventRecord[];
  // 撕裂尾巴标记（D2 可见化）：文件末尾存在未完整落盘的记录残片；
  // 残片不进 records（按未持久化容忍），但视图必须如实标注而非假装证据链完整
  tornTail: boolean;
  runtimeEvents: RuntimeEventRecord[];
  intents: IntentRecord[];
  decisions: DecisionRecord[];
  receipts: Receipt[];
  breakers: BreakerRecord[];
  resolutions: ResolutionRecord[];
  // entry 族（M4 S5，D3）：transcript 消息的 EntryId 映射，按落盘顺序
  entries: EntryRecord[];
  // grant 族（M4 S6，决策 3）：created / revoked 原始记录与生效集（created − revoked，
  // 按 createdAt 排序）——冷恢复的 grant 还原面（决策 3b：静默继续有效，/grants 唯一展示入口）
  grantCreateds: GrantCreatedRecord[];
  grantRevokeds: GrantRevokedRecord[];
  grants: ActiveGrant[];
  // 固化规则升格/移除留痕（M4 收口决策 ①）：配置面动作的原始记录，不参与会话 grant 生效集
  grantPromoteds: GrantPromotedRecord[];
  grantConfigRemoveds: GrantConfigRemovedRecord[];
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
// v2 → v3（M4 S5）：加法式演进（新增 entry 族；resolution 增 human-confirmed 渠道、
// evidence 改可选）——v2 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 2, (doc) => ({ ...doc, version: 3 }));
// v3 → v4（M4 S6）：加法式演进（新增 grant.created / grant.revoked 族）——
// v3 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 3, (doc) => ({ ...doc, version: 4 }));
// v4 → v5（M4 收口决策 ①）：加法式演进（新增 grant.promoted / grant.config-removed 族）——
// v4 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 4, (doc) => ({ ...doc, version: 5 }));

// 全量读 + 校验的结果：记录集 + 撕裂尾巴标记。
// tornTail：进程死于写盘中途的痕迹——追加协议保证每条记录以 \n 结尾，
// 故「文件非空且不以 \n 结尾」或「末行不是合法 JSON」都意味着最后一次写盘未完整落盘；
// 记录本身仍按「未持久化」容忍（不进记录集），该标记供 replay 等视图如实标注（D2 可见化）
export interface EventLogReadResult {
  records: EventRecord[];
  tornTail: boolean;
}

// 全量读 + 校验：进程死于写盘中途会留下半截末行——按"未持久化"容忍（torn tail）；
// 非末行损坏说明日志被外部破坏，响亮失败。
// 读路径迁移（M0 管线）：version 低于当前格式的记录先经 eventLogMigrations 逐级升级再校验
export function readEventLogFileDetailed(path: string): EventLogReadResult {
  if (!existsSync(path)) {
    return { records: [], tornTail: false };
  }
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  let tornTail = content.length > 0 && !content.endsWith("\n");
  const records: EventRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        tornTail = true;
        break; // torn tail：半截末行视为未写入
      }
      throw new EventLogCorruptionError(`事件日志损坏：${path} 第 ${index + 1} 行不是合法 JSON`);
    }
    let record: EventRecord;
    try {
      record =
        typeof raw === "object" &&
        raw !== null &&
        "version" in raw &&
        raw.version !== EVENT_LOG_VERSION
          ? eventLogMigrations.migrate("event-log", raw, EVENT_LOG_VERSION, EventRecordSchema)
          : Value.Parse(EventRecordSchema, raw);
    } catch (error) {
      throw new EventLogCorruptionError(
        `事件日志损坏：${path} 第 ${index + 1} 行校验失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    records.push(record);
  }
  return { records, tornTail };
}

// 只取记录集的既有入口（tornTail 标记的调用方用 readEventLogFileDetailed）
export function readEventLogFile(path: string): EventRecord[] {
  return readEventLogFileDetailed(path).records;
}

// Session 列表 = 列目录（D1：ULID 字典序即时间序）；目录不存在 = 尚无会话（空清单），
// 旧账本退役文件（*.legacy.jsonl，D8）与无关文件不进清单
export function listSessionIds(dir: string): SessionId[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".legacy.jsonl"))
    .sort()
    .map((name) => asSessionId(name.slice(0, -".jsonl".length)));
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

  // D3 entry 映射落盘（M4 S5）：观察族耐久（同步写不 fsync，与运行时事件同级）。
  // 信封 id 即分配给该条 transcript 消息的 EntryId；无 executionId，不进治理幂等索引
  appendEntry(input: EntryInput): EntryRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(EntryRecordSchema, {
      ...this.#envelope(runId),
      kind: "entry",
      ...body,
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

  // grant.created 落盘（M4 S6，决策 3）：治理族耐久（fsync），无 executionId 幂等键
  appendGrantCreated(input: GrantCreatedInput): GrantCreatedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantCreatedRecordSchema, {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: Date.now(),
      kind: "grant.created",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.revoked 落盘（M4 S6）：治理族耐久（fsync）；撤销以新事件表达，append-only 不删 created 行
  appendGrantRevoked(input: GrantRevokedInput): GrantRevokedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantRevokedRecordSchema, {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: Date.now(),
      kind: "grant.revoked",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.promoted 落盘（M4 收口决策 ①）：治理族耐久（fsync）；/grants save 先落本记录再写配置
  appendGrantPromoted(input: GrantPromotedInput): GrantPromotedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantPromotedRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "grant.promoted",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.config-removed 落盘（M4 收口决策 ①）：治理族耐久（fsync）；/revoke config#N 先改配置再落本记录
  appendGrantConfigRemoved(input: GrantConfigRemovedInput): GrantConfigRemovedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantConfigRemovedRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "grant.config-removed",
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

  // grant 族信封：runId 可选（REPL 时段的配置面动作无活动 Run）
  #grantEnvelope(runId: RunId | undefined) {
    return {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
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
  const { records, tornTail } = readEventLogFileDetailed(path);
  const runtimeEvents: RuntimeEventRecord[] = [];
  const intents: IntentRecord[] = [];
  const decisions: DecisionRecord[] = [];
  const receipts: Receipt[] = [];
  const breakers: BreakerRecord[] = [];
  const resolutions: ResolutionRecord[] = [];
  const entries: EntryRecord[] = [];
  const grantCreateds: GrantCreatedRecord[] = [];
  const grantRevokeds: GrantRevokedRecord[] = [];
  const grantPromoteds: GrantPromotedRecord[] = [];
  const grantConfigRemoveds: GrantConfigRemovedRecord[] = [];
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
    } else if (record.kind === "entry") {
      entries.push(record);
    } else if (record.kind === "grant.created") {
      grantCreateds.push(record);
    } else if (record.kind === "grant.revoked") {
      grantRevokeds.push(record);
    } else if (record.kind === "grant.promoted") {
      grantPromoteds.push(record);
    } else if (record.kind === "grant.config-removed") {
      grantConfigRemoveds.push(record);
    } else {
      runtimeEvents.push(record);
    }
  }
  const reconcile = reconcileRecords(intents, decisions, receipts, resolutions);
  return {
    sessionId,
    path,
    records,
    tornTail,
    runtimeEvents,
    intents,
    decisions,
    receipts,
    breakers,
    resolutions,
    entries,
    grantCreateds,
    grantRevokeds,
    grants: activeGrants(grantCreateds, grantRevokeds),
    grantPromoteds,
    grantConfigRemoveds,
    reconcile,
    classification: classifySessionRecords(records, runtimeEvents, breakers, reconcile),
  };
}

// 生效 grant 还原（决策 3b）：created 减去 revoked——revoked 集合内的 grantId 全部失效；
// 其余按 createdAt 排序原样生效（grant 对象自创建后不可变，无部分撤销）
function activeGrants(
  createds: GrantCreatedRecord[],
  revokeds: GrantRevokedRecord[]
): ActiveGrant[] {
  const revokedIds = new Set(revokeds.map((record) => record.grantId));
  return createds
    .filter((record) => !revokedIds.has(record.grantId))
    .map((record) => ({
      grantId: record.grantId,
      tool: record.tool,
      ...(record.pathPrefix !== undefined ? { pathPrefix: record.pathPrefix } : {}),
      createdAt: record.createdAt,
      firstCall: record.firstCall,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
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
  // grant 族 runId 可选（REPL 时段的放权/撤销无活动 Run）——无 runId 的记录不进
  // 任何 Run 的事实表（grant 是 session 级状态，由 /grants 展示，决策 3b）
  for (const record of records) {
    if (record.runId !== undefined) {
      runFactsOf(record.runId);
    }
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
