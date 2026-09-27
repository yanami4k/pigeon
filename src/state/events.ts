// 运行时事件信封：Adapter 归一化后的事件（内存序列与订阅转发共用，不落盘；会话的持久记录在会话存储）。
// payload 按 kind 解释，信封不约束其结构；具体事件的 payload schema 在 runtime-events.ts。
import { type Static, Type } from "typebox";
import { EntryIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

// 当前信封 schema 版本
export const EVENT_ENVELOPE_VERSION = 1;

export const EventEnvelopeSchema = Type.Object({
  version: Type.Literal(EVENT_ENVELOPE_VERSION),
  id: EntryIdSchema,
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  // Unix 毫秒时间戳
  timestamp: Type.Integer({ minimum: 0 }),
  // 事件种类，如 "run.created"、"tool.dispatched"
  kind: Type.String({ minLength: 1 }),
  payload: Type.Unknown(),
});

export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
