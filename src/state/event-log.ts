// Event Log 记录族 schema（ROADMAP §3.5 权威状态源；M4 S1/S2/S5/S6 + 收口）：
// 单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）、entry 族
// （D3 Pi transcript 消息映射）、治理族（intent/decision/receipt，M3 账本归并而来，
// 决策 2 不双写；breaker/resolution）与 grant 族（created/revoked/promoted/config-removed）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 本文件只定义形状与读路径迁移链；存储引擎（JSONL 读写、fsync、幂等索引）在
// persistence/event-log.ts，冷物化与对账在 state/materialize.ts。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { AttemptBudgetSchema, VerifyConfigSchema } from "./attempt-config.ts";
import {
  CandidateKindSchema,
  migrateCandidateToCurrent,
  OutcomeLabelSchema,
  ReviewerCandidateSchema,
  ScanHitSchema,
} from "./candidate.ts";
import {
  EntryIdSchema,
  ExecutionIdSchema,
  GrantIdSchema,
  ReceiptIdSchema,
  type RunId,
  RunIdSchema,
  SessionIdSchema,
} from "./ids.ts";
import { type ContentSourceMessage, Sha256HexSchema } from "./message-content.ts";
import { MigrationRegistry } from "./migration.ts";
import { migrateReceiptToCurrent, type Receipt, ReceiptSchema } from "./receipt.ts";
import {
  EvalVerdictSchema,
  EvalVerifiedPayloadSchema,
  LlmRequestPayloadSchema,
  ObservationKind,
  ReviewSkippedPayloadSchema,
  ReviewUnparsablePayloadSchema,
  RunEndedPayloadSchema,
  RunLimitHitPayloadSchema,
  RunStartedPayloadSchema,
  RuntimeEventKind,
  SkillLoadedPayloadSchema,
  ToolProposedPayloadSchema,
  ToolSettledPayloadSchema,
  TurnCompletedPayloadSchema,
  TurnStartedPayloadSchema,
  WorkspaceCheckpointPayloadSchema,
} from "./runtime-events.ts";
import { ToolExecutionDecisionSchema } from "./tool-execution.ts";

// Event Log 记录格式版本；迁移管线（M0 migration.ts）按 version 字段路由。
// v2（M4 S2）：intent 增 contentHashes、tool.settled 增 errorKind、新增 breaker/resolution 族；
// v3（M4 S5）：新增 entry 族（D3 Pi transcript 消息映射）、resolution 增 human-confirmed
// 人工确认渠道且 evidence 改可选；
// v4（M4 S6）：新增 grant.created / grant.revoked 族（决策 3 Grant 体系）；
// v5（M4 收口决策 ①）：新增 grant.promoted / grant.config-removed 族（固化规则升格/移除留痕）；
// v6（M5，决策 037 / 043 / 044 一次升）：entry 增 contentHash（旁置内容文件回指）、
// turn.completed 增 usage、新增 run.started / llm.request / skill.loaded 观察族——
// 全部加法式（可缺省/新成员），旧记录经读路径迁移链逐级升级（见 eventLogMigrations）；
// v7（M5.5 S2，决策 040）：新增 session.header / child.spawned / child.settled 三族（worker 编排）；
// v8（M5.7 S3，决策 053）：receipt 载荷升 v5（加 mcp 块），读路径把内嵌 receipt 经其迁移链升到当前版本；
// v9（M6.5 S3，决策 058）：新增 eval.verified 观察族（加法式）；
// v10（M6，决策 064 / 065）：工作区联合新增"无工作区"成员、child.settled 的结果放宽（无工作区无分支与
// 改动文件）并可携带结构化内容、worker 上限加可选 token 项与 token-limit 收尾状态、新增 review.skipped 观察族、
// 新增候选提出与候选筛查两族（加法式）；
// v11（M7，决策 069 / 071 / 072 / 075 / 077 / 078）：child.spawned 加可选共享任务标识，新增通用验证、分叉、分支会话头、
// 提炼跳过四族与工作区快照、撞上限、树写穿失败三个观察族，候选提出内嵌的候选升 v3（加法式）；
// v12（M8，决策 081 / 082 / 087 / 089）：新增候选验证回执、候选决定、候选激活三族，worker 角色加 verifier，
// git 工作树工作区加可选起点提交 baseCommit，run.started 载荷加可选预算块、验证命令加来源字段——
// 全部加法式（新成员 / 可缺省字段），v11 旧记录逐字有效
export const EVENT_LOG_VERSION = 12;

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

