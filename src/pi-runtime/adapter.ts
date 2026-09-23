// PiRuntimeAdapter（ROADMAP M1 + M3 切片 3 治理接线）：把 pi-agent-core 的 Agent 藏在闭包内，
// 业务层只接触 Adapter 方法。核心约束：
// 1. streamFn 永远显式传入，不依赖包内默认（stream-fn.js 的 getDefaultStreamFn 缺省陷阱）；
// 2. 成败不看 prompt() 的 Promise（失败路径照常 resolve），看末条 assistant 消息的 stopReason
//    + state.errorMessage；
// 3. 内部事件记录与对外订阅全部自包 try/catch——上游 processEvents 顺序 await listener 且无
//    防护，一个抛异常的 listener 会把健康 Run 毒化成 error 终态；
// 4. 注入快照在构造时深冻结；Agent 实例不外泄，hook 字段因此不可被运行中改写；
// 5. 中断固定姿势：abort() → waitForIdle()，终态 stopReason === "aborted"，任何路径不悬挂；
// 6. M3 治理闭环：beforeToolCall 审批闸 + ToolExecution 账本 + 熔断 + run() 互斥（决策 1/2/4）。
//    M5.5 S0（决策 049）：审批闸整族逻辑的实现在 application/governance.ts，经 ToolGovernance
//    接口注入；Adapter 只在 hook 处转发 decide、把阻断理由原样交回上游，在 tool_execution_end
//    处转发 settle。run() 互斥与 Run 生命周期仍归 Adapter。
// 7. 上游拦截（幽灵工具名 not-found / 已广告但参数校验失败）hook 不可见：事件级连续计数熔断
//    兜底，判据与计数在治理实现内，Adapter 只转发 settled 事件。
// 8. M4 S5（D3 Pi entry 映射）：每条 message_end 事件落地时刻分配 EntryId 并同步落盘
//    entry 记录（(runId, runSeq) 权威键）；abort 与上游合成失败消息同样占序号；
//    记录逻辑自身绝不抛（上游 listener 路径无防护，同约束 3）。
// 9. M2 S1（决策 024）：subscribeStream 只读流式观察口——上游 message_update 携带
//    text_delta / thinking_delta 时把增量连同 runId 与 kind 转发给订阅者（045 修订）；
//    不进 Event Log、不进 events()、不锚身份（013：流式载荷是浅拷贝 partial）。
// 10. M5 S1（决策 037）：message_end 时刻把消息深拷贝交给落盘口，正文进旁置内容文件，
//    entry 带 contentHash 回指；turn.completed 携带 usage（044）。
// 11. M5 S5（决策 044）：每个 Run 开始落 run.started（快照摘要），system prompt 全文每个 Adapter
//    生命周期写一次内容记录；transformContext 只读观察每次模型调用落 llm.request（条数、角色计数、
//    估算字符数、消息内容哈希的滚动哈希），原样返回消息数组，观察失败只进 listenerErrors。
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
import { classifyRunOutcome, type FailureClass } from "../state/classification.ts";
import type { ObservationInput } from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import {
  buildMessageContent,
  type MessageContentOptions,
  sha256Hex,
} from "../state/message-content.ts";
import {
  type RunStartedPayload,
  RuntimeEventKind,
  type ToolSettledPayload,
} from "../state/runtime-events.ts";
import type { ToolErrorKind, ToolExecution } from "../state/tool-execution.ts";
import { classifyToolError } from "../tools/error-kind.ts";
import { isSyntheticFailureMessage, normalizePiEvent } from "./events.ts";
import type { EventLogSink, ToolGovernance, ToolGovernanceFactory } from "./governance.ts";
import { type InjectionSnapshot, InjectionSnapshotSchema } from "./snapshot.ts";

export type { EventLogSink } from "./governance.ts";

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

