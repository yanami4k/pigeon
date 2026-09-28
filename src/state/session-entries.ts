// 新会话存储的自定义条目（决策 176 / 182 / 184）：会话文件是 pi 的 v4 JSONL 会话树，消息以 pi 消息条目完整存储（179），
// Pigeon 自有的事实只以 custom 条目挂进树里（上游 entry 与 record 类型封闭，写入未知类型"写时不报、读时整个文件打不开"）。
// 除消息外只写七种：Run 开始、Run 收尾、验证记录、代码快照、worker 派出与收尾、分叉、授权建立与撤销。
// 条目数据的形状与版本由 Pigeon 自己负责（上游读盘只要求 customType 是字符串）：每种数据都带 version，读者按它分派。
// worker 与分支会话的来历不写成条目，放进会话文件头的 metadata（只在创建与分叉时写一次，177）。
// 本文件只定义形状与写入接口，纯类型、无 IO；写者在 pi-runtime/session-store.ts，只读读取器在 persistence/session-reader.ts。
import { type Static, Type } from "typebox";
import {
  AttemptBudgetSchema,
  RepairRoundsSchema,
  RetryOnFailSchema,
  VerifyConfigSchema,
} from "./attempt-config.ts";
import { Sha256HexSchema } from "./hashing.ts";
import { GrantIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";
import { MemoryReviewTagSchema, PushedMemoryManifestSchema } from "./learned-memory.ts";
import { EvalVerdictSchema, GitObjectIdSchema, RunStartedPayloadSchema } from "./runtime-events.ts";
import {
  CheckpointRefSchema,
  ChildSettledStatusSchema,
  DelegatedPolicySchema,
  ForkPointSchema,
  ForkTriggerSchema,
  GitWorktreeWorkspaceSchema,
  WorkerLimitsSchema,
  WorkerRoleSchema,
  WorkerWorkspaceSchema,
} from "./session-payloads.ts";
import { VerifyStepResultSchema } from "./verify-steps.ts";

// 七种自定义条目的 customType（加 pigeon. 前缀，与上游或其他应用写的 custom 条目区分）
export const SessionEntryType = {
  RunStart: "pigeon.run-start",
  RunEnd: "pigeon.run-end",
  Verification: "pigeon.verification",
  Checkpoint: "pigeon.checkpoint",
  Worker: "pigeon.worker",
  Fork: "pigeon.fork",
  Grant: "pigeon.grant",
} as const;
export type SessionEntryTypeName = (typeof SessionEntryType)[keyof typeof SessionEntryType];

// 本批 schema 的版本；读者按条目数据里的 version 分派
export const SESSION_ENTRY_VERSION = 1;
const VERSION = Type.Literal(SESSION_ENTRY_VERSION);

const run = RunStartedPayloadSchema.properties;

// 本次运行的上下文压缩配置（188、218）：模型窗口、预留、压缩后保留的最近消息量、触发点（上下文 token 数大于它即压缩）
export const CompactionConfigSchema = Type.Object({
  contextWindow: Type.Integer({ minimum: 1 }),
  reserveTokens: Type.Integer({ minimum: 1 }),
  keepRecentTokens: Type.Integer({ minimum: 1 }),
  thresholdTokens: Type.Integer({ minimum: 1 }),
});

// Run 开始（182 / 184）：本次配置与系统提示全文，先于本 Run 的任何消息。
// 不再带旧 run.started 的 systemPromptHash（有全文即可现算）、stepStart 与 structuredMemory（都已无读者）
export const RunStartDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  startedAt: Type.Integer({ minimum: 0 }),
  model: run.model,
  policy: run.policy,
  // 实际广告给模型的工具名单
  advertisedTools: run.advertisedTools,
  // 系统提示全文（pi 消息不含系统提示）
  systemPrompt: Type.String(),
  taskDirective: run.taskDirective,
  memory: run.memory,
  skills: run.skills,
  mcpTools: run.mcpTools,
  mcpServers: run.mcpServers,
  verify: Type.Optional(VerifyConfigSchema),
  retryOnFail: Type.Optional(RetryOnFailSchema),
  budget: Type.Optional(AttemptBudgetSchema),
  repairRounds: Type.Optional(RepairRoundsSchema),
  // 上下文压缩配置（188、218）：运行面没有压缩（测试装配）时不带
  compaction: Type.Optional(CompactionConfigSchema),
  // 推送的记忆（191）：推送开着时记开局冻结的 MEMORY.md 身份（路径、哈希、字节数、条数、上限），与常驻 Memory 分开
  learnedMemory: Type.Optional(PushedMemoryManifestSchema),
  // 复盘会话（175、192、207）：复盘种类与模板版本；普通会话不带
  memoryReview: Type.Optional(MemoryReviewTagSchema),
});
export type RunStartData = Static<typeof RunStartDataSchema>;

