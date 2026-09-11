// Pi 公开事件 → Pigeon Runtime Event 的归一化映射（ROADMAP M1）。
// 映射表（M1 覆盖范围）：
//   message_start(role=assistant)  → turn.started
//   message_end(role=assistant)    → turn.completed（携带 stopReason / syntheticFailure 标注）
//   tool_execution_start           → tool.proposed（M1 无工具，映射先立）
//   tool_execution_end             → tool.settled（同上）
//   agent_end                      → run.ended（不携带成功语义；成败另看末条 assistant 消息的 stopReason）
// 其余事件（agent_start、turn_start/turn_end、message_update、注入消息的 message_*、
// tool_execution_update）M1 不落 Pigeon 事件，返回 null。
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, type RunId, type SessionId } from "../state/ids.ts";
import { ToolErrorKindSchema } from "../state/tool-execution.ts";

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

// 识别上游 handleRunFailure 合成的 assistant 消息：
// 空文本内容 + usage 全零 + 携带 errorMessage，三者齐备才认定，避免误标真实模型错误消息。
export function isSyntheticFailureMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (typeof message.errorMessage !== "string") {
    return false;
  }
  const emptyText =
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0]?.text === "";
  const usage = message.usage;
  const zeroUsage =
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.totalTokens === 0 &&
    usage.cost.input === 0 &&
    usage.cost.output === 0 &&
    usage.cost.cacheRead === 0 &&
    usage.cost.cacheWrite === 0 &&
    usage.cost.total === 0;
  return emptyText && zeroUsage;
}

// 归一化单条 Pi 事件；返回 null 表示该事件在 M1 不产生 Pigeon Runtime Event。
export function normalizePiEvent(
  event: AgentEvent,
  ids: { sessionId: SessionId; runId: RunId }
): EventEnvelope | null {
  switch (event.type) {
    case "message_start":
      // 只把 assistant 消息视作 Turn 边界；user / toolResult 是注入或反馈，不算 Turn
      if (event.message.role === "assistant") {
        return envelope(ids, RuntimeEventKind.TurnStarted, {});
      }
      return null;
    case "message_end": {
      if (event.message.role !== "assistant") {
        return null;
      }
      const message: AssistantMessage = event.message;
      const payload: TurnCompletedPayload = {
        stopReason: message.stopReason,
        syntheticFailure: isSyntheticFailureMessage(message),
        ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
      };
      return envelope(ids, RuntimeEventKind.TurnCompleted, payload);
    }
    case "tool_execution_start": {
      // args 深拷贝：上游事件对象可能被事后修改，直接引用会回溯污染已落日志的 payload
      const payload: ToolProposedPayload = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: structuredClone(event.args),
      };
      return envelope(ids, RuntimeEventKind.ToolProposed, payload);
    }
    case "tool_execution_end": {
      const payload: ToolSettledPayload = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
      return envelope(ids, RuntimeEventKind.ToolSettled, payload);
    }
    case "agent_end": {
      const payload: RunEndedPayload = { messageCount: event.messages.length };
      return envelope(ids, RuntimeEventKind.RunEnded, payload);
    }
    default:
      return null;
  }
}

function envelope(
  ids: { sessionId: SessionId; runId: RunId },
  kind: RuntimeEventKind,
  payload: unknown
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId: ids.sessionId,
    runId: ids.runId,
    timestamp: Date.now(),
    kind,
    payload,
  };
}
