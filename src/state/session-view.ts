// 会话原生视图（决策 180）：把新会话存储里一个会话文件的主分支条目投影成读者直接用的结构——按 Run 切段的消息
// （带 Run 内序号）、七种自定义条目、worker 父子关系、Run 级与工具级失败分类。搜索与各显示读者（会话列表、trace、replay、
// 历史）共用这一份。纯函数、无 IO：输入按结构读取（persistence/session-reader.ts 的读取结果
// 满足它），state 不依赖 persistence。
// 切段口径：Run 开始条目之后、下一个 Run 开始之前的消息属于它，Run 内序号从 1 起、每条消息占一个（同 messageEntryAt）；
// 自定义条目按数据里的 runId 归属 Run，不带 runId 的是会话级条目。
// 分支会话文件开头是 pi 的 fork 从来源会话复制来的历史（条目号与时间戳原样），属于来源会话，不算本会话的内容：
// 复制段止于文件头记下的分叉点（Run 开始之后按消息条数数到第 runSeq 条），投影从其后开始。
import { Value } from "typebox/value";
import type { FailureClass } from "./classification.ts";
import { canonicalJson, sha256Hex } from "./hashing.ts";
import type { RunId, SessionId } from "./ids.ts";
import {
  type CheckpointData,
  type ForkData,
  type GrantData,
  HEADER_METADATA_KEY,
  type RunEndData,
  type RunStartData,
  SESSION_ENTRY_SCHEMAS,
  SESSION_ENTRY_VERSION,
  SessionEntryType,
  type SessionHeaderMetadata,
  SessionHeaderMetadataSchema,
  type VerificationData,
  type WorkerData,
} from "./session-entries.ts";
import {
  runFailureOf,
  type StoreMessage,
  type StoreToolOutcome,
  storeSessionView,
  storeToolOutcomes,
} from "./session-judge.ts";
import {
  type SessionSummary,
  type SessionSummaryFailureClass,
  sessionCreatedAt,
} from "./session-summary.ts";
import { omittedThinkingOf } from "./thinking-omission.ts";

// 读取结果里本投影用到的部分（结构类型）
export interface SessionFileEntryInput {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: number;
  message?: unknown;
  customType?: unknown;
  data?: unknown;
  [field: string]: unknown;
}

export interface SessionFileInput {
  header: {
    id: string;
    createdAt: number;
    parentSessionId?: string;
    metadata?: Record<string, unknown>;
  };
  // 主分支从根到叶的条目（branchEntries 的结果）
  entries: readonly SessionFileEntryInput[];
}

// 消息内容块：text、thinking、工具调用、图片（只给元数据）与不认识的块
export type ViewBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "image"; mimeType: string; bytes: number; hash: string }
  | { type: "unknown"; originalType: string; hash: string }
  // 思考不持久化时写入前剥去的思考块（045）：只剩字节数，位置同原块
  | { type: "omitted-thinking"; bytes: number; redacted: boolean };

export interface ViewMessage {
  entryId: string;
  runId: RunId;
  // Run 内序号（1 起）
  runSeq: number;
  role: string;
  // 条目写入时刻
  timestamp: number;
  blocks: ViewBlock[];
  // 原始消息（pi 消息条目的 message，完整存储）
  raw: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // 助手消息的停止原因、错误文本与用量
  stopReason?: string;
  errorMessage?: string;
  usage?: ViewUsage;
}

export interface ViewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

// 时间线上的一条（消息或自定义条目），按文件顺序
export type ViewItem =
  | { kind: "message"; timestamp: number; message: ViewMessage }
  | { kind: "run-start"; entryId: string; timestamp: number; data: RunStartData }
  | { kind: "run-end"; entryId: string; timestamp: number; data: RunEndData }
  | { kind: "verification"; entryId: string; timestamp: number; data: VerificationData }
  | { kind: "checkpoint"; entryId: string; timestamp: number; data: CheckpointData }
  | { kind: "worker"; entryId: string; timestamp: number; data: WorkerData }
  | { kind: "fork"; entryId: string; timestamp: number; data: ForkData }
  | { kind: "grant"; entryId: string; timestamp: number; data: GrantData };

// 一次工具调用：助手消息里的调用块与对应的工具结果消息（按工具调用号在同一 Run 内配对）
export interface ViewToolCall {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result?: ViewMessage;
}

// 一轮 = 一条助手消息 + 它发起的工具调用
export interface ViewTurn {
  index: number;
  assistant: ViewMessage;
  toolCalls: ViewToolCall[];
}

