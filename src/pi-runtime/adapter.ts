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
// 8. M4 S5（D3）：每条 message_end 占本 Run 的一个条目序号（abort 与上游合成失败消息同样占序号）；
//    记录逻辑自身绝不抛（上游 listener 路径无防护，同约束 3）。
// 9. M2 S1（决策 024）：subscribeStream 只读流式观察口——上游 message_update 携带
//    text_delta / thinking_delta 时把增量连同 runId 与 kind 转发给订阅者（045 修订）；
//    不落盘、不进 events()、不锚身份（013：流式载荷是浅拷贝 partial）。
// 10. 会话存储（决策 176 / 182 / 184）：每条 message_end 的完整消息、每个 Run 的开始（本次配置与系统提示全文）
//    与收尾（结束方式）写进新会话存储。撞上限的一方经 interrupt(原因) 交代中止原因，收尾条目一次写全；
//    写入面自身不抛，这里仍兜一层，异常只进 listenerErrors，不影响运行。
// 11. 上下文压缩（决策 188、189）：两个触发挂点——一次 Run 内轮与轮之间（上游 prepareNextTurnWithContext，返回替换后的
//    上下文）、一次 Run 开始之前（prompt 或 continue 发起前自行检查并整体替换 Agent 的消息）；另有手动压缩。轮间替换后
//    Agent 的消息仍按 message_end 累积全量，故本 Run 内压缩过时，Run 结束后按会话树重新还原一次。上游的 convertToLlm
//    必须交给 Agent：缺省实现只留 user、assistant、toolResult，会把压缩摘要消息静默丢掉。压缩自身不抛，失败只进
//    listenerErrors，本轮照原上下文继续。
// 12. 终端界面完善（决策 286）：两个只读观察口——subscribeToolResults 在工具结果消息落定时转发结果文本与 details
//    （界面展开工具输出与 diff 用；同 subscribeStream 不落盘、不进 events()、不改事件载荷与会话记录），contextUsage
//    读当前上下文的 token 数与模型窗口（状态栏用）。没有订阅者时行为与此前逐字节一致，eval stream、pigeon run 与
//    逐行对话不订阅，实验路径不受影响。
// 13. 一轮之内的失控（决策 367）：撞上限续跑——末条回复因输出上限截断且没有工具调用时暂扣收尾（同空回复重试），从 Agent 的消息
//    去掉它、会话存储里把它移出主分支并写一条续跑记录，再以一条提示接着跑；连续与每次 Run 合计各有上限，用尽照原样收尾。
//    流式重复检测包在 streamFn 外层（repetition-guard.ts），每次命中写一条记录，掐断的回复以 length 收尾、交给续跑。
// 14. 代码快照移出关键路径（决策 350）：addToolGate 登记工具执行前的等待口（审批之后、真正执行之前逐个等待），
//    快照器在此等未完成的快照拍完；等待方自己保证有上限，抛异常只进 listenerErrors、不挡工具执行。没有登记时行为不变。
// 15. 开工状态块与状态变化通道（决策 363）：挂了状态通道时，Run 开始之前与一批工具结果之后各问一次，状态消息作用户消息
//    放在本次输入之前或该批工具结果之后（轮间压缩之后再交，压缩过即重发完整块）；没挂时行为不变。
import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  Agent,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  buildSessionContext,
  convertToLlm,
  type PrepareNextTurnContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  StopReason,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { classifyRunOutcome, type FailureClass } from "../state/classification.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { LoopRound } from "../state/loop-guard.ts";
import type { RunModelInfo } from "../state/model-info.ts";
import {
  type RepetitionGuardMode,
  type RepetitionGuardParams,
  TRUNCATION_CONTINUE_PROMPT,
} from "../state/runaway-config.ts";
import {
  type RunStartedPayload,
  RuntimeEventKind,
  type ToolSettledPayload,
} from "../state/runtime-events.ts";
import {
  type RunEnding,
  type RunStopCause,
  SESSION_ENTRY_VERSION,
  SessionEntryType,
} from "../state/session-entries.ts";
import { TOOL_RESULT_MARK_KEY, type ToolResultMark } from "../state/session-judge.ts";
import { isStatusMessage, STATUS_MARKER, withoutStatusMarker } from "../state/status-text.ts";
import type { ToolErrorKind, ToolExecution } from "../state/tool-execution.ts";
import { classifyToolError } from "../tools/error-kind.ts";
import type {
  CompactionConfig,
  CompactionOutcome,
  CompactionStore,
  CompactionTrigger,
  ContextCompactor,
} from "./compaction.ts";
import { isSyntheticFailureMessage, normalizePiEvent } from "./events.ts";
import type { ToolGovernance, ToolGovernanceFactory, ToolHookPort } from "./governance.ts";
import { guardRepetition, type RepetitionHit } from "./repetition-guard.ts";
import type { SessionStoreSink } from "./session-store.ts";
import { type InjectionSnapshot, InjectionSnapshotSchema } from "./snapshot.ts";

// 推理档位的缺省：快照里没给即 off（不请求推理）
export const DEFAULT_THINKING_LEVEL = "off";

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
  // 失败四分类（M4 S2，D7）：与会话读者同一套判据纯函数（classification.ts）；null = 非失败
  failure: FailureClass | null;
  // 本次 Run 实际广告给模型的工具名单
  advertisedTools: string[];
  // 本次 Run 的 ToolExecution 账本记录（终态快照，深拷贝）
  toolExecutions: ToolExecution[];
  // 空回复异常结束（决策 170 ②）：重试一次仍是空回复（或空回复时已来了中止请求、没能重试）。此时 status 为 failed。
  // 运行面恒给出；结构替身可缺省（缺省即否）
  emptyReply?: boolean;
}

// 空回复重试仍空时的错误文本（Run 结果与收尾条目共用）
export const EMPTY_REPLY_ERROR = "模型返回空回复（既无文字也无工具调用），重试一次仍为空回复";

// 撞上限续跑的对象（决策 367）：因输出上限截断（含被流式重复检测掐断）且没有工具调用的回复
export function isTruncatedWithoutTools(message: AssistantMessage): boolean {
  return (
    message.stopReason === "length" && !message.content.some((block) => block.type === "toolCall")
  );
}

// 空回复（决策 170 ②）：以正常停止收尾，既无非空文字、也无工具调用；思考块不算内容，只有空白的文字算空
export function isEmptyReply(message: AssistantMessage): boolean {
  if (message.stopReason !== "stop") {
    return false;
  }
  return !message.content.some(
    (block) => block.type === "toolCall" || (block.type === "text" && block.text.trim() !== "")
  );
}

// M2 S1（决策 024）：流式文本增量载荷——subscribeStream 观察口的转发单位。
// 派生显示态、非权威状态：不持久化、不可重建、不锚身份；只有 runId 出处与增量文本
// M5 S1（045 修订）：kind 区分正文增量与思维链增量，订阅方按 kind 分段渲染
export interface StreamTextDelta {
  runId: RunId;
  kind: "text" | "thinking";
  delta: string;
}

// 压缩提示（189）：界面据此各提示一行——压成了（压缩前后的 token 数）、自动压缩没压成（原因；本轮按原上下文继续；
// 被中断的不提示）、压缩前回调失败（原因；压缩照常进行）。手动压缩没压成时结果直接交回调用方，不另发提示
export type CompactionNotice =
  // messages：压缩后的上下文（钩子 PostCompact 的 compact_summary 从中取真实摘要）
  | {
      kind: "compacted";
      trigger: CompactionTrigger;
      tokensBefore: number;
      tokensAfter: number;
      messages: AgentMessage[];
    }
  | {
      kind: "incomplete";
      trigger: Exclude<CompactionTrigger, "manual">;
      outcome: Exclude<CompactionOutcome, { kind: "compacted" }>;
    }
  | { kind: "hook-failed"; trigger: CompactionTrigger; error: unknown };

