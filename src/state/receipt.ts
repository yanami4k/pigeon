// Receipt（ROADMAP §3.2 + §4 状态机）：一次副作用调用的持久化回执。
// 所有到达 Preparing 的调用都产生 Receipt；executed=false 表示 Rejected、参数非法或
// 执行前取消，即副作用从未发生。摘要仅供人读，治理结论必须回查原始记录（§3.3）。
import { type Static, Type } from "typebox";
import { ExecutionIdSchema, ReceiptIdSchema } from "./ids.ts";

export const RECEIPT_VERSION = 1;

export const ReceiptSchema = Type.Object({
  version: Type.Literal(RECEIPT_VERSION),
  id: ReceiptIdSchema,
  executionId: ExecutionIdSchema,
  // 副作用是否真实发生
  executed: Type.Boolean(),
  // 执行过程是否出错（仅 executed=true 时有意义）
  isError: Type.Boolean(),
  // 起止时间，Unix 毫秒
  startedAt: Type.Integer({ minimum: 0 }),
  finishedAt: Type.Integer({ minimum: 0 }),
  // 面向人的结果摘要，不是证据
  summary: Type.String(),
});

export type Receipt = Static<typeof ReceiptSchema>;
