// Receipt（ROADMAP §3.2 + §4 状态机）：一次副作用调用的持久化回执。
// 所有到达 dispatch 的调用都产生 Receipt；executed=false 表示 Rejected、参数非法或
// 执行前取消，即副作用从未发生。摘要仅供人读，治理结论必须回查原始记录（§3.3）。
// v2：补批准来源（决策 4，证据链）与 toolCallId（回联上游 transcript / ToolExecution 账本）。
import { type Static, Type } from "typebox";
import { ExecutionIdSchema, ReceiptIdSchema } from "./ids.ts";
import type { Migration } from "./migration.ts";

export const RECEIPT_VERSION = 2;

// 批准来源（与 ToolExecutionDecision.approvedBy 同枚举，决策 4）
export const ReceiptApprovedBySchema = Type.Union([
  Type.Literal("human"),
  Type.Literal("policy:yolo"),
  Type.Literal("policy:auto"),
  Type.Literal("policy:deny"),
]);

export const ReceiptSchema = Type.Object({
  version: Type.Literal(RECEIPT_VERSION),
  id: ReceiptIdSchema,
  executionId: ExecutionIdSchema,
  // 上游 toolCall id：回联 transcript 与 ToolExecution 账本
  toolCallId: Type.String({ minLength: 1 }),
  // 批准来源：人工 / yolo 批发授权 / 分层自动放行 / deny 清单拒绝
  approvedBy: ReceiptApprovedBySchema,
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

// v1 → v2：补 approvedBy / toolCallId。注意：v1 Receipt 从未被任何代码路径持久化
// （M0 仅为 schema 占位，首个写入方是 M3 切片 5 的 JSONL 账本，直接写 v2），
// 迁移的字段默认值是占位语义，作用只是维系迁移管线连续性（同 snapshot v1→v2 先例）。
export const migrateReceiptV1toV2: Migration = (doc) => ({
  ...doc,
  version: RECEIPT_VERSION,
  toolCallId: "legacy-v1",
  approvedBy: "policy:auto",
});