// M2 S1（决策 024）：流式文本增量载荷——subscribeStream 观察口的转发单位。
// 派生显示态、非权威状态：不持久化、不可重建、不锚身份；只有 runId 出处与增量文本
// M5 S1（045 修订）：kind 区分正文增量与思维链增量，订阅方按 kind 分段渲染
export interface StreamTextDelta {
  runId: RunId;
  kind: "text" | "thinking";
  delta: string;
}

export interface PiRuntimeAdapterOptions {
  snapshot: InjectionSnapshot;
  // 永远显式传入；测试注入假 streamFn，生产注入真实 provider 实现
  streamFn: StreamFn;
  // 真实部署时补充 api/baseUrl 等模型元数据；provider/id 属于模型身份，
  // 由 InjectionSnapshot 唯一提供（类型层 Omit 拒绝 + 构造器运行期兜底）
  model?: Omit<Partial<Model<Api>>, "provider" | "id">;
  sessionId?: SessionId;
  // M5.5 S0（决策 049）：工具调用治理——装配根组装后注入，Adapter 构造时绑定宿主能力。
  // 必填：治理缺席不存在隐式缺省，fail-closed 的空配置由装配方显式给出
  governance: ToolGovernanceFactory;
  // M3：工具执行体清单；按快照 tools.policy.allow 过滤后广告给模型（deny 不过滤，闸口逐调用拒绝并留账）
  tools?: AgentTool[];
  // M4 S1：Event Log 落盘点（缺省 = 纯内存事件序列，不落盘）。
  // 结构类型而非 JsonlEventLog 具体类：测试可注入故障包装器模拟崩溃点
  eventLog?: EventLogSink;
  // M5 S5（决策 044）：llm.request 指纹的内容抽取选项——必须与落盘口的内容记录选项一致
  // （thinking 是否持久化、单块上限），指纹才能与内容文件按哈希对上；缺省同内容记录缺省
  messageContent?: MessageContentOptions;
  // M5.7 S3（决策 052）：run.started 的附加摘要（MCP 工具集的注解 / 配置 / 实际档位与冲突、server 状态）——
  // 装配根注入，每个 Run 开始时取一次；结构类型，pi-runtime 不触达 mcp
  runStartedExtras?: () => Pick<RunStartedPayload, "mcpTools" | "mcpServers">;
  // M7（决策 077）：分叉续跑的 Agent 初始消息（由会话树 buildSessionContext 还原的分支消息）；缺省为空
  initialMessages?: AgentMessage[];
}

export class PiRuntimeAdapter {
  readonly sessionId: SessionId;
  readonly #agent: Agent;
  readonly #snapshot: InjectionSnapshot;
  readonly #events: EventEnvelope[] = [];
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  // M2 S1（决策 024）：流式文本观察口的订阅者集合（与归一化事件 listener 分离——
  // 增量不是 Pigeon Runtime Event，不走 #events/#eventLog 路径）
  readonly #streamListeners = new Set<(delta: StreamTextDelta) => void>();
  readonly #listenerErrors: unknown[] = [];
  readonly #unsubscribe: () => void;
  // M5.5 S0（决策 049）：本 Adapter 绑定的治理实例
  readonly #governance: ToolGovernance;
  readonly #eventLog: EventLogSink | undefined;
  // D3 entry 映射（M4 S5）：本 Run 的 message_end 累计序号——runSeq 权威键的 run 内分量。
  // 序号推进无条件（abort/合成失败消息也占序号；写盘失败不占位重试——缺一条即留证缺口，
  // 绝不重排后续序号），保证"entry 序 = transcript 追加序"在任何故障路径下成立
  #runEntrySeq = 0;
  // 工具抛错分类留证（M4 S2，D7）：toolCallId → 域/环境归类。
  // 上游把工具异常转成 isError 结果后只剩消息字符串，错误类信息必须在抛出源头捕获
  // （包装 execute，见 #wrapToolErrorCapture）；判不出存 undefined → settled 不落 errorKind
  readonly #toolErrorKinds = new Map<string, ToolErrorKind | undefined>();
  #currentRunId: RunId | null = null;
  #disposed = false;
  // M5 S5（决策 044）：指纹内容选项、system prompt 原文哈希（冻结快照算一次）、全文是否已落内容文件
  readonly #messageContent: MessageContentOptions;
  readonly #systemPromptHash: string;
  #systemPromptRecorded = false;
  readonly #runStartedExtras: PiRuntimeAdapterOptions["runStartedExtras"];

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