export interface ViewRun {
  runId: RunId;
  start: RunStartData;
  end?: RunEndData;
  // 本 Run 的条目（Run 开始、消息、归属本 Run 的自定义条目、Run 收尾），按文件顺序
  items: ViewItem[];
  messages: ViewMessage[];
  turns: ViewTurn[];
  toolCalls: ViewToolCall[];
  // Run 级失败四分类（D7 判据，同 classifyRunOutcome）；null = 正常
  failure: FailureClass | null;
}

type WorkerSpawned = Extract<WorkerData, { event: "spawned" }>;
type WorkerSettled = Extract<WorkerData, { event: "settled" }>;

export interface ViewChild {
  spawned: WorkerSpawned;
  settled?: WorkerSettled;
}

export interface SessionView {
  sessionId: SessionId;
  createdAt: number;
  parentSessionId?: SessionId;
  // 文件头 metadata 里的来历（worker 会话与分支会话）
  worker?: NonNullable<SessionHeaderMetadata["worker"]>;
  branch?: NonNullable<SessionHeaderMetadata["branch"]>;
  // 文件开头从来源会话复制来的条目数（非分支会话为 0）
  copiedEntries: number;
  // 本会话自己的全部条目（跳过复制段），按文件顺序
  items: ViewItem[];
  runs: ViewRun[];
  // 本会话自己的全部消息（跳过复制段；不在任何 Run 之后的消息不计入）
  messages: ViewMessage[];
  children: ViewChild[];
  // 有收尾无派出的 worker 收尾条目
  orphanSettleds: WorkerSettled[];
  // 工具级失败分类（逐个调用，按出现顺序）：判定类读者的同一现算口径（session-judge.ts 的 storeToolOutcomes）
  toolOutcomes: StoreToolOutcome[];
  // 数据不合 schema、版本不认识而被跳过的自定义条目说明
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBlock(block: unknown): ViewBlock {
  if (!isObject(block)) {
    return { type: "unknown", originalType: typeof block, hash: sha256Hex(canonicalJson(block)) };
  }
  const unknownBlock = (): ViewBlock => ({
    type: "unknown",
    originalType: typeof block.type === "string" ? block.type : "<missing>",
    hash: sha256Hex(canonicalJson(block)),
  });
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", text: block.text } : unknownBlock();
    case "thinking":
      return typeof block.thinking === "string"
        ? { type: "thinking", thinking: block.thinking, redacted: block.redacted === true }
        : unknownBlock();
    case "toolCall":
      return {
        type: "toolCall",
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        arguments: block.arguments,
      };
    case "image": {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        return unknownBlock();
      }
      const bytes = Buffer.from(block.data, "base64");
      return {
        type: "image",
        mimeType: block.mimeType,
        bytes: bytes.length,
        hash: sha256Hex(bytes),
      };
    }
    default:
      return unknownBlock();
  }
}

// 消息正文的内容块：字符串正文视作一个 text 块；写入前剥去的思考块按标记插回原位置
export function messageBlocks(message: Record<string, unknown>): ViewBlock[] {
  const content = message.content;
  const blocks: ViewBlock[] = (
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : []
  ).map(toBlock);
  for (const omitted of omittedThinkingOf(message).sort((a, b) => a.index - b.index)) {
    blocks.splice(Math.min(omitted.index, blocks.length), 0, {
      type: "omitted-thinking",
      bytes: omitted.bytes,
      redacted: omitted.redacted === true,
    });
  }
  return blocks;
}

function usageOf(value: unknown): ViewUsage | undefined {
  if (!isObject(value) || !isObject(value.cost)) {
    return undefined;
  }
  const number = (field: unknown): number => (typeof field === "number" ? field : 0);
  return {
    input: number(value.input),
    output: number(value.output),
    cacheRead: number(value.cacheRead),
    cacheWrite: number(value.cacheWrite),
    totalTokens: number(value.totalTokens),
    cost: { total: number(value.cost.total) },
  };
}

// 上游 handleRunFailure 合成的失败消息：空文本 + 用量全零 + 带错误文本（同 pi-runtime/events.ts 的判据）
export function isSyntheticFailure(message: ViewMessage): boolean {
  if (message.role !== "assistant" || message.errorMessage === undefined) {
    return false;
  }
  const [only] = message.blocks;
  const emptyText = message.blocks.length === 1 && only?.type === "text" && only.text === "";
  const usage = message.usage;
  return (
    emptyText &&
    usage !== undefined &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  );
}

