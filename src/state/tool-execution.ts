// ToolExecution（ROADMAP §M3）：单次工具调用的最小治理账本，统一承载
// proposal → approval → dispatch → execution → settled → verification 生命周期。
// 审批动作集只有批准/拒绝，无"人工改参数"（决策 1）；批准来源区分 human / policy:yolo（决策 4），
// policy:deny 记录 deny 清单的自动拒绝——策略拒绝不能伪装成人工或 yolo 决定。
// spike S5：transcript/事件只记模型原始参数，"批准≠执行"上游不可自检，故 rawArgs 快照在此留证。
import { type Static, Type } from "typebox";
import { ExecutionIdSchema, newExecutionId, ReceiptIdSchema } from "./ids.ts";

export const TOOL_EXECUTION_VERSION = 1;

// 生命周期状态机（ROADMAP §M3）
export const ToolExecutionStateSchema = Type.Union([
  Type.Literal("proposal"),
  Type.Literal("approval"),
  Type.Literal("dispatch"),
  Type.Literal("execution"),
  Type.Literal("settled"),
  Type.Literal("verification"),
]);
export type ToolExecutionState = Static<typeof ToolExecutionStateSchema>;

// 审批决定：批准/拒绝 + 批准来源 + 可选理由 + 决定时间。
// 拒绝理由会逐字反馈给模型（spike S2a），构成模型的自我修正闭环。
export const ToolExecutionDecisionSchema = Type.Object({
  outcome: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
  approvedBy: Type.Union([
    Type.Literal("human"),
    Type.Literal("policy:yolo"),
    Type.Literal("policy:deny"),
  ]),
  reason: Type.Optional(Type.String()),
  decidedAt: Type.Integer({ minimum: 0 }),
});
export type ToolExecutionDecision = Static<typeof ToolExecutionDecisionSchema>;

export const ToolExecutionSchema = Type.Object({
  version: Type.Literal(TOOL_EXECUTION_VERSION),
  executionId: ExecutionIdSchema,
  // 上游 toolCall id：非 Pigeon 五类稳定标识，原样保留用于对账
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  // 模型原始参数快照（hook 入场时 structuredClone 留证）
  rawArgs: Type.Unknown(),
  state: ToolExecutionStateSchema,
  // 进入 approval 后由 recordDecision 写入；决定不可改判
  decision: Type.Optional(ToolExecutionDecisionSchema),
  // 各阶段时间戳（Unix 毫秒）：proposedAt 创建必填，其余由 advanceToolExecution 入场盖章
  proposedAt: Type.Integer({ minimum: 0 }),
  dispatchedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  executionStartedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  settledAt: Type.Optional(Type.Integer({ minimum: 0 })),
  verifiedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  // settled 后关联的执行 Receipt（M3 切片 5 账本）
  receiptId: Type.Optional(ReceiptIdSchema),
});
export type ToolExecution = Static<typeof ToolExecutionSchema>;

export class ToolExecutionTransitionError extends Error {}

// 合法迁移表。注意没有 proposal → settled：deny 清单的拒绝也走 approval 阶段
// （policy:deny 自动决定），保证一切拒绝都有 decision 留证、可审计。
const TRANSITIONS: Record<ToolExecutionState, readonly ToolExecutionState[]> = {
  proposal: ["approval"],
  approval: ["dispatch", "settled"],
  dispatch: ["execution"],
  execution: ["settled"],
  settled: ["verification"],
  verification: [],
};

// 各状态入场时要盖的时间戳字段；proposal/approval 的时间由 proposedAt / decision.decidedAt 承载
const STATE_TIMESTAMPS = {
  dispatch: "dispatchedAt",
  execution: "executionStartedAt",
  settled: "settledAt",
  verification: "verifiedAt",
} as const;

// 创建 proposal 阶段的账本记录
export function proposeToolExecution(input: {
  toolCallId: string;
  toolName: string;
  rawArgs: unknown;
  at: number;
}): ToolExecution {
  return {
    version: TOOL_EXECUTION_VERSION,
    executionId: newExecutionId(),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    rawArgs: input.rawArgs,
    state: "proposal",
    proposedAt: input.at,
  };
}

// 在 approval 状态记录审批决定；决定一旦写下不可改判（§3.1 防伪造批准）
export function recordDecision(
  exec: ToolExecution,
  decision: ToolExecutionDecision
): ToolExecution {
  if (exec.state !== "approval") {
    throw new ToolExecutionTransitionError(`只能在 approval 状态记录决定，当前为 ${exec.state}`);
  }
  if (exec.decision !== undefined) {
    throw new ToolExecutionTransitionError("决定已记录，不可改判");
  }
  return { ...exec, decision };
}

// 推进状态机：非法迁移、以及"决定-去向"不一致（未批准进 dispatch / 已批准进 settled）一律拒绝
export function advanceToolExecution(
  exec: ToolExecution,
  next: ToolExecutionState,
  at: number
): ToolExecution {
  if (!TRANSITIONS[exec.state].includes(next)) {
    throw new ToolExecutionTransitionError(`非法迁移：${exec.state} → ${next}`);
  }
  if (exec.state === "approval") {
    const outcome = exec.decision?.outcome;
    if (next === "dispatch" && outcome !== "approved") {
      throw new ToolExecutionTransitionError("未经批准的决定不能进入 dispatch");
    }
    if (next === "settled" && outcome !== "rejected") {
      throw new ToolExecutionTransitionError("只有被拒绝的执行才能从 approval 直接 settled");
    }
  }
  const stamp = STATE_TIMESTAMPS[next as keyof typeof STATE_TIMESTAMPS];
  return stamp === undefined ? { ...exec, state: next } : { ...exec, state: next, [stamp]: at };
}
