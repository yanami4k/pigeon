// 判定类读者的原生视图（账本重构第二段，决策 180 / 182 / 183 / 184）：成败分类与标签、回炉一步、尝试切片、运行指标、
// 工具级失败分类、需审批次数、生效授权与 worker 派出记录，全部直接从新会话存储的条目现算——消息条目与七种自定义条目，
// 不合成旧账本形状的视图。纯函数、无 IO：读哪个会话文件、读主分支哪一段由调用方决定（persistence/session-reader.ts）。
// 判据沿用 classification.ts 与 outcome-label.ts 的同一套纯函数，只换事实来源：
// - Run 级失败分类：末条助手消息的停止原因与是否上游合成的失败消息、Run 收尾条目在不在、结束方式是不是熔断；
// - 撞上限：Run 收尾条目的结束方式（轮数、墙钟、token 三种）；
// - 悬账：带工具调用而没有工具结果的助手消息（续跑时补的"结果未知"工具结果同样算，它只说明结果不明）；
// - 验证结论：验证记录条目（旧 eval.verified 随 184 停写，不再计入）；
// - 工具级失败分类与需审批次数：工具结果消息 details 里运行面挂的标记（错误归类与审批闸决定），没有标记时退回按消息正文与策略判。
// 旧账本的判定函数（materialize.ts、outcome-label.ts、episode.ts、repair-step.ts）在停写之前保留，只供双写对照与
// 双写之前的旧会话回退读取；新读者一律经本文件。
import type { AttemptRef, OutcomeLabel } from "./attempt-ref.ts";
import { classifyRunOutcome, type FailureClass } from "./classification.ts";
import type { RunId, SessionId } from "./ids.ts";
import type { ActiveGrant } from "./materialize.ts";
import { type AttemptOutcomeFacts, labelAttempt } from "./outcome-label.ts";
import type { EvalVerdict, TurnUsage } from "./runtime-events.ts";
import {
  type CheckpointData,
  type ForkData,
  type GrantData,
  type RunEndData,
  type RunStartData,
  SessionEntryType,
  type SessionHeaderMetadata,
  type VerificationData,
  type WorkerData,
} from "./session-entries.ts";

// 读取器给出的一条条目（结构兼容 persistence/session-reader.ts 的 StoredEntry；state 不依赖 persistence）
export interface StoreEntry {
  type: string;
  id: string;
  parentId: string | null;
  [field: string]: unknown;
}

// 本文件用到的 pi 消息字段（state 不依赖上游类型，按结构读）
export interface StoreMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: Partial<TurnUsage> & { cost?: Partial<TurnUsage["cost"]> };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

export interface StoreMessageRef {
  entryId: string;
  message: StoreMessage;
}

// 代码快照：afterRunSeq 同旧记录的口径——快照打在工具落定时，下一条消息就是该调用的工具结果，快照归到那一条
// （所属 Run 里前面已有的消息条数加一）
export interface StoreCheckpoint {
  entryId: string;
  data: CheckpointData;
  afterRunSeq: number;
}

export interface StoreRun {
  runId: RunId;
  start: RunStartData;
  end?: RunEndData;
  messages: StoreMessageRef[];
  checkpoints: StoreCheckpoint[];
}

export interface StoreRecord<T> {
  entryId: string;
  data: T;
}

export interface StoreSessionView {
  sessionId: SessionId;
  parentSessionId?: SessionId;
  metadata?: SessionHeaderMetadata;
  // 本会话自己的 Run（分支会话不含从来源复制过来的那一段）
  runs: StoreRun[];
  verifications: StoreRecord<VerificationData>[];
  forks: StoreRecord<ForkData>[];
  workers: StoreRecord<WorkerData>[];
  grants: StoreRecord<GrantData>[];
}

// 续跑时为悬空工具调用补的工具结果（决策 183）：正文给 agent 看，details 里的标记给读者认
export const INTERRUPTED_TOOL_RESULT_TEXT =
  "进程在执行途中中断，这次工具调用的结果未知：请自行核实（例如重新读取相关文件、查看命令的效果）后再决定下一步。";
export const INTERRUPTED_TOOL_RESULT_MARK = "pigeonInterrupted";

