// 新会话存储的自定义条目（决策 176 / 182 / 184）：会话文件是 pi 的 v4 JSONL 会话树，消息以 pi 消息条目完整存储（179），
// Pigeon 自有的事实只以 custom 条目挂进树里（上游 entry 与 record 类型封闭，写入未知类型"写时不报、读时整个文件打不开"）。
// 除消息外只写十一种：Run 开始、Run 收尾、验证记录（旧会话只读）、代码快照、worker 派出与收尾、分叉、授权建立与撤销、
// 终端界面退出（283）、钩子运行（323）、撞上限续跑与流式重复检测命中（367）。
// 条目数据的形状与版本由 Pigeon 自己负责（上游读盘只要求 customType 是字符串）：每种数据都带 version，读者按它分派。
// worker 与分支会话的来历不写成条目，放进会话文件头的 metadata（只在创建与分叉时写一次，177）。
// 本文件只定义形状与写入接口，纯类型、无 IO；写者在 pi-runtime/session-store.ts，只读读取器在 persistence/session-reader.ts。
import { type Static, Type } from "typebox";
import { AttemptBudgetSchema } from "./attempt-config.ts";
import { Sha256HexSchema } from "./hashing.ts";
import { GrantIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";
import {
  MemoryReviewTagSchema,
  PushedMemoryLayersSchema,
  PushedMemoryManifestSchema,
} from "./learned-memory.ts";
import { RunModelInfoSchema } from "./model-info.ts";
import {
  EvalVerdictSchema,
  GitObjectIdSchema,
  RunStartedPayloadSchema,
  TurnUsageSchema,
} from "./runtime-events.ts";
import {
  CheckpointRefSchema,
  ChildSettledStatusSchema,
  DelegatedPolicySchema,
  ForkPointSchema,
  ForkTriggerSchema,
  GitWorktreeWorkspaceSchema,
  ScriptSettleTagSchema,
  ScriptSpawnTagSchema,
  WorkerErrorKindSchema,
  WorkerLimitsSchema,
  WorkerRoleSchema,
  WorkerWorkspaceSchema,
} from "./session-payloads.ts";

// 自定义条目的 customType（加 pigeon. 前缀，与上游或其他应用写的 custom 条目区分）
export const SessionEntryType = {
  RunStart: "pigeon.run-start",
  RunEnd: "pigeon.run-end",
  Verification: "pigeon.verification",
  Checkpoint: "pigeon.checkpoint",
  CheckpointMark: "pigeon.checkpoint-mark",
  Worker: "pigeon.worker",
  Fork: "pigeon.fork",
  Grant: "pigeon.grant",
  Exit: "pigeon.exit",
  Hook: "pigeon.hook",
  Continuation: "pigeon.continuation",
  Repetition: "pigeon.repetition",
  Status: "pigeon.status",
  Prune: "pigeon.prune",
  BackgroundJob: "pigeon.background-job",
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
  skippedTools: run.skippedTools,
  budget: Type.Optional(AttemptBudgetSchema),
  // 决策 322：验证命令、失败自动分叉重试与回炉轮数已删除。本对象非严格（未设 additionalProperties: false），
  // 旧记录里的 verify、retryOnFail、repairRounds 字段读取时忽略
  // 上下文压缩配置（188、218）：运行面没有压缩（测试装配）时不带
  compaction: Type.Optional(CompactionConfigSchema),
  // 推送的记忆（332）：推送开着时记开局冻结的两层记忆的身份（层、路径、哈希、字节数、条数、上限）与记忆文字的版本
  pushedMemory: Type.Optional(PushedMemoryLayersSchema),
  // 本次所用的模型信息与每一项的来源（362：设置、接入模块声明、pi-ai 目录、未知）；加法式不升版本，此前的记录无此字段
  modelInfo: Type.Optional(RunModelInfoSchema),
  // 旧的推送记忆（191，332 之前的单层 MEMORY.md）：不再产生，只为读旧会话保留
  learnedMemory: Type.Optional(PushedMemoryManifestSchema),
  // 复盘会话（175、192、207）：复盘种类与模板版本。决策 331 删除复盘后不再产生，只为读旧会话保留
  memoryReview: Type.Optional(MemoryReviewTagSchema),
});
export type RunStartData = Static<typeof RunStartDataSchema>;