// 观察族（M5，决策 043 / 044）：Pigeon 自有观察记录，payload schema 唯一事实源在 ./runtime-events.ts
export const RunStartedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.RunStarted),
  payload: RunStartedPayloadSchema,
});
export type RunStartedRecord = Static<typeof RunStartedRecordSchema>;
export const LlmRequestRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.LlmRequest),
  payload: LlmRequestPayloadSchema,
});
export type LlmRequestRecord = Static<typeof LlmRequestRecordSchema>;
export const SkillLoadedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.SkillLoaded),
  payload: SkillLoadedPayloadSchema,
});
export type SkillLoadedRecord = Static<typeof SkillLoadedRecordSchema>;
// M6.5 S3（决策 058）：Eval 验证器判决，落在该次运行的会话文件里
export const EvalVerifiedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.EvalVerified),
  payload: EvalVerifiedPayloadSchema,
});
export type EvalVerifiedRecord = Static<typeof EvalVerifiedRecordSchema>;
// M6（决策 064 子裁决 ①）：后台审阅因上一次未收尾而跳过本次触发，落在被审主会话的会话文件里
export const ReviewSkippedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.ReviewSkipped),
  payload: ReviewSkippedPayloadSchema,
});
export type ReviewSkippedRecord = Static<typeof ReviewSkippedRecordSchema>;
// M6（决策 065）：Reviewer 收尾结果不可解析
export const ReviewUnparsableRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.ReviewUnparsable),
  payload: ReviewUnparsablePayloadSchema,
});
export type ReviewUnparsableRecord = Static<typeof ReviewUnparsableRecordSchema>;
// M7（决策 078）：工作区快照与条目号的对应
export const WorkspaceCheckpointRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.WorkspaceCheckpoint),
  payload: WorkspaceCheckpointPayloadSchema,
});
export type WorkspaceCheckpointRecord = Static<typeof WorkspaceCheckpointRecordSchema>;
// M7（决策 072）：本 Run 因上限被中止
export const RunLimitHitRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal(ObservationKind.RunLimitHit),
  payload: RunLimitHitPayloadSchema,
});
export type RunLimitHitRecord = Static<typeof RunLimitHitRecordSchema>;

export const ObservationRecordSchema = Type.Union([
  RunStartedRecordSchema,
  LlmRequestRecordSchema,
  SkillLoadedRecordSchema,
  EvalVerifiedRecordSchema,
  ReviewSkippedRecordSchema,
  ReviewUnparsableRecordSchema,
  WorkspaceCheckpointRecordSchema,
  RunLimitHitRecordSchema,
]);
export type ObservationRecord = Static<typeof ObservationRecordSchema>;

// 观察族追加输入：kind + 对应 payload + runId；信封其余字段由日志盖章
export type ObservationInput = {
  [K in ObservationRecord["kind"]]: {
    kind: K;
    payload: Extract<ObservationRecord, { kind: K }>["payload"];
    runId: RunId;
  };
}[ObservationRecord["kind"]];

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
  // M5 S1（决策 037）：旁置内容文件里该条消息内容块的规范序列化 sha256。缺省 = M5 前会话
  // （无正文）；存在而内容文件无对应记录或重算不符 = 冷侧派生的正文缺口
  contentHash: Type.Optional(Sha256HexSchema),
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
  // M5.5 S5（决策 048）：exec 档精确命令串——只放行这条一模一样的命令（加法式字段）
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
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
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
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
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
  index: Type.Integer({ minimum: 0 }),
  removedAt: Type.Integer({ minimum: 0 }),
});
export type GrantConfigRemovedRecord = Static<typeof GrantConfigRemovedRecordSchema>;

