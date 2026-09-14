// 归一化运行时事件的 kind 与 payload schema（M1 映射表；M4 S1 Event Log 按 kind 校验
// payload 的唯一事实源）。归一化写入方（pi-runtime/events.ts）与持久化读取方
// （state/event-log.ts）共用同一份形状，杜绝漂移。本文件不依赖上游类型——上游事件到
// 这些形状的映射在 pi-runtime 完成（§2 边界规则：上游交互只经 PiRuntimeAdapter）。
import { type Static, Type } from "typebox";
import { MemoryManifestEntrySchema, SkillManifestEntrySchema } from "./injection-manifest.ts";
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
// 不进 events() 与订阅转发（归一化五族的不变式不变），只落 Event Log 供 trace / 学习闭环消费。
// 耐久同观察族：同步写不 fsync
export const ObservationKind = {
  RunStarted: "run.started",
  LlmRequest: "llm.request",
  SkillLoaded: "skill.loaded",
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

export const RunStartedPayloadSchema = Type.Object({
  model: Type.Object({
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    // M5.5 S5（决策 050）：本 Run 的推理档位（冻结快照值；M5 记录无此字段）
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  }),
  policy: Type.Object({
    allow: Type.Array(Type.String()),
    deny: Type.Array(Type.String()),
    approvalMode: Type.Union([Type.Literal("prompt"), Type.Literal("yolo")]),
  }),
  // 实际广告给模型的工具名单（§2 规则 5：记录实际暴露，不只记配置意图）
  advertisedTools: Type.Array(Type.String()),
  systemPromptHash: Sha256HexSchema,
  memory: Type.Array(MemoryManifestEntrySchema),
  skills: Type.Array(SkillManifestEntrySchema),
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
