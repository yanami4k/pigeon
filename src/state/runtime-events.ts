// 归一化运行时事件的 kind 与 payload schema（M1 映射表；M4 S1 Event Log 按 kind 校验
// payload 的唯一事实源）。归一化写入方（pi-runtime/events.ts）与持久化读取方
// （state/event-log.ts）共用同一份形状，杜绝漂移。本文件不依赖上游类型——上游事件到
// 这些形状的映射在 pi-runtime 完成（§2 边界规则：上游交互只经 PiRuntimeAdapter）。
import { type Static, Type } from "typebox";
import {
  AttemptBudgetSchema,
  RepairRoundsSchema,
  RetryOnFailSchema,
  VerifyConfigSchema,
} from "./attempt-config.ts";
import {
  MemoryManifestEntrySchema,
  SkillManifestEntrySchema,
  StructuredMemoryManifestSchema,
} from "./injection-manifest.ts";
import { McpServerStatusSchema, McpToolsetEntrySchema } from "./mcp-toolset.ts";
import { Sha256HexSchema } from "./message-content.ts";
import { ToolErrorKindSchema } from "./tool-execution.ts";

export const RuntimeEventKind = {
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  ToolProposed: "tool.proposed",
  ToolSettled: "tool.settled",
  RunEnded: "run.ended",
} as const;
export type RuntimeEventKind = (typeof RuntimeEventKind)[keyof typeof RuntimeEventKind];

// 五种归一化事件的 payload schema（M4 S1：Event Log 按 kind 校验 payload 的唯一事实源）。
// 类型由 schema 派生（Static），归一化写入方与持久化读取方共用同一份形状，杜绝漂移。

// pi-ai 的 StopReason 字面量集合（types.d.ts）：落盘格式自有一份，不随上游改名漂移
export const StopReasonSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("stop"),
  Type.Literal("length"),
  Type.Literal("toolUse"),
  Type.Literal("error"),
  Type.Literal("aborted"),
  Type.Literal("deferred"),
]);

export const TurnStartedPayloadSchema = Type.Object({});
export type TurnStartedPayload = Static<typeof TurnStartedPayloadSchema>;

// M5 S1（决策 044）：一轮模型调用的 token 与成本，源自上游 AssistantMessage.usage。
// 落盘格式自有一份（不随上游加字段漂移；cacheWrite1h / reasoning 等 provider 专有细分不收）
const NonNegative = () => Type.Number({ minimum: 0 });
export const TurnUsageSchema = Type.Object({
  input: NonNegative(),
  output: NonNegative(),
  cacheRead: NonNegative(),
  cacheWrite: NonNegative(),
  totalTokens: NonNegative(),
  cost: Type.Object({
    input: NonNegative(),
    output: NonNegative(),
    cacheRead: NonNegative(),
    cacheWrite: NonNegative(),
    total: NonNegative(),
  }),
});
export type TurnUsage = Static<typeof TurnUsageSchema>;

export const TurnCompletedPayloadSchema = Type.Object({
  stopReason: StopReasonSchema,
  // 是否为上游 handleRunFailure 合成的失败消息（agent.js: 空文本 + usage 全零 + errorMessage）
  syntheticFailure: Type.Boolean(),
  errorMessage: Type.Optional(Type.String()),
  // M5 S1（044）：加法式；M5 前的记录缺省
  usage: Type.Optional(TurnUsageSchema),
});
export type TurnCompletedPayload = Static<typeof TurnCompletedPayloadSchema>;

export const ToolProposedPayloadSchema = Type.Object({
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  args: Type.Unknown(),
});
export type ToolProposedPayload = Static<typeof ToolProposedPayloadSchema>;

export const ToolSettledPayloadSchema = Type.Object({
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  isError: Type.Boolean(),
  // M4 S2（D7）：工具错误的域/环境分类，由 Adapter 在工具抛出处捕获归类后 enrich；
  // 判不出的缺省（冷分类落「未知」默认桶），上游拦截类错误由 Adapter 标 domain
  errorKind: Type.Optional(ToolErrorKindSchema),
});
export type ToolSettledPayload = Static<typeof ToolSettledPayloadSchema>;

export const RunEndedPayloadSchema = Type.Object({
  // 本次 Run 新增的消息条数；仅是生命周期事实，不含成败语义
  messageCount: Type.Integer({ minimum: 0 }),
});
export type RunEndedPayload = Static<typeof RunEndedPayloadSchema>;