// 运行面给工具结果消息挂的标记（写在该消息 details 的这个键下，不新增记录种类）：工具抛错时的错误归类（域 / 环境；
// 上游拦截记域错误），与审批闸对这次调用的决定（结果与批准来源；上游拦截的调用审批闸没跑过，没有这一项）
export const TOOL_RESULT_MARK_KEY = "pigeon";
export interface ToolResultMark {
  errorKind?: "domain" | "environment";
  gate?: { outcome: "approved" | "rejected"; approvedBy: string };
}

// 审批闸在 prompt 档而没有审批通道时的固定拒绝理由（application/governance.ts 用它，工具级分类据它认出策略拒绝）
export const FAIL_CLOSED_APPROVAL_REASON = "策略要求人工审批但未配置审批通道";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function customData<T>(entry: StoreEntry, customType: string): T | undefined {
  return entry.type === "custom" && entry.customType === customType && isObject(entry.data)
    ? (entry.data as T)
    : undefined;
}

function messageOf(entry: StoreEntry): StoreMessage | undefined {
  if (entry.type !== "message" || !isObject(entry.message)) {
    return undefined;
  }
  const message = entry.message;
  return typeof message.role === "string" ? (message as unknown as StoreMessage) : undefined;
}

// 分支会话文件开头从来源复制过来的条目数：pi 的 fork 复制根到分叉点（含）的路径，分叉点由文件头的分支来历给出
function copiedPrefixLength(
  entries: readonly StoreEntry[],
  metadata: SessionHeaderMetadata | undefined
): number {
  const point = metadata?.branch?.forkPoint;
  if (point === undefined) {
    return 0;
  }
  let inRun = false;
  let count = 0;
  for (const [index, entry] of entries.entries()) {
    const start = customData<RunStartData>(entry, SessionEntryType.RunStart);
    if (start !== undefined) {
      inRun = start.runId === point.runId;
      count = 0;
    } else if (inRun && entry.type === "message") {
      count += 1;
      if (count === point.runSeq) {
        return index + 1;
      }
    }
  }
  return 0;
}

