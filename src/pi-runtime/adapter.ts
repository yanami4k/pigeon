// PiRuntimeAdapter（ROADMAP M1 + M3 切片 3 治理接线）：把 pi-agent-core 的 Agent 藏在闭包内，
// 业务层只接触 Adapter 方法。核心约束：
// 1. streamFn 永远显式传入，不依赖包内默认（stream-fn.js 的 getDefaultStreamFn 缺省陷阱）；
// 2. 成败不看 prompt() 的 Promise（失败路径照常 resolve），看末条 assistant 消息的 stopReason
//    + state.errorMessage；
// 3. 内部事件记录与对外订阅全部自包 try/catch——上游 processEvents 顺序 await listener 且无
//    防护，一个抛异常的 listener 会把健康 Run 毒化成 error 终态；
// 4. 注入快照在构造时深冻结；Agent 实例不外泄，hook 字段因此不可被运行中改写；
// 5. 中断固定姿势：abort() → waitForIdle()，终态 stopReason === "aborted"，任何路径不悬挂；
// 6. M3 治理闭环：beforeToolCall 审批闸（策略判定 → 人工审批/自动放行 → block）+
//    ToolExecution 账本 + 熔断 + run() 互斥（决策 1/2/4，spike S2a/S4/S5）。
// 7. 幽灵工具名（从未广告）hook 不可见：上游 prepareToolCall 在 hook 前拦截，
//    事件级连续计数熔断兜底（tmp/notfound-spike.mjs 实证 tool_execution_end 照常到达）。
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, StopReason } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { type JsonlLedger, LEDGER_INTENT_VERSION } from "../persistence/ledger.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newReceiptId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import {
  advanceToolExecution,
  proposeToolExecution,
  recordDecision,
  type ToolExecution,
} from "../state/tool-execution.ts";
import { evaluateToolPolicy } from "../tools/policy.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  isSyntheticFailureMessage,
  normalizePiEvent,
  RuntimeEventKind,
  type ToolSettledPayload,
} from "./events.ts";
import { type InjectionSnapshot, InjectionSnapshotSchema } from "./snapshot.ts";

// Run 终态：completed / failed / aborted 之外保留 unknown——
// ROADMAP M1 要求“中断和异常能够得到明确终态或 OutcomeUnknown”，
// 当 transcript 里连一条 assistant 消息都没有（或终态 stopReason 不在预期集合内）时如实上报。
export type RunTerminalStatus = "completed" | "failed" | "aborted" | "unknown";

export interface RunResult {
  runId: RunId;
  status: RunTerminalStatus;
  // 末条 assistant 消息的 stopReason（若有）
  stopReason?: StopReason;
  // 最近一次失败/中止 turn 的错误文本（agent.state.errorMessage）
  errorMessage?: string;
  // 末条 assistant 消息是否为上游合成的失败消息
  syntheticFailure: boolean;
  // 本次 Run 实际广告给模型的工具名单
  advertisedTools: string[];
  // 本次 Run 的 ToolExecution 账本记录（终态快照，深拷贝）
  toolExecutions: ToolExecution[];
}

// 账本落盘口的结构类型（= JsonlLedger 的写入面）；测试注入故障包装器模拟崩溃点
export type LedgerSink = Pick<JsonlLedger, "appendIntent" | "appendReceipt">;

export interface PiRuntimeAdapterOptions {
  snapshot: InjectionSnapshot;
  // 永远显式传入；测试注入假 streamFn，生产注入真实 provider 实现
  streamFn: StreamFn;
  // 真实部署时补充 api/baseUrl 等模型元数据；provider/id 属于模型身份，
  // 由 InjectionSnapshot 唯一提供（类型层 Omit 拒绝 + 构造器运行期兜底）
  model?: Omit<Partial<Model<Api>>, "provider" | "id">;
  sessionId?: SessionId;
  // M3：工具注册表（策略判定的 tier/元数据来源）；缺省 = 空注册表（一切工具调用 fail-closed）
  registry?: ToolRegistry;
  // M3：工具执行体清单；按快照 tools.policy.allow 过滤后广告给模型（deny 不过滤，闸口逐调用拒绝并留账）
  tools?: AgentTool[];
  // M3：人工审批注入点（策略判定为 prompt 时调用）；缺省时 prompt 一律 fail-closed 拒绝
  approvalHandler?: ApprovalHandler;
  // M3 切片 5：JSONL 账本落盘点（缺省 = 纯内存账本，不落盘）。
  // 结构类型而非 JsonlLedger 具体类：测试可注入故障包装器模拟崩溃点
  ledger?: LedgerSink;
  // 熔断阈值：同一 工具名+参数指纹 在同一 Run 内被阻断的次数上限（spike S4：上游无循环护栏）
  circuitBreakerThreshold?: number;
}