// 被我们的上限中止的原因：由撞上限的一方在发中止请求时交给运行面，收尾条目据此一次写全。
// looping：打转检测叫停（决策 307，原因记为打转）
export const RunStopCauseSchema = Type.Union([
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
  Type.Literal("looping"),
]);
export type RunStopCause = Static<typeof RunStopCauseSchema>;

// Run 的结束方式：正常完成、撞轮数 / 墙钟 / token 上限、打转叫停、熔断、中止、出错，以及空回复异常结束
// （empty-reply：空回复重试一次仍空，见 pi-runtime/adapter.ts 的 isEmptyReply）。
// 决策 322 / 323：stop-hook-limit = 收尾钩子连续拦截到上限后照常结束（不贴失败标签）
export const RunEndingSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("turn-limit"),
  Type.Literal("wall-clock-limit"),
  Type.Literal("token-limit"),
  Type.Literal("looping"),
  Type.Literal("breaker"),
  Type.Literal("aborted"),
  Type.Literal("error"),
  Type.Literal("empty-reply"),
  Type.Literal("stop-hook-limit"),
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

// 验证记录的一步（决策 159 / 170 ③）：决策 322 删除验证门后验证记录已停写，本 schema 只为旧会话照常可读而保留
// （原 VerifyStepResultSchema 在 state/verify-steps.ts，随删除并入此处，含工具故障标记）
export const VerificationStepSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  verdict: EvalVerdictSchema,
  output: Type.String(),
  truncated: Type.Boolean(),
  // 这一步的执行目录（相对工作区根）；缺省即工作区根
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  // 检查工具自身崩溃的标记：整体结论只看不带此标记的步
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

// 代码快照（078）：写档或命令档工具落定后工作区确有改动时打的快照提交，以 toolCallId 对应发起它的工具调用。
// 决策 350 起快照在工具结果交回之后于后台生成，条目落在文件里的位置不再说明它对应哪一条：runSeq 写明对应的条目号
// （该调用的工具结果消息在所属 Run 里的序号）。没有 runSeq 的旧记录紧跟在发起调用的助手消息之后、该调用的工具结果
// 消息之前，对应条目号由位置取得
export const CheckpointDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  runSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  ref: Type.String({ minLength: 1 }),
  commit: GitObjectIdSchema,
  tree: GitObjectIdSchema,
  // 本会话首个快照的改前基线
  baseCommit: Type.Optional(GitObjectIdSchema),
  // 决策 365：拍摄时在跑的后台作业（作业号）；这时的快照可能含作业做到一半的改动
  backgroundJobs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type CheckpointData = Static<typeof CheckpointDataSchema>;

// 快照的拍摄标记（决策 350）：开拍之前先写 shooting；拍完得到快照写代码快照条目，文件没有改变写 unchanged，
// 失败或等待超时写 failed。只有 shooting、没有下文（进程在拍完之前退出）或 failed 的快照，使对应分叉点明确报错
export const CheckpointMarkStateSchema = Type.Union([
  Type.Literal("shooting"),
  Type.Literal("unchanged"),
  Type.Literal("failed"),
]);
export type CheckpointMarkState = Static<typeof CheckpointMarkStateSchema>;
export const CheckpointMarkDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  runSeq: Type.Integer({ minimum: 1 }),
  state: CheckpointMarkStateSchema,
  // failed 的原因
  reason: Type.Optional(Type.String()),
});
export type CheckpointMarkData = Static<typeof CheckpointMarkDataSchema>;

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
  // 决策 294：派出时带的标签（加这一项之前的记录没有它）
  label: Type.Optional(Type.String({ minLength: 1 })),
  policy: DelegatedPolicySchema,
  limits: WorkerLimitsSchema,
  workspace: WorkerWorkspaceSchema,
  spawnedAt: Type.Integer({ minimum: 0 }),
  // 决策 312：脚本编排派出的调用（运行号、指纹、接力的上游；加这一项之前的记录没有它）
  script: Type.Optional(ScriptSpawnTagSchema),
});
export const WorkerSettledDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("settled"),
  runId: Type.Optional(RunIdSchema),
  childSessionId: SessionIdSchema,
  name: Type.String({ minLength: 1 }),
  status: ChildSettledStatusSchema,
  error: Type.Optional(Type.String()),
  // 决策 298：错误类型（加这一项之前的记录没有它）
  errorKind: Type.Optional(WorkerErrorKindSchema),
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
  // 决策 312：脚本编排派出的调用（运行号、指纹与交回的结构化数据）
  script: Type.Optional(ScriptSettleTagSchema),
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