// 工具结果观察口的转发单位（决策 286）：派生显示态，不落盘、不锚身份；details 原样（深拷贝）交出，形状由订阅方判读
export interface ToolResultNotice {
  runId: RunId;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  // 结果里文本块的拼接（图片等非文本块不含）
  text: string;
  details: unknown;
}

// 整轮观察口的转发单位（决策 305）：一轮结束（上游 turn_end）时这一轮助手消息里的工具调用与它们的返回结果。
// 派生显示态，不落盘、不锚身份；参数与结果为深拷贝
export interface TurnRoundNotice extends LoopRound {
  runId: RunId;
  // 这一轮的回复因输出上限截断且没有工具调用（决策 367：续跑时从上下文去掉，打转检测不把它算作一轮）
  truncated?: true;
}

// 手动压缩的结果：运行面没有配置压缩时为 disabled
export type ManualCompactionOutcome = CompactionOutcome | { kind: "skipped"; reason: "disabled" };

type RunStartedExtras = Pick<RunStartedPayload, "mcpTools" | "mcpServers" | "skippedTools">;

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
  // M5.7 S3（决策 052）：Run 开始条目的附加摘要（MCP 工具集的注解 / 配置 / 实际档位与冲突、server 状态）——
  // 装配根注入，每个 Run 开始时取一次；结构类型，pi-runtime 不触达 mcp
  // 决策 359：另带按环境没注册的工具与原因
  runStartedExtras?: () => RunStartedExtras;
  // 决策 362：本次所用的模型信息与每一项的来源（装配根解析好交来），每个 Run 开始条目照记；缺省不记
  modelInfo?: RunModelInfo;
  // M7（决策 077）：分叉续跑的 Agent 初始消息（由会话树 buildSessionContext 还原的分支消息）；缺省为空
  initialMessages?: AgentMessage[];
  // 新会话存储的写入面（决策 176）；缺省不写
  sessionStore?: SessionStoreSink;
  // 决策 188：上下文压缩（阈值、保留量、摘要请求的模型接入与压缩前回调）；缺省不压缩。压缩读写会话树，
  // 故只在新存储写入面带读分支与写压缩条目时生效
  compaction?: ContextCompactor;
  // 决策 363：开工状态块与状态变化通道；缺省不挂（行为与此前一致）
  status?: StatusChannel;
  // 决策 353：逐工具的执行模式（装配根按登记表给）；缺省一律串行。Agent 恒为并行模式，上游在同一批调用里只要有一件
  // 标为串行就整批串行：纯读的一批同时执行，含写与命令的一批照旧逐个准备（含审批）、执行
  executionModeOf?: (toolName: string) => "parallel" | "sequential";
  // 决策 324：工具事件钩子——PreToolUse 交治理实例（在审批之前），PostToolUse / PostToolUseFailure
  // 在此接 afterToolCall（工具执行之后）：替换结果文本、把理由与上下文补进结果。缺省不挂
  toolHooks?: ToolHookPort;
  // 决策 367：撞上限续跑的连续与每次 Run 合计上限；缺省不续跑
  truncationContinuation?: { maxConsecutive: number; maxPerRun: number };
  // 决策 367：流式重复检测的模式与参数，包在 streamFn 外层；缺省不检测
  repetitionGuard?: { mode: RepetitionGuardMode; params: RepetitionGuardParams };
}

// 决策 363：状态变化通道——Run 开始之前（首次、续跑后、压缩之后）、一批工具结果之后与轮间压缩之后、下一次请求之前各问一次；
// 有要说的即作一条带标记（pigeonStatus）的用户消息，放在本次输入之前、该批工具结果之后或压缩后的上下文末尾（照常进会话记录）。
// compacted 为此前压缩过（要重发完整块）。那条消息进了会话记录即调 delivered（通道据此记成已发）
export interface StatusChannel {
  beforeRun(input: { compacted: boolean }): Promise<string | undefined>;
  betweenTurns(input: { compacted: boolean }): Promise<string | undefined>;
  delivered(): void;
}

export class PiRuntimeAdapter {
  readonly sessionId: SessionId;
  readonly #agent: Agent;
  readonly #snapshot: InjectionSnapshot;
  readonly #events: EventEnvelope[] = [];
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  // M2 S1（决策 024）：流式文本观察口的订阅者集合（与归一化事件 listener 分离——
  // 增量不是 Pigeon Runtime Event，不走 #events 路径）
  readonly #streamListeners = new Set<(delta: StreamTextDelta) => void>();
  readonly #listenerErrors: unknown[] = [];
  readonly #unsubscribe: () => void;
  // M5.5 S0（决策 049）：本 Adapter 绑定的治理实例
  readonly #governance: ToolGovernance;
  // 决策 324：工具事件钩子（afterToolCall 转发用；PreToolUse 走治理实例）
  readonly #toolHooks: ToolHookPort | undefined;
  // 决策 324：PreToolUse 钩子改过的参数（toolCallId → 改后的参数）：执行时替换上游校验后的参数
  readonly #updatedArgs = new Map<string, unknown>();
  // D3（M4 S5）：本 Run 的 message_end 累计序号——Run 内序号。序号推进无条件（abort/合成失败消息也占序号，
  // 写盘失败不重排后续序号），保证"条目序 = transcript 追加序"在任何故障路径下成立
  #runEntrySeq = 0;
  // 工具抛错分类留证（M4 S2，D7）：toolCallId → 域/环境归类。
  // 上游把工具异常转成 isError 结果后只剩消息字符串，错误类信息必须在抛出源头捕获
  // （包装 execute，见 #wrapToolErrorCapture）；判不出存 undefined → settled 不落 errorKind
  // 当前（或最近一次）Run 彻底收尾的时刻（settled() 等它）
  #runSettled: Promise<void> = Promise.resolve();
  readonly #toolErrorKinds = new Map<string, ToolErrorKind | undefined>();
  #currentRunId: RunId | null = null;
  #disposed = false;
  readonly #runStartedExtras: PiRuntimeAdapterOptions["runStartedExtras"];
  readonly #modelInfo: RunModelInfo | undefined;
  readonly #sessionStore: SessionStoreSink | undefined;
  // 当前 Run 被我们的上限中止的原因（interrupt 时给出；每个 Run 开始时清空）
  #stopCause: RunStopCause | undefined;
  // 决策 297：待递的通知——先留在这里，Run 内每轮结束（turn_end）时转入上游的 steer 队列、进下一轮；空闲时由 runNotices
  // 或下一次 run 一并带上。转入之前可撤回（同一结果已由等待工具交回时不再另发）
  readonly #notices: Array<{ key: string; message: AgentMessage }> = [];
  readonly #deliveredNotices = new Set<string>();
  #noticeSeq = 0;
  readonly #compactor: ContextCompactor | undefined;
  readonly #compactionListeners = new Set<(notice: CompactionNotice) => void>();
  readonly #toolResultListeners = new Set<(notice: ToolResultNotice) => void>();
  // 决策 350：工具执行前的等待口
  readonly #toolGates = new Set<() => Promise<void>>();
  // 决策 363：状态通道；压缩过之后的下一次要重发完整块；有工具结果的一轮把状态与通知留到轮间再入队
  readonly #status: StatusChannel | undefined;
  #statusCompacted = false;
  #deliverAfterTurn = false;
  readonly #roundListeners = new Set<(round: TurnRoundNotice) => void>();
  // Run 开始之前与手动压缩的中止口（轮间压缩用 Agent 的中止信号）：interrupt 与 dispose 时一并中止
  #compactionAbort: AbortController | undefined;
  // 手动压缩进行中：此时不接受 Run
  #manualCompacting = false;
  // 本 Run 内轮间压缩过：压缩后的上下文与压缩时 Agent 已有的消息条数，Run 结束后据此还原（会话树读不到时的后备）
  #turnCompaction: { messages: AgentMessage[]; stateLength: number } | undefined;
  // 当前 Run 是否来过中止请求（任何来源；每个 Run 开始时清空）：来过即不再为空回复重试
  #interruptRequested = false;
  // 钩子的 continue:false（决策 324）：整轮停止——置位后中止 agent 循环，终态如实记这个理由
  #hookStopReason: string | undefined;
  // 空回复重试（决策 170 ②）：本 Run 是否已重试过；等待重试时暂扣的那次 agent_end（重试那次的 agent_end 才是本 Run 的收尾）
  #emptyReplyRetried = false;
  #deferredRunEnd: AgentEvent | undefined;
  // 撞上限续跑（决策 367）：配置；本 Run 已续跑次数与连续次数（一条回复没触发续跑即清零）；
  // 被重复检测掐断的回复将占的条目序号（续跑记录据此区分截断的来由）
  readonly #continuation: PiRuntimeAdapterOptions["truncationContinuation"];
  #continuations = 0;
  #consecutiveContinuations = 0;
  #repetitionCutSeq = 0;

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