// M5.5 S2（决策 040）：worker 编排三族。worker 会话首条记 session.header（父会话、父 Run、角色、
// 工作树）；父会话记 child.spawned（派出意图，先于建工作树落盘）与 child.settled（结构化结果）。
// 任何文件只有一个写入者：父会话文件只由父运行面写，worker 会话文件只由该 worker 写。
// 三族均治理族耐久（fsync），无 executionId 幂等键；信封同 grant 族（runId 可选——人以 /spawn
// 派出时父会话无活动 Run）
// M8（决策 082）：新增验证器角色——在独立工作树中重执行被验证那次尝试；
// 它的命令档工具只在固化命令规则内放行（083）
export const WorkerRoleSchema = Type.Union([
  Type.Literal("reviewer"),
  Type.Literal("explorer"),
  Type.Literal("implementer"),
  Type.Literal("tester"),
  // M7（决策 074）：提炼器——只读、无工作区，作用域绑定一组尝试
  Type.Literal("distiller"),
  Type.Literal("verifier"),
]);
export type WorkerRole = Static<typeof WorkerRoleSchema>;

// 隔离工作区：git 工作树（M5.5）与"无工作区"（M6，决策 064）——Reviewer 只读、不开工作树。
// 加法式联合，054 的形状封顶口径不变：git-worktree 成员逐字不动，旧记录读取不变
// M8（决策 082）：加可选起点提交——回放必须回到"任务开始处"，工作树的起点提交是它唯一精确的记法。
// v11 之前的派出记录没有该字段，回放回退到分支尖端并在回执里如实标注
export const GitWorktreeWorkspaceSchema = Type.Object({
  kind: Type.Literal("git-worktree"),
  baseCommit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" })),
  path: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
});
export const NoWorkspaceSchema = Type.Object({ kind: Type.Literal("none") });
export const WorkerWorkspaceSchema = Type.Union([GitWorktreeWorkspaceSchema, NoWorkspaceSchema]);
export type WorkerWorkspace = Static<typeof WorkerWorkspaceSchema>;
export type GitWorktreeWorkspace = Static<typeof GitWorktreeWorkspaceSchema>;

// 类型谓词：只有 git 工作树形状才有路径与分支（无工作区的 worker 两者皆无）
export function isGitWorktreeWorkspace(
  workspace: WorkerWorkspace
): workspace is GitWorktreeWorkspace {
  return workspace.kind === "git-worktree";
}

// 委派策略摘要：与 InjectionSnapshot.tools.policy 同形（state 是叶子层，不引 tools 的 schema）
export const DelegatedPolicySchema = Type.Object({
  allow: Type.Array(Type.String({ minLength: 1 })),
  deny: Type.Array(Type.String({ minLength: 1 })),
  approvalMode: Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]),
});
export type DelegatedPolicy = Static<typeof DelegatedPolicySchema>;

// 轮次与墙钟两个上限；M6（决策 064 子裁决 ④）加可选的累计 token 上限（Reviewer 专设预算用，缺省不限）
export const WorkerLimitsSchema = Type.Object({
  maxTurns: Type.Integer({ minimum: 1 }),
  wallClockMs: Type.Integer({ minimum: 1 }),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type WorkerLimits = Static<typeof WorkerLimitsSchema>;

export const ChildSettledStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("cancelled"),
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  // M6（决策 064 子裁决 ④）：累计 token 达到上限而中止
  Type.Literal("token-limit"),
  // 派出失败（工作树或运行面建不起来）：spawned 已落盘，以 settled 收口保证两族配对
  Type.Literal("spawn-failed"),
]);
export type ChildSettledStatus = Static<typeof ChildSettledStatusSchema>;

// worker 结构化结果：分支、改动文件清单（工作树内相对路径）、receipt 列表、自述摘要。
// M6（决策 064）：无工作区的 worker（Reviewer）没有分支与改动文件，两项改可缺省；
// structured 承载模型交回的结构化内容（候选由 Controller 据此落盘，模型侧只产出结论）
export const ChildResultSchema = Type.Object({
  branch: Type.Optional(Type.String({ minLength: 1 })),
  changedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  receiptIds: Type.Array(ReceiptIdSchema),
  summary: Type.String(),
  summaryTruncated: Type.Boolean(),
  structured: Type.Optional(Type.Unknown()),
});
export type ChildResult = Static<typeof ChildResultSchema>;

