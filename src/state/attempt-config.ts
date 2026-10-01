// 尝试级配置（M8，决策 087）：本次尝试的预算。决策 322 删除验证门、回炉与失败自动分叉重试后，
// 验证命令、重试次数与回炉轮数的 schema 一并删除；预算仍在会话开始时冻结进注入快照，随 Run 开始条目落盘。
// 本模块只放 schema。
import { type Static, Type } from "typebox";

// 本次尝试的预算（M8，决策 087）：回放必须沿用原那次尝试的预算，不得放宽——预算因此必须在账本里可得。
// maxOutputTokens 与模型标识一起记在 Run 开始条目 的 model 段，不重复进本块。
export const AttemptBudgetSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  wallClockMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type AttemptBudget = Static<typeof AttemptBudgetSchema>;