export class PiRuntimeAdapter {
  readonly sessionId: SessionId;
  readonly #agent: Agent;
  readonly #snapshot: InjectionSnapshot;
  readonly #events: EventEnvelope[] = [];
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  readonly #listenerErrors: unknown[] = [];
  readonly #unsubscribe: () => void;
  // M3 治理件：注册表（策略判定元数据）/ 审批注入点 / 熔断阈值
  readonly #registry: ToolRegistry;
  readonly #breakerThreshold: number;
  readonly #approvalHandler: ApprovalHandler | undefined;
  readonly #tools: ReadonlyMap<string, AgentTool>;
  // ToolExecution 账本：toolCallId → 记录（M3 内存态；持久化是切片 5）
  readonly #executions = new Map<string, ToolExecution>();
  readonly #ledger: LedgerSink | undefined;
  // 熔断计数：同一 Run 内同一 工具名+参数指纹 的连续阻断次数（spike S4：上游无循环护栏）
  readonly #blockCounts = new Map<string, number>();
  // 幽灵工具熔断（事件级）连击状态：toolName + 连续次数。模型请求"从未广告"的工具名时，
  // 上游 prepareToolCall 在 beforeToolCall 之前以 "Tool not found" 拦截（agent-loop.js:392-399），
  // 审批闸/账本/#blockCounts 全部不可见；但 tool_execution_end 照常发出
  // （tmp/notfound-spike.mjs 实证：isError=true、resultText="Tool <name> not found"）。
  // 故在 #recordAndForward 事件层计数：同名幽灵 settled 连续达 #breakerThreshold 即 abort。
  #phantomStreak = { toolName: "", count: 0 };
  // 本次 Run 的账本 toolCallId 序列（RunResult.toolExecutions 的选取依据）
  #runToolCallIds: string[] = [];
  #currentRunId: RunId | null = null;
  #disposed = false;