// 终端界面退出（283）：退出那一刻工作目录的样子，供下次启动时后台补做复盘读代码。本机 git 工作区记工作目录快照
// （没有未提交改动时即 HEAD；另建了快照提交时带挂着它的引用）；沙箱会话不另拍，记交回的分支与提交；非 git 工作区或拍快照失败
// 记无快照与原因。一次运行都没跑过的会话不写。会话原生视图不投影这种条目（它不属于任何 Run）
export const ExitDataSchema = Type.Object({
  version: VERSION,
  exitedAt: Type.Integer({ minimum: 0 }),
  workdir: Type.Union([
    Type.Object({
      kind: Type.Literal("snapshot"),
      commit: GitObjectIdSchema,
      head: GitObjectIdSchema,
      ref: Type.Optional(Type.String({ minLength: 1 })),
    }),
    Type.Object({
      kind: Type.Literal("sandbox"),
      branch: Type.String({ minLength: 1 }),
      commit: GitObjectIdSchema,
    }),
    Type.Object({ kind: Type.Literal("none"), reason: Type.String({ minLength: 1 }) }),
  ]),
});
export type ExitData = Static<typeof ExitDataSchema>;

// 钩子的一次运行（决策 323 / 324）：事件、命令、退出码、用时、结论与输出摘要。
// 结论按事件各自的语义记（放行 / 拦下 / 要求确认 / 补上下文 / 只通知 / 钩子自身出错）；输出摘要为 stdout 与 stderr 的截尾
export const HookRunDataSchema = Type.Object({
  version: VERSION,
  // 写入时该会话的活动 Run（会话级事件如 SessionStart 无 Run 时缺省）
  runId: Type.Optional(RunIdSchema),
  event: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
  matcher: Type.Optional(Type.String()),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  timedOut: Type.Boolean(),
  durationMs: Type.Integer({ minimum: 0 }),
  // 结论：allow / deny / ask / block / context / notify / pass / error / limit（词表见 application/hooks.ts）
  conclusion: Type.String({ minLength: 1 }),
  // stdout 与 stderr 的摘要（截尾；空即缺省）
  output: Type.Optional(Type.String()),
});
export type HookRunData = Static<typeof HookRunDataSchema>;

// 撞上限续跑（决策 367）：末条回复因输出上限截断（或被流式重复检测掐断）且没有工具调用，运行面不收尾、接着跑。
// 重复检测掐断的：被截断的回复留在会话文件里，但移出主分支（主分支的叶子退回它之前），模型上下文与续跑还原都不再含它；
// 本条目挂在主分支上被截断回复的位置，其后是给模型的提示消息。被截断的回复是一次真实的模型请求：轮数与用量的统计
// 按本条目把它加回（一条续跑条目算一轮，用量取 droppedUsage；截断的回复没有用量时缺省）。
// 单纯撞上限的（决策 376）：截断的回复留在主分支上、照常计轮与用量，本条目挂在它之后、带 replyKept，不再加回。
// 376 之前写下的条目没有 replyKept，一律是移出主分支的
export const ContinuationDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  // 截断的来由：撞输出上限 / 流式重复检测掐断
  cause: Type.Union([Type.Literal("output-limit"), Type.Literal("repetition")]),
  // 本 Run 第几次续跑、连续第几次
  attempt: Type.Integer({ minimum: 1 }),
  consecutive: Type.Integer({ minimum: 1 }),
  continuedAt: Type.Integer({ minimum: 0 }),
  droppedUsage: Type.Optional(TurnUsageSchema),
  // 截断的回复留在主分支上（决策 376：单纯撞上限）；缺省即已移出主分支
  replyKept: Type.Optional(Type.Literal(true)),
});
export type ContinuationData = Static<typeof ContinuationDataSchema>;

