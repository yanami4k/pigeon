// 归一化运行时事件的 kind 与 payload schema（M1 映射表）：Adapter 的内存事件序列与订阅转发共用；另有 Run 开始条目
// 借用的配置摘要形状与验证三值。本文件不依赖上游类型——上游事件到这些形状的映射在 pi-runtime 完成
// （§2 边界规则：上游交互只经 PiRuntimeAdapter）。
import { type Static, Type } from "typebox";
import { Sha256HexSchema } from "./hashing.ts";
import {
  MemoryManifestEntrySchema,
  SkillManifestEntrySchema,
  StructuredMemoryManifestSchema,
} from "./injection-manifest.ts";
import { McpServerStatusSchema, McpToolsetEntrySchema } from "./mcp-toolset.ts";
import { ToolErrorKindSchema } from "./tool-execution.ts";

export const RuntimeEventKind = {
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  ToolProposed: "tool.proposed",
  ToolSettled: "tool.settled",
  RunEnded: "run.ended",
} as const;
export type RuntimeEventKind = (typeof RuntimeEventKind)[keyof typeof RuntimeEventKind];

// 五种归一化事件的 payload schema；类型由 schema 派生（Static），归一化写入方与订阅方共用同一份形状。

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
export const GitObjectIdSchema = Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });

// 每个 Run 的配置摘要（InjectionSnapshot 的冻结值）：Run 开始条目（state/session-entries.ts）逐项取用这里的形状
export const RunStartedPayloadSchema = Type.Object({
  model: Type.Object({
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    // M5.5 S5（决策 050）：本 Run 的推理档位（冻结快照值；M5 记录无此字段）
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    // 决策 063：本 Run 的单轮输出上限（冻结快照值；加法式可缺省，决策 063 之前的记录无此字段；决策 347 起未配置即不记，表示跟模型）
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
  // 决策 359：按环境没注册的工具与原因（加法式；都注册了时不带）
  skippedTools: Type.Optional(
    Type.Array(
      Type.Object({
        tools: Type.Array(Type.String({ minLength: 1 })),
        reason: Type.String({ minLength: 1 }),
      })
    )
  ),
  // 决策 137：后台审阅配置字段已删除。本对象非严格（未设 additionalProperties: false），
  // v10 至 v15 旧记录里的 review 字段读取时忽略
  // 决策 322：验证命令、失败自动分叉重试与回炉轮数已删除。本对象非严格（未设 additionalProperties: false），
  // 旧记录里的 verify、retryOnFail、repairRounds 字段读取时忽略
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

// load_skill 每次读取的结果摘要（名、资源路径、读到内容的哈希、是否截断），作工具结果的 details
export const SkillLoadedPayloadSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  resourcePath: Type.String({ minLength: 1 }),
  hash: Sha256HexSchema,
  bytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
});
export type SkillLoadedPayload = Static<typeof SkillLoadedPayloadSchema>;

// 验证三值（决策 058）：pass（退出码 0）/ fail（非 0）/ undetermined（超时、被信号终止或拉不起来——缺失的结果不支撑
// 确定性结论，§3.3）
export const EvalVerdictSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("undetermined"),
]);
export type EvalVerdict = Static<typeof EvalVerdictSchema>;