  constructor(options: PiRuntimeAdapterOptions) {
    // 运行期兜底（JS 调用方可绕过类型门）：options.model 不得携带模型身份字段，
    // 否则 spread 会让实际 Agent 模型与 InjectionSnapshot 脱钩
    if (options.model !== undefined && ("provider" in options.model || "id" in options.model)) {
      throw new Error(
        "options.model 不允许携带 provider/id：模型身份由 InjectionSnapshot 唯一提供"
      );
    }
    // 运行期校验 + 防御性拷贝 + 深冻结：此后快照不可变
    const snapshot = Value.Parse(InjectionSnapshotSchema, options.snapshot);
    this.#snapshot = deepFreeze(structuredClone(snapshot));
    this.sessionId = options.sessionId ?? newSessionId();

    // M3 治理件
    this.#registry = options.registry ?? new ToolRegistry();
    this.#approvalHandler = options.approvalHandler;
    this.#breakerThreshold = options.circuitBreakerThreshold ?? 3;
    this.#ledger = options.ledger;
    // 广告集 = 执行体 ∩ 快照 allow。deny 不在此过滤：deny 是逐调用绝对拒绝（决策 4），
    // 必须在审批闸执行并留 policy:deny 账本——若在广告层过滤，模型请求会被上游以
    // "Tool not found" 拦截，hook 不可见、无账本、hook 级熔断也失效（agent-loop.js:393-399）。
    // 模型重发"从未广告"工具名的幽灵循环由事件级熔断收口：tool_execution_end 照常到达事件层，
    // #recordAndForward 按工具名连续计数、达阈值 abort（见 #phantomStreak 注释与 spike）。
    const policy = this.#snapshot.tools.policy;
    const advertised = (options.tools ?? []).filter((tool) => policy.allow.includes(tool.name));
    for (const tool of advertised) {
      if (!this.#registry.has(tool.name)) {
        throw new Error(`广告的工具未在注册表登记：${tool.name}`);
      }
    }
    this.#tools = new Map(advertised.map((tool) => [tool.name, tool]));

    this.#agent = new Agent({
      streamFn: options.streamFn,
      // 决策 2：写死 sequential——审批瓶颈是人，parallel 的交错观感错乱且写审批有顺序依赖。
      // 依据：agent.js:134 构造选项读取、agent.js:299 传入 loop config、
      // agent-loop.js:288 sequential 走逐 call 的 start→hook→execute→end 执行器
      toolExecution: "sequential",
      // M3 审批闸（spike S2a：block 可靠，reason 逐字反馈模型）
      beforeToolCall: (context, signal) => this.#governToolCall(context, signal),
      initialState: {
        systemPrompt: this.#snapshot.context.systemPrompt,
        model: {
          id: this.#snapshot.model.id,
          name: this.#snapshot.model.id,
          api: "unknown",
          provider: this.#snapshot.model.provider,
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 0,
          maxTokens: 0,
          ...options.model,
        },
        // 广告给模型的工具集：执行体 ∩ 快照 allow ∩ 已注册（deny 不过滤，闸口逐调用拒绝并留账）
        tools: [...this.#tools.values()],
      },
    });
    // 内部订阅挂一次，覆盖 Adapter 整个生命周期；回调绝不抛异常
    this.#unsubscribe = this.#agent.subscribe((event: AgentEvent) => {
      this.#recordAndForward(event);
    });
  }

  // 启动一次 Run 并等待其彻底收尾；返回终态判定结果。
  async run(input: string): Promise<RunResult> {
    this.#assertUsable();
    // 决策 2：run() 互斥——任何时刻最多一个待审批/执行中的 call
    if (this.#currentRunId !== null) {
      throw new Error("已有进行中的 Run：run() 互斥（决策 2）");
    }
    const runId = newRunId();
    this.#currentRunId = runId;
    this.#blockCounts.clear();
    this.#phantomStreak.toolName = "";
    this.#phantomStreak.count = 0;
    this.#runToolCallIds = [];
    // 实际广告名单以 Run 启动时 Agent 持有的工具为准（上游对此拍快照，运行中改不动）
    const advertisedTools = this.#agent.state.tools.map((tool) => tool.name);
    try {
      await this.#agent.prompt(input);
      await this.#agent.waitForIdle();
      return this.#judgeTerminal(runId, advertisedTools);
    } finally {
      this.#currentRunId = null;
    }
  }

  // 中断当前 Run：固定姿势 abort → waitForIdle；终态由并发等待的 run() 返回承载。
  async interrupt(): Promise<void> {
    this.#agent.abort();
    await this.#agent.waitForIdle();
  }

  // 观察口：归一化后的 Pigeon Runtime Event 序列（拷贝，不外泄内部数组）
  events(): EventEnvelope[] {
    return this.#events.slice();
  }

  // 观察口：订阅归一化事件；listener 抛异常被吞掉并记录，绝不影响 Run
  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // 被吞掉的 listener 异常记录（含内部归一化异常）
  listenerErrors(): unknown[] {
    return this.#listenerErrors.slice();
  }

  // 观察口：本 Session 全部 ToolExecution 账本记录（深拷贝；账本原文由 Adapter 持有）
  toolExecutions(): ToolExecution[] {
    return structuredClone([...this.#executions.values()]);
  }

  // 冻结的注入快照
  snapshot(): InjectionSnapshot {
    return this.#snapshot;
  }

  // Pi transcript 的深拷贝（观察用途；它不是治理事实源，权威状态以事件日志为准）。
  // 必须深拷贝：浅拷贝会与 Agent 内部共享 message/content 对象，
  // 调用方在观察拷贝上的就地修改会污染 Agent 会话状态，进而毒化后续 Run 的上下文。
  // 拷贝不冻结：观察方对自己的副本做变换是合法的。
  transcript(): AgentMessage[] {
    return structuredClone(this.#agent.state.messages);
  }

  isRunning(): boolean {
    return this.#agent.state.isStreaming;
  }

  // 释放：中止可能的在途 Run，退订并清空外部 listener
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#agent.abort();
    await this.#agent.waitForIdle();
    this.#unsubscribe();
    this.#listeners.clear();
  }

  // Pi 事件入口：归一化 + 落日志 + 账本联动 + 转发。整个路径自包 try/catch，
  // 任何异常（含归一化自身）都只进 listenerErrors，绝不冒泡回上游毒化 Run。
  #recordAndForward(event: AgentEvent): void {
    try {
      const runId = this.#currentRunId;
      if (!runId) {
        return;
      }
      const normalized = normalizePiEvent(event, { sessionId: this.sessionId, runId });
      if (!normalized) {
        return;
      }
      // 账本联动：tool_execution_end 到达即 settled——被阻断者从 approval 落（决策已 rejected），
      // 执行完毕者从 execution 落；spike S1/S2a：无论放行与否 end 事件都保证到达。
      // 例外留痕：approved 但停在 approval = intent 写盘失败被 fail-closed 阻断（从未 dispatch），
      // 不迁移状态（审计可见的异常记录），也不产生 receipt。
      if (normalized.kind === RuntimeEventKind.ToolSettled) {
        const payload = normalized.payload as ToolSettledPayload;
        const existing = this.#executions.get(payload.toolCallId);
        if (
          existing !== undefined &&
          (existing.state === "execution" ||
            (existing.state === "approval" && existing.decision?.outcome === "rejected"))
        ) {
          const settled = advanceToolExecution(existing, "settled", Date.now());
          this.#executions.set(payload.toolCallId, settled);
          this.#persistReceipt(settled, payload.isError);
        }
        this.#countPhantomAndMaybeBreak(payload);
      }
      // 单一冻结点：日志与 listener 共享同一冻结对象，事件日志按治理语义不可变。
      // 篡改尝试在严格模式下抛 TypeError，被下方 listener 自包 try/catch 吞进 listenerErrors。
      this.#events.push(deepFreeze(normalized));
      for (const listener of this.#listeners) {
        try {
          listener(normalized);
        } catch (error) {
          this.#listenerErrors.push(error);
        }
      }
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 终态判定：以末条 assistant 消息的 stopReason 为准，agent_end/prompt() resolve 均无成败语义
  #judgeTerminal(runId: RunId, advertisedTools: string[]): RunResult {
    const messages = this.#agent.state.messages;
    const lastAssistant = messages.findLast(
      (message): message is AssistantMessage => message.role === "assistant"
    );
    const stopReason = lastAssistant?.stopReason;
    const errorMessage = this.#agent.state.errorMessage;
    let status: RunTerminalStatus;
    if (stopReason === "aborted") {
      status = "aborted";
    } else if (stopReason === "error") {
      status = "failed";
    } else if (stopReason === "stop" || stopReason === "length" || stopReason === "deferred") {
      status = "completed";
    } else {
      status = "unknown";
    }
    return {
      runId,
      status,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      syntheticFailure: lastAssistant !== undefined && isSyntheticFailureMessage(lastAssistant),
      advertisedTools,
      // 本次 Run 的账本记录终态快照（waitForIdle 之后所有 tool.settled 已处理，记录已定型）
      toolExecutions: structuredClone(
        this.#runToolCallIds
          .map((id) => this.#executions.get(id))
          .filter((record) => record !== undefined)
      ),
    };
  }

  // M3 审批闸入口：自包 try/catch——spike 证明 hook 抛错上游会兜底降级，但那是
  // "错误文案反馈模型"，不是治理决定；账本/审批代码自身异常一律转为 block（fail-closed）
  async #governToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    try {
      return await this.#governToolCallInner(context, signal);
    } catch (error) {
      return {
        block: true,
        reason: `审批闸内部异常（fail-closed 阻断）：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async #governToolCallInner(
    context: BeforeToolCallContext,
    _signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    const toolName = context.toolCall.name;
    const toolCallId = context.toolCall.id;
    // rawArgs 快照（spike S5）：账本留模型原始参数。决策 1 无改参通道，
    // 原始参数 = 批准参数 = 执行参数，无需写回 ctx.args。
    const rawArgs = structuredClone(context.toolCall.arguments);
    const proposed = proposeToolExecution({ toolCallId, toolName, rawArgs, at: Date.now() });
    let record = advanceToolExecution(proposed, "approval", Date.now());
    this.#executions.set(toolCallId, record);
    this.#runToolCallIds.push(toolCallId);

    const policy = this.#snapshot.tools.policy;
    const decision = evaluateToolPolicy(this.#registry, toolName, policy);

    // deny 清单绝对 / 未注册 fail-closed：自动拒绝，不弹人工审批
    if (decision.kind === "deny") {
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "policy:deny",
        reason: decision.reason,
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      return this.#blockWithBreaker(toolName, rawArgs, decision.reason);
    }

    // 自动放行：yolo 批发授权（policy:yolo）或 prompt 模式下 read 层（policy:auto）。
    // sequential 模式下 hook 放行即进入执行（上游无独立 execution-start 事件），
    // 故 dispatch/execution 两个时间戳在放行时一并盖章
    if (decision.kind === "auto-allow") {
      record = recordDecision(record, {
        outcome: "approved",
        approvedBy: policy.approvalMode === "yolo" ? "policy:yolo" : "policy:auto",
        decidedAt: Date.now(),
      });
      // ROADMAP §3.2：dispatch 前先持久化意图；写盘失败 = fail-closed（异常由外层转 block）
      this.#persistIntent(record);
      record = advanceToolExecution(record, "dispatch", Date.now());
      record = advanceToolExecution(record, "execution", Date.now());
      this.#executions.set(toolCallId, record);
      return undefined;
    }

    // prompt：必须人工批准；未配置审批通道 = fail-closed 拒绝
    if (this.#approvalHandler === undefined) {
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "policy:deny",
        reason: "策略要求人工审批但未配置审批通道（fail-closed）",
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      return this.#blockWithBreaker(toolName, rawArgs, "策略要求人工审批但未配置审批通道");
    }
    // 写工具的 diff 预览：工具有 preview 能力就带上；预览失败不阻断审批（审批仍可看参数）
    let diffPreview: string | undefined;
    const tool = this.#tools.get(toolName);
    if (tool !== undefined && "preview" in tool && typeof tool.preview === "function") {
      try {
        diffPreview = await tool.preview(context.args);
      } catch {
        diffPreview = undefined;
      }
    }
    const approval = await this.#approvalHandler({
      toolName,
      toolCallId,
      args: rawArgs,
      ...(diffPreview !== undefined ? { diffPreview } : {}),
    });
    if (!approval.approved) {
      const reason = approval.reason ?? "人工拒绝";
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "human",
        reason,
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      return this.#blockWithBreaker(toolName, rawArgs, reason);
    }
    record = recordDecision(record, {
      outcome: "approved",
      approvedBy: "human",
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      decidedAt: Date.now(),
    });
    // ROADMAP §3.2：dispatch 前先持久化意图；写盘失败 = fail-closed（异常由外层转 block）
    this.#persistIntent(record);
    record = advanceToolExecution(record, "dispatch", Date.now());
    record = advanceToolExecution(record, "execution", Date.now());
    this.#executions.set(toolCallId, record);
    return undefined;
  }

  // dispatch 前持久化调用意图（ROADMAP §3.2）。写盘失败向上抛——外层 catch 转成 block，
  // 即 fail-closed：账本写不进就不放行，未留证的副作用一律不得发生
  #persistIntent(record: ToolExecution): void {
    if (this.#ledger === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      throw new Error("账本 intent 缺失决定快照");
    }
    this.#ledger.appendIntent({
      kind: "intent",
      version: LEDGER_INTENT_VERSION,
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      rawArgs: record.rawArgs,
      decision,
      at: Date.now(),
    });
  }

  // tool_execution_end 后写 Receipt 并回填 receiptId（三层关联 executionId/toolCallId/receiptId）。
  // executed 判据：到达 execution 阶段且执行结果无错误。M3 两个自建工具的唯一副作用都在
  // 最后一次写盘调用（edit_file 全部预检通过才落盘），故"执行过且无错"≡副作用发生；
  // 阻断/拒绝路径 executionStartedAt 为空 → executed=false（副作用从未发生）。
  // 崩溃点：进程死于 end 事件前则 receipt 永不落盘——冷启动 reconcile 报 OutcomeUnknown。
  #persistReceipt(record: ToolExecution, isError: boolean): void {
    if (this.#ledger === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      return;
    }
    const executed = record.executionStartedAt !== undefined && !isError;
    const receipt: Receipt = {
      version: RECEIPT_VERSION,
      id: newReceiptId(),
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      approvedBy: decision.approvedBy,
      executed,
      isError,
      startedAt: record.executionStartedAt ?? record.proposedAt,
      finishedAt: record.settledAt ?? Date.now(),
      summary: executed
        ? `${record.toolName} 执行完成`
        : `${record.toolName} 未产生副作用（${decision.outcome === "rejected" ? "已拒绝" : "执行出错"}）`,
    };
    this.#ledger.appendReceipt(receipt);
    // settled 后回填 receiptId：schema 允许的回填，不是状态迁移
    this.#executions.set(record.toolCallId, { ...record, receiptId: receipt.id });
  }

  // 阻断 + 熔断（spike S4：上游无循环护栏，模型可无限重发被拦调用）。
  // 同一 Run 内同一 工具名+参数指纹 阻断达阈值即中止整个 Run。
  // 取舍：选 agent.abort() 而非 terminate:true——terminate 只在"批次内全部 result 都 terminate"
  // 时停批次，且终态 stopReason 停在 toolUse（无"已熔断"语义）；abort 的终态是明确的 aborted。
  // 代价：abort 后本次 block 的 reason 被上游覆盖为 "Operation aborted"（agent-loop.js:410-416）。
  #blockWithBreaker(toolName: string, rawArgs: unknown, reason: string): BeforeToolCallResult {
    const fingerprint = `${toolName}\n${JSON.stringify(rawArgs)}`;
    const count = (this.#blockCounts.get(fingerprint) ?? 0) + 1;
    this.#blockCounts.set(fingerprint, count);
    if (count >= this.#breakerThreshold) {
      this.#agent.abort();
    }
    return { block: true, reason };
  }

  // 幽灵工具熔断（事件级，tmp/notfound-spike.mjs 实证）：模型请求"从未广告"的工具名时，
  // 上游 prepareToolCall 在 beforeToolCall 之前以 "Tool <name> not found" 拦截
  // （agent-loop.js:392-399）——审批闸/账本/#blockWithBreaker 全部不可见，
  // 但 tool_execution_end 照常到达（isError=true），故在事件层兜底计数。
  // 判据：settled 且 isError 且 toolName 不在广告集。同一工具名连续达阈值即 abort
  // （与 hook 级熔断共用 #breakerThreshold）；任何非幽灵 settled 重置连击。
  // 审计留痕：此路径 hook 从未运行，不可能有 ToolExecution 账本记录；
  // 事件日志里的 tool.proposed/tool.settled 序列即为幽灵循环的审计轨迹。
  #countPhantomAndMaybeBreak(payload: ToolSettledPayload): void {
    if (payload.isError && !this.#tools.has(payload.toolName)) {
      if (this.#phantomStreak.toolName === payload.toolName) {
        this.#phantomStreak.count += 1;
      } else {
        this.#phantomStreak.toolName = payload.toolName;
        this.#phantomStreak.count = 1;
      }
      if (this.#phantomStreak.count >= this.#breakerThreshold) {
        this.#agent.abort();
      }
    } else {
      this.#phantomStreak.toolName = "";
      this.#phantomStreak.count = 0;
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("PiRuntimeAdapter 已释放，不能再启动 Run");
    }
  }
}

// 递归冻结快照（含嵌套对象与数组）
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
