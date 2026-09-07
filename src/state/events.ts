// Event Log 信封（ROADMAP §3.5 权威状态源）：一切状态变化以事件追加进日志，
// 权威状态可从 Event Log + 版本化 Snapshot 冷物化。
// payload 按 kind 解释，信封不约束其结构；具体事件的 payload schema 随后续里程碑收紧。
import { type Static, Type } from "typebox";
import { EntryIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

// 当前信封 schema 版本；迁移管线（migration.ts）按 version 字段路由
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
