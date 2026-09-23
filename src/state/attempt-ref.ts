// 尝试的成败标签与尝试引用（决策 072 / 075）：成败标签由账本现算（state/outcome-label.ts），
// 尝试引用指明某次尝试落在哪个治理根、哪个会话、哪次 Run、哪段条目，以及现算出的标签与验证记录引用。
// 两者都是执行侧的公共形状（分叉、重试与 /spawn --attempts 用），不属于任何一条产出线，故单独成模块。
import { type Static, Type } from "typebox";
import { EntryIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";

// 五个标签（决策 072）：由账本现算，不落盘
export const OutcomeLabelSchema = Type.Union([
  Type.Literal("Passed"),
  Type.Literal("Failed"),
  Type.Literal("Abandoned"),
  Type.Literal("Unknown"),
  Type.Literal("InfrastructureError"),
]);
export type OutcomeLabel = Static<typeof OutcomeLabelSchema>;

// 一次尝试引用：治理根、会话、Run、条目范围、标签、验证记录引用（在哪个会话文件、哪条记录）
export const AttemptRefSchema = Type.Object(
  {
    governanceRoot: Type.String({ minLength: 1 }),
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    entryRange: Type.Object({
      from: Type.Integer({ minimum: 1 }),
      to: Type.Integer({ minimum: 1 }),
    }),
    label: OutcomeLabelSchema,
    verification: Type.Optional(
      Type.Object({ sessionId: SessionIdSchema, recordId: EntryIdSchema })
    ),
  },
  { additionalProperties: false }
);
export type AttemptRef = Static<typeof AttemptRefSchema>;
