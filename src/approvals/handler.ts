// 人工审批接口（ROADMAP §M3 + 决策 3：CLI REPL 内联审批，切片 4 实现 CLI）。
// Adapter 的 beforeToolCall 审批闸在策略判定为 prompt 时调用注入的 ApprovalHandler；
// 本文件只定义注入点，不含任何交互实现。
//
// 决策 1：审批动作只有批准/拒绝，无"人工改参数"——拒绝理由逐字反馈给模型（spike S2a），
// 让模型自我修正后重提，而不是人替模型修参数。
export interface ApprovalRequest {
  readonly toolName: string;
  readonly toolCallId: string;
  // 模型原始参数（审批闸入场时的快照；批准后按原样执行，无改参通道）
  readonly args: unknown;
  // 写工具的执行前 diff 预览（工具实现 PreviewableTool 能力时提供）
  readonly diffPreview?: string;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  // 拒绝时必填更佳：理由逐字成为模型可见的 error toolResult
  readonly reason?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