// 由主分支条目（根到叶）建视图：Run 开始之后、下一个 Run 开始之前的消息与快照属于它
export function storeSessionView(input: {
  sessionId: SessionId;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
  entries: readonly StoreEntry[];
}): StoreSessionView {
  const metadata = isObject(input.metadata?.pigeon)
    ? (input.metadata.pigeon as unknown as SessionHeaderMetadata)
    : undefined;
  const runs: StoreRun[] = [];
  const verifications: StoreRecord<VerificationData>[] = [];
  const forks: StoreRecord<ForkData>[] = [];
  const workers: StoreRecord<WorkerData>[] = [];
  const grants: StoreRecord<GrantData>[] = [];
  const own = input.entries.slice(copiedPrefixLength(input.entries, metadata));
  for (const entry of own) {
    const current = runs.at(-1);
    const start = customData<RunStartData>(entry, SessionEntryType.RunStart);
    if (start !== undefined) {
      runs.push({ runId: start.runId, start, messages: [], checkpoints: [] });
      continue;
    }
    const end = customData<RunEndData>(entry, SessionEntryType.RunEnd);
    if (end !== undefined) {
      const run = runs.find((candidate) => candidate.runId === end.runId);
      if (run !== undefined) {
        run.end = end;
      }
      continue;
    }
    const message = messageOf(entry);
    if (message !== undefined) {
      current?.messages.push({ entryId: entry.id, message });
      continue;
    }
    const checkpoint = customData<CheckpointData>(entry, SessionEntryType.Checkpoint);
    if (checkpoint !== undefined) {
      const run = runs.find((candidate) => candidate.runId === checkpoint.runId);
      run?.checkpoints.push({
        entryId: entry.id,
        data: checkpoint,
        afterRunSeq: run.messages.length + 1,
      });
      continue;
    }
    const verification = customData<VerificationData>(entry, SessionEntryType.Verification);
    if (verification !== undefined) {
      verifications.push({ entryId: entry.id, data: verification });
      continue;
    }
    const fork = customData<ForkData>(entry, SessionEntryType.Fork);
    if (fork !== undefined) {
      forks.push({ entryId: entry.id, data: fork });
      continue;
    }
    const worker = customData<WorkerData>(entry, SessionEntryType.Worker);
    if (worker !== undefined) {
      workers.push({ entryId: entry.id, data: worker });
      continue;
    }
    const grant = customData<GrantData>(entry, SessionEntryType.Grant);
    if (grant !== undefined) {
      grants.push({ entryId: entry.id, data: grant });
    }
  }
  return {
    sessionId: input.sessionId,
    ...(input.parentSessionId !== undefined
      ? { parentSessionId: input.parentSessionId as SessionId }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    runs,
    verifications,
    forks,
    workers,
    grants,
  };
}

// ---- 消息的几项事实 ----

interface ToolCallBlock {
  id: string;
  name: string;
}

// 助手消息里会被执行的工具调用：以出错或中止收尾的助手消息里的调用上游从不执行（pi-agent-core 0.84.4 agent-loop），
// 发给模型时也整条跳过（pi-ai transform-messages），不算发起过
function toolCallsOf(message: StoreMessage): ToolCallBlock[] {
  if (
    message.role !== "assistant" ||
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    !Array.isArray(message.content)
  ) {
    return [];
  }
  const calls: ToolCallBlock[] = [];
  for (const block of message.content) {
    if (
      isObject(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      calls.push({ id: block.id, name: block.name });
    }
  }
  return calls;
}

function textOf(message: StoreMessage): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((block) => (isObject(block) && block.type === "text" ? String(block.text ?? "") : ""))
    .join("");
}

// 上游合成的失败消息（provider 侧故障）：同 pi-runtime/events.ts 的判据——带错误文本、正文只有一个空文本块、用量全零
export function isSyntheticFailure(message: StoreMessage): boolean {
  if (message.role !== "assistant" || typeof message.errorMessage !== "string") {
    return false;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const first = content[0];
  const emptyText =
    content.length === 1 && isObject(first) && first.type === "text" && first.text === "";
  const usage = message.usage;
  const zeroUsage =
    usage !== undefined &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0;
  return emptyText && zeroUsage;
}

// 工具结果消息上的运行面标记；没有标记（标记之前写的文件、测试夹具）返回 undefined
export function toolResultMark(message: StoreMessage): ToolResultMark | undefined {
  if (message.role !== "toolResult" || !isObject(message.details)) {
    return undefined;
  }
  const mark = message.details[TOOL_RESULT_MARK_KEY];
  if (!isObject(mark)) {
    return undefined;
  }
  const gate = isObject(mark.gate) ? mark.gate : undefined;
  return {
    ...(mark.errorKind === "domain" || mark.errorKind === "environment"
      ? { errorKind: mark.errorKind }
      : {}),
    ...(gate !== undefined &&
    (gate.outcome === "approved" || gate.outcome === "rejected") &&
    typeof gate.approvedBy === "string"
      ? { gate: { outcome: gate.outcome, approvedBy: gate.approvedBy } }
      : {}),
  };
}

// 续跑时补的"结果未知"工具结果
export function isInterruptedToolResult(message: StoreMessage): boolean {
  return (
    message.role === "toolResult" &&
    isObject(message.details) &&
    message.details[INTERRUPTED_TOOL_RESULT_MARK] === true
  );
}

// 一段消息末尾悬空的工具调用：末条助手消息里没有配上工具结果的调用（续跑时补结果用）。
// 末条助手消息以出错或中止收尾时它的调用没被执行，也不会发给模型，不算悬空
export function danglingToolCalls(messages: readonly StoreMessage[]): ToolCallBlock[] {
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant === -1) {
    return [];
  }
  const answered = new Set(
    messages
      .slice(lastAssistant + 1)
      .flatMap((message) =>
        message.role === "toolResult" && typeof message.toolCallId === "string"
          ? [message.toolCallId]
          : []
      )
  );
  const assistant = messages[lastAssistant];
  return assistant === undefined
    ? []
    : toolCallsOf(assistant).filter((call) => !answered.has(call.id));
}

// ---- Run 级 ----

export function findRun(view: StoreSessionView, runId: RunId): StoreRun | undefined {
  return view.runs.find((run) => run.runId === runId);
}

function lastAssistantOf(run: StoreRun): StoreMessage | undefined {
  return run.messages.findLast((ref) => ref.message.role === "assistant")?.message;
}

// Run 级失败分类（同 classifyRunOutcome 判据）：收尾条目即运行结束的证据，末条助手消息给停止原因与合成失败
export function storeRunFailure(run: StoreRun): FailureClass | null {
  const lastAssistant = lastAssistantOf(run);
  return classifyRunOutcome({
    ...(lastAssistant?.stopReason !== undefined ? { stopReason: lastAssistant.stopReason } : {}),
    syntheticFailure: lastAssistant !== undefined && isSyntheticFailure(lastAssistant),
    breakerTripped: run.end?.ending === "breaker",
    hasTurnCompleted: lastAssistant !== undefined,
    hasRunEnded: run.end !== undefined,
  });
}

function limitHitOf(run: StoreRun | undefined): boolean {
  const ending = run?.end?.ending;
  return ending === "turn-limit" || ending === "wall-clock-limit" || ending === "token-limit";
}

// 本 Run 的悬账：没有配上工具结果、或只配上续跑补的"结果未知"工具结果的工具调用
function pendingToolCallsOf(run: StoreRun): number {
  const results = new Map<string, StoreMessage>();
  for (const { message } of run.messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, message);
    }
  }
  let pending = 0;
  for (const { message } of run.messages) {
    for (const call of toolCallsOf(message)) {
      const result = results.get(call.id);
      if (result === undefined || isInterruptedToolResult(result)) {
        pending += 1;
      }
    }
  }
  return pending;
}