export const SessionHeaderRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("session.header"),
  parentSessionId: SessionIdSchema,
  parentRunId: Type.Optional(RunIdSchema),
  worker: Type.Object({ name: Type.String({ minLength: 1 }), role: WorkerRoleSchema }),
  workspace: WorkerWorkspaceSchema,
  startedAt: Type.Integer({ minimum: 0 }),
});
export type SessionHeaderRecord = Static<typeof SessionHeaderRecordSchema>;

export const ChildSpawnedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("child.spawned"),
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  role: WorkerRoleSchema,
  task: Type.String({ minLength: 1 }),
  // M7（决策 069）：并行派发同一任务的多个 worker 共享的任务标识（同任务认定只按显式标识）；单派缺省
  taskKey: Type.Optional(Type.String({ minLength: 1 })),
  policy: DelegatedPolicySchema,
  limits: WorkerLimitsSchema,
  workspace: WorkerWorkspaceSchema,
  spawnedAt: Type.Integer({ minimum: 0 }),
});
export type ChildSpawnedRecord = Static<typeof ChildSpawnedRecordSchema>;

export const ChildSettledRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("child.settled"),
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  status: ChildSettledStatusSchema,
  // 失败、派出失败时的人读原因
  error: Type.Optional(Type.String()),
  // 派出失败时缺省（没有可回收的工作）
  result: Type.Optional(ChildResultSchema),
  // 完成的模型轮次数
  turns: Type.Integer({ minimum: 0 }),
  settledAt: Type.Integer({ minimum: 0 }),
});
export type ChildSettledRecord = Static<typeof ChildSettledRecordSchema>;

// 候选提出（M6，决策 065）：Controller 从 Reviewer 收尾结果落盘候选后写入被审主会话的会话文件——
// 不可变元数据全文（种类、名字、哈希、来源、摘要、判断强度、扫描结果、取代关系）加审阅所用模型与用量。
// runId 是被审的那一次 Run；候选状态由本族与筛查族现算，不写进候选目录
export const CandidateProposedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("candidate.proposed"),
  candidate: ReviewerCandidateSchema,
  model: Type.Object({
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
  }),
  usage: Type.Optional(
    Type.Object({
      turns: Type.Integer({ minimum: 0 }),
      totalTokens: Type.Integer({ minimum: 0 }),
    })
  ),
});
export type CandidateProposedRecord = Static<typeof CandidateProposedRecordSchema>;

// 候选筛查（M6，决策 065）：确定性扫描器版本与命中项；模型筛查只作建议标注（不参与判决）
export const CandidateScreenedRecordSchema = Type.Object({
  ...ENVELOPE_PROPS,
  kind: Type.Literal("candidate.screened"),
  candidateKind: CandidateKindSchema,
  name: Type.String({ minLength: 1 }),
  contentHash: Sha256HexSchema,
  scannerVersion: Type.String({ minLength: 1 }),
  hits: Type.Array(ScanHitSchema),
  modelNote: Type.Optional(Type.String()),
});
export type CandidateScreenedRecord = Static<typeof CandidateScreenedRecordSchema>;

// 通用验证记录（M7，决策 071）：尝试收尾后由程序作为独立子进程在该尝试的工作区执行配置的验证命令，模型看不到；
// 三值口径同 058。落在哪个会话文件由写入方的单写者约束决定（worker 尝试落父会话，普通会话落自身），
// target 指明对应的会话与 Run；信封 Run 可缺省（父会话无活动 Run 时）。观察族耐久（同步写不 fsync）
export const AttemptVerifiedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("attempt.verified"),
  target: Type.Object({ sessionId: SessionIdSchema, runId: RunIdSchema }),
  // 实际执行的参数数组
  command: Type.Array(Type.String()),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  timedOut: Type.Boolean(),
  // 验证命令自身故障（拉不起进程、工作区不存在）
  error: Type.Optional(Type.String()),
  durationMs: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  outputHash: Sha256HexSchema,
  output: Type.String(),
  truncated: Type.Boolean(),
  // 执行验证的工作区（尝试所在的工作树或工作区根）
  workspace: Type.String({ minLength: 1 }),
  verdict: EvalVerdictSchema,
  verifiedAt: Type.Integer({ minimum: 0 }),
});
export type AttemptVerifiedRecord = Static<typeof AttemptVerifiedRecordSchema>;