function toViewMessage(
  entry: SessionFileEntryInput,
  runId: RunId,
  runSeq: number
): ViewMessage | undefined {
  const raw = entry.message;
  if (!isObject(raw) || typeof raw.role !== "string") {
    return undefined;
  }
  const usage = raw.role === "assistant" ? usageOf(raw.usage) : undefined;
  return {
    entryId: entry.id,
    runId,
    runSeq,
    role: raw.role,
    timestamp: entry.timestamp,
    blocks: messageBlocks(raw),
    raw,
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
    ...(raw.role === "assistant" && typeof raw.stopReason === "string"
      ? { stopReason: raw.stopReason }
      : {}),
    ...(raw.role === "assistant" && typeof raw.errorMessage === "string"
      ? { errorMessage: raw.errorMessage }
      : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

const CUSTOM_KINDS = {
  [SessionEntryType.RunStart]: "run-start",
  [SessionEntryType.RunEnd]: "run-end",
  [SessionEntryType.Verification]: "verification",
  [SessionEntryType.Checkpoint]: "checkpoint",
  [SessionEntryType.Worker]: "worker",
  [SessionEntryType.Fork]: "fork",
  [SessionEntryType.Grant]: "grant",
} as const;

// 自定义条目 → 时间线条目；不是 Pigeon 的条目返回 undefined，数据不合 schema 记告警
function toCustomItem(
  entry: SessionFileEntryInput,
  warnings: string[]
): Exclude<ViewItem, { kind: "message" }> | undefined {
  const customType = entry.customType;
  if (typeof customType !== "string" || !(customType in CUSTOM_KINDS)) {
    return undefined;
  }
  const type = customType as keyof typeof CUSTOM_KINDS;
  const data = entry.data;
  if (!isObject(data) || data.version !== SESSION_ENTRY_VERSION) {
    warnings.push(`条目 ${entry.id}（${type}）的数据版本不认识，已跳过`);
    return undefined;
  }
  if (!Value.Check(SESSION_ENTRY_SCHEMAS[type], data)) {
    warnings.push(`条目 ${entry.id}（${type}）的数据不合 schema，已跳过`);
    return undefined;
  }
  return {
    kind: CUSTOM_KINDS[type],
    entryId: entry.id,
    timestamp: entry.timestamp,
    data,
  } as Exclude<ViewItem, { kind: "message" }>;
}

function headerMetadata(header: SessionFileInput["header"]): SessionHeaderMetadata | undefined {
  const value = header.metadata?.[HEADER_METADATA_KEY];
  return Value.Check(SessionHeaderMetadataSchema, value) ? value : undefined;
}

// 分支会话文件开头复制段的条目数：主分支上 Run 开始之后按消息条数数到分叉点（含）为止
function copiedPrefixLength(
  entries: readonly SessionFileEntryInput[],
  forkPoint: { runId: string; runSeq: number }
): number {
  let inRun = false;
  let count = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "custom" && entry.customType === SessionEntryType.RunStart) {
      inRun = isObject(entry.data) && entry.data.runId === forkPoint.runId;
      count = 0;
    } else if (inRun && entry.type === "message") {
      count += 1;
      if (count === forkPoint.runSeq) {
        return index + 1;
      }
    }
  }
  // 文件头记的分叉点在文件里数不到（复制段与文件头不符）时按不含复制段处理
  return 0;
}

// 会话号是 Pigeon 的 sess_<ULID> 时取 ULID 的时间分量（与旧会话列表同一口径），否则取文件头的创建时间
function createdAtOf(header: SessionFileInput["header"]): number {
  return /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(header.id)
    ? sessionCreatedAt(header.id as SessionId)
    : header.createdAt;
}

// Run 级分类：事实装配与判定类读者共用一处（session-judge.ts 的 runFailureOf），读末条助手消息的原始消息
function classifyRun(run: Omit<ViewRun, "failure">): FailureClass | null {
  const lastAssistant = run.messages.findLast((message) => message.role === "assistant");
  return runFailureOf(lastAssistant?.raw as StoreMessage | undefined, run.end);
}

function customRunId(item: Exclude<ViewItem, { kind: "message" }>): string | undefined {
  return (item.data as { runId?: string }).runId;
}

export function buildSessionView(input: SessionFileInput): SessionView {
  const warnings: string[] = [];
  const metadata = headerMetadata(input.header);
  const copiedEntries =
    metadata?.branch !== undefined
      ? copiedPrefixLength(input.entries, metadata.branch.forkPoint)
      : 0;
  const items: ViewItem[] = [];
  const runs: ViewRun[] = [];
  const runById = new Map<string, ViewRun>();
  const messages: ViewMessage[] = [];
  let current: ViewRun | undefined;
  for (const entry of input.entries.slice(copiedEntries)) {
    if (entry.type === "message") {
      if (current === undefined) {
        continue;
      }
      const message = toViewMessage(entry, current.runId, current.messages.length + 1);
      if (message === undefined) {
        continue;
      }
      const item: ViewItem = { kind: "message", timestamp: entry.timestamp, message };
      items.push(item);
      current.items.push(item);
      current.messages.push(message);
      messages.push(message);
      continue;
    }
    if (entry.type !== "custom") {
      continue;
    }
    const item = toCustomItem(entry, warnings);
    if (item === undefined) {
      continue;
    }
    items.push(item);
    if (item.kind === "run-start") {
      current = {
        runId: item.data.runId,
        start: item.data,
        items: [item],
        messages: [],
        turns: [],
        toolCalls: [],
        failure: null,
      };
      runs.push(current);
      runById.set(item.data.runId, current);
      continue;
    }
    const runId = customRunId(item);
    const owner = runId !== undefined ? runById.get(runId) : undefined;
    if (owner === undefined) {
      continue;
    }
    owner.items.push(item);
    if (item.kind === "run-end" && owner.end === undefined) {
      owner.end = item.data;
    }
  }
  for (const run of runs) {
    const callsById = new Map<string, ViewToolCall>();
    for (const message of run.messages) {
      if (message.role === "assistant") {
        const turn: ViewTurn = { index: run.turns.length + 1, assistant: message, toolCalls: [] };
        for (const block of message.blocks) {
          if (block.type === "toolCall") {
            const call: ViewToolCall = {
              toolCallId: block.id,
              toolName: block.name,
              arguments: block.arguments,
            };
            turn.toolCalls.push(call);
            run.toolCalls.push(call);
            callsById.set(block.id, call);
          }
        }
        run.turns.push(turn);
      } else if (message.role === "toolResult" && message.toolCallId !== undefined) {
        const call = callsById.get(message.toolCallId);
        if (call !== undefined && call.result === undefined) {
          call.result = message;
        }
      }
    }
    run.failure = classifyRun(run);
  }
  const children: ViewChild[] = [];
  const childById = new Map<string, ViewChild>();
  const orphanSettleds: WorkerSettled[] = [];
  for (const item of items) {
    if (item.kind !== "worker") {
      continue;
    }
    if (item.data.event === "spawned") {
      const child: ViewChild = { spawned: item.data };
      children.push(child);
      childById.set(item.data.childSessionId, child);
    } else {
      const child = childById.get(item.data.childSessionId);
      if (child === undefined || child.settled !== undefined) {
        orphanSettleds.push(item.data);
      } else {
        child.settled = item.data;
      }
    }
  }
  return {
    sessionId: input.header.id as SessionId,
    createdAt: createdAtOf(input.header),
    ...(input.header.parentSessionId !== undefined
      ? { parentSessionId: input.header.parentSessionId as SessionId }
      : {}),
    ...(metadata?.worker !== undefined ? { worker: metadata.worker } : {}),
    ...(metadata?.branch !== undefined ? { branch: metadata.branch } : {}),
    copiedEntries,
    items,
    runs,
    messages,
    children,
    orphanSettleds,
    toolOutcomes: storeToolOutcomes(
      storeSessionView({
        sessionId: input.header.id as SessionId,
        ...(input.header.metadata !== undefined ? { metadata: input.header.metadata } : {}),
        entries: input.entries,
      })
    ),
    warnings,
  };
}

// 会话摘要（会话列表与检索过滤共用）：Run 数、用过的工具名、失败分类（Run 级在前、工具级在后，按出现序去重）、
// 用量合计与父子关系，全部从本会话自己的条目现算（分支会话的复制段不计）。旧摘要的"待对账"随写操作回执停写（184）
// 不再有来源
export type SessionViewSummary = SessionSummary;

export function summarizeSessionView(view: SessionView): SessionViewSummary {
  const toolNames: string[] = [];
  const failureClasses: SessionSummaryFailureClass[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  for (const run of view.runs) {
    for (const call of run.toolCalls) {
      if (!toolNames.includes(call.toolName)) {
        toolNames.push(call.toolName);
      }
    }
    if (run.failure !== null && !failureClasses.includes(run.failure.category)) {
      failureClasses.push(run.failure.category);
    }
  }
  for (const outcome of view.toolOutcomes) {
    if (outcome.failure !== null && !failureClasses.includes(outcome.failure.category)) {
      failureClasses.push(outcome.failure.category);
    }
  }
  for (const message of view.messages) {
    if (message.usage !== undefined) {
      totalTokens += message.usage.totalTokens;
      totalCost += message.usage.cost.total;
    }
  }
  return {
    sessionId: view.sessionId,
    createdAt: view.createdAt,
    runCount: view.runs.length,
    toolNames,
    failureClasses,
    totalTokens,
    totalCost,
    ...(view.worker !== undefined && view.parentSessionId !== undefined
      ? {
          worker: {
            name: view.worker.name,
            role: view.worker.role,
            parentSessionId: view.parentSessionId,
          },
        }
      : {}),
    ...(view.children.length > 0
      ? {
          children: {
            count: view.children.length,
            unsettled: view.children.filter((child) => child.settled === undefined).length,
          },
        }
      : {}),
  };
}
