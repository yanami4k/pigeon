// Event Log 记录族 schema（ROADMAP §3.5 权威状态源；M4 S1/S2/S5/S6 + 收口）：
// 单一日志承载全部事件族——运行时事件（turn/tool/run 五种归一化事件）、entry 族
// （D3 Pi transcript 消息映射）、治理族（intent/decision/receipt，M3 账本归并而来，
// 决策 2 不双写；breaker/resolution）与 grant 族（created/revoked）。
// 记录信封：version + EntryId + SessionId + RunId + 时间戳；kind 区分族，payload/字段随族。
// 本文件只定义形状与读路径迁移链；存储引擎（JSONL 读写、fsync、幂等索引）在
// persistence/event-log.ts，冷物化与对账在 state/materialize.ts。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
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
import { VerifyStepResultSchema } from "./verify-steps.ts";

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
// v13（M9）：run.started 载荷的 model 段加可选采样温度——加法式，v12 旧记录逐字有效
// v14（决策 128）：退役候选筛查、提炼跳过、固化升格与固化移除四族（无读者或与别的记录逐字重复）——
// 停写并移出记录并集；旧会话文件里的这四种记录由读取边界按 RETIRED_EVENT_KINDS 跳过，其余记录逐字有效
// v15（决策 142 / 143）：run.started 载荷加可选回炉轮数——加法式，v14 旧记录逐字有效
// v16（决策 137 / 158）：第一版学习闭环退役——候选提出、候选验证、候选决定、候选激活、审阅跳过与审阅结果不可解析
// 六种记录停写并移出记录并集（旧回放的结果记录类型随候选验证记录一起移除），照决策 128 由读取边界跳过；
// run.started 载荷去掉审阅配置字段（非严格对象，旧记录里的该字段读取时忽略）。其余记录逐字有效
// v17（决策 134 / 157 / 159）：通用验证记录加可选的各步结论，run.started 载荷的验证命令加可选分步、另加可选的
// 结构化记忆推送留痕与可选的这一步起点（容器工作区的起点提交与开工时的树）——加法式，v16 旧记录逐字有效
export const EVENT_LOG_VERSION = 17;

// 已退役的记录种类：读取边界在 schema 校验之前按本清单跳过——任何版本都跳过，不算损坏，
// 也不进入任何视图与执行编号重复检测；旧会话文件不改写
export const RETIRED_EVENT_KINDS: ReadonlySet<string> = new Set([
  // 决策 128：无读者或与别的记录逐字重复
  "candidate.screened",
  "distill.skipped",
  "grant.promoted",
  "grant.config-removed",
  // 决策 137 / 158：第一版学习闭环退役
  "candidate.proposed",
  "candidate.verified",
  "candidate.decided",
  "candidate.activated",
  "review.skipped",
  "review.unparsable",
]);

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

// M5.5 S2（决策 040）：worker 编排三族。worker 会话首条记 session.header（父会话、父 Run、角色、
// 工作树）；父会话记 child.spawned（派出意图，先于建工作树落盘）与 child.settled（结构化结果）。
// 任何文件只有一个写入者：父会话文件只由父运行面写，worker 会话文件只由该 worker 写。
// 三族均治理族耐久（fsync），无 executionId 幂等键；信封同 grant 族（runId 可选——人以 /spawn
// 派出时父会话无活动 Run）
// M8（决策 082）：新增验证器角色——在独立工作树中重执行被验证那次尝试；
// 它的命令档工具只在固化命令规则内放行（083）
// 决策 137 / 158：reviewer、distiller、verifier 已停用、不再派出；取值保留，旧会话文件与项目命令配置里记着它们，
// 删值会使其读不出。可派出的角色见 orchestration/roles.ts
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
// 加法式联合，054 的形状封顶口径不变：git-worktree 成员逐字不动，旧记录读取不变。
// 决策 137 之后不再产生无工作区（只读角色已退役），该成员只为读取旧记录保留
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

// 轮次与墙钟两个上限；M6（决策 064 子裁决 ④）加可选的累计 token 上限（当初为 Reviewer 专设，现对所有 worker 通用；缺省不限）
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
// receipt 列表自账本重构第二段起不再写（回执随 184 停写后失去来源），旧记录里的照常可读，故改可缺省。
// M6（决策 064）：无工作区的 worker（已退役的 Reviewer，决策 137）没有分支与改动文件，两项改可缺省；
// structured 承载模型交回的结构化内容：仍在写入（编排器收尾时取运行面的结构化结果），第一版的读取方
// （候选落盘）随决策 137 退役后，生产代码暂无读取方
export const ChildResultSchema = Type.Object({
  branch: Type.Optional(Type.String({ minLength: 1 })),
  changedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  receiptIds: Type.Optional(Type.Array(ReceiptIdSchema)),
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
  // 决策 159：分步配置下的各步结论（加法式可缺省）。在场时整体结论为各步合取、退出码取第一个失败步骤的、
  // 输出为各步输出按步分段后的末尾；单条命令配置不带（读取时视为一步，见 state/verify-steps.ts）
  steps: Type.Optional(Type.Array(VerifyStepResultSchema, { minItems: 1 })),
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

// Event Log 记录并集（M4 S5 新增 entry 族；M4 S6 新增 grant.created / grant.revoked 族；
// 决策 128 与决策 137 退役的各族不在并集里，见 RETIRED_EVENT_KINDS）
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
  SessionHeaderRecordSchema,
  ChildSpawnedRecordSchema,
  ChildSettledRecordSchema,
  AttemptVerifiedRecordSchema,
  SessionForkedRecordSchema,
  BranchHeaderRecordSchema,
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

// v10 → v11（M7）：加法式演进（派出记录可选任务标识、新增四族与两个观察族）——纯版本推进。
// 此前这一步还升级候选提出内嵌的候选、改写不可解析记录的产出会话字段名；两种记录已退役（决策 137），
// 在读取边界即被跳过，走不到这里，相应分支随之删除
eventLogMigrations.register("event-log", 10, (doc) => ({ ...doc, version: 11 }));

// v11 → v12（M8）：加法式演进（新增候选三族、角色加 verifier、工作区加可选起点提交、
// run.started 载荷加可选预算块与验证命令来源）——v11 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 11, (doc) => ({ ...doc, version: 12 }));

// v12 → v13（M9）：加法式演进（run.started 的 model 段加可选采样温度）——v12 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 12, (doc) => ({ ...doc, version: 13 }));

// v13 → v14（决策 128）：退役四族。退役种类在读取边界已被跳过，走到这里的都是保留下来的记录——
// 逐字有效，纯版本推进
eventLogMigrations.register("event-log", 13, (doc) => ({ ...doc, version: 14 }));

// v14 → v15（决策 142 / 143）：加法式演进（run.started 加可选回炉轮数）——v14 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 14, (doc) => ({ ...doc, version: 15 }));

// v15 → v16（决策 137 / 158）：退役六族。退役种类在读取边界已被跳过，走到这里的都是保留下来的记录；
// run.started 里旧的审阅配置字段由非严格对象忽略——逐字有效，纯版本推进
eventLogMigrations.register("event-log", 15, (doc) => ({ ...doc, version: 16 }));

// v16 → v17（决策 134 / 157 / 159）：加法式演进（验证记录加可选各步结论、run.started 的验证命令加可选分步、
// run.started 加可选结构化记忆留痕与可选的这一步起点）——v16 旧记录逐字有效，纯版本推进
eventLogMigrations.register("event-log", 16, (doc) => ({ ...doc, version: 17 }));

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

// M7 三族追加输入：业务字段 + 可选 runId；信封其余字段由日志盖章
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
