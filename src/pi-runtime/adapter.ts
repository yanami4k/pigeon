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
// 7. 上游拦截（幽灵工具名 not-found / 已广告但参数校验失败）hook 不可见：上游
//    prepareToolCall 在 hook 前拦截，事件级连续计数熔断兜底
//    （tmp/notfound-spike.mjs 实证 tool_execution_end 照常到达）。
// 8. M4 S5（D3 Pi entry 映射）：每条 message_end 事件落地时刻分配 EntryId 并同步落盘
//    entry 记录（(runId, runSeq) 权威键）；abort 与上游合成失败消息同样占序号；
//    记录逻辑自身绝不抛（上游 listener 路径无防护，同约束 3）。
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
import { classifyRunOutcome, type FailureClass } from "../state/classification.ts";
import type {
  BreakerInput,
  DecisionInput,
  EntryInput,
  IntentInput,
  ReceiptInput,
} from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { newReceiptId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { RuntimeEventKind, type ToolSettledPayload } from "../state/runtime-events.ts";
import {
  advanceToolExecution,
  proposeToolExecution,
  recordDecision,
  type ToolErrorKind,
  type ToolExecution,
} from "../state/tool-execution.ts";
import { classifyToolError } from "../tools/error-kind.ts";
import { type GrantMatchOutcome, matchConfigGrants } from "../tools/grants.ts";
import { evaluateToolPolicy } from "../tools/policy.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ContentEvidence } from "../tools/wrap.ts";
import { isSyntheticFailureMessage, normalizePiEvent } from "./events.ts";
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
  // 失败四分类（M4 S2，D7）：与冷物化同一套判据纯函数（classification.ts）；null = 非失败
  failure: FailureClass | null;
  // 本次 Run 实际广告给模型的工具名单
  advertisedTools: string[];
  // 本次 Run 的 ToolExecution 账本记录（终态快照，深拷贝）
  toolExecutions: ToolExecution[];
}

// Event Log 落盘口的结构类型（persistence/JsonlEventLog 的写入面满足它，M4 S1：账本归并进
// Event Log，不双写）。只依赖 state 的输入形状，不依赖存储引擎——pi-runtime 不触达
// persistence；测试注入故障包装器模拟崩溃点
export interface EventLogSink {
  appendRuntimeEvent(event: EventEnvelope): unknown;
  appendEntry(input: EntryInput): unknown;
  appendIntent(input: IntentInput): unknown;
  appendDecision(input: DecisionInput): unknown;
  appendReceipt(input: ReceiptInput): unknown;
  appendBreaker(input: BreakerInput): unknown;
}