// M5 观察族（决策 043 / 044）：不是上游事件的归一化，而是 Pigeon 自己的观察记录——
// 不进 events() 与订阅转发（归一化五族的不变式不变），只落 Event Log 供 trace 与冷侧消费。
// 审阅跳过与审阅结果不可解析两种已随第一版学习闭环退役（决策 137），读取时按退役种类跳过。
// 耐久同观察族：同步写不 fsync
export const ObservationKind = {
  RunStarted: "run.started",
  LlmRequest: "llm.request",
  SkillLoaded: "skill.loaded",
  // M6.5 S3（决策 058）：Eval 验证器判决
  EvalVerified: "eval.verified",
  // M7（决策 078）：写操作或命令确实改变文件后生成的工作区快照，与条目号的对应关系
  WorkspaceCheckpoint: "workspace.checkpoint",
  // M7（决策 072）：尝试因轮次、墙钟或 token 上限被中止（上限中止在运行终态上表现为中止，标签据此判失败）
  RunLimitHit: "run.limit-hit",
} as const;
export type ObservationKind = (typeof ObservationKind)[keyof typeof ObservationKind];

// run.started（044）：InjectionSnapshot v3 的摘要——全文不进治理日志（system prompt 全文在
// 内容文件的 system 记录里，靠 systemPromptHash 回指）
// M5.5 S5（决策 050）：推理档位——与上游 pi-agent-core ThinkingLevel 同一组字面量；off = 不请求推理。
// 是成本旋钮不是权限：Run 开始定、Run 内不变（§2 规则 4 快照冻结）
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// 字面量逐个列出：typebox 需要元组才能推出联合类型（map 生成的数组会把静态类型推成 never）
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

// git 对象号（SHA-1 或 SHA-256）
const GitObjectIdSchema = Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });

export const RunStartedPayloadSchema = Type.Object({
  model: Type.Object({
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    // M5.5 S5（决策 050）：本 Run 的推理档位（冻结快照值；M5 记录无此字段）
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    // 决策 063：本 Run 的单轮输出上限（冻结快照值；加法式可缺省，决策 063 之前的记录无此字段）
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    // M9：本 Run 的采样温度（冻结快照值；加法式可缺省——缺省 = 未设，由 provider 决定）
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    // M9：请求了温度但未生效（推理开启时上游不把温度交给 provider）——如实记请求值与原因，不记成温度
    temperatureIgnored: Type.Optional(
      Type.Object({
        requested: Type.Number({ minimum: 0, maximum: 2 }),
        reason: Type.Literal("reasoning-enabled"),
      })
    ),
  }),
  policy: Type.Object({
    allow: Type.Array(Type.String()),
    deny: Type.Array(Type.String()),
    approvalMode: Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]),
  }),
  // 实际广告给模型的工具名单（§2 规则 5：记录实际暴露，不只记配置意图）
  advertisedTools: Type.Array(Type.String()),
  systemPromptHash: Sha256HexSchema,
  // M9：任务源给的工作方式指令原文（冻结快照值；已含在 system prompt 里，单列供回放与冻结项核对；缺省 = 没有）
  taskDirective: Type.Optional(Type.String({ minLength: 1 })),
  memory: Type.Array(MemoryManifestEntrySchema),
  skills: Type.Array(SkillManifestEntrySchema),
  // M5.7 S3（决策 052）：MCP 工具集摘要（注解线索、配置与实际档位、冲突）与 server 当前状态——
  // 加法式不升版本；本会话没有 MCP server 时不带
  mcpTools: Type.Optional(Type.Array(McpToolsetEntrySchema)),
  mcpServers: Type.Optional(Type.Array(McpServerStatusSchema)),
  // 决策 137：后台审阅配置字段已删除。本对象非严格（未设 additionalProperties: false），
  // v10 至 v15 旧记录里的 review 字段读取时忽略
  // M7（决策 071 / 079）：本会话的验证命令与失败自动分叉重试次数（冻结快照值，加法式可缺省）
  verify: Type.Optional(VerifyConfigSchema),
  retryOnFail: Type.Optional(RetryOnFailSchema),
  // M8（决策 087）：本次尝试的预算（冻结快照值，加法式可缺省）——回放据此沿用同一预算，不得放宽
  budget: Type.Optional(AttemptBudgetSchema),
  // 回炉轮数（决策 142 / 143；冻结快照值，只在开启时在场）：一步里的每次 Run 都带同一个值，
  // 这一步的成败由它与这一步最后一次验证记录推出（state/repair-step.ts），不另记
  repairRounds: Type.Optional(RepairRoundsSchema),
  // 这一步的起点（决策 154②；加法式可缺省）：工作区在执行端另一侧（容器）时，回炉开启下执行端在第一个 Run 之前记下的
  // 起点提交与"开工时的树"挂在它之下的提交；一步里的每个 Run 同值。两者之差即开工时的脏文件（跑批器预置、尚未提交的人写测试），
  // 结构化记忆删除（决策 174）后只作记录、没有读者——本地工作区由快照记录的改前基线给出，不带本字段。旧记录没有时按未知处理
  stepStart: Type.Optional(
    Type.Object({ commit: GitObjectIdSchema, baseCommit: Type.Optional(GitObjectIdSchema) })
  ),
  // 结构化记忆（决策 134 / 157；加法式可缺省）：开关、挑选方式、开局给了哪几条（冻结快照值，每个 Run 同值），
  // 以及本 Run 作为回炉轮收到了哪几条（只在回炉 Run 上在场）。决策 174 删除结构化记忆后已停写，只为旧会话照常可读而保留
  structuredMemory: Type.Optional(
    Type.Object({
      ...StructuredMemoryManifestSchema.properties,
      repair: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      // 这一轮回炉挑出来、但用前核验没过而被拦下的条目（只在回炉 Run 上、有被拦下的时在场）
      repairBlocked: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    })
  ),
});
export type RunStartedPayload = Static<typeof RunStartedPayloadSchema>;