// ---- 回炉一步（决策 142 / 143 / 154 修订），同 repair-step.ts 的口径 ----

export function storeRepairRounds(view: StoreSessionView): number {
  return view.runs[0]?.start.repairRounds ?? 0;
}

export function storeStepRuns(view: StoreSessionView, runId: RunId): RunId[] {
  if (storeRepairRounds(view) === 0) {
    return [runId];
  }
  const runs = view.runs.map((run) => run.runId);
  return runs.includes(runId) ? runs : [runId];
}

export function storeLastStepRun(view: StoreSessionView, runId: RunId): RunId {
  return storeStepRuns(view, runId).at(-1) ?? runId;
}

// 某个 Run 上验证时间最晚的一条验证记录；sources 为其他可能承载它的会话（worker 尝试的验证落在父会话里）
export function storeLastVerification(
  view: StoreSessionView,
  runId: RunId,
  sources: readonly StoreSessionView[] = []
): { sessionId: SessionId; record: StoreRecord<VerificationData> } | undefined {
  let best: { sessionId: SessionId; record: StoreRecord<VerificationData> } | undefined;
  for (const source of [view, ...sources]) {
    for (const record of source.verifications) {
      const target = record.data.target;
      if (
        target.sessionId === view.sessionId &&
        target.runId === runId &&
        (best === undefined || record.data.verifiedAt >= best.record.data.verifiedAt)
      ) {
        best = { sessionId: source.sessionId, record };
      }
    }
  }
  return best;
}

export interface StoreRepairStepOutcome {
  rounds: number;
  verdict?: EvalVerdict;
}

// 回炉一步的结果；回炉未开启返回 undefined
export function storeRepairStepOutcome(view: StoreSessionView): StoreRepairStepOutcome | undefined {
  if (storeRepairRounds(view) === 0) {
    return undefined;
  }
  const lastRun = view.runs.at(-1)?.runId;
  const last = lastRun !== undefined ? storeLastVerification(view, lastRun) : undefined;
  return {
    rounds: Math.max(0, view.runs.length - 1),
    ...(last !== undefined ? { verdict: last.record.data.verdict } : {}),
  };
}

// ---- 成败标签（决策 072，判定顺序见 outcome-label.ts） ----

export function storeAttemptFacts(
  view: StoreSessionView,
  runId: RunId,
  options: { verificationSources?: readonly StoreSessionView[] } = {}
): AttemptOutcomeFacts {
  const stepRuns = storeStepRuns(view, runId);
  const lastRunId = stepRuns.at(-1) ?? runId;
  const lastRun = findRun(view, lastRunId);
  const last = storeLastVerification(view, lastRunId, options.verificationSources);
  // 回炉开启时最后一个 Run 没有验证记录即这一步未收尾，与缺收尾条目同样现算为未知
  const stepClosed =
    storeRepairRounds(view) === 0 || storeLastVerification(view, lastRunId) !== undefined;
  const pendingCount = stepRuns.reduce((sum, id) => {
    const run = findRun(view, id);
    return sum + (run !== undefined ? pendingToolCallsOf(run) : 0);
  }, 0);
  return {
    hasRunEnded: stepClosed && lastRun?.end !== undefined,
    pendingCount,
    failure: lastRun !== undefined ? storeRunFailure(lastRun) : { category: "unknown" },
    limitHit: limitHitOf(lastRun),
    ...(last !== undefined ? { verdict: last.record.data.verdict } : {}),
  };
}

