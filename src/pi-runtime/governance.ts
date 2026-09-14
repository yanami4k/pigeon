// ToolGovernance 接缝（M5.5 S0，决策 049）：审批闸整族逻辑（策略判定、grant 求值、人工审批、
// ToolExecution 账本、intent / decision / receipt / breaker 落盘、熔断）的实现归 application，
// pi-runtime 只定义接口并在上游 hook 处转发。Adapter 构造时把自己持有的宿主能力（冻结策略、
// 广告工具、落盘口、活动 runId、abort、内部异常观察口）交给工厂，一个 Adapter 绑一份治理实例。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  BreakerInput,
  DecisionInput,
  EntryAppendInput,
  IntentInput,
  ObservationInput,
  ReceiptInput,
} from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { RunId } from "../state/ids.ts";
import type { ToolSettledPayload } from "../state/runtime-events.ts";
import type { ToolExecution } from "../state/tool-execution.ts";
import type { ToolPolicy } from "./snapshot.ts";

// application 层不直连上游包：工具执行体类型经本文件转口
export type { AgentTool } from "@earendil-works/pi-agent-core";

// Event Log 落盘口的结构类型（persistence/JsonlEventLog 的写入面满足它，M4 S1：账本归并进
// Event Log，不双写）。只依赖 state 的输入形状，不依赖存储引擎——pi-runtime 不触达
// persistence；测试注入故障包装器模拟崩溃点。Adapter 写 entry / 运行事件 / 观察族，
// 治理实例写 intent / decision / receipt / breaker
export interface EventLogSink {
  appendRuntimeEvent(event: EventEnvelope): unknown;
  appendEntry(input: EntryAppendInput): unknown;
  appendIntent(input: IntentInput): unknown;
  appendDecision(input: DecisionInput): unknown;
  appendReceipt(input: ReceiptInput): unknown;
  appendBreaker(input: BreakerInput): unknown;
  // M5 观察族（决策 043 / 044）：可选——既有故障注入包装器不必实现
  appendObservation?(input: ObservationInput): unknown;
  // M5 S5（决策 044）：system prompt 全文写进旁置内容文件；可选，同上
  appendSystemPrompt?(input: { runId: RunId; text: string }): unknown;
}

// Adapter 交给治理实例的宿主能力
export interface GovernanceHost {
  // 冻结快照里的工具策略（InjectionSnapshot 唯一来源）
  readonly policy: ToolPolicy;
  // 实际广告给模型的工具执行体（执行体 ∩ 快照 allow），preview / 内容证据探针从这里取
  readonly tools: ReadonlyMap<string, AgentTool>;
  // Event Log 落盘口；缺省 = 不落盘
  readonly eventLog: EventLogSink | undefined;
  // 治理族落盘的 runId；Run 活动窗口外调用响亮失败
  activeRunId(): RunId;
  // 熔断落闸：中止整个 Run
  abort(): void;
  // 内部异常观察口（Adapter.listenerErrors）：落盘失败等不改变结果的故障记在这里
  reportError(error: unknown): void;
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

// 判定结果：放行，或带理由的阻断（理由由 Adapter 原样交回上游，逐字成为模型可见的 toolResult）
export type GovernanceVerdict = { kind: "allow" } | { kind: "block"; reason: string };

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
  // tool_execution_end 后：账本迁 settled、落 receipt、上游拦截熔断计数
  settle(settlement: ToolSettledPayload): void;
  runOutcome(): GovernanceRunOutcome;
  // 本 Session 全部账本记录（深拷贝）
  toolExecutions(): ToolExecution[];
}

export type ToolGovernanceFactory = (host: GovernanceHost) => ToolGovernance;