// 流式重复检测的一次命中（决策 367）：判据（逐字周期 / 段落相似度）、通道（正文 / 思考）、周期长度、重复次数、
// 起点与触发位置（本条回复里该通道的字符偏移，见 pi-runtime/repetition-guard.ts）与当时的模式（掐断 / 只记录）
export const RepetitionDataSchema = Type.Object({
  version: VERSION,
  runId: RunIdSchema,
  mode: Type.Union([Type.Literal("abort"), Type.Literal("log")]),
  criterion: Type.Union([Type.Literal("cycle"), Type.Literal("paragraph")]),
  channel: Type.Union([Type.Literal("text"), Type.Literal("thinking")]),
  periodChars: Type.Integer({ minimum: 1 }),
  repeats: Type.Integer({ minimum: 1 }),
  startChar: Type.Integer({ minimum: 0 }),
  atChar: Type.Integer({ minimum: 0 }),
  detectedAt: Type.Integer({ minimum: 0 }),
});
export type RepetitionData = Static<typeof RepetitionDataSchema>;

// 开工状态块最后发出的一份（决策 363）：节名 → 该节原文（转义前）的哈希。每次发出完整块或变化追加、
// 以及模型自己写的记忆记成已发时写一条；续跑与分叉从主分支最后一条取，与当前状态比对，只追加变了的节
export const StatusDataSchema = Type.Object({
  version: VERSION,
  sections: Type.Record(Type.String({ minLength: 1 }), Sha256HexSchema),
});
export type StatusData = Static<typeof StatusDataSchema>;

// 一次上下文裁剪（决策 361）：裁了哪些工具结果（按工具调用号）、各换成什么占位、为什么算候选、原来估算的 token 数；
// 时机；估算的代价与节省（按命中价折算的 token 当量：代价为改写点之后的量 ×（价格比 − 1），节省为裁掉量 × N；免费时机
// 代价为 0）；前后的上下文 token 数。组装请求时依次应用，续跑照记录重放；原文照旧在会话记录里
export const PruneDataSchema = Type.Object({
  version: VERSION,
  runId: Type.Optional(RunIdSchema),
  trigger: Type.Union([
    Type.Literal("compaction"),
    Type.Literal("model"),
    Type.Literal("tools"),
    Type.Literal("system-prompt"),
    Type.Literal("idle"),
    Type.Literal("paid"),
  ]),
  items: Type.Array(
    Type.Object({
      toolCallId: Type.String({ minLength: 1 }),
      toolName: Type.String(),
      reason: Type.Union([Type.Literal("stale"), Type.Literal("empty"), Type.Literal("large")]),
      tokens: Type.Integer({ minimum: 0 }),
      placeholder: Type.String({ minLength: 1 }),
    }),
    { minItems: 1 }
  ),
  priceRatio: Type.Number({ minimum: 1 }),
  horizonTurns: Type.Integer({ minimum: 1 }),
  prunedTokens: Type.Integer({ minimum: 0 }),
  rewriteTokens: Type.Integer({ minimum: 0 }),
  estimatedCost: Type.Number({ minimum: 0 }),
  estimatedSaving: Type.Number({ minimum: 0 }),
  tokensBefore: Type.Integer({ minimum: 0 }),
  tokensAfter: Type.Integer({ minimum: 0 }),
  prunedAt: Type.Integer({ minimum: 0 }),
});
export type PruneData = Static<typeof PruneDataSchema>;