export function storeAttemptLabel(
  view: StoreSessionView,
  runId: RunId,
  options: { verificationSources?: readonly StoreSessionView[] } = {}
): OutcomeLabel {
  return labelAttempt(storeAttemptFacts(view, runId, options));
}

// ---- 尝试切片（决策 070）：一次尝试 = 尝试会话的首个 Run，回炉时轮次按整步计、收尾取整步最后一个 Run ----

export interface StoreAttempt extends AttemptRef {
  turns: number;
  endedAt?: number;
}

export function storeFirstRun(view: StoreSessionView): RunId | undefined {
  return view.runs[0]?.runId;
}

// 一个 Run 的最末条目号：本 Run 的消息条数；收尾条目记的消息数更大时以它为准
export function storeLastRunSeq(view: StoreSessionView, runId: RunId): number {
  const run = findRun(view, runId);
  return Math.max(run?.messages.length ?? 0, run?.end?.messageCount ?? 0);
}

export function storeTaskAttempt(input: {
  governanceRoot: string;
  view: StoreSessionView;
  runId?: RunId;
  fromRunSeq?: number;
  verificationSources?: readonly StoreSessionView[];
}): StoreAttempt {
  const { view } = input;
  const runId = input.runId ?? storeFirstRun(view);
  if (runId === undefined) {
    throw new Error(`会话 ${view.sessionId} 没有任何 Run，不能作为一次尝试`);
  }
  const sources = input.verificationSources ?? [];
  const stepRuns = storeStepRuns(view, runId);
  let turns = 0;
  let endedAt: number | undefined;
  for (const id of stepRuns) {
    const run = findRun(view, id);
    turns += run?.messages.filter((ref) => ref.message.role === "assistant").length ?? 0;
    if (run?.end !== undefined) {
      endedAt = run.end.endedAt;
    }
  }
  const from = input.fromRunSeq ?? 1;
  const last = storeLastVerification(view, storeLastStepRun(view, runId), sources);
  return {
    governanceRoot: input.governanceRoot,
    sessionId: view.sessionId,
    runId,
    entryRange: { from, to: Math.max(from, storeLastRunSeq(view, runId)) },
    label: storeAttemptLabel(view, runId, { verificationSources: sources }),
    turns,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(last !== undefined
      ? { verification: { sessionId: last.sessionId, recordId: last.record.entryId as never } }
      : {}),
  };
}

// ---- 工具级失败分类（Q4：由消息、工具档位与审批模式现算） ----

export interface StoreToolOutcome {
  runId: RunId;
  toolCallId: string;
  toolName: string;
  failure: FailureClass | null;
}

// 上游在审批闸之前拦下的调用（工具名不存在、参数校验失败、输出撞上限而参数可能截断）：上游固定文案（pi 0.84.4）
function upstreamIntercepted(call: ToolCallBlock, text: string): boolean {
  return (
    text === `Tool ${call.name} not found` ||
    text.startsWith(`Validation failed for tool "${call.name}"`) ||
    text.startsWith(`Tool call "${call.name}" was not executed: the response hit the output token`)
  );
}

// 审批闸的策略拒绝（治理闭环，不是失败）：工具在 deny 清单上，或 prompt 档无审批通道时的固定拒绝理由（无标记时的判据）
function policyRejected(call: ToolCallBlock, text: string, start: RunStartData): boolean {
  return start.policy.deny.includes(call.name) || text === FAIL_CLOSED_APPROVAL_REASON;
}