// 分叉点：来源会话里某次 Run 的条目号（含该条，之后的消息不进分支）
export const ForkPointSchema = Type.Object({
  runId: RunIdSchema,
  runSeq: Type.Integer({ minimum: 1 }),
});
export type ForkPoint = Static<typeof ForkPointSchema>;

// 分叉点快照引用：分叉点之前最近的快照提交与其 ref
export const CheckpointRefSchema = Type.Object({
  ref: Type.String({ minLength: 1 }),
  commit: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }),
});
export type CheckpointRef = Static<typeof CheckpointRefSchema>;

export const ForkTriggerSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("retry-on-fail"),
]);
export type ForkTrigger = Static<typeof ForkTriggerSchema>;

// 分叉记录（M7，决策 077）：写进来源会话文件，先于建树与分支续跑落盘——会话树的权威来源。
// 新分支标识即分支会话号（分支作为新的 Pigeon 会话续跑）。治理族耐久（fsync）
export const SessionForkedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("session.forked"),
  forkPoint: ForkPointSchema,
  branchSessionId: SessionIdSchema,
  checkpoint: CheckpointRefSchema,
  trigger: ForkTriggerSchema,
  forkedAt: Type.Integer({ minimum: 0 }),
});
export type SessionForkedRecord = Static<typeof SessionForkedRecordSchema>;

// 分支会话头（M7，决策 077 / 079）：分支会话文件的首条记录，指向来源会话与分叉点；分支恒在独立工作树里续跑。
// 与 worker 会话头分开：分支不是委派，没有父子角色与委派策略
export const BranchHeaderRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("branch.header"),
  sourceSessionId: SessionIdSchema,
  forkPoint: ForkPointSchema,
  checkpoint: CheckpointRefSchema,
  workspace: GitWorktreeWorkspaceSchema,
  trigger: ForkTriggerSchema,
  startedAt: Type.Integer({ minimum: 0 }),
});
export type BranchHeaderRecord = Static<typeof BranchHeaderRecordSchema>;

// 提炼跳过（M7，决策 074 未裁细节的保守缺省）：一组尝试不满足自动提炼条件（全成功、全失败、成败两侧凑不齐）时留痕；
// 写进触发提炼的会话文件（并行派发的父会话、分叉的来源会话）。观察族耐久
export const DistillSkippedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("distill.skipped"),
  taskKey: Type.Optional(Type.String({ minLength: 1 })),
  reason: Type.Union([
    Type.Literal("all-passed"),
    Type.Literal("all-failed"),
    Type.Literal("no-contrast"),
  ]),
  attempts: Type.Array(
    Type.Object({ sessionId: SessionIdSchema, runId: RunIdSchema, label: OutcomeLabelSchema })
  ),
});
export type DistillSkippedRecord = Static<typeof DistillSkippedRecordSchema>;

// ── M8：候选验证、决定与激活三族（决策 089） ──────────────────────────────────────────
// 三族都写进候选的来源会话文件（与候选提出、候选筛查同一个文件，单写者约束不变），信封 Run 可缺省
// （审批发生在任何 Run 之外）。候选状态仍由账本现算，不写进候选目录（§3.5 一个权威状态源）。

// 回放的四组（决策 084）：失败侧与成功侧各跑带经验与不带经验两组，固定 N 全跑不中途停。
// 正回放看失败侧带经验是否变好，负回放看成功侧带经验是否变差
export const RerunArmSchema = Type.Union([
  Type.Literal("failed-baseline"),
  Type.Literal("failed-with"),
  Type.Literal("successful-baseline"),
  Type.Literal("successful-with"),
]);
export type RerunArm = Static<typeof RerunArmSchema>;

