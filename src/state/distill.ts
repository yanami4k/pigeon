// 提炼器的只读工具名与提炼目标（M7 S4，决策 074 / 076）：常量与类型放 state 叶子层，编排层的角色表、装配根与
// distillation 层的工具实现共用同一份，不引入反向依赖。两个工具的作用域只限一组尝试（成功侧、失败侧、
// 分叉共享前缀与任务描述所在的那条），参数里没有会话或 Run 入口。
import type { AttemptRef, OutcomeLabel } from "./attempt-ref.ts";
import type { RunId, SessionId } from "./ids.ts";

export const DISTILL_SNAPSHOT_TOOL = "distill_snapshot";
export const DISTILL_ENTRY_TOOL = "distill_entry";

// 一侧尝试的读取范围：治理根（可以是其他治理根，只读）、会话、Run、条目范围
export interface DistillAttemptScope {
  governanceRoot: string;
  sessionId: SessionId;
  runId: RunId;
  from: number;
  to: number;
  label: OutcomeLabel;
  verification?: AttemptRef["verification"];
}

export interface DistillTarget {
  // 同任务比对（task）或分叉（fork）
  kind: "task" | "fork";
  // 同任务比对的任务标识（并行派发的共享标识或 Eval 任务编号）
  taskKey?: string;
  // 任务描述所在：该会话该 Run 的第 1 条（只喂一次）
  task: { governanceRoot: string; sessionId: SessionId; runId: RunId };
  // 分叉共享前缀（来源 Run 的第 1 条到分叉点，只喂一次）
  sharedPrefix?: {
    governanceRoot: string;
    sessionId: SessionId;
    runId: RunId;
    from: number;
    to: number;
  };
  successful?: DistillAttemptScope;
  failed?: DistillAttemptScope;
  // 未进对比的其余同组尝试（只记在对比来源块里）
  others: AttemptRef[];
}
