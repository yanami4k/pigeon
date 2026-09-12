// Event Log 记录族 schema（ROADMAP §3.5 权威状态源；M4 S1/S2/S5/S6 + 收口）：
// 单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）、entry 族
// （D3 Pi transcript 消息映射）、治理族（intent/decision/receipt，M3 账本归并而来，
// 决策 2 不双写；breaker/resolution）与 grant 族（created/revoked/promoted/config-removed）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 本文件只定义形状与读路径迁移链；存储引擎（JSONL 读写、fsync、幂等索引）在
// persistence/event-log.ts，冷物化与对账在 state/materialize.ts。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  EntryIdSchema,
  ExecutionIdSchema,
  GrantIdSchema,
  type RunId,
  RunIdSchema,
  SessionIdSchema,
} from "./ids.ts";
import { MigrationRegistry } from "./migration.ts";
import { migrateReceiptToCurrent, type Receipt, ReceiptSchema } from "./receipt.ts";
import {
  RunEndedPayloadSchema,
  RuntimeEventKind,
  ToolProposedPayloadSchema,
  ToolSettledPayloadSchema,
  TurnCompletedPayloadSchema,
  TurnStartedPayloadSchema,
} from "./runtime-events.ts";
import { ToolExecutionDecisionSchema } from "./tool-execution.ts";

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

// 观察族：五种归一化运行时事件（payload schema 唯一事实源在 ./runtime-events.ts）
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

// 读路径迁移入口：version 低于当前格式的记录逐级升级并按当前 schema 校验；
// 当前版本的记录直接校验。校验失败原样上抛，由读取方（persistence）定性为日志损坏
export function parseEventRecord(raw: unknown): EventRecord {
  return typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    raw.version !== EVENT_LOG_VERSION
    ? eventLogMigrations.migrate("event-log", raw, EVENT_LOG_VERSION, EventRecordSchema)
    : Value.Parse(EventRecordSchema, raw);
}