// 单次回放运行：会话号（决策 091 要求记全各次运行的会话号）、落在哪个治理根、三值判决与过程指标。
// 运行本身没跑起来（开工作树失败、装配失败）时判决为 undetermined 并带 error
export const RerunRunSchema = Type.Object(
  {
    arm: RerunArmSchema,
    index: Type.Integer({ minimum: 1 }),
    sessionId: SessionIdSchema,
    // 该次回放的临时治理根（经验按正常格式放在其 .pigeon 下，与真激活同一条装载路径）
    governanceRoot: Type.String({ minLength: 1 }),
    verdict: EvalVerdictSchema,
    status: Type.String({ minLength: 1 }),
    turns: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    durationMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type RerunRun = Static<typeof RerunRunSchema>;

// 一组的统计（决策 084）：pass@k 与 pass^k 分开算并按 k 逐项列出；Wilson 区间算出来进回执但不参与判定
export const RerunArmStatsSchema = Type.Object(
  {
    arm: RerunArmSchema,
    runs: Type.Integer({ minimum: 0 }),
    passes: Type.Integer({ minimum: 0 }),
    passRate: Type.Number({ minimum: 0, maximum: 1 }),
    // 下标 k-1 对应 k = 1..runs
    passAtK: Type.Array(Type.Number({ minimum: 0, maximum: 1 })),
    passPowK: Type.Array(Type.Number({ minimum: 0, maximum: 1 })),
    wilson: Type.Object(
      {
        low: Type.Number({ minimum: 0, maximum: 1 }),
        high: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type RerunArmStats = Static<typeof RerunArmStatsSchema>;

// 装载进回放的一条经验（决策 091）：经验集合内容哈希由这些条目算出，是批准失效四项判据之一
export const LoadedExperienceSchema = Type.Object(
  {
    kind: CandidateKindSchema,
    name: Type.String({ minLength: 1 }),
    contentHash: Sha256HexSchema,
    bytes: Type.Integer({ minimum: 0 }),
    // 本次被验证的候选自身（带经验两组里恰有一条为真）
    candidate: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type LoadedExperience = Static<typeof LoadedExperienceSchema>;

// 验证环境摘要（决策 091）：记全——模型标识与版本、harness 提交号、Node 与平台、预算参数、验证命令、
// 同时装载的经验集合内容哈希与明细。批准失效只看封闭四项清单：模型标识、经验集合内容哈希、预算参数、
// 验证命令（判据实现在 replay/environment.ts）；清单外的项（Node、平台、harness 提交号、超时）只记录不判定。
export const VerificationEnvironmentSchema = Type.Object(
  {
    model: Type.Object(
      {
        provider: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        thinkingLevel: Type.Optional(Type.String({ minLength: 1 })),
        maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false }
    ),
    // Pigeon 仓库 HEAD 短号与是否有未提交改动（与 Eval 结果行同一口径，决策 061）
    harness: Type.Object(
      { commit: Type.String({ minLength: 1 }), dirty: Type.Boolean() },
      { additionalProperties: false }
    ),
    runtime: Type.Object(
      { node: Type.String({ minLength: 1 }), platform: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    budget: AttemptBudgetSchema,
    verify: VerifyConfigSchema,
    experienceSetHash: Sha256HexSchema,
    experiences: Type.Array(LoadedExperienceSchema),
  },
  { additionalProperties: false }
);
export type VerificationEnvironment = Static<typeof VerificationEnvironmentSchema>;

// 三值结论（决策 084）：通过 / 未测出 / 回归。回归一律不可批准（092）
export const VerificationConclusionSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("inconclusive"),
  Type.Literal("regressed"),
]);
export type VerificationConclusion = Static<typeof VerificationConclusionSchema>;

// 验证回执（决策 089 第一族）：一次 pigeon verify 的完整结论与证据。治理族耐久（fsync）——
// 批准与激活以它为前提，写不进就当作没验过
export const CandidateVerifiedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("candidate.verified"),
  candidateKind: CandidateKindSchema,
  name: Type.String({ minLength: 1 }),
  contentHash: Sha256HexSchema,
  conclusion: VerificationConclusionSchema,
  // 每组固定跑几次（决策 084：缺省 5，可配，低于 3 直接拒绝）
  n: Type.Integer({ minimum: 3 }),
  // 大效应门槛：正回放通过率提升达到它才算通过，成功侧下降达到它即回归
  effectThreshold: Type.Number({ minimum: 0, maximum: 1 }),
  // 失败侧与成功侧的"带经验减不带经验"通过率差
  positiveDelta: Type.Number({ minimum: -1, maximum: 1 }),
  negativeDelta: Type.Number({ minimum: -1, maximum: 1 }),
  arms: Type.Array(RerunArmStatsSchema),
  runs: Type.Array(RerunRunSchema),
  environment: VerificationEnvironmentSchema,
  verifiedAt: Type.Integer({ minimum: 0 }),
});
export type CandidateVerifiedRecord = Static<typeof CandidateVerifiedRecordSchema>;

// 决定的动作（决策 089 第二族）：批准、拒绝、撤销、取代合成一族，用动作字段区分
export const CandidateDecisionActionSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("reject"),
  Type.Literal("revoke"),
  Type.Literal("supersede"),
]);
export type CandidateDecisionAction = Static<typeof CandidateDecisionActionSchema>;

// 理由来源（同决策 066）：人写 / 系统默认——单按拒绝会让账本充满默认文案，来源字段让事后能分开看
export const DecisionReasonSourceSchema = Type.Union([
  Type.Literal("human"),
  Type.Literal("system-default"),
]);
export type DecisionReasonSource = Static<typeof DecisionReasonSourceSchema>;

// 候选决定（决策 089 第二族）：治理族耐久（fsync）。
// 未测出的候选可由人显式批准，此时理由必填且来源必须是人写（决策 092，判据在 application 层）
export const CandidateDecidedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("candidate.decided"),
  candidateKind: CandidateKindSchema,
  name: Type.String({ minLength: 1 }),
  contentHash: Sha256HexSchema,
  action: CandidateDecisionActionSchema,
  reason: Type.String(),
  reasonSource: DecisionReasonSourceSchema,
  // 取代：接替它的新候选哈希（与 065 的候选取代同构）
  supersededBy: Type.Optional(Sha256HexSchema),
  // 批准所依据的验证回执；从未验证过就批准时缺省
  verification: Type.Optional(
    Type.Object(
      { recordId: EntryIdSchema, conclusion: VerificationConclusionSchema },
      { additionalProperties: false }
    )
  ),
  decidedAt: Type.Integer({ minimum: 0 }),
});
export type CandidateDecidedRecord = Static<typeof CandidateDecidedRecordSchema>;

// 候选激活（决策 089 第三族 / 093）：按种类复制到治理根的正常目录后落盘。治理族耐久（fsync）。
// activatedHash 是写盘后重算的落点内容哈希——"批准内容与最终激活内容摘要一致"由它与 contentHash 相等钉死；
// 启动时再拿它与落点现状比对，不一致即标注"已脱离批准版本"，不阻止使用（093：人仍可直接编辑）
export const CandidateActivatedRecordSchema = Type.Object({
  ...GRANT_ENVELOPE_PROPS,
  kind: Type.Literal("candidate.activated"),
  candidateKind: CandidateKindSchema,
  name: Type.String({ minLength: 1 }),
  contentHash: Sha256HexSchema,
  // 落点（治理根相对路径，正斜杠）
  path: Type.String({ minLength: 1 }),
  activatedHash: Sha256HexSchema,
  // 未经回放证实（决策 092）：结论为未测出时由人显式批准激活，此处标记为真
  unverified: Type.Boolean(),
  decisionId: EntryIdSchema,
  activatedAt: Type.Integer({ minimum: 0 }),
});
export type CandidateActivatedRecord = Static<typeof CandidateActivatedRecordSchema>;

// Event Log 记录并集（M4 S5 新增 entry 族；M4 S6 新增 grant.created / grant.revoked 族；
// M4 收口新增 grant.promoted / grant.config-removed 族）
export const EventRecordSchema = Type.Union([
  RuntimeEventRecordSchema,
  ObservationRecordSchema,
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
  SessionHeaderRecordSchema,
  ChildSpawnedRecordSchema,
  ChildSettledRecordSchema,
  CandidateProposedRecordSchema,
  CandidateScreenedRecordSchema,
  CandidateVerifiedRecordSchema,
  CandidateDecidedRecordSchema,
  CandidateActivatedRecordSchema,
  AttemptVerifiedRecordSchema,
  SessionForkedRecordSchema,
  BranchHeaderRecordSchema,
  DistillSkippedRecordSchema,
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
// M5 S1（决策 037）：appendEntry 的入参——message 是 message_end 时刻消息的深拷贝，由日志决定
// 落盘位置（旁置内容文件）并据此盖 contentHash；调用方不自报哈希
export type EntryAppendInput = Omit<EntryInput, "contentHash"> & { message?: ContentSourceMessage };
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
// worker 编排三族追加输入（M5.5 S2）
export type SessionHeaderInput = Omit<
  SessionHeaderRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type ChildSpawnedInput = Omit<
  ChildSpawnedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type ChildSettledInput = Omit<
  ChildSettledRecord,
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
// v5 → v6（M5）：加法式演进（entry 增 contentHash、turn.completed 增 usage、新增三个观察族）——
// v5 旧记录逐字有效，纯版本推进；无 contentHash 的 entry 即"M5 前会话，无正文"
eventLogMigrations.register("event-log", 5, (doc) => ({ ...doc, version: 6 }));
// v6 → v7（M5.5 S2）：加法式演进（新增 worker 编排三族）——v6 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 6, (doc) => ({ ...doc, version: 7 }));
// v7 → v8（M5.7 S3，决策 053）：receipt 载荷升 v5。迁移链只在末尾按当前 schema 校验一次，内嵌 receipt 必须在链上
// 显式升级——更早各版本的记录都经过这一步（同时补上 v6 → v7 未升级内嵌 receipt、v6 会话文件读回即报损坏的缺口）
eventLogMigrations.register("event-log", 7, (doc) => ({
  ...doc,
  version: 8,
  ...(doc.kind === "receipt" ? { receipt: migrateReceiptToCurrent(doc.receipt) } : {}),
}));

// v8 → v9（M6.5 S3，决策 058）：加法式演进（新增 eval.verified 观察族）——v8 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 8, (doc) => ({ ...doc, version: 9 }));

// v9 → v10（M6，决策 064 / 065）：加法式演进（工作区联合加"无工作区"、child.settled 结果放宽并可带结构化内容、
// 新增候选两族）——v9 旧记录逐字有效（git-worktree 工作区与带分支的结果仍通过当前 schema），纯版本推进
eventLogMigrations.register("event-log", 9, (doc) => ({ ...doc, version: 10 }));

// v10 → v11（M7）：加法式演进（派出记录可选任务标识、新增四族与两个观察族）；候选提出内嵌的 v2 候选经候选迁移链升 v3——
// 迁移链只在末尾按当前 schema 校验一次，内嵌候选必须在链上显式升级（同 v7 → v8 的内嵌 receipt）。
// 另按 065 修订改写结构化结果不可解析记录里记产出会话的字段名（v10 记的 reviewSessionId 原样搬到 producerSessionId，
// 值不变）——该族是 M6 已入库的形状，旧记录必须真的改写，不能只改 schema
eventLogMigrations.register("event-log", 10, (doc) => ({
  ...doc,
  version: 11,
  ...(doc.kind === "candidate.proposed"
    ? { candidate: migrateCandidateToCurrent(doc.candidate) }
    : {}),
  ...(doc.kind === "review.unparsable" ? { payload: renameProducerField(doc.payload) } : {}),
}));

// v11 → v12（M8）：加法式演进（新增候选三族、角色加 verifier、工作区加可选起点提交、
// run.started 载荷加可选预算块与验证命令来源）——v11 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 11, (doc) => ({ ...doc, version: 12 }));

// 不可解析记录的 payload：旧名在场即搬到新名，其余字段原样；已是新名的原样返回
function renameProducerField(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("reviewSessionId" in payload)) {
    return payload;
  }
  const { reviewSessionId, ...rest } = payload as Record<string, unknown>;
  return { ...rest, producerSessionId: reviewSessionId };
}

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

// 候选两族追加输入（M6）：业务字段 + runId；信封其余字段由日志盖章
export type CandidateProposedInput = Omit<
  CandidateProposedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type CandidateScreenedInput = Omit<
  CandidateScreenedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;

// M7 四族追加输入：业务字段 + 可选 runId；信封其余字段由日志盖章
export type AttemptVerifiedInput = Omit<
  AttemptVerifiedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type SessionForkedInput = Omit<
  SessionForkedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type BranchHeaderInput = Omit<
  BranchHeaderRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type DistillSkippedInput = Omit<
  DistillSkippedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;

// M8 三族追加输入（决策 089）：业务字段 + 可选 runId；信封其余字段由日志盖章
export type CandidateVerifiedInput = Omit<
  CandidateVerifiedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type CandidateDecidedInput = Omit<
  CandidateDecidedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
export type CandidateActivatedInput = Omit<
  CandidateActivatedRecord,
  "version" | "id" | "sessionId" | "kind" | "timestamp"
>;