// 被我们的上限中止的三种原因：由撞上限的一方在发中止请求时交给运行面，收尾条目据此一次写全
export const RunStopCauseSchema = Type.Union([
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
]);
export type RunStopCause = Static<typeof RunStopCauseSchema>;

// Run 的结束方式：正常完成、撞轮数 / 墙钟 / token 上限、熔断、中止、出错，以及空回复异常结束
// （empty-reply：空回复重试一次仍空，见 pi-runtime/adapter.ts 的 isEmptyReply）
export const RunEndingSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
  Type.Literal("breaker"),
  Type.Literal("aborted"),
  Type.Literal("error"),
  Type.Literal("empty-reply"),
]);
export type RunEnding = Static<typeof RunEndingSchema>;

// Run 收尾（182）：有开始无收尾即未收尾。messageCount 是本 Run 追加的消息条数（含中止与上游合成的失败消息）
export const RunEndDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  ending: RunEndingSchema,
  // 末条助手消息的停止原因与运行面记下的错误文本（在场才带）
  stopReason: Type.Optional(Type.String({ minLength: 1 })),
  errorMessage: Type.Optional(Type.String()),
  messageCount: Type.Integer({ minimum: 0 }),
  endedAt: Type.Integer({ minimum: 0 }),
});
export type RunEndData = Static<typeof RunEndDataSchema>;

// 验证记录的一步：在旧的各步结论上加"工具故障"标记——检查工具本身崩溃（以各检查工具公开的非正常退出码识别，
// 重跑一次仍崩）时标记，整体结论只看其余步（决策 170 ③；识别表见 state/verify-steps.ts）
export const VerificationStepSchema = Type.Object({
  ...VerifyStepResultSchema.properties,
  toolFault: Type.Optional(Type.Literal(true)),
});
export type VerificationStep = Static<typeof VerificationStepSchema>;

// 验证记录（071 / 159）：落在哪个会话文件由单写者约束决定（worker 尝试落父会话），target 指明被验证的会话与 Run
export const VerificationDataSchema = Type.Object({
  version: VERSION,
  // 写入时该会话的活动 Run（父会话无活动 Run 时缺省）
  runId: Type.Optional(RunIdSchema),
  target: Type.Object({ sessionId: SessionIdSchema, runId: RunIdSchema }),
  command: Type.Array(Type.String()),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  timedOut: Type.Boolean(),
  error: Type.Optional(Type.String()),
  durationMs: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  outputHash: Sha256HexSchema,
  // 输出末尾（截断规则同旧验证记录）
  output: Type.String(),
  truncated: Type.Boolean(),
  workspace: Type.String({ minLength: 1 }),
  verdict: EvalVerdictSchema,
  verifiedAt: Type.Integer({ minimum: 0 }),
  steps: Type.Optional(Type.Array(VerificationStepSchema, { minItems: 1 })),
});
export type VerificationData = Static<typeof VerificationDataSchema>;

// 代码快照（078）：写档或命令档工具落定后工作区确有改动时打的快照提交。条目紧跟在发起调用的助手消息之后、
// 该调用的工具结果消息之前（工具落定先于结果消息），以 toolCallId 对应；旧记录的 afterRunSeq 由位置取代
export const CheckpointDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  ref: Type.String({ minLength: 1 }),
  commit: GitObjectIdSchema,
  tree: GitObjectIdSchema,
  // 本会话首个快照的改前基线
  baseCommit: Type.Optional(GitObjectIdSchema),
});
export type CheckpointData = Static<typeof CheckpointDataSchema>;

// worker 派出与收尾（040）：写在父会话文件里。派出先于建工作树落盘；派出失败以 spawn-failed 收尾，保证两者配对。
// 旧记录的 taskKey 与结果里的 structured、receiptIds 不再写（前两者无读者，回执随 184 停写）
export const WorkerSpawnedDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("spawned"),
  // 派出时父会话的活动 Run（人以 /spawn 派出时缺省）
  runId: Type.Optional(RunIdSchema),
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  role: WorkerRoleSchema,
  task: Type.String({ minLength: 1 }),
  policy: DelegatedPolicySchema,
  limits: WorkerLimitsSchema,
  workspace: WorkerWorkspaceSchema,
  spawnedAt: Type.Integer({ minimum: 0 }),
});
export const WorkerSettledDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("settled"),
  runId: Type.Optional(RunIdSchema),
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  status: ChildSettledStatusSchema,
  error: Type.Optional(Type.String()),
  result: Type.Optional(
    Type.Object({
      branch: Type.Optional(Type.String({ minLength: 1 })),
      changedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      summary: Type.String(),
      summaryTruncated: Type.Boolean(),
    })
  ),
  turns: Type.Integer({ minimum: 0 }),
  settledAt: Type.Integer({ minimum: 0 }),
});
export const WorkerDataSchema = Type.Union([WorkerSpawnedDataSchema, WorkerSettledDataSchema]);
export type WorkerData = Static<typeof WorkerDataSchema>;