    this.#eventLog = options.eventLog;
    this.#runStartedExtras = options.runStartedExtras;
    this.#messageContent = options.messageContent ?? {};
    this.#systemPromptHash = sha256Hex(this.#snapshot.context.systemPrompt);
    // 广告集 = 执行体 ∩ 快照 allow。deny 不在此过滤：deny 是逐调用绝对拒绝（决策 4），
    // 必须在审批闸执行并留 policy:deny 账本——若在广告层过滤，模型请求会被上游以
    // "Tool not found" 拦截，hook 不可见、无账本、hook 级熔断也失效（agent-loop.js:393-399）。
    // 模型重发"从未广告"工具名的幽灵循环由事件级熔断收口：tool_execution_end 照常到达事件层，
    // 治理实例的 settle 按工具名连续计数、达阈值 abort。
    const policy = this.#snapshot.tools.policy;
    const advertised = (options.tools ?? []).filter((tool) => policy.allow.includes(tool.name));
    // 包装 execute 捕获错误分类（M4 S2，D7）：上游把工具异常转成 isError 结果后只剩
    // 消息字符串，域/环境归类必须在抛出源头留证；preview/探针等可选能力随 spread 保留
    const tools: ReadonlyMap<string, AgentTool> = new Map(
      advertised.map((tool) => [tool.name, this.#wrapToolErrorCapture(tool)])
    );
    // 治理绑定宿主能力；广告工具未在注册表登记时在此构造期 fail-fast
    this.#governance = options.governance({
      policy,
      tools,
      eventLog: this.#eventLog,
      activeRunId: () => this.#activeRunId(),
      abort: () => this.#agent.abort(),
      reportError: (error) => {
        this.#listenerErrors.push(error);
      },
    });