    this.#runStartedExtras = options.runStartedExtras;
    this.#modelInfo = options.modelInfo;
    this.#sessionStore = options.sessionStore;
    this.#compactor = options.compaction;
    this.#continuation = options.truncationContinuation;
    const repetition = options.repetitionGuard;
    this.#status = options.status;
    // 广告集 = 执行体 ∩ 快照 allow。deny 不在此过滤：deny 是逐调用绝对拒绝（决策 4），
    // 必须在审批闸执行并留 policy:deny 账本——若在广告层过滤，模型请求会被上游以
    // "Tool not found" 拦截，hook 不可见、无账本、hook 级熔断也失效（agent-loop.js:393-399）。
    // 模型重发"从未广告"工具名的幽灵循环由事件级熔断收口：tool_execution_end 照常到达事件层，
    // 治理实例的 settle 按工具名连续计数、达阈值 abort。
    const policy = this.#snapshot.tools.policy;
    const advertised = (options.tools ?? []).filter((tool) => policy.allow.includes(tool.name));
    // 包装 execute 捕获错误分类（M4 S2，D7）：上游把工具异常转成 isError 结果后只剩
    // 消息字符串，域/环境归类必须在抛出源头留证；preview/探针等可选能力随 spread 保留
    // 决策 353：执行模式以装配根的登记为准（覆盖工具自带的标记）
    const modeOf = options.executionModeOf ?? (() => "sequential" as const);
    const tools: ReadonlyMap<string, AgentTool> = new Map(
      advertised.map((tool) => [
        tool.name,
        { ...this.#wrapToolErrorCapture(tool), executionMode: modeOf(tool.name) },
      ])
    );
    // 治理绑定宿主能力；广告工具未在注册表登记时在此构造期 fail-fast
    this.#toolHooks = options.toolHooks;
    this.#governance = options.governance({
      policy,
      tools,
      activeRunId: () => this.#activeRunId(),
      abort: () => this.#agent.abort(),
      reportError: (error) => {
        this.#listenerErrors.push(error);
      },
      // 决策 324：工具事件钩子（PreToolUse 由治理实例在审批之前调用）
      ...(options.toolHooks !== undefined ? { toolHooks: options.toolHooks } : {}),
    });

    this.#agent = new Agent({
      // 决策 367：流式重复检测包在模型调用外层
      streamFn:
        repetition !== undefined
          ? guardRepetition(options.streamFn, {
              ...repetition,
              onHit: (hit) => this.#recordRepetition(repetition.mode, hit),
            })
          : options.streamFn,
      // 决策 353：恒为 parallel，实际怎么跑由逐工具的执行模式决定（agent-loop.js:287：一批里有一件串行即整批走
      // 逐 call 的 start→hook→execute→end 执行器）——写审批的顺序依赖与预览时机照旧（决策 2 的顾虑由此保留）
      toolExecution: "parallel",
      // M3 审批闸（spike S2a：block 可靠，reason 逐字反馈模型）；M5.5 S0 起只转发治理判定
      beforeToolCall: (context) => this.#forwardDecide(context),
      // 决策 324：工具执行之后（PostToolUse / PostToolUseFailure）——替换结果文本与补上下文
      afterToolCall: (context) => this.#forwardAfterToolCall(context),
      // 决策 324：钩子 continue:false 置位后这一轮收尾即停——上游只在整批每个调用都 terminate 时提前结束，
      // 混合批次（前面的调用已放行）与排队的 steer 消息都会让循环继续，故在轮末另行判停
      shouldStopAfterTurn: () => this.#hookStopReason !== undefined,
      // 决策 188：上游的转换（压缩摘要与分支摘要转成用户消息），缺省实现会丢掉它们。
      // 决策 363：状态消息上的标记交给模型之前去掉
      convertToLlm: (messages) => convertToLlm(messages.map(withoutStatusMarker)),
      // 决策 188：一次 Run 内轮与轮之间的压缩挂点
      prepareNextTurnWithContext: (context, signal) => this.#compactBetweenTurns(context, signal),
      initialState: {
        systemPrompt: this.#snapshot.context.systemPrompt,
        // M5.5 S5（决策 050）：推理档位随快照冻结；缺省 off = 不请求推理
        thinkingLevel: this.#snapshot.model.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
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

  // 启动一次 Run 并等待其彻底收尾；返回终态判定结果。有待递的通知时连同输入一起交给模型（通知在前）
  // 决策 363：状态通道给的状态消息排在最前（lead）
  async run(input: string): Promise<RunResult> {
    return this.#runWith((lead) => {
      if (lead.length === 0 && this.#notices.length === 0) {
        return this.#agent.prompt(input);
      }
      return this.#agent.prompt([
        ...lead,
        ...this.#takeNotices(),
        { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() },
      ]);
    });
  }

  // 决策 297：递一条通知（作一条用户消息进模型的下一轮）；返回撤回与查询用的键
  notify(text: string): string {
    this.#noticeSeq += 1;
    const key = `notice-${this.#noticeSeq}`;
    this.#notices.push({
      key,
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
    return key;
  }

  // 撤回还没递出的通知；已递出（或不认识）返回 false
  withdrawNotice(key: string): boolean {
    const index = this.#notices.findIndex((notice) => notice.key === key);
    if (index < 0) {
      return false;
    }
    this.#notices.splice(index, 1);
    return true;
  }

  noticeDelivered(key: string): boolean {
    return this.#deliveredNotices.has(key);
  }

  pendingNotices(): number {
    return this.#notices.length;
  }

  // 决策 297：空闲时被叫醒——只带待递的通知开一次 Run
  async runNotices(): Promise<RunResult> {
    if (this.#notices.length === 0) {
      throw new Error("没有待递的通知");
    }
    return this.#runWith((lead) => this.#agent.prompt([...lead, ...this.#takeNotices()]));
  }

  #takeNotices(): AgentMessage[] {
    const taken = this.#notices.splice(0);
    for (const notice of taken) {
      this.#deliveredNotices.add(notice.key);
    }
    return taken.map((notice) => notice.message);
  }

  // M7（决策 077 / 079）：不给新输入，从已有消息续跑（上游 continue：末条消息须是用户消息或工具结果）——
  // 分叉续跑与失败自动分叉重试用，不注入任何提示
  async continueRun(): Promise<RunResult> {
    // 决策 363：状态消息经 steer 交给上游，续跑开头即取走
    return this.#runWith((lead) => {
      for (const message of lead) {
        this.#agent.steer(message);
      }
      return this.#agent.continue();
    });
  }

  async #runWith(start: (lead: AgentMessage[]) => Promise<void>): Promise<RunResult> {
    this.#assertUsable();
    // 决策 2：run() 互斥——任何时刻最多一个待审批/执行中的 call
    if (this.#currentRunId !== null) {
      throw new Error("已有进行中的 Run：run() 互斥（决策 2）");
    }
    if (this.#manualCompacting) {
      throw new Error("手动压缩进行中，等它完成再启动 Run");
    }
    const runId = newRunId();
    this.#currentRunId = runId;
    this.#governance.beginRun();
    this.#runEntrySeq = 0;
    this.#stopCause = undefined;
    this.#turnCompaction = undefined;
    this.#interruptRequested = false;
    this.#hookStopReason = undefined;
    this.#emptyReplyRetried = false;
    this.#deferredRunEnd = undefined;
    this.#continuations = 0;
    this.#consecutiveContinuations = 0;
    this.#repetitionCutSeq = 0;
    this.#deliverAfterTurn = false;
    // 实际广告名单以 Run 启动时 Agent 持有的工具为准（上游对此拍快照，运行中改不动）
    const advertisedTools = this.#agent.state.tools.map((tool) => tool.name);
    // 附加摘要每个 Run 取一次；取失败只进 listenerErrors，Run 开始条目缺 MCP 字段，不挡 Run 启动
    let extras: RunStartedExtras = {};
    try {
      extras = this.#runStartedExtras?.() ?? {};
    } catch (error) {
      this.#listenerErrors.push(error);
    }
    this.#recordRunStart(runId, advertisedTools, extras);
    let settle = (): void => {};
    this.#runSettled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      // 决策 188：Run 开始之前的压缩挂点（上游 prepareNextTurn 不在首轮之前调用）。压缩期间被中断时，
      // 照常发起再立即中止：Agent 按上游的标准事件序列以中止收尾，不留半截 Run
      const interrupted = await this.#compactBeforeRun();
      // 决策 363：压缩之后再问状态（压缩过即重发完整块）；压缩期间被中断时不带
      const lead = interrupted ? [] : await this.#statusMessages("run");
      const started = start(lead);
      if (interrupted || this.#interruptRequested) {
        this.#agent.abort();
      }
      await started;
      await this.#agent.waitForIdle();
      await this.#resumeDeferredRunEnd();
      const result = this.#judgeTerminal(runId, advertisedTools);
      this.#recordRunEnded(result);
      await this.#restoreAfterTurnCompaction();
      return result;
    } catch (error) {
      // Run 以异常结束（上游抛错）：收尾条目记出错，不留成"有开始无收尾"（那只留给进程死于中途）
      this.#recordRunEnded({
        runId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.#currentRunId = null;
      settle();
    }
  }

  // 当前活动 Run（无活动 Run 时为 undefined）：钩子运行记录（决策 324）据此挂到 Run 上，
  // 窗口外的事件（SessionStart 等）记为会话级条目
  currentRunId(): RunId | undefined {
    return this.#currentRunId ?? undefined;
  }

  // 上游一次运行以空回复或撞上限且没有工具调用的回复收尾时，其 agent_end 已被暂扣（见 #recordAndForward），在同一个 Run 里
  // 接着运行：重试或续跑那一轮照常发事件、计轮与计预算，又以同样的方式收尾时再次暂扣，直到不再暂扣。
  // 暂扣之后来了中止请求即不再接着跑，补发暂扣的 agent_end。continue 与 prompt 同步建立上游的活动运行，其间中止请求插不进空档
  async #resumeDeferredRunEnd(): Promise<void> {
    for (;;) {
      const deferred = this.#deferredRunEnd;
      if (deferred === undefined) {
        return;
      }
      this.#deferredRunEnd = undefined;
      if (this.#interruptRequested) {
        this.#recordAndForward(deferred);
        return;
      }
      const last = this.#agent.state.messages.at(-1);
      if (last?.role === "assistant" && isEmptyReply(last)) {
        await this.#retryEmptyReply();
      } else {
        await this.#continueTruncated();
      }
      await this.#agent.waitForIdle();
    }
  }

  // 空回复重试（决策 170 ②）：从 Agent 状态去掉这条空消息（会话文件照实留着它）再接着运行一次
  async #retryEmptyReply(): Promise<void> {
    this.#emptyReplyRetried = true;
    this.#agent.state.messages = this.#agent.state.messages.slice(0, -1);
    await this.#agent.continue();
  }

  // 撞上限续跑（决策 367）：从 Agent 状态去掉截断的回复，会话存储里把它移出主分支（文件里照留）并记一条续跑记录；
  // 本 Run 内轮间压缩过时先按会话树还原成压缩后的上下文（Agent 的消息累积着全量），再追加提示接着跑
  async #continueTruncated(): Promise<void> {
    this.#continuations += 1;
    this.#consecutiveContinuations += 1;
    const dropped = this.#agent.state.messages.at(-1);
    const usage = dropped?.role === "assistant" ? dropped.usage : undefined;
    this.#agent.state.messages = this.#agent.state.messages.slice(0, -1);
    const runId = this.#currentRunId;
    if (this.#sessionStore !== undefined && runId !== null) {
      try {
        this.#sessionStore.dropTruncatedReply?.();
        this.#sessionStore.append({
          customType: SessionEntryType.Continuation,
          data: {
            version: SESSION_ENTRY_VERSION,
            runId,
            cause: this.#repetitionCutSeq === this.#runEntrySeq ? "repetition" : "output-limit",
            attempt: this.#continuations,
            consecutive: this.#consecutiveContinuations,
            continuedAt: Date.now(),
            // 截断的回复移出主分支后，轮数与用量的统计按这里加回
            ...(usage !== undefined
              ? {
                  droppedUsage: {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    totalTokens: usage.totalTokens,
                    cost: {
                      input: usage.cost.input,
                      output: usage.cost.output,
                      cacheRead: usage.cost.cacheRead,
                      cacheWrite: usage.cost.cacheWrite,
                      total: usage.cost.total,
                    },
                  },
                }
              : {}),
          },
        });
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
    await this.#restoreAfterTurnCompaction();
    // 还原要等会话树的读取：其间来的中止请求或释放落空（上游没有活动运行），故照常发起再立即中止，以中止收尾（同 #runWith）
    const started = this.#agent.prompt({
      role: "user",
      content: [{ type: "text", text: TRUNCATION_CONTINUE_PROMPT }],
      timestamp: Date.now(),
    });
    if (this.#interruptRequested || this.#disposed) {
      this.#agent.abort();
    }
    await started;
  }

  // 这次 agent_end 要不要暂扣、等撞上限续跑：配置了续跑、两个上限都没到、没来过中止请求、钩子没要求停止，
  // 且对话以撞上限且没有工具调用的回复收尾
  #shouldContinueTruncated(): boolean {
    const limits = this.#continuation;
    if (
      limits === undefined ||
      this.#interruptRequested ||
      this.#hookStopReason !== undefined ||
      this.#continuations >= limits.maxPerRun ||
      this.#consecutiveContinuations >= limits.maxConsecutive
    ) {
      return false;
    }
    const last = this.#agent.state.messages.at(-1);
    return last !== undefined && last.role === "assistant" && isTruncatedWithoutTools(last);
  }

  // 流式重复检测的一次命中（决策 367）：写一条会话记录；掐断模式下记下被掐断的回复将占的条目序号
  #recordRepetition(mode: RepetitionGuardMode, hit: RepetitionHit): void {
    const runId = this.#currentRunId;
    if (runId === null) {
      return;
    }
    if (mode === "abort") {
      this.#repetitionCutSeq = this.#runEntrySeq + 1;
    }
    if (this.#sessionStore === undefined) {
      return;
    }
    try {
      this.#sessionStore.append({
        customType: SessionEntryType.Repetition,
        data: { version: SESSION_ENTRY_VERSION, runId, mode, ...hit, detectedAt: Date.now() },
      });
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 这次 agent_end 要不要暂扣、等空回复重试：本 Run 还没重试过、没来过中止请求，且对话以空回复收尾
  #shouldRetryEmptyReply(): boolean {
    if (this.#emptyReplyRetried || this.#interruptRequested) {
      return false;
    }
    const last = this.#agent.state.messages.at(-1);
    return last !== undefined && last.role === "assistant" && isEmptyReply(last);
  }

  // 工具结果消息挂运行面标记（账本重构第二段的裁决：写在该消息 details 的 pigeon 键下，不新增记录种类）：
  // 工具抛错时捕获的错误归类（审批闸没跑过即上游拦截，记域错误）与审批闸的决定（结果与批准来源）。
  // 就地改这条消息：交给 Agent 的对话与会话存储是同一份（details 不发给模型）。
  // 工具自己的 details 是对象时并入，缺省时新建；其余形状（非对象）不动。标记自身出错只进 listenerErrors
  #markToolResult(message: ToolResultMessage): void {
    try {
      const errorKind = message.isError
        ? (this.#toolErrorKinds.get(message.toolCallId) ??
          (this.#governance.governs(message.toolCallId) ? undefined : "domain"))
        : undefined;
      const decision = this.#governance.decisionOf(message.toolCallId);
      const mark: ToolResultMark = {
        ...(errorKind !== undefined ? { errorKind } : {}),
        ...(decision !== undefined
          ? { gate: { outcome: decision.outcome, approvedBy: decision.approvedBy } }
          : {}),
      };
      if (mark.errorKind === undefined && mark.gate === undefined) {
        return;
      }
      const details: unknown = message.details;
      if (details === undefined || details === null) {
        message.details = { [TOOL_RESULT_MARK_KEY]: mark };
      } else if (typeof details === "object" && !Array.isArray(details)) {
        message.details = { ...details, [TOOL_RESULT_MARK_KEY]: mark };
      }
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 等当前 Run 彻底收尾（收尾条目已交给新存储写者）；没有进行中的 Run 时立即返回。
  // run.ended 事件先于收尾条目到达，读者在事件回调里要读收尾条目时先等这里
  async settled(): Promise<void> {
    await this.#runSettled;
  }

  // 中断当前 Run：固定姿势 abort → waitForIdle；终态由并发等待的 run() 返回承载。
  // 撞上限的一方给出原因（轮数 / 墙钟 / token）：该 Run 确以中止收尾时，收尾条目的结束方式记这个原因；
  // 同一 Run 先到的原因为准，Run 之外的调用不留原因
  async interrupt(cause?: RunStopCause): Promise<void> {
    if (cause !== undefined && this.#currentRunId !== null && this.#stopCause === undefined) {
      this.#stopCause = cause;
    }
    this.#compactionAbort?.abort();
    if (this.#currentRunId !== null) {
      this.#interruptRequested = true;
    }
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
  // thinking_delta 时把增量连同 runId 与 kind 转发（045 修订）。派生显示态：增量不落盘、
  // 不进 events()、不锚身份，重启不可重建。与 subscribe 同不变式：listener 自包
  // try/catch 进 listenerErrors，绝不毒化 Run
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void {
    this.#streamListeners.add(listener);
    return () => this.#streamListeners.delete(listener);
  }

  // 观察口（189）：订阅压缩提示（压成、自动压缩没压成、压缩前回调失败）；listener 抛异常只进 listenerErrors
  subscribeCompaction(listener: (notice: CompactionNotice) => void): () => void {
    this.#compactionListeners.add(listener);
    return () => this.#compactionListeners.delete(listener);
  }

  // 观察口（286）：订阅工具结果（结果消息落定时）；listener 抛异常只进 listenerErrors
  subscribeToolResults(listener: (notice: ToolResultNotice) => void): () => void {
    this.#toolResultListeners.add(listener);
    return () => this.#toolResultListeners.delete(listener);
  }

  // 决策 350：登记工具执行前的等待口（审批之后、真正执行之前）；返回撤销函数
  addToolGate(gate: () => Promise<void>): () => void {
    this.#toolGates.add(gate);
    return () => this.#toolGates.delete(gate);
  }

  // 观察口（305）：订阅整轮（一轮的工具调用与返回结果，一轮结束时）。在本轮的待递通知转入下一轮之前发出——
  // 订阅方在回调里递的通知随即进下一轮；listener 抛异常只进 listenerErrors
  subscribeRounds(listener: (round: TurnRoundNotice) => void): () => void {
    this.#roundListeners.add(listener);
    return () => this.#roundListeners.delete(listener);
  }

  // 当前上下文用量（286）：同压缩判据的 token 数（最后一条正常助手回复的用量加其后消息的估算，压缩后随之下降）
  // 与模型窗口；没有配置压缩（无窗口可比）时为 undefined
  contextUsage(): { tokens: number; contextWindow: number } | undefined {
    const compactor = this.#compactor;
    if (compactor === undefined) {
      return undefined;
    }
    return {
      tokens: compactor.check(this.#agent.state.messages).tokens,
      contextWindow: compactor.config.contextWindow,
    };
  }

  // 本运行面的压缩配置（188、218）：派出的 worker 按同一配置跑；没有配置压缩时为 undefined
  compactionConfig(): CompactionConfig | undefined {
    return this.#compactor !== undefined ? { ...this.#compactor.config } : undefined;
  }

  // 手动压缩（189 的 /compact [重点]）：重点作为摘要的附加说明。只在没有进行中的 Run 时可用；
  // 完成后整体替换 Agent 的消息为压缩后的上下文。失败以结果返回，不抛
  async compact(customInstructions?: string): Promise<ManualCompactionOutcome> {
    this.#assertUsable();
    if (this.#currentRunId !== null || this.#manualCompacting) {
      throw new Error("Run 进行中，不能手动压缩");
    }
    const compactor = this.#compactor;
    if (compactor === undefined) {
      return { kind: "skipped", reason: "disabled" };
    }
    this.#manualCompacting = true;
    const abort = new AbortController();
    this.#compactionAbort = abort;
    try {
      const focus = customInstructions?.trim();
      const outcome = await this.#runCompaction(
        "manual",
        compactor.check(this.#agent.state.messages).tokens,
        abort.signal,
        focus !== undefined && focus !== "" ? focus : undefined
      );
      if (outcome.kind === "compacted") {
        this.#agent.state.messages = structuredClone(outcome.messages);
        this.#statusCompacted = true;
      }
      return outcome;
    } finally {
      this.#compactionAbort = undefined;
      this.#manualCompacting = false;
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

  // Pi transcript 的深拷贝（观察用途；权威记录以会话存储为准）。
  // 必须深拷贝：浅拷贝会与 Agent 内部共享 message/content 对象，
  // 调用方在观察拷贝上的就地修改会污染 Agent 会话状态，进而毒化后续 Run 的上下文。
  // 拷贝不冻结：观察方对自己的副本做变换是合法的。
  transcript(): AgentMessage[] {
    return structuredClone(this.#agent.state.messages);
  }

  // 续跑（决策 183）：以会话里还原出的消息作为 Agent 的对话上下文（深拷贝）。只在还没有跑过任何 Run、也没有进行中的 Run 时可用
  restoreMessages(messages: readonly AgentMessage[]): void {
    this.#assertUsable();
    if (this.#currentRunId !== null || this.#agent.state.messages.length > 0) {
      throw new Error("只能在运行面跑任何 Run 之前还原对话上下文");
    }
    this.#agent.state.messages = structuredClone([...messages]);
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
    this.#compactionAbort?.abort();
    this.#agent.abort();
    await this.#agent.waitForIdle();
    this.#unsubscribe();
    this.#listeners.clear();
    this.#streamListeners.clear();
    this.#compactionListeners.clear();
    this.#toolResultListeners.clear();
  }

  // 压缩要用的会话树读写：新存储写入面带读分支与写压缩条目时才有
  #compactionStore(): CompactionStore | undefined {
    const sink = this.#sessionStore;
    if (sink?.branch === undefined || sink.appendCompaction === undefined) {
      return undefined;
    }
    return {
      branch: () => sink.branch?.() ?? Promise.resolve(undefined),
      appendCompaction: (result) => sink.appendCompaction?.(result) ?? Promise.resolve(undefined),
    };
  }

  // 转发一条工具结果（286）；构造通知出错（details 不可克隆等）与 listener 抛异常都只进 listenerErrors
  #notifyToolResult(runId: RunId, message: ToolResultMessage): void {
    let notice: ToolResultNotice;
    try {
      notice = Object.freeze({
        runId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        text: message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter((text) => text !== "")
          .join("\n"),
        details: structuredClone(message.details),
      });
    } catch (error) {
      this.#listenerErrors.push(error);
      return;
    }
    for (const listener of this.#toolResultListeners) {
      try {
        listener(notice);
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
  }

  // 发出一条整轮通知（305）：助手消息里的工具调用按出现顺序，结果按 toolCallId 由订阅方对上
  #notifyRound(runId: RunId, message: AgentMessage, toolResults: ToolResultMessage[]): void {
    let round: TurnRoundNotice;
    try {
      const calls =
        message.role === "assistant"
          ? message.content.flatMap((block) =>
              block.type === "toolCall"
                ? [
                    {
                      toolCallId: block.id,
                      toolName: block.name,
                      args: structuredClone(block.arguments),
                    },
                  ]
                : []
            )
          : [];
      round = Object.freeze({
        runId,
        calls,
        results: toolResults.map((result) => ({
          toolCallId: result.toolCallId,
          isError: result.isError,
          text: result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .filter((text) => text !== "")
            .join("\n"),
        })),
        ...(message.role === "assistant" && isTruncatedWithoutTools(message)
          ? { truncated: true as const }
          : {}),
      });
    } catch (error) {
      this.#listenerErrors.push(error);
      return;
    }
    for (const listener of this.#roundListeners) {
      try {
        listener(round);
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
  }

  // 发出一条压缩提示；listener 抛异常只进 listenerErrors
  #notifyCompaction(notice: CompactionNotice): void {
    const frozen = Object.freeze(notice);
    for (const listener of this.#compactionListeners) {
      try {
        listener(frozen);
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
  }

  // 执行一次压缩并发出提示。摘要请求失败与压缩前回调失败属运行时诊断，经提示给出、不计入会话记录写入失败；
  // 压缩条目写不进会话文件属落盘失败，仍进 listenerErrors
  async #runCompaction(
    trigger: CompactionTrigger,
    tokens: number,
    signal: AbortSignal,
    customInstructions?: string
  ): Promise<CompactionOutcome> {
    const compactor = this.#compactor;
    if (compactor === undefined) {
      return { kind: "skipped", reason: "store-unavailable" };
    }
    const outcome = await compactor.run(this.#compactionStore(), {
      trigger,
      tokens,
      ...(customInstructions !== undefined ? { customInstructions } : {}),
      signal,
      onHookError: (error) => {
        this.#notifyCompaction({ kind: "hook-failed", trigger, error });
      },
    });
    if (outcome.kind === "failed" && outcome.stage === "store") {
      this.#listenerErrors.push(outcome.error);
    }
    if (outcome.kind === "compacted") {
      this.#notifyCompaction({
        kind: "compacted",
        trigger,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
        messages: outcome.messages,
      });
    } else if (trigger !== "manual" && !signal.aborted) {
      this.#notifyCompaction({ kind: "incomplete", trigger, outcome });
    }
    return outcome;
  }

  // 轮间挂点（上游 prepareNextTurnWithContext）：本轮的消息都已交给新存储写者，超过触发点即压缩，返回替换后的上下文；
  // 未超过或压缩没有完成时返回 undefined（照原上下文继续）。上游对此回调无防护，这里绝不抛
  // 轮间挂点：先压缩（需要时），再把留到轮间的状态消息与待递通知交给上游——上游在这之后、发下一次请求之前取走，
  // 排在该批工具结果之后（决策 363）。中断或钩子要求停止时不交，留待下一次运行
  async #compactBetweenTurns(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal
  ): Promise<AgentLoopTurnUpdate | undefined> {
    const update = await this.#compactTurn(turn, signal);
    const proceed = !this.#interruptRequested && this.#hookStopReason === undefined;
    // 压缩抹掉了此前的状态块：不论本轮有没有工具结果，下一次请求之前都重发完整块。上游在已有待交消息（通知、排队的输入）时
    // 压缩之后不再取 steer 队列，故直接放进压缩后的上下文末尾，并照常记进会话记录
    const injected =
      update?.context !== undefined && proceed ? await this.#injectStatus(update.context) : false;
    if (this.#deliverAfterTurn) {
      this.#deliverAfterTurn = false;
      if (proceed) {
        const status = injected ? [] : await this.#statusMessages("turn");
        for (const message of [...status, ...this.#takeNotices()]) {
          this.#agent.steer(message);
        }
      }
    }
    return update;
  }

  // 轮间压缩之后的完整状态块：放进压缩后的上下文末尾，记进会话记录（占本 Run 一个条目序号），并补进压缩后的消息
  //（Run 结束按会话树还原；读不到会话树时退回的那份也要有它）。放进去了返回 true
  async #injectStatus(context: { messages: AgentMessage[] }): Promise<boolean> {
    const [message] = await this.#statusMessages("turn");
    if (message === undefined) {
      return false;
    }
    context.messages.push(message);
    this.#turnCompaction?.messages.push(message);
    this.#runEntrySeq += 1;
    if (this.#sessionStore !== undefined) {
      try {
        this.#sessionStore.appendMessage(structuredClone(message));
      } catch (error) {
        this.#listenerErrors.push(error);
      }
    }
    this.#statusDelivered();
    return true;
  }

  // 状态消息进了会话记录：告诉通道记成已发；通道出错只进 listenerErrors
  #statusDelivered(): void {
    try {
      this.#status?.delivered();
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 决策 363：问状态通道要一条状态消息；通道出错只进 listenerErrors，这一次不带（压缩标记留着，下次照样重发完整块）
  async #statusMessages(where: "run" | "turn"): Promise<AgentMessage[]> {
    const status = this.#status;
    if (status === undefined) {
      return [];
    }
    try {
      const input = { compacted: this.#statusCompacted };
      const text =
        where === "run" ? await status.beforeRun(input) : await status.betweenTurns(input);
      this.#statusCompacted = false;
      return text === undefined
        ? []
        : [
            {
              role: "user",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
              [STATUS_MARKER]: true,
            } as AgentMessage,
          ];
    } catch (error) {
      this.#listenerErrors.push(error);
      return [];
    }
  }

  async #compactTurn(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal
  ): Promise<AgentLoopTurnUpdate | undefined> {
    try {
      const compactor = this.#compactor;
      if (compactor === undefined || this.#currentRunId === null) {
        return undefined;
      }
      const { tokens, exceeds } = compactor.check(turn.context.messages);
      if (!exceeds) {
        return undefined;
      }
      const outcome = await this.#runCompaction(
        "turn",
        tokens,
        signal ?? new AbortController().signal
      );
      if (outcome.kind !== "compacted") {
        return undefined;
      }
      this.#turnCompaction = {
        messages: outcome.messages,
        stateLength: this.#agent.state.messages.length,
      };
      this.#statusCompacted = true;
      return { context: { ...turn.context, messages: structuredClone(outcome.messages) } };
    } catch (error) {
      this.#listenerErrors.push(error);
      return undefined;
    }
  }

  // Run 开始之前的挂点：超过触发点即压缩并整体替换 Agent 的消息。返回压缩期间是否被中断
  async #compactBeforeRun(): Promise<boolean> {
    const compactor = this.#compactor;
    if (compactor === undefined) {
      return false;
    }
    const abort = new AbortController();
    this.#compactionAbort = abort;
    try {
      const { tokens, exceeds } = compactor.check(this.#agent.state.messages);
      if (!exceeds) {
        return false;
      }
      const outcome = await this.#runCompaction("run-start", tokens, abort.signal);
      if (outcome.kind === "compacted" && !abort.signal.aborted) {
        this.#agent.state.messages = structuredClone(outcome.messages);
        this.#statusCompacted = true;
      }
      return abort.signal.aborted;
    } catch (error) {
      this.#listenerErrors.push(error);
      return abort.signal.aborted;
    } finally {
      this.#compactionAbort = undefined;
    }
  }

  // 本 Run 内轮间压缩过：Agent 的消息按 message_end 累积了全量，按会话树重新还原一次，使下一个 Run 从压缩后的上下文接着跑。
  // 会话树读不到时退回压缩后的上下文加压缩之后追加的消息
  async #restoreAfterTurnCompaction(): Promise<void> {
    const compaction = this.#turnCompaction;
    if (compaction === undefined) {
      return;
    }
    this.#turnCompaction = undefined;
    try {
      const entries = await this.#compactionStore()?.branch();
      const messages =
        entries !== undefined
          ? buildSessionContext(entries).messages
          : [...compaction.messages, ...this.#agent.state.messages.slice(compaction.stateLength)];
      this.#agent.state.messages = structuredClone(messages);
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // beforeToolCall 转发（决策 049）：判定交治理实例，阻断理由原样交回上游（逐字成为模型可见的
  // error toolResult）。治理实现承诺自身不抛；接缝仍兜一层——实现若抛，按 fail-closed 阻断，
  // 不交给上游的"hook 抛错降级为错误文案"路径
  async #forwardDecide(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
    // continue:false 已置位：本批其余调用一律拦下并带 terminate，不再交治理判定——停下后不再执行钩子、不再请示
    if (this.#hookStopReason !== undefined) {
      return { block: true, reason: this.#hookStopReason, terminate: true };
    }
    try {
      const verdict = await this.#governance.decide({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.toolCall.arguments,
        preparedArgs: context.args,
      });
      if (verdict.kind === "block") {
        // continue:false（terminate）：整轮结束——记理由；本批经 terminate 提前收尾，不调 abort
        // （abort 在假流不遵守中止信号时会多发一次模型请求；terminate 让批干净地停）
        if (verdict.terminate === true) {
          this.#hookStopReason = verdict.reason;
        }
        return {
          block: true,
          reason: verdict.reason,
          ...(verdict.terminate === true ? { terminate: true } : {}),
        };
      }
      // 决策 324：钩子改过的参数——执行时替换上游按原参数校验过的 args（账本已按改后参数记录）
      if (verdict.updatedArgs !== undefined) {
        this.#updatedArgs.set(context.toolCall.id, verdict.updatedArgs);
      }
      return undefined;
    } catch (error) {
      return {
        block: true,
        reason: `治理判定异常（fail-closed 阻断）：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // afterToolCall 转发（决策 324）：PostToolUse / PostToolUseFailure——成功走前者、失败走后者；
  // 替换的结果文本（updatedToolOutput）整份替换正文，补的理由与上下文（decision block 的 reason、additionalContext）
  // 追加为结果末尾的一个文本块；钩子自身出错只记进内部异常清单，不改变工具结果
  async #forwardAfterToolCall(
    context: AfterToolCallContext
  ): Promise<AfterToolCallResult | undefined> {
    if (this.#toolHooks?.toolFinished === undefined) return undefined;
    // 钩子已要求停止（continue:false）：同批其余调用（并行批次里已准备好、仍在执行的）不再跑收尾钩子
    if (this.#hookStopReason !== undefined) return undefined;
    try {
      const text = context.result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const outcome = await this.#toolHooks.toolFinished({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
        isError: context.isError,
        text,
      });
      if (outcome === undefined) return undefined;
      // continue:false：整轮结束（决策 324 复审：PostToolUse 也生效，不只是 PreToolUse）
      if (outcome.stopReason !== undefined) {
        this.#hookStopReason = outcome.stopReason;
        this.#agent.abort();
      }
      const extra: Array<{ type: "text"; text: string }> = [];
      if (outcome.contextText !== undefined) {
        extra.push({ type: "text", text: outcome.contextText });
      }
      if (outcome.replaceText !== undefined) {
        return { content: [{ type: "text", text: outcome.replaceText }, ...extra] };
      }
      if (extra.length > 0) {
        return { content: [...context.result.content, ...extra] };
      }
      return undefined;
    } catch (error) {
      this.#listenerErrors.push(error);
      return undefined;
    }
  }

  // 工具执行体包装（M4 S2，D7）：捕获抛出的真实错误对象并按域/环境归类存证——
  // 上游 agent-loop 把工具异常转成 isError 结果（createErrorToolResult）后只剩消息字符串，
  // 错误类信息过了那道边界就不可恢复。spread 保留 preview/内容证据探针等可选能力
  #wrapToolErrorCapture(tool: AgentTool): AgentTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        // 决策 324：PreToolUse 钩子改过的参数——用改后的参数执行（治理已按它重新过完全部检查）
        const updated = this.#updatedArgs.get(toolCallId);
        if (updated !== undefined) {
          this.#updatedArgs.delete(toolCallId);
        }
        for (const gate of this.#toolGates) {
          try {
            await gate();
          } catch (error) {
            this.#listenerErrors.push(error);
          }
        }
        try {
          return await tool.execute(
            toolCallId,
            updated !== undefined ? updated : params,
            signal,
            onUpdate
          );
        } catch (error) {
          this.#toolErrorKinds.set(toolCallId, classifyToolError(error));
          throw error;
        }
      },
    };
  }

  // Pi 事件入口：归一化 + 写会话存储 + 账本联动 + 转发。整个路径自包 try/catch，
  // 任何异常（含归一化自身）都只进 listenerErrors，绝不冒泡回上游毒化 Run。
  #recordAndForward(event: AgentEvent): void {
    try {
      const runId = this.#currentRunId;
      if (!runId) {
        return;
      }
      // 决策 305：整轮观察口排在通知转入之前，订阅方这时递的通知同样进下一轮
      if (event.type === "turn_end" && this.#roundListeners.size > 0) {
        this.#notifyRound(runId, event.message, event.toolResults);
      }
      // 决策 297：一轮结束时把待递的通知转入上游的 steer 队列，上游随即在进入下一轮前取走（本轮没有工具调用时同样接着跑一轮）；
      // 钩子要求停止（continue:false）时这一轮之后即停，通知留在本地队列待下一次运行
      // 决策 363：挂了状态通道时，有工具结果的一轮留到轮间（压缩之后）连同状态消息一起交（见 #compactBetweenTurns）
      if (
        event.type === "turn_end" &&
        !this.#interruptRequested &&
        this.#hookStopReason === undefined
      ) {
        if (this.#status !== undefined && event.toolResults.length > 0) {
          this.#deliverAfterTurn = true;
        } else if (this.#notices.length > 0) {
          for (const message of this.#takeNotices()) {
            this.#agent.steer(message);
          }
        }
      }
      // 空回复要重试或撞上限要续跑时暂扣这次 agent_end：一个 Run 只发一次 run.ended（订阅方据它验证、收会话树），由最后那次的发出
      if (
        event.type === "agent_end" &&
        (this.#shouldRetryEmptyReply() || this.#shouldContinueTruncated())
      ) {
        this.#deferredRunEnd = event;
        return;
      }
      // D3（M4 S5）：身份只在 message_end 时刻确立（spike P1/P3：流式阶段的 start/update 是浅拷贝 partial，
      // 不锚身份）。每条 message_end——含归一化不产生事件的 user/toolResult、abort 与上游合成失败消息——
      // 都占一个 Run 内序号并交给会话存储。时序：上游 processEvents 先 push transcript 再 await listener
      // （agent.js 379-420），本回调在同一事件分派内同步交出，先于任何后续 transcript 变更。
      // 序号推进无条件、写入隔离 try/catch（同本函数不变式：记录逻辑自身绝不抛）。
      if (event.type === "message_end") {
        this.#runEntrySeq += 1;
        // 决策 367：一条助手回复没触发续跑（不是撞上限且没有工具调用），连续续跑次数清零
        if (event.message.role === "assistant" && !isTruncatedWithoutTools(event.message)) {
          this.#consecutiveContinuations = 0;
        }
        if (event.message.role === "toolResult") {
          this.#markToolResult(event.message);
        }
        // 完整消息的深拷贝进会话存储（179：不截断；上游零防御拷贝，不得与 Agent 持有的消息共享对象）；
        // 写入面异常只进 listenerErrors
        if (this.#sessionStore !== undefined) {
          try {
            this.#sessionStore.appendMessage(structuredClone(event.message));
          } catch (error) {
            this.#listenerErrors.push(error);
          }
        }
        // 决策 363：状态消息记下了，通道据此记成已发
        if (isStatusMessage(event.message)) {
          this.#statusDelivered();
        }
        // 工具结果观察口（286）排在会话存储写入之后：它的任何故障都不影响本条的记录
        if (event.message.role === "toolResult" && this.#toolResultListeners.size > 0) {
          this.#notifyToolResult(runId, event.message);
        }
      }
      const normalized = normalizePiEvent(event, { sessionId: this.sessionId, runId });
      if (!normalized) {
        // 决策 024 流式观察口：message_update 携带 text_delta / thinking_delta 时把增量连同
        // runId 与 kind 转发给 subscribeStream 订阅者（045 修订：thinking 一并转发）——这是增量的
        // 唯一出口：不归一化（normalizePiEvent 对 message_update 返回 null）、不落盘、
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
        // 决策 049：账本迁 settled、上游拦截熔断计数归治理实例；
        // 其内部故障只进 listenerErrors，不影响下方事件入内存序列与转发
        this.#governance.settle(payload);
      }
      // 不变式：事件入内存序列与转发无条件——账本联动故障（上方已隔离）或任何其他异常
      // 都不得让事件从 #events 或 listener 丢失。
      // 单一冻结点：内存序列与 listener 共享同一冻结对象，事件不可变。
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

  // Run 开始条目（182 / 184）：本次配置与系统提示全文
  #recordRunStart(runId: RunId, advertisedTools: string[], extras: RunStartedExtras): void {
    if (this.#sessionStore === undefined) {
      return;
    }
    const snapshot = this.#snapshot;
    try {
      this.#sessionStore.append({
        customType: SessionEntryType.RunStart,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId,
          startedAt: Date.now(),
          model: {
            provider: snapshot.model.provider,
            id: snapshot.model.id,
            thinkingLevel: snapshot.model.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
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
          advertisedTools: [...advertisedTools],
          systemPrompt: snapshot.context.systemPrompt,
          ...(snapshot.context.taskDirective !== undefined
            ? { taskDirective: snapshot.context.taskDirective }
            : {}),
          memory: structuredClone(snapshot.memory),
          skills: structuredClone(snapshot.skills),
          ...structuredClone(extras),
          ...(snapshot.budget !== undefined ? { budget: { ...snapshot.budget } } : {}),
          // 决策 188、218：本次的压缩配置
          ...(this.#compactor !== undefined ? { compaction: { ...this.#compactor.config } } : {}),
          // 决策 332：推送的记忆
          ...(snapshot.pushedMemory !== undefined
            ? { pushedMemory: structuredClone(snapshot.pushedMemory) }
            : {}),
          // 决策 362：本次所用的模型信息与来源
          ...(this.#modelInfo !== undefined ? { modelInfo: structuredClone(this.#modelInfo) } : {}),
        },
      });
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // Run 收尾条目（182）。结束方式：空回复异常结束记 empty-reply；确以中止收尾时，撞上限的原因优先，其次熔断，否则为中止；
  // 出错与终态不明记为出错；其余为正常完成
  #recordRunEnded(
    result: Pick<RunResult, "runId" | "status" | "stopReason" | "errorMessage" | "emptyReply">
  ): void {
    if (this.#sessionStore === undefined) {
      return;
    }
    let ending: RunEnding;
    if (result.emptyReply === true) {
      ending = "empty-reply";
    } else if (result.status === "aborted") {
      ending =
        this.#stopCause ?? (this.#governance.runOutcome().breakerTripped ? "breaker" : "aborted");
    } else if (result.status === "completed") {
      ending = "completed";
    } else {
      ending = "error";
    }
    try {
      this.#sessionStore.append({
        customType: SessionEntryType.RunEnd,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId: result.runId,
          ending,
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          messageCount: this.#runEntrySeq,
          endedAt: Date.now(),
        },
      });
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
    // 走到这里仍以空回复收尾：已重试过一次，或空回复时已来了中止请求、没能重试
    const emptyReply = lastAssistant !== undefined && isEmptyReply(lastAssistant);
    const errorMessage = emptyReply ? EMPTY_REPLY_ERROR : this.#agent.state.errorMessage;
    let status: RunTerminalStatus;
    if (this.#hookStopReason !== undefined) {
      // 钩子的 continue:false：整轮被钩子停下——终态中止，原因如实交出（stopReason 显示给人）
      status = "aborted";
      return {
        runId,
        status,
        errorMessage: `钩子要求停止：${this.#hookStopReason}`,
        syntheticFailure: false,
        failure: null,
        advertisedTools,
        toolExecutions: this.#governance.runOutcome().toolExecutions,
        emptyReply: false,
      };
    }
    if (emptyReply) {
      status = "failed";
    } else if (stopReason === "aborted") {
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
      // M4 S2（D7）：活侧失败四分类——与会话读者同一判据纯函数；
      // 活侧事实直接取自终态判定与治理实例的熔断状态
      failure: classifyRunOutcome({
        ...(stopReason !== undefined ? { stopReason } : {}),
        syntheticFailure,
        breakerTripped: governed.breakerTripped,
        hasTurnCompleted: lastAssistant !== undefined,
        // 活侧在 prompt() resolve 之后计算，agent_end 已发出（abort 路径同样发）
        hasRunEnded: true,
        emptyReply,
      }),
      advertisedTools,
      toolExecutions: governed.toolExecutions,
      emptyReply,
    };
  }

  // 审批请求的 runId 来源：审批闸与 tool.settled 联动只在 Run 活动窗口内发生，
  // 窗口外调用说明时序错乱，响亮失败
  #activeRunId(): RunId {
    const runId = this.#currentRunId;
    if (runId === null) {
      throw new Error("审批闸需要活动 Run（hook/settled 联动只在 Run 窗口内发生）");
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
