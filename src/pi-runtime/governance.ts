// ToolGovernance 接缝（M5.5 S0，决策 049）：审批闸整族逻辑（策略判定、grant 求值、人工审批、
// 内存里的 ToolExecution 账本、熔断）的实现归 application，pi-runtime 只定义接口并在上游 hook 处转发。
// Adapter 构造时把自己持有的宿主能力（冻结策略、广告工具、活动 runId、abort、内部异常观察口）交给工厂，
// 一个 Adapter 绑一份治理实例。审批决定与错误归类随工具结果消息记进会话存储（运行面标记），治理实例自己不落盘。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunId } from "../state/ids.ts";
import type { ToolSettledPayload } from "../state/runtime-events.ts";
import type { ToolExecution, ToolExecutionDecision } from "../state/tool-execution.ts";
import type { ToolPolicy } from "./snapshot.ts";

// application 层不直连上游包：工具执行体类型经本文件转口
export type { AgentTool } from "@earendil-works/pi-agent-core";

// Adapter 交给治理实例的宿主能力
export interface GovernanceHost {
  // 冻结快照里的工具策略（InjectionSnapshot 唯一来源）
  readonly policy: ToolPolicy;
  // 实际广告给模型的工具执行体（执行体 ∩ 快照 allow），preview 与命令检查从这里取
  readonly tools: ReadonlyMap<string, AgentTool>;
  // 当前活动 Run（审批请求的出处）；Run 活动窗口外调用响亮失败
  activeRunId(): RunId;
  // 熔断落闸：中止整个 Run
  abort(): void;
  // 内部异常观察口（Adapter.listenerErrors）：不改变结果的故障记在这里
  reportError(error: unknown): void;
  // 工具事件钩子（决策 324）：在场时 PreToolUse 在审批之前、PostToolUse/PostToolUseFailure 在执行之后
  readonly toolHooks?: ToolHookPort;
}

// 一次工具调用的判定输入
export interface ToolCallProposal {
  toolCallId: string;
  toolName: string;
  // 模型原始参数（上游 toolCall.arguments）
  args: unknown;
  // 上游按工具 schema 校验后的参数（写工具 diff 预览用）
  preparedArgs: unknown;
}

// PreToolUse 钩子的结论（决策 324）：拒绝 > 要人确认 > 放行；放行只免掉人工审批这一步。
// decision 可缺省：钩子只改参数、不放行（updatedInput 单独在场时不改变治理结论，只换参数）
export interface PreToolUseHookDecision {
  decision?: "allow" | "ask" | "deny";
  reason?: string;
  // 钩子的 continue:false（压过 decision）：阻断本调用并在这批工具后停下——停止本轮处理
  terminate?: boolean;
  // 钩子改过的参数（在场时按新参数重新经过全部检查，预览与执行都用新参数；本身不含放行含义）
  updatedInput?: unknown;
}

// 工具事件钩子端口（决策 323 / 324）：实现在 application（会话级钩子调度）；
// PreToolUse 在审批之前执行，工具结束后的事件（PostToolUse / PostToolUseFailure）在执行之后
export interface ToolHookPort {
  preToolUse?(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<PreToolUseHookDecision | undefined>;
  // 工具结束：isError 区分成功与失败事件；text 为结果文本（PostToolUse 的 updatedToolOutput 按它替换）
  toolFinished?(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    isError: boolean;
    text: string;
  }): Promise<{ replaceText?: string; contextText?: string } | undefined>;
}

// 判定结果：放行，或带理由的阻断（理由由 Adapter 原样交回上游，逐字成为模型可见的 toolResult）；
// 钩子改过参数时 updatedArgs 交给执行侧替换（只由 PreToolUse 钩子产生）
export type GovernanceVerdict =
  | { kind: "allow"; updatedArgs?: unknown }
  // terminate：钩子的 continue:false——阻断本调用并提示上游在这批工具后停下（停止本轮处理）
  | { kind: "block"; reason: string; terminate?: boolean };

// 本 Run 的治理结论（RunResult 的活侧来源）
export interface GovernanceRunOutcome {
  breakerTripped: boolean;
  toolExecutions: ToolExecution[];
}

export interface ToolGovernance {
  // 每个 Run 开始时重置 Run 级状态（熔断计数、上游拦截连击、本 Run 账本序列）
  beginRun(): void;
  // beforeToolCall 转发口：自身不抛，内部异常一律转阻断（fail-closed）
  decide(call: ToolCallProposal): Promise<GovernanceVerdict>;
  // 账本是否有该调用的记录（有 ⟺ 审批闸跑过；无 ⟺ 被上游拦截）
  governs(toolCallId: string): boolean;
  // 审批闸对该调用的决定（结果与批准来源）；审批闸没跑过时为 undefined
  decisionOf(toolCallId: string): ToolExecutionDecision | undefined;
  // tool_execution_end 后：账本迁 settled、上游拦截熔断计数
  settle(settlement: ToolSettledPayload): void;
  runOutcome(): GovernanceRunOutcome;
  // 本 Session 全部账本记录（深拷贝）
  toolExecutions(): ToolExecution[];
}

export type ToolGovernanceFactory = (host: GovernanceHost) => ToolGovernance;
