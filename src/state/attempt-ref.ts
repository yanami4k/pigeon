// 尝试的成败标签（决策 072）：由账本现算（state/outcome-label.ts），不落盘。
// 决策 322：标签集合不变——"Passed" 只剩旧会话的验证记录还能现算出；新会话没有验证记录，正常做完记未知。
// （原有的 AttemptRef 尝试引用随多份尝试的自动贴标签一并删除——322 起多份尝试交回各份结果、不再贴标签）
import { type Static, Type } from "typebox";

// 五个标签（决策 072）：由账本现算，不落盘
export const OutcomeLabelSchema = Type.Union([
  Type.Literal("Passed"),
  Type.Literal("Failed"),
  Type.Literal("Abandoned"),
  Type.Literal("Unknown"),
  Type.Literal("InfrastructureError"),
]);
export type OutcomeLabel = Static<typeof OutcomeLabelSchema>;