// 分叉（077 / 177）：写在来源会话文件里；分支会话自成文件，由 pi 的 fork 把分叉点之前的历史复制过去。
// forkEntryId 是分叉点在本文件里对应的消息条目号（来源会话在本存储里没有对应消息时缺省）
export const ForkDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  branchSessionId: SessionIdSchema,
  forkPoint: ForkPointSchema,
  forkEntryId: Type.Optional(Type.String({ minLength: 1 })),
  checkpoint: CheckpointRefSchema,
  trigger: ForkTriggerSchema,
  forkedAt: Type.Integer({ minimum: 0 }),
});
export type ForkData = Static<typeof ForkDataSchema>;

// 授权建立与撤销（决策 3）：会话级放权；冷恢复以建立减撤销还原生效集合
export const GrantCreatedDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("created"),
  runId: Type.Optional(RunIdSchema),
  grantId: GrantIdSchema,
  tool: Type.String({ minLength: 1 }),
  pathPrefix: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.Optional(Type.String({ minLength: 1 })),
  shell: Type.Optional(Type.Boolean()),
  // 决策 290：按网站放权的主机名（加法式字段，版本不变）
  host: Type.Optional(Type.String({ minLength: 1 })),
  firstCall: Type.Object({ toolCallId: Type.String({ minLength: 1 }), args: Type.Unknown() }),
  createdAt: Type.Integer({ minimum: 0 }),
});
export const GrantRevokedDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("revoked"),
  runId: Type.Optional(RunIdSchema),
  grantId: GrantIdSchema,
  revokedAt: Type.Integer({ minimum: 0 }),
});
export const GrantDataSchema = Type.Union([GrantCreatedDataSchema, GrantRevokedDataSchema]);
export type GrantData = Static<typeof GrantDataSchema>;

// 一条待写的自定义条目：customType 与数据成对
export type SessionCustomEntry =
  | { customType: typeof SessionEntryType.RunStart; data: RunStartData }
  | { customType: typeof SessionEntryType.RunEnd; data: RunEndData }
  | { customType: typeof SessionEntryType.Verification; data: VerificationData }
  | { customType: typeof SessionEntryType.Checkpoint; data: CheckpointData }
  | { customType: typeof SessionEntryType.Worker; data: WorkerData }
  | { customType: typeof SessionEntryType.Fork; data: ForkData }
  | { customType: typeof SessionEntryType.Grant; data: GrantData };

// 各 customType 的数据 schema（读者校验用）
export const SESSION_ENTRY_SCHEMAS = {
  [SessionEntryType.RunStart]: RunStartDataSchema,
  [SessionEntryType.RunEnd]: RunEndDataSchema,
  [SessionEntryType.Verification]: VerificationDataSchema,
  [SessionEntryType.Checkpoint]: CheckpointDataSchema,
  [SessionEntryType.Worker]: WorkerDataSchema,
  [SessionEntryType.Fork]: ForkDataSchema,
  [SessionEntryType.Grant]: GrantDataSchema,
} as const;

// 自定义条目的写入面：写者自身从不抛，写失败按内部故障处理（向标准错误输出去重告警），不中断运行。
// approvals、orchestration 等不触达 pi-runtime 的层经这个结构类型接收写者
export interface SessionEntrySink {
  append(entry: SessionCustomEntry): void;
}

// 会话文件头 metadata 里 Pigeon 的一段（只在创建与分叉时写一次）：worker 会话记派出它的父 Run、名字、角色、工作区；
// 分支会话记来源会话、分叉点、快照与工作树。父会话号在文件头的 parentSessionId 上，不重复
export const SessionHeaderMetadataSchema = Type.Object({
  version: VERSION,
  worker: Type.Optional(
    Type.Object({
      parentRunId: Type.Optional(RunIdSchema),
      name: Type.String({ minLength: 1 }),
      role: WorkerRoleSchema,
      workspace: WorkerWorkspaceSchema,
      startedAt: Type.Integer({ minimum: 0 }),
    })
  ),
  branch: Type.Optional(
    Type.Object({
      sourceSessionId: SessionIdSchema,
      forkPoint: ForkPointSchema,
      checkpoint: CheckpointRefSchema,
      workspace: GitWorktreeWorkspaceSchema,
      trigger: ForkTriggerSchema,
      startedAt: Type.Integer({ minimum: 0 }),
    })
  ),
});
export type SessionHeaderMetadata = Static<typeof SessionHeaderMetadataSchema>;

// 文件头 metadata 里存放上面那一段的键
export const HEADER_METADATA_KEY = "pigeon";