// 后台作业的启动与结束（决策 365）：各写一条。启动记作业号、命令、标记与输出的虚拟路径；结束记结局（exited 正常退出、
// killed 被停掉、failed 没能启动）、退出码、停掉的来由（job_kill、会话结束 aborted、收尾时限 closeout）与输出字节数。
// 只有启动、没有结束的作业属于已退出的进程，续跑时提示已丢失
const JobIdSchema = Type.String({ minLength: 1 });
export const BackgroundJobStartedDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("started"),
  runId: Type.Optional(RunIdSchema),
  jobId: JobIdSchema,
  command: Type.String({ minLength: 1 }),
  marker: Type.String({ minLength: 1 }),
  output: Type.String({ minLength: 1 }),
  toolCallId: Type.Optional(Type.String({ minLength: 1 })),
});
export const BackgroundJobEndedDataSchema = Type.Object({
  version: VERSION,
  event: Type.Literal("ended"),
  runId: Type.Optional(RunIdSchema),
  jobId: JobIdSchema,
  state: Type.Union([Type.Literal("exited"), Type.Literal("killed"), Type.Literal("failed")]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  reason: Type.Optional(
    Type.Union([Type.Literal("job_kill"), Type.Literal("aborted"), Type.Literal("closeout")])
  ),
  output: Type.Optional(Type.String({ minLength: 1 })),
  outputBytes: Type.Integer({ minimum: 0 }),
});
export const BackgroundJobDataSchema = Type.Union([
  BackgroundJobStartedDataSchema,
  BackgroundJobEndedDataSchema,
]);
export type BackgroundJobData = Static<typeof BackgroundJobDataSchema>;

// 一条待写的自定义条目：customType 与数据成对
export type SessionCustomEntry =
  | { customType: typeof SessionEntryType.RunStart; data: RunStartData }
  | { customType: typeof SessionEntryType.RunEnd; data: RunEndData }
  | { customType: typeof SessionEntryType.Verification; data: VerificationData }
  | { customType: typeof SessionEntryType.Checkpoint; data: CheckpointData }
  | { customType: typeof SessionEntryType.CheckpointMark; data: CheckpointMarkData }
  | { customType: typeof SessionEntryType.Worker; data: WorkerData }
  | { customType: typeof SessionEntryType.Fork; data: ForkData }
  | { customType: typeof SessionEntryType.Grant; data: GrantData }
  | { customType: typeof SessionEntryType.Exit; data: ExitData }
  | { customType: typeof SessionEntryType.Hook; data: HookRunData }
  | { customType: typeof SessionEntryType.Continuation; data: ContinuationData }
  | { customType: typeof SessionEntryType.Repetition; data: RepetitionData }
  | { customType: typeof SessionEntryType.Status; data: StatusData }
  | { customType: typeof SessionEntryType.Prune; data: PruneData }
  | { customType: typeof SessionEntryType.BackgroundJob; data: BackgroundJobData };

// 各 customType 的数据 schema（读者校验用）
export const SESSION_ENTRY_SCHEMAS = {
  [SessionEntryType.RunStart]: RunStartDataSchema,
  [SessionEntryType.RunEnd]: RunEndDataSchema,
  [SessionEntryType.Verification]: VerificationDataSchema,
  [SessionEntryType.Checkpoint]: CheckpointDataSchema,
  [SessionEntryType.CheckpointMark]: CheckpointMarkDataSchema,
  [SessionEntryType.Worker]: WorkerDataSchema,
  [SessionEntryType.Fork]: ForkDataSchema,
  [SessionEntryType.Grant]: GrantDataSchema,
  [SessionEntryType.Exit]: ExitDataSchema,
  [SessionEntryType.Hook]: HookRunDataSchema,
  [SessionEntryType.Continuation]: ContinuationDataSchema,
  [SessionEntryType.Repetition]: RepetitionDataSchema,
  [SessionEntryType.Status]: StatusDataSchema,
  [SessionEntryType.Prune]: PruneDataSchema,
  [SessionEntryType.BackgroundJob]: BackgroundJobDataSchema,
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