// M4 S6（决策 3）：会话 grant 匹配注入面——approvals/grant-store.ts 的 SessionGrantStore
// 满足该结构；测试可注入假实现。match 纯求值（无副作用）；命中计数由 Adapter 在
// 放行实际生效后调 noteEffectiveHit（deny 压过 grant 的求值不计命中——审计口径：命中 = 实际免审放行）
export interface SessionGrantMatcher {
  match(toolName: string, args: unknown): GrantMatchOutcome | null;
  noteEffectiveHit(outcome: GrantMatchOutcome): void;
}

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
  // M4 S1：Event Log 落盘点（缺省 = 纯内存事件序列，不落盘）。
  // 结构类型而非 JsonlEventLog 具体类：测试可注入故障包装器模拟崩溃点
  eventLog?: EventLogSink;
  // M4 S6（决策 3）：会话 grant 存储——审批提示 [a]/[d] 键创建的放权由此注入求值；
  // 治理面运行时状态，不进 InjectionSnapshot（约束 4：grant 必须可撤销，与快照冻结矛盾）
  sessionGrants?: SessionGrantMatcher;
  // M4 S6（D6）：固化配置规则（.pigeon/grants.json，启动时装载、会话内冻结）；
  // 命中记 approvedBy=policy:config，intent 回指规则的 promotedFrom.grantId（收口决策 ①：稳定身份）
  configGrants?: readonly ConfigGrantRule[];
  // 目录限定匹配（pathPrefix）的 realpath 解析根；缺省 = 带 pathPrefix 的规则一律不匹配
  // （fail-closed 到人工审批——授权判定不猜）
  workspaceRoot?: string;
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
  // M4 S6（决策 3）：grant 求值件（会话 grant 匹配 + 固化配置规则 + 目录解析根）
  readonly #sessionGrants: SessionGrantMatcher | undefined;
  readonly #configGrants: readonly ConfigGrantRule[];
  readonly #workspaceRoot: string | undefined;
  // ToolExecution 账本：toolCallId → 记录（M3 内存态；持久化是切片 5）
  readonly #executions = new Map<string, ToolExecution>();
  readonly #eventLog: EventLogSink | undefined;
  // key 带粒度前缀——`tool\n<名字>`：policy:deny 系绝对拒绝（deny 清单 / 无审批通道
  // fail-closed），参数改不改都照样拒，任何重试皆徒劳，按工具名计数；
  // `fingerprint\n<名字>\n<参数 JSON>`：人工拒绝与闸内异常，决策 1 鼓励模型改参重提，
  // 指纹级计数给修订循环留路（见 #blockWithBreaker 注释）。
  readonly #blockCounts = new Map<string, number>();
  // 上游拦截熔断（事件级）连击状态：toolName + 连续次数。两类拦截 hook 都不可见：
  //   ① 幽灵工具名（从未广告）：prepareToolCall 以 "Tool not found" 拦截（agent-loop.js:392-399）；
  //   ② 已广告但参数畸形：validateToolArguments 在 hook 前抛错（agent-loop.js:399-448）。
  // 两者审批闸/账本/#blockCounts 全部不可见；但 tool_execution_end 照常发出
  // （tmp/notfound-spike.mjs 实证：isError=true）。故判据取"settled 且 isError 且
  // 账本无此 toolCallId 记录"——无记录 ⟺ hook 从未运行 ⟺ 被上游拦截，一并兜底。
  #interceptedStreak = { toolName: "", count: 0 };
  // 本次 Run 的账本 toolCallId 序列（RunResult.toolExecutions 的选取依据）
  #runToolCallIds: string[] = [];
  // D3 entry 映射（M4 S5）：本 Run 的 message_end 累计序号——runSeq 权威键的 run 内分量。
  // 序号推进无条件（abort/合成失败消息也占序号；写盘失败不占位重试——缺一条即留证缺口，
  // 绝不重排后续序号），保证"entry 序 = transcript 追加序"在任何故障路径下成立
  #runEntrySeq = 0;
  // 工具抛错分类留证（M4 S2，D7）：toolCallId → 域/环境归类。
  // 上游把工具异常转成 isError 结果后只剩消息字符串，错误类信息必须在抛出源头捕获
  // （包装 execute，见 #wrapToolErrorCapture）；判不出存 undefined → settled 不落 errorKind
  readonly #toolErrorKinds = new Map<string, ToolErrorKind | undefined>();
  // 本次 Run 是否发生过熔断落闸（D7 Run 级「治理熔断」子类的活侧判据；breaker 记录是冷侧判据）
  #breakerTripped = false;
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
    this.#eventLog = options.eventLog;
    // M4 S6（决策 3）：grant 求值件——会话 grant 优先于固化配置规则（排律第 3 档内次序）
    this.#sessionGrants = options.sessionGrants;
    this.#configGrants = options.configGrants ?? [];
    this.#workspaceRoot = options.workspaceRoot;
    // 广告集 = 执行体 ∩ 快照 allow。deny 不在此过滤：deny 是逐调用绝对拒绝（决策 4），
    // 必须在审批闸执行并留 policy:deny 账本——若在广告层过滤，模型请求会被上游以
    // "Tool not found" 拦截，hook 不可见、无账本、hook 级熔断也失效（agent-loop.js:393-399）。
    // 模型重发"从未广告"工具名的幽灵循环由事件级熔断收口：tool_execution_end 照常到达事件层，
    // #recordAndForward 按工具名连续计数、达阈值 abort（见 #interceptedStreak 注释与 spike）。
    const policy = this.#snapshot.tools.policy;
    const advertised = (options.tools ?? []).filter((tool) => policy.allow.includes(tool.name));
    for (const tool of advertised) {
      if (!this.#registry.has(tool.name)) {
        throw new Error(`广告的工具未在注册表登记：${tool.name}`);
      }
    }
    // 包装 execute 捕获错误分类（M4 S2，D7）：上游把工具异常转成 isError 结果后只剩
    // 消息字符串，域/环境归类必须在抛出源头留证；preview/探针等可选能力随 spread 保留
    this.#tools = new Map(advertised.map((tool) => [tool.name, this.#wrapToolErrorCapture(tool)]));

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
    this.#interceptedStreak.toolName = "";
    this.#interceptedStreak.count = 0;
    this.#breakerTripped = false;
    this.#runToolCallIds = [];
    this.#runEntrySeq = 0;
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

  // 工具执行体包装（M4 S2，D7）：捕获抛出的真实错误对象并按域/环境归类存证——
  // 上游 agent-loop 把工具异常转成 isError 结果（createErrorToolResult）后只剩消息字符串，
  // 错误类信息过了那道边界就不可恢复。spread 保留 preview/内容证据探针等可选能力
  #wrapToolErrorCapture(tool: AgentTool): AgentTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (error) {
          this.#toolErrorKinds.set(toolCallId, classifyToolError(error));
          throw error;
        }
      },
    };
  }

  // Pi 事件入口：归一化 + 落日志 + 账本联动 + 转发。整个路径自包 try/catch，
  // 任何异常（含归一化自身）都只进 listenerErrors，绝不冒泡回上游毒化 Run。
  #recordAndForward(event: AgentEvent): void {
    try {
      const runId = this.#currentRunId;
      if (!runId) {
        return;
      }
      // D3 entry 映射（M4 S5）：身份只在 message_end 时刻确立（spike P1/P3：流式阶段的
      // start/update 是浅拷贝 partial，不锚身份）。每条 message_end——含归一化不落事件的
      // user/toolResult、abort 与上游合成失败消息——都占一个 runSeq 序号并同步落盘。
      // 时序：上游 processEvents 先 push transcript 再 await listener（agent.js 379-420），
      // 本回调在同一事件分派内同步落盘，先于任何后续 transcript 变更（"同于"语义的实现）。
      // 序号推进无条件、写盘隔离 try/catch（同本函数不变式：记录逻辑自身绝不抛）——
      // 写盘失败进 listenerErrors 留证缺口，绝不毒化 Run 或重排后续序号。
      if (event.type === "message_end") {
        this.#runEntrySeq += 1;
        if (this.#eventLog !== undefined) {
          try {
            this.#eventLog.appendEntry({
              runSeq: this.#runEntrySeq,
              role: event.message.role,
              runId,
            });
          } catch (error) {
            this.#listenerErrors.push(error);
          }
        }
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
        // D7 错误分类 enrich（M4 S2）：优先工具抛出处捕获的归类（包装 execute 留证）；
        // 账本无记录 ⟺ 上游拦截（参数校验失败/幽灵工具名——模型侧错误）→ domain；
        // 判不出的真实工具错误不落字段，冷分类留「未知」默认桶
        const errorKind =
          this.#toolErrorKinds.get(payload.toolCallId) ??
          (this.#executions.has(payload.toolCallId) ? undefined : "domain");
        if (payload.isError && errorKind !== undefined) {
          payload.errorKind = errorKind;
        }
        // 账本联动隔离在独立 try/catch（P2-2）：receipt 写盘失败只进 listenerErrors，
        // 绝不让 settled 事件本体因此丢失——下方"事件落日志与转发无条件"是不变式
        try {
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
        } catch (error) {
          this.#listenerErrors.push(error);
        }
        this.#countUpstreamInterceptedAndMaybeBreak(payload);
      }
      // Event Log 落盘（观察族，D2：同步写不 fsync）：写失败只进 listenerErrors——
      // 与账本联动同级的隔离，事件本体照常入内存日志并转发（下方不变式不受影响）
      if (this.#eventLog !== undefined) {
        try {
          this.#eventLog.appendRuntimeEvent(normalized);
        } catch (error) {
          this.#listenerErrors.push(error);
        }
      }
      // 不变式：事件落日志与转发无条件——账本联动故障（上方已隔离）或任何其他异常
      // 都不得让事件从 #events 或 listener 丢失（决策 ①：事件日志是审计轨迹）。
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
    const syntheticFailure =
      lastAssistant !== undefined && isSyntheticFailureMessage(lastAssistant);
    return {
      runId,
      status,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      syntheticFailure,
      // M4 S2（D7）：活侧失败四分类——与冷物化同一判据纯函数；
      // 活侧事实直接取自终态判定与 #breakerTripped（breaker 记录是冷侧对应物）
      failure: classifyRunOutcome({
        ...(stopReason !== undefined ? { stopReason } : {}),
        syntheticFailure,
        breakerTripped: this.#breakerTripped,
        hasTurnCompleted: lastAssistant !== undefined,
        // 活侧在 prompt() resolve 之后计算，agent_end 已发出（abort 路径同样发）
        hasRunEnded: true,
      }),
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
      // fail-closed 语义不变（异常一律转 block），但阻断必须过熔断计数（P2-1b）：
      // 账本写盘持续失败 + 顽固模型 = 无限阻断循环。rawArgs 可能正是异常源
      // （structuredClone 失败），故取原始参数做指纹，由 #blockWithBreaker 兜底不抛
      return this.#blockWithBreaker(
        context.toolCall.name,
        context.toolCall.id,
        context.toolCall.arguments,
        `审批闸内部异常（fail-closed 阻断）：${error instanceof Error ? error.message : String(error)}`,
        "fingerprint"
      );
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
    // 排律（决策 3）：deny 清单 → 会话 grant → 配置 grant → yolo → read 自动 → prompt——
    // 前二档收在 evaluateToolPolicy 内（deny 绝对优先，grant 不豁免）；grant 匹配在此注入：
    // 会话 grant 优先于固化配置规则。匹配纯求值不计命中，命中计数在放行实际生效后记
    const grantHit =
      this.#sessionGrants?.match(toolName, rawArgs) ??
      matchConfigGrants(this.#configGrants, this.#workspaceRoot, toolName, rawArgs);
    const decision = evaluateToolPolicy(this.#registry, toolName, policy, grantHit ?? undefined);

    // deny 清单绝对 / 未注册 fail-closed：自动拒绝，不弹人工审批
    if (decision.kind === "deny") {
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "policy:deny",
        reason: decision.reason,
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      this.#persistDecision(record);
      return this.#blockWithBreaker(toolName, toolCallId, rawArgs, decision.reason, "tool");
    }

    // 自动放行：grant 命中（human:grant / policy:config，回指出处）> yolo 批发授权
    // （policy:yolo）> prompt 模式下 read 层（policy:auto）。
    // sequential 模式下 hook 放行即进入执行（上游无独立 execution-start 事件），
    // 故 dispatch/execution 两个时间戳在放行时一并盖章
    if (decision.kind === "auto-allow") {
      const grant = decision.grant;
      const approvedBy =
        grant?.source === "session-grant"
          ? "human:grant"
          : grant?.source === "config-rule"
            ? "policy:config"
            : policy.approvalMode === "yolo"
              ? "policy:yolo"
              : "policy:auto";
      record = recordDecision(record, {
        outcome: "approved",
        approvedBy,
        // 每次免审放行回指具体 grant/配置条目（决策 3）：可审计"这次写操作凭什么没问人"
        ...(grant !== undefined ? { grantRef: { kind: grant.source, id: grant.refId } } : {}),
        decidedAt: Date.now(),
      });
      // 决策 1 证据链分层（M4 S6 G）：读层调用只留事件级记录——无副作用，intent/receipt
      // 级持久化冗余；写/exec 层维持 §3.2 三族齐全（intent 写盘失败 = fail-closed 不放行）
      if (this.#registry.get(toolName)?.tier !== "read") {
        await this.#persistIntent(record);
      }
      if (grant !== undefined) {
        this.#sessionGrants?.noteEffectiveHit(grant);
      }
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
      this.#persistDecision(record);
      return this.#blockWithBreaker(
        toolName,
        toolCallId,
        rawArgs,
        "策略要求人工审批但未配置审批通道",
        "tool"
      );
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
      // 出处 run：审批提示创建 grant（[a]/[d]）时写入 grant.created 事件
      runId: this.#activeRunId(),
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
      this.#persistDecision(record);
      return this.#blockWithBreaker(toolName, toolCallId, rawArgs, reason, "fingerprint");
    }
    record = recordDecision(record, {
      outcome: "approved",
      approvedBy: "human",
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      decidedAt: Date.now(),
    });
    // ROADMAP §3.2：dispatch 前先持久化意图；写盘失败 = fail-closed（异常由外层转 block）
    await this.#persistIntent(record);
    record = advanceToolExecution(record, "dispatch", Date.now());
    record = advanceToolExecution(record, "execution", Date.now());
    this.#executions.set(toolCallId, record);
    return undefined;
  }

  // dispatch 前持久化调用意图（ROADMAP §3.2）。写盘失败向上抛——外层 catch 转成 block，
  // 即 fail-closed：事件日志写不进就不放行，未留证的副作用一律不得发生。
  // M4 S2（D5）：写工具 intent 携带内容哈希三元组（工具探针零副作用算出改前/预期改后）；
  // 探针无能力或失败 → 字段缺省，该悬账冷恢复时降级为人工对账，不阻断审批流
  async #persistIntent(record: ToolExecution): Promise<void> {
    if (this.#eventLog === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      throw new Error("账本 intent 缺失决定快照");
    }
    let contentHashes: ContentEvidence | null = null;
    const tool = this.#tools.get(record.toolName);
    if (
      this.#registry.get(record.toolName)?.tier === "write" &&
      tool !== undefined &&
      "probeContentEvidence" in tool &&
      typeof tool.probeContentEvidence === "function"
    ) {
      try {
        contentHashes = await tool.probeContentEvidence(record.rawArgs);
      } catch {
        contentHashes = null;
      }
    }
    this.#eventLog.appendIntent({
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      rawArgs: record.rawArgs,
      decision,
      ...(contentHashes != null ? { contentHashes } : {}),
      at: Date.now(),
      runId: this.#activeRunId(),
    });
  }

  // 拒绝决定落盘（决策 4 证据链：拒绝理由必须在场，进程退出后不蒸发）。
  // 失败语义：调用已被阻断（副作用已防住），写盘失败不得改变结果——故自包 catch 进
  // listenerErrors（代码库既有的内部异常观察口），而非上抛让外层 catch 把逐字拒绝理由
  #persistDecision(record: ToolExecution): void {
    if (this.#eventLog === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      throw new Error("账本 decision 缺失决定快照");
    }
    try {
      this.#eventLog.appendDecision({
        executionId: record.executionId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        rawArgs: record.rawArgs,
        decision,
        at: Date.now(),
        runId: this.#activeRunId(),
      });
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // tool_execution_end 后写 Receipt 并回填 receiptId（三层关联 executionId/toolCallId/receiptId）。
  // executed 判据：到达 execution 阶段且执行结果无错误。M3 两个自建工具的唯一副作用都在
  // 最后一次写盘调用（edit_file 全部预检通过才落盘），故"执行过且无错"≡副作用发生；
  // 阻断/拒绝路径 executionStartedAt 为空 → executed=false（副作用从未发生）。
  // 崩溃点：进程死于 end 事件前则 receipt 永不落盘——approved 路径冷启动 reconcile 报
  // OutcomeUnknown；rejected 路径已有 decision 行闭环，归 rejected 不入 unknown。
  #persistReceipt(record: ToolExecution, isError: boolean): void {
    if (this.#eventLog === undefined) {
      return;
    }
    // 决策 1 证据链分层（M4 S6 G）：读层调用只留事件级记录——receipt 不落盘
    // （无副作用可对账；内存账本与事件流仍完整）
    if (this.#registry.get(record.toolName)?.tier === "read") {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      return;
    }
    const executed = record.executionStartedAt !== undefined && !isError;
    // M4 S2（D5）：执行成功且工具具备内容证据能力时，实测目标现状哈希随 receipt 落盘
    // （实测而非采信工具自报，撕裂写会在冷恢复三方比对中现形）；测不得则缺省
    let contentAfterHash: string | null = null;
    if (executed) {
      const tool = this.#tools.get(record.toolName);
      if (
        tool !== undefined &&
        "hashContentTarget" in tool &&
        typeof tool.hashContentTarget === "function"
      ) {
        try {
          contentAfterHash = tool.hashContentTarget(record.rawArgs);
        } catch {
          contentAfterHash = null;
        }
      }
    }
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
      ...(contentAfterHash !== null ? { contentAfterHash } : {}),
    };
    this.#eventLog.appendReceipt({ receipt, runId: this.#activeRunId() });
    // settled 后回填 receiptId：schema 允许的回填，不是状态迁移
    this.#executions.set(record.toolCallId, { ...record, receiptId: receipt.id });
  }

  // 阻断 + 熔断（spike S4：上游无循环护栏，模型可无限重发被拦调用）。
  // 计数粒度按拒绝性质不对称（P2-1c 裁决）：
  //   - "tool"：policy:deny 系绝对拒绝（deny 清单 / 无审批通道 fail-closed）——
  //     参数改不改都照样拒，任何重试皆徒劳，按工具名计数，参数微变不能重置连击；
  //   - "fingerprint"：人工拒绝与闸内异常——决策 1 鼓励模型改参数重提，
  //     按 工具名+参数指纹 计数，改参后的重提不累积（修订循环是期望行为）。
  // 同一 Run 内同一粒度 key 计数达阈值即中止整个 Run。
  // 取舍：选 agent.abort() 而非 terminate:true——terminate 只在"批次内全部 result 都 terminate"
  // 时停批次，且终态 stopReason 停在 toolUse（无"已熔断"语义）；abort 的终态是明确的 aborted。
  // 代价：abort 后本次 block 的 reason 被上游覆盖为 "Operation aborted"（agent-loop.js:410-416）。
  #blockWithBreaker(
    toolName: string,
    toolCallId: string,
    rawArgs: unknown,
    reason: string,
    scope: "tool" | "fingerprint"
  ): BeforeToolCallResult {
    // 畸形参数（循环引用等）序列化会抛：退化为固定串并入同一指纹桶——
    // 宁可按工具名合并计数，也不让熔断因异常参数失效
    let argsKey: string;
    try {
      argsKey = JSON.stringify(rawArgs) ?? "";
    } catch {
      argsKey = "<unserializable>";
    }
    const key = scope === "tool" ? `tool\n${toolName}` : `fingerprint\n${toolName}\n${argsKey}`;
    const count = (this.#blockCounts.get(key) ?? 0) + 1;
    this.#blockCounts.set(key, count);
    if (count >= this.#breakerThreshold) {
      this.#breakerTripped = true;
      this.#persistBreaker({
        toolName,
        toolCallId,
        scope,
        count,
        threshold: this.#breakerThreshold,
      });
      this.#agent.abort();
    }
    return { block: true, reason };
  }

  // 熔断落闸留证（M4 S2，D7「治理熔断」判据行）：落闸决定已生效（abort 不可逆），
  // 写盘失败只进 listenerErrors，绝不改变熔断行为
  #persistBreaker(input: {
    toolName: string;
    toolCallId: string;
    scope: "tool" | "fingerprint" | "intercepted";
    count: number;
    threshold: number;
  }): void {
    if (this.#eventLog === undefined) {
      return;
    }
    try {
      this.#eventLog.appendBreaker({ ...input, at: Date.now(), runId: this.#activeRunId() });
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 上游拦截熔断（事件级）：覆盖两类 beforeToolCall 之前的上游拦截——
  //   ① 幽灵工具名（从未广告）：prepareToolCall 以 "Tool <name> not found" 拦截
  //      （agent-loop.js:392-399，tmp/notfound-spike.mjs 实证 end 事件照常到达）；
  //   ② 已广告但参数畸形：validateToolArguments 在 hook 前抛错 → immediate error result
  //      （agent-loop.js:399-448，sequential 执行器对 immediate 结果照常发 start/end）。
  // 判据：settled 且 isError 且 账本无此 toolCallId 记录——无记录 ⟺ hook 从未运行 ⟺
  // 被上游拦截；它同时吞并原"toolName 不在广告集"判据（幽灵调用 hook 同样未运行）。
  // 同一工具名连续达阈值即 abort（与 hook 级熔断共用 #breakerThreshold）；
  // 任何 hook 跑过的 settled（含执行出错）或非错误 settled 重置连击。
  // 审计留痕：此路径 hook 从未运行，不可能有 ToolExecution 账本记录；
  // 事件日志里的 tool.proposed/tool.settled 序列即为拦截循环的审计轨迹。
  #countUpstreamInterceptedAndMaybeBreak(payload: ToolSettledPayload): void {
    if (payload.isError && !this.#executions.has(payload.toolCallId)) {
      if (this.#interceptedStreak.toolName === payload.toolName) {
        this.#interceptedStreak.count += 1;
      } else {
        this.#interceptedStreak.toolName = payload.toolName;
        this.#interceptedStreak.count = 1;
      }
      if (this.#interceptedStreak.count >= this.#breakerThreshold) {
        this.#breakerTripped = true;
        this.#persistBreaker({
          toolName: payload.toolName,
          toolCallId: payload.toolCallId,
          scope: "intercepted",
          count: this.#interceptedStreak.count,
          threshold: this.#breakerThreshold,
        });
        this.#agent.abort();
      }
    } else {
      this.#interceptedStreak.toolName = "";
      this.#interceptedStreak.count = 0;
    }
  }
  // 治理族落盘的 runId 来源：审批闸与 tool.settled 联动只在 Run 活动窗口内发生，
  // 窗口外调用说明时序错乱，响亮失败而非写出 runId 缺失的记录
  #activeRunId(): RunId {
    const runId = this.#currentRunId;
    if (runId === null) {
      throw new Error("治理族落盘需要活动 Run（hook/settled 联动只在 Run 窗口内发生）");
    }
    return runId;
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
