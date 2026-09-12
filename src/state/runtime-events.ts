// 归一化运行时事件的 kind 与 payload schema（M1 映射表；M4 S1 Event Log 按 kind 校验
// payload 的唯一事实源）。归一化写入方（pi-runtime/events.ts）与持久化读取方
// （state/event-log.ts）共用同一份形状，杜绝漂移。本文件不依赖上游类型——上游事件到
// 这些形状的映射在 pi-runtime 完成（§2 边界规则：上游交互只经 PiRuntimeAdapter）。
import { type Static, Type } from "typebox";
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

export const TurnCompletedPayloadSchema = Type.Object({
  stopReason: StopReasonSchema,
  // 是否为上游 handleRunFailure 合成的失败消息（agent.js: 空文本 + usage 全零 + errorMessage）
  syntheticFailure: Type.Boolean(),
  errorMessage: Type.Optional(Type.String()),
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