function resultsOf(run: StoreRun): Map<string, StoreMessage> {
  const results = new Map<string, StoreMessage>();
  for (const { message } of run.messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

// 一个执行出错的调用的分类。判定顺序同 classifyToolOutcome：审批闸拒绝 → 上游拦截 → Run 中止 → 错误归类。
// 有运行面标记时按标记（审批闸决定、错误归类）；没有标记的结果（标记之前写的文件、测试夹具）退回按消息正文与策略判
function erroredToolFailure(
  call: ToolCallBlock,
  result: StoreMessage,
  run: StoreRun,
  aborted: boolean
): FailureClass | null {
  const mark = toolResultMark(result);
  const text = textOf(result);
  const rejected =
    mark !== undefined ? mark.gate?.outcome === "rejected" : policyRejected(call, text, run.start);
  if (rejected) {
    return null;
  }
  const intercepted =
    mark !== undefined
      ? mark.gate === undefined
      : upstreamIntercepted(call, text) || !run.start.advertisedTools.includes(call.name);
  if (intercepted) {
    return { category: "business" };
  }
  if (aborted) {
    return { category: "cancelled", breaker: run.end?.ending === "breaker" };
  }
  if (mark?.errorKind === "domain") {
    return { category: "business" };
  }
  if (mark?.errorKind === "environment") {
    return { category: "infrastructure" };
  }
  return { category: "unknown" };
}

// 口径：成功为非失败；没有结果或只有续跑补的"结果未知"为未知；执行出错的按 erroredToolFailure——
// 审批闸拒绝（策略拒绝与人工拒绝）为非失败，上游拦截为业务失败，Run 以中止收尾归取消（熔断为其子类），
// 工具抛错的域错误为业务失败、环境异常为基础设施错误，判不出为未知
export function storeToolOutcomes(view: StoreSessionView): StoreToolOutcome[] {
  const outcomes: StoreToolOutcome[] = [];
  for (const run of view.runs) {
    const results = resultsOf(run);
    const aborted = lastAssistantOf(run)?.stopReason === "aborted";
    for (const { message } of run.messages) {
      for (const call of toolCallsOf(message)) {
        const result = results.get(call.id);
        let failure: FailureClass | null;
        if (result === undefined || isInterruptedToolResult(result)) {
          failure = { category: "unknown" };
        } else if (result.isError !== true) {
          failure = null;
        } else {
          failure = erroredToolFailure(call, result, run, aborted);
        }
        outcomes.push({ runId: run.runId, toolCallId: call.id, toolName: call.name, failure });
      }
    }
  }
  return outcomes;
}

// 一次调用是否"需要人来批"：写档与命令档里，审批闸以 yolo 批发授权放行（有人在场时会被问）、由人批准或拒绝、
// 或因没有审批通道而拒绝的；固化规则与会话放权放行的、deny 清单拒绝的、读档的不算
function neededApproval(
  call: ToolCallBlock,
  result: StoreMessage,
  run: StoreRun,
  tier: string | undefined
): boolean {
  if ((tier !== "write" && tier !== "exec") || isInterruptedToolResult(result)) {
    return false;
  }
  const mark = toolResultMark(result);
  if (mark !== undefined) {
    const approvedBy = mark.gate?.approvedBy;
    return (
      approvedBy === "policy:yolo" ||
      approvedBy === "human" ||
      (approvedBy === "policy:deny" && textOf(result) === FAIL_CLOSED_APPROVAL_REASON)
    );
  }
  // 没有标记：只能认出 yolo 档下通过了审批闸的调用（不在 deny 清单、没被上游拦截）
  return (
    run.start.policy.approvalMode === "yolo" &&
    !run.start.policy.deny.includes(call.name) &&
    !(result.isError === true && upstreamIntercepted(call, textOf(result)))
  );
}

// 需审批次数（Q4 与其后的裁决）：按 neededApproval 计。toolTiers 缺某个工具时不计
function approvalsNeededOf(
  runs: readonly StoreRun[],
  toolTiers: ReadonlyMap<string, string>
): number {
  let count = 0;
  for (const run of runs) {
    const results = resultsOf(run);
    for (const { message } of run.messages) {
      for (const call of toolCallsOf(message)) {
        const result = results.get(call.id);
        if (result !== undefined && neededApproval(call, result, run, toolTiers.get(call.name))) {
          count += 1;
        }
      }
    }
  }
  return count;
}

// ---- 单次运行会话的指标（headless 结果，046）：取首个 Run，回炉开启时按整步汇总 ----

export interface StoreRunMetrics {
  runId?: RunId;
  failure: FailureClass | null;
  turns: number;
  toolCalls: number;
  approvalsNeeded: number;
  usage: TurnUsage;
}

function zeroUsage(): TurnUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function storeRunMetrics(
  view: StoreSessionView,
  options: { toolTiers?: ReadonlyMap<string, string> } = {}
): StoreRunMetrics {
  const runId = storeFirstRun(view);
  if (runId === undefined) {
    return {
      failure: { category: "unknown" },
      turns: 0,
      toolCalls: 0,
      approvalsNeeded: 0,
      usage: zeroUsage(),
    };
  }
  const runs = storeStepRuns(view, runId).flatMap((id) => {
    const run = findRun(view, id);
    return run !== undefined ? [run] : [];
  });
  const usage = zeroUsage();
  let turns = 0;
  let toolCalls = 0;
  for (const run of runs) {
    for (const { message } of run.messages) {
      if (message.role !== "assistant") {
        continue;
      }
      turns += 1;
      toolCalls += toolCallsOf(message).length;
      const turn = message.usage;
      if (turn !== undefined) {
        usage.input += turn.input ?? 0;
        usage.output += turn.output ?? 0;
        usage.cacheRead += turn.cacheRead ?? 0;
        usage.cacheWrite += turn.cacheWrite ?? 0;
        usage.totalTokens += turn.totalTokens ?? 0;
        usage.cost.input += turn.cost?.input ?? 0;
        usage.cost.output += turn.cost?.output ?? 0;
        usage.cost.cacheRead += turn.cost?.cacheRead ?? 0;
        usage.cost.cacheWrite += turn.cost?.cacheWrite ?? 0;
        usage.cost.total += turn.cost?.total ?? 0;
      }
    }
  }
  const lastRun = findRun(view, storeLastStepRun(view, runId));
  return {
    runId,
    failure: lastRun !== undefined ? storeRunFailure(lastRun) : { category: "unknown" },
    turns,
    toolCalls,
    approvalsNeeded: approvalsNeededOf(runs, options.toolTiers ?? new Map()),
    usage,
  };
}

// ---- 恢复与分叉用的几项 ----

// 生效授权（决策 3b）：建立减撤销，按建立时间排序
export function storeActiveGrants(view: StoreSessionView): ActiveGrant[] {
  const revoked = new Set(
    view.grants.flatMap((record) =>
      record.data.event === "revoked" ? [record.data.grantId as string] : []
    )
  );
  const active: ActiveGrant[] = [];
  for (const { data } of view.grants) {
    if (data.event !== "created" || revoked.has(data.grantId)) {
      continue;
    }
    active.push({
      grantId: data.grantId as ActiveGrant["grantId"],
      tool: data.tool,
      ...(data.pathPrefix !== undefined ? { pathPrefix: data.pathPrefix } : {}),
      ...(data.command !== undefined ? { command: data.command } : {}),
      ...(data.shell === true ? { shell: true } : {}),
      createdAt: data.createdAt,
      firstCall: data.firstCall as ActiveGrant["firstCall"],
    });
  }
  return active.sort((a, b) => a.createdAt - b.createdAt);
}

// 父会话里派出某个 worker 的记录
export function storeWorkerSpawned(
  view: StoreSessionView,
  childSessionId: SessionId
): Extract<WorkerData, { event: "spawned" }> | undefined {
  for (const { data } of view.workers) {
    if (data.event === "spawned" && data.childSessionId === childSessionId) {
      return data;
    }
  }
  return undefined;
}

// 分叉点之前最近的代码快照（同 checkpoint-ref.ts 的口径）：分叉点所在 Run 里归属条目号不大于 runSeq 的最后一个快照，
// 没有则取更早 Run 的最后一个；仍没有即该点早于首次改动，取首个快照的改前基线；整个会话都没改过文件返回 undefined
export function storeCheckpointBefore(
  view: StoreSessionView,
  point: { runId: RunId; runSeq: number }
): { commit: string; ref?: string } | undefined {
  const pointIndex = view.runs.findIndex((run) => run.runId === point.runId);
  let best: { commit: string; ref: string } | undefined;
  for (const [index, run] of view.runs.entries()) {
    for (const checkpoint of run.checkpoints) {
      const before =
        index < pointIndex || (index === pointIndex && checkpoint.afterRunSeq <= point.runSeq);
      if (before) {
        best = { commit: checkpoint.data.commit, ref: checkpoint.data.ref };
      }
    }
  }
  if (best !== undefined) {
    return best;
  }
  for (const run of view.runs) {
    for (const checkpoint of run.checkpoints) {
      if (checkpoint.data.baseCommit !== undefined) {
        return { commit: checkpoint.data.baseCommit };
      }
    }
  }
  return undefined;
}

// 分叉点 (runId, runSeq) 对应的消息
export function storeMessageAt(
  view: StoreSessionView,
  point: { runId: RunId; runSeq: number }
): StoreMessageRef | undefined {
  return findRun(view, point.runId)?.messages[point.runSeq - 1];
}