// llm.request（044）：每次模型调用前 transformContext 的只读指纹——条数、角色计数、估算字符数、
// 全部消息内容哈希的滚动哈希（与内容文件按哈希可对上）、system prompt 哈希
export const LlmRequestPayloadSchema = Type.Object({
  messageCount: Type.Integer({ minimum: 0 }),
  roleCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  estimatedChars: Type.Integer({ minimum: 0 }),
  messagesHash: Sha256HexSchema,
  systemPromptHash: Sha256HexSchema,
});
export type LlmRequestPayload = Static<typeof LlmRequestPayloadSchema>;

// skill.loaded（043）：load_skill 每次实际读取的留痕（名、资源路径、读到内容的哈希、是否截断）
export const SkillLoadedPayloadSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  resourcePath: Type.String({ minLength: 1 }),
  hash: Sha256HexSchema,
  bytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
});
export type SkillLoadedPayload = Static<typeof SkillLoadedPayloadSchema>;

// eval.verified（M6.5 S3，决策 058 含修订）：runner 收工后回填验证资产、在工作区独立执行验证器的判决。
// 三值：pass（退出码 0）/ fail（非 0）/ undetermined（超时、被信号终止或拉不起来——缺失的结果不支撑确定性结论，§3.3）。
// 形态同 exec 回执（命令、退出码、输出哈希与截断输出），但不是工具调用，不进治理族
export const EvalVerdictSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("undetermined"),
]);
export type EvalVerdict = Static<typeof EvalVerdictSchema>;

export const EvalVerifiedPayloadSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  // 实际执行的参数数组（任务目录占位已替换）
  command: Type.Array(Type.String()),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  timedOut: Type.Boolean(),
  // 验证器自身故障（拉不起进程、回填失败）
  error: Type.Optional(Type.String()),
  durationMs: Type.Integer({ minimum: 0 }),
  // 输出全文不入账：stdout 与 stderr 按到达顺序的字节数与哈希，只留尾部截断文本
  outputBytes: Type.Integer({ minimum: 0 }),
  outputHash: Sha256HexSchema,
  output: Type.String(),
  truncated: Type.Boolean(),
  verdict: EvalVerdictSchema,
  // stdout 尾行是 JSON 对象或数组时原样收入，字段不约束
  details: Type.Optional(Type.Unknown()),
  // 验证前从任务目录回填的资产（工作区相对路径）
  assets: Type.Array(Type.String()),
  // 误报第一层：agent 自报完成（从账本判定）且判决为 fail
  selfReportedDone: Type.Boolean(),
  falsePositive: Type.Boolean(),
});
export type EvalVerifiedPayload = Static<typeof EvalVerifiedPayloadSchema>;

// workspace.checkpoint（M7，决策 078）：git 底层命令在临时索引上生成的快照提交，挂在 refs/pigeon/checkpoints/<会话>/ 下。
// afterRunSeq 是该工具调用的结果消息在本 Run 的条目号：分叉点（含）之前最近的快照即 afterRunSeq 不大于分叉序号的最后一条；
// baseCommit 是本会话首个快照的改前基线（首次改动之前的工作区状态），分叉点早于首次改动时取它
export const WorkspaceCheckpointPayloadSchema = Type.Object({
  ref: Type.String({ minLength: 1 }),
  commit: GitObjectIdSchema,
  tree: GitObjectIdSchema,
  baseCommit: Type.Optional(GitObjectIdSchema),
  toolCallId: Type.String({ minLength: 1 }),
  afterRunSeq: Type.Integer({ minimum: 1 }),
});
export type WorkspaceCheckpointPayload = Static<typeof WorkspaceCheckpointPayloadSchema>;

// run.limit-hit（M7，决策 072）：本 Run 因上限被中止
export const RunLimitHitPayloadSchema = Type.Object({
  limit: Type.Union([
    Type.Literal("turn-limit"),
    Type.Literal("wall-clock-limit"),
    Type.Literal("token-limit"),
  ]),
});
export type RunLimitHitPayload = Static<typeof RunLimitHitPayloadSchema>;