    this.#agent = new Agent({
      streamFn: options.streamFn,
      // 决策 2：写死 sequential——审批瓶颈是人，parallel 的交错观感错乱且写审批有顺序依赖。
      // 依据：agent.js:134 构造选项读取、agent.js:299 传入 loop config、
      // agent-loop.js:288 sequential 走逐 call 的 start→hook→execute→end 执行器
      toolExecution: "sequential",
      // M3 审批闸（spike S2a：block 可靠，reason 逐字反馈模型）；M5.5 S0 起只转发治理判定
      beforeToolCall: (context) => this.#forwardDecide(context),
      // M5 S5（决策 044）：实际上下文的唯一观察点——只读，原样返回（042：Memory 不经此注入）
      transformContext: (messages) => this.#observeContext(messages),
      initialState: {
        systemPrompt: this.#snapshot.context.systemPrompt,
        // M5.5 S5（决策 050）：推理档位随快照冻结；缺省 off = 不请求推理
        thinkingLevel: this.#snapshot.model.thinkingLevel ?? "off",
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
        tools: [...tools.values()],
        // M7（决策 077）：分叉续跑的初始消息（深拷贝，不与调用方共享对象）
        ...(options.initialMessages !== undefined
          ? { messages: structuredClone(options.initialMessages) }
          : {}),
      },
    });
    // 内部订阅挂一次，覆盖 Adapter 整个生命周期；回调绝不抛异常
    this.#unsubscribe = this.#agent.subscribe((event: AgentEvent) => {
      this.#recordAndForward(event);
    });
  }

  // 启动一次 Run 并等待其彻底收尾；返回终态判定结果。
  async run(input: string): Promise<RunResult> {
    return this.#runWith(() => this.#agent.prompt(input));
  }

  // M7（决策 077 / 079）：不给新输入，从已有消息续跑（上游 continue：末条消息须是用户消息或工具结果）——
  // 分叉续跑与失败自动分叉重试用，不注入任何提示
  async continueRun(): Promise<RunResult> {
    return this.#runWith(() => this.#agent.continue());
  }

  async #runWith(start: () => Promise<void>): Promise<RunResult> {
    this.#assertUsable();
    // 决策 2：run() 互斥——任何时刻最多一个待审批/执行中的 call
    if (this.#currentRunId !== null) {
      throw new Error("已有进行中的 Run：run() 互斥（决策 2）");
    }
    const runId = newRunId();
    this.#currentRunId = runId;
    this.#governance.beginRun();
    this.#runEntrySeq = 0;
    // 实际广告名单以 Run 启动时 Agent 持有的工具为准（上游对此拍快照，运行中改不动）
    const advertisedTools = this.#agent.state.tools.map((tool) => tool.name);
    this.#recordRunStarted(advertisedTools);
    try {
      await start();
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

  // 观察口（M2 S1，决策 024）：订阅流式增量——上游 message_update 携带 text_delta /
  // thinking_delta 时把增量连同 runId 与 kind 转发（045 修订）。派生显示态：增量不进 Event Log、
  // 不进 events()、不锚身份，重启不可重建。与 subscribe 同不变式：listener 自包
  // try/catch 进 listenerErrors，绝不毒化 Run
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void {
    this.#streamListeners.add(listener);
    return () => this.#streamListeners.delete(listener);
  }

  // 观察记录入口（M5，决策 043 / 044）：盖当前 runId 落观察族。只在 Run 活动窗口内有意义——
  // 窗口外或未配置落盘口时跳过；写盘失败进 listenerErrors，绝不抛回调用方（观察不毒化 Run）
  // runId 缺省取当前 Run；Run 收尾之后补记（如确以中止收尾后的撞上限记录）时由调用方显式给出
  recordObservation<K extends ObservationInput["kind"]>(
    kind: K,
    payload: Extract<ObservationInput, { kind: K }>["payload"],
    runId: RunId | null = this.#currentRunId
  ): void {
    const sink = this.#eventLog;
    if (runId === null || sink?.appendObservation === undefined) {
      return;
    }
    try {
      sink.appendObservation({ kind, payload, runId } as ObservationInput);
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 被吞掉的 listener 异常记录（含内部归一化异常）
  listenerErrors(): unknown[] {
    return this.#listenerErrors.slice();
  }

  // 观察口：本 Session 全部 ToolExecution 账本记录（深拷贝；账本原文由治理实例持有）
  toolExecutions(): ToolExecution[] {
    return this.#governance.toolExecutions();
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

  // M7（决策 078）：本 Run 已分配的最后一个条目号（message_end 累计序号）；Run 之外为 0
  entrySeq(): number {
    return this.#currentRunId === null ? 0 : this.#runEntrySeq;
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
    this.#streamListeners.clear();
  }

  // beforeToolCall 转发（决策 049）：判定交治理实例，阻断理由原样交回上游（逐字成为模型可见的
  // error toolResult）。治理实现承诺自身不抛；接缝仍兜一层——实现若抛，按 fail-closed 阻断，
  // 不交给上游的"hook 抛错降级为错误文案"路径
  async #forwardDecide(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
    try {
      const verdict = await this.#governance.decide({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.toolCall.arguments,
        preparedArgs: context.args,
      });
      return verdict.kind === "block" ? { block: true, reason: verdict.reason } : undefined;
    } catch (error) {
      return {
        block: true,
        reason: `治理判定异常（fail-closed 阻断）：${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
            // M5 S1（决策 037）：消息深拷贝交落盘口——上游零防御拷贝，落盘侧抽取内容块
            // 期间不得与 Agent 持有的消息共享对象；拷贝失败与写盘失败同样只进 listenerErrors
            this.#eventLog.appendEntry({
              runSeq: this.#runEntrySeq,
              role: event.message.role,
              runId,
              message: structuredClone(event.message),
            });
          } catch (error) {
            this.#listenerErrors.push(error);
          }
        }
      }
      const normalized = normalizePiEvent(event, { sessionId: this.sessionId, runId });
      if (!normalized) {
        // 决策 024 流式观察口：message_update 携带 text_delta / thinking_delta 时把增量连同
        // runId 与 kind 转发给 subscribeStream 订阅者（045 修订：thinking 一并转发）——这是增量的
        // 唯一出口：不归一化（normalizePiEvent 对 message_update 返回 null）、不落 Event Log、
        // 不进 #events、不锚身份（013：流式载荷是上游浅拷贝 partial）；toolcall_delta 等不转发。
        // listener 自包 try/catch（同本函数不变式：绝不毒化 Run）
        const streamEvent = event.type === "message_update" ? event.assistantMessageEvent : null;
        if (
          this.#streamListeners.size > 0 &&
          streamEvent !== null &&
          (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta")
        ) {
          const delta: StreamTextDelta = Object.freeze({
            runId,
            kind: streamEvent.type === "text_delta" ? "text" : "thinking",
            delta: streamEvent.delta,
          });
          for (const listener of this.#streamListeners) {
            try {
              listener(delta);
            } catch (error) {
              this.#listenerErrors.push(error);
            }
          }
        }
        return;
      }
      if (normalized.kind === RuntimeEventKind.ToolSettled) {
        const payload = normalized.payload as ToolSettledPayload;
        // D7 错误分类 enrich（M4 S2）：优先工具抛出处捕获的归类（包装 execute 留证）；
        // 账本无记录 ⟺ 上游拦截（参数校验失败/幽灵工具名——模型侧错误）→ domain；
        // 判不出的真实工具错误不落字段，冷分类留「未知」默认桶
        const errorKind =
          this.#toolErrorKinds.get(payload.toolCallId) ??
          (this.#governance.governs(payload.toolCallId) ? undefined : "domain");
        if (payload.isError && errorKind !== undefined) {
          payload.errorKind = errorKind;
        }
        // 决策 049：账本迁 settled、落 receipt、上游拦截熔断计数归治理实例；
        // 其内部落盘失败只进 listenerErrors，不影响下方事件本体落日志与转发
        this.#governance.settle(payload);
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

  // run.started 落盘（M5 S5，决策 044）：InjectionSnapshot v3 的摘要，先于本 Run 任何其他记录；
  // system prompt 全文每个 Adapter 生命周期只写一次（写失败下个 Run 再试）。整段自包，
  // 失败只进 listenerErrors——快照留证缺口可见，但不挡 Run 启动
  #recordRunStarted(advertisedTools: string[]): void {
    const runId = this.#currentRunId;
    const sink = this.#eventLog;
    if (runId === null || sink === undefined) {
      return;
    }
    if (!this.#systemPromptRecorded && sink.appendSystemPrompt !== undefined) {
      try {
        sink.appendSystemPrompt({ runId, text: this.#snapshot.context.systemPrompt });
        this.#systemPromptRecorded = true;
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
    const snapshot = this.#snapshot;
    // 附加摘要取失败只进 listenerErrors：该 Run 的 run.started 缺 MCP 字段，不挡 Run 启动
    let extras: Pick<RunStartedPayload, "mcpTools" | "mcpServers"> = {};
    try {
      extras = this.#runStartedExtras?.() ?? {};
    } catch (error) {
      this.#listenerErrors.push(error);
    }
    this.recordObservation("run.started", {
      model: {
        provider: snapshot.model.provider,
        id: snapshot.model.id,
        thinkingLevel: snapshot.model.thinkingLevel ?? "off",
        ...(snapshot.model.maxOutputTokens !== undefined
          ? { maxOutputTokens: snapshot.model.maxOutputTokens }
          : {}),
        ...(snapshot.model.temperature !== undefined
          ? { temperature: snapshot.model.temperature }
          : {}),
        ...(snapshot.model.temperatureIgnored !== undefined
          ? { temperatureIgnored: { ...snapshot.model.temperatureIgnored } }
          : {}),
      },
      policy: {
        allow: [...snapshot.tools.policy.allow],
        deny: [...snapshot.tools.policy.deny],
        approvalMode: snapshot.tools.policy.approvalMode,
      },
      advertisedTools,
      systemPromptHash: this.#systemPromptHash,
      ...(snapshot.context.taskDirective !== undefined
        ? { taskDirective: snapshot.context.taskDirective }
        : {}),
      memory: structuredClone(snapshot.memory),
      skills: structuredClone(snapshot.skills),
      // M6（决策 064）：后台审阅配置随 run.started 落盘（只在主会话快照里在场）
      ...(snapshot.review !== undefined ? { review: { ...snapshot.review } } : {}),
      // M7（决策 071 / 079）：验证命令与失败自动分叉重试次数随 run.started 落盘
      ...(snapshot.verify !== undefined ? { verify: { ...snapshot.verify } } : {}),
      ...(snapshot.retryOnFail !== undefined ? { retryOnFail: snapshot.retryOnFail } : {}),
      // M8（决策 087）：本次尝试的预算随 run.started 落盘——回放据此沿用同一预算
      ...(snapshot.budget !== undefined ? { budget: { ...snapshot.budget } } : {}),
      // 决策 142 / 143：回炉轮数随 run.started 落盘（一步里的每次 Run 同值）
      ...(snapshot.repairRounds !== undefined ? { repairRounds: snapshot.repairRounds } : {}),
      ...extras,
    });
  }

  // transformContext 只读观察（M5 S5，决策 044）：每次模型调用前落 llm.request——消息条数、各角色
  // 条数、估算字符数（text 与 thinking 块长度之和）、全部消息内容哈希（037 规范序列化，与内容文件
  // 同一抽取选项）按序以换行连接后的 sha256、system prompt 哈希。只读：不改写、不重排、不注入，
  // 恒原样返回同一数组；观察自身任何异常只进 listenerErrors，绝不毒化 Run
  async #observeContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    try {
      if (this.#currentRunId !== null) {
        const roleCounts: Record<string, number> = {};
        const hashes: string[] = [];
        let estimatedChars = 0;
        for (const message of messages) {
          roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
          const content = buildMessageContent(message, this.#messageContent);
          hashes.push(content.contentHash);
          for (const block of content.blocks) {
            if (block.type === "text") {
              estimatedChars += block.text.length;
            } else if (block.type === "thinking") {
              estimatedChars += block.thinking.length;
            }
          }
        }
        this.recordObservation("llm.request", {
          messageCount: messages.length,
          roleCounts,
          estimatedChars,
          messagesHash: sha256Hex(hashes.join("\n")),
          systemPromptHash: this.#systemPromptHash,
        });
      }
    } catch (error) {
      this.#listenerErrors.push(error);
    }
    return messages;
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
    // 本次 Run 的治理结论：熔断是否落闸 + 账本记录终态快照（waitForIdle 之后已定型）
    const governed = this.#governance.runOutcome();
    return {
      runId,
      status,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      syntheticFailure,
      // M4 S2（D7）：活侧失败四分类——与冷物化同一判据纯函数；
      // 活侧事实直接取自终态判定与治理实例的熔断状态（breaker 记录是冷侧对应物）
      failure: classifyRunOutcome({
        ...(stopReason !== undefined ? { stopReason } : {}),
        syntheticFailure,
        breakerTripped: governed.breakerTripped,
        hasTurnCompleted: lastAssistant !== undefined,
        // 活侧在 prompt() resolve 之后计算，agent_end 已发出（abort 路径同样发）
        hasRunEnded: true,
      }),
      advertisedTools,
      toolExecutions: governed.toolExecutions,
    };
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
