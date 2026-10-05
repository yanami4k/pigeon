// 缓存感知的上下文裁剪（决策 361，候选按时机分开见决策 373）：把最近几轮之外的部分工具结果换成写明原来是什么与怎么找回的
// 固定占位，降低之后每轮的输入量。只换工具结果的正文，消息本身（工具调用号、工具名）留着，调用与结果的配对不变；用户的话、
// 模型正文、工具调用参数、思考内容、开工状态块与变化通道的消息（都不是工具结果）一律不碰。
// 候选（保护轮之外、尚未裁过）：被后来的读取覆盖或被整体覆写的过时读取；无事发生的结果（零命中的搜索与检索、没有结果也没有
// 答案的网页搜索、退出码 0 且没有输出也没有文件变化的命令，只随批顺带：不当改写起点，不计入下限与不等式）；不小于最小大小的
// 较大旧结果。占位比原文还大的不算。命令输出截断了而全文没落盘的不裁（上下文里的头尾两段是唯一副本，命令可能有副作用，不能
// 指望重新运行）。
// 时机：免费时机（压缩前、Run 开始时模型或工具集或系统提示与上一个 Run 不同、空闲超过缓存保留时长）一次裁光全部候选，含较大的
// 旧结果；其余每次请求之前是付费时机，候选只有过时读取与随批顺带的无事发生结果（较大的旧结果多是仍在用的文件，付费裁掉后常被
// 读回，读回按未命中价计），按价格比算账——选改写起点使预计净省最大，满足 裁掉量 × N ≥（价格比 − 1）× 改写点之后的量 且裁掉量
// 不小于最小批量才裁。token 量按上游的 estimateTokens（与压缩判定同一口径）。
// 每次裁剪产出一条记录（各项换成的占位原文），先写进会话记录再生效，组装请求时按工具调用号应用；续跑从会话记录取回，前缀
// 逐字节一致（决策 373 之前付费时机裁掉的较大旧结果照样重放）。裁掉的命令输出还没落盘的先补落盘（空输出不落盘），补不成的不裁；
// 占位给出虚拟路径，带文件变化的保留文件变化清单。裁掉的读取在上下文里再没有同一文件的读写结果时不再算读过。
// 打转检测看的是上游 turn_end 事件里的原文，不受裁剪影响。
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextPruneSettings } from "../state/prune-config.ts";
import { type PruneData, SessionEntryType } from "../state/session-entries.ts";
import { freshUsageMessage } from "./compaction.ts";

export type PruneTrigger = PruneData["trigger"];
export type PruneItem = PruneData["items"][number];
export type PruneRecord = Omit<PruneData, "version" | "runId">;

// 一个 Run 的模型、广告的工具集与系统提示（Run 开始条目里的那几项）
export interface RunSignature {
  model: string;
  tools: readonly string[];
  systemPrompt: string;
}

// 续跑、分叉与重载的起点：已有的裁剪（工具调用号 → 占位）与上一个 Run 的模型、工具集与系统提示
export interface PruneSeed {
  placeholders: ReadonlyArray<readonly [string, string]>;
  signature?: RunSignature;
}

export interface PruneEffects {
  // 没落盘的命令输出补落盘，返回虚拟路径；落不了返回 undefined 或抛错
  saveOutput?(text: string): string | undefined;
  // 这个文件不再算本会话读过
  forgetRead?(resolvedPath: string): void;
}

// 命令输出的落盘位置；partial 为只存了前 bytes 字节
interface SavedOutput {
  uri: string;
  bytes: number;
  partial: boolean;
}

const SEARCH_TOOLS = new Set(["grep", "glob", "search_sessions", "web_search"]);
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
// 估算占位大小时代替还没落盘的虚拟路径（与真路径长度相当）
const URI_STAND_IN = "pigeon://outputs/sess_00000000000000000000000000/000";
const CLIP_CHARS = 160;
// run_command 结果正文里文件变化一段的开头（tools/run-command.ts 的 resultText）
const FILE_CHANGES_HEAD = "\n文件变化：";

interface Candidate {
  index: number;
  toolCallId: string;
  toolName: string;
  reason: PruneItem["reason"];
  tokens: number;
  saved: number;
  result: ToolResultMessage;
  args: Record<string, unknown>;
}

type Details = Record<string, unknown> | undefined;

export class ContextPruner {
  readonly settings: ContextPruneSettings;
  readonly #effects: PruneEffects;
  readonly #now: () => number;
  readonly #placeholders = new Map<string, string>();
  #signature: RunSignature | undefined;
  #changed: PruneTrigger | undefined;
  // 估算上下文所用的那条助手消息（最新一条带可用 usage 的）按首次见到的先后编号：每次请求之前与压缩之前都登记一次。
  // 先后不看时间戳——假模型的回复与裁剪常落在同一毫秒；也不看在消息数组里的位置——压缩后与 Run 内的两份上下文位置不同
  readonly #usageSeq = new Map<string, number>();
  // 本进程里各次裁剪的裁掉量与裁剪时所用 usage 的编号（没有为 −1）：估算上下文时，所用 usage 不晚于它的，裁掉的量要减去
  readonly #pruned: Array<{ seq: number; tokens: number }> = [];
  #lastRequestAt: number | undefined;

  constructor(
    settings: ContextPruneSettings,
    effects: PruneEffects = {},
    seed?: PruneSeed,
    now: () => number = Date.now
  ) {
    this.settings = settings;
    this.#effects = effects;
    this.#now = now;
    for (const [toolCallId, placeholder] of seed?.placeholders ?? []) {
      this.#placeholders.set(toolCallId, placeholder);
    }
    this.#signature = seed?.signature;
  }

  // Run 开始：模型、工具集或系统提示与上一个 Run 不同即记下，下一次请求之前一次裁光
  observeRun(signature: RunSignature): void {
    const previous = this.#signature;
    if (previous !== undefined) {
      const change: PruneTrigger | undefined =
        previous.model !== signature.model
          ? "model"
          : previous.tools.join("\n") !== signature.tools.join("\n")
            ? "tools"
            : previous.systemPrompt !== signature.systemPrompt
              ? "system-prompt"
              : undefined;
      this.#changed = change ?? this.#changed;
    }
    this.#signature = { ...signature, tools: [...signature.tools] };
  }

  // 应用已有的裁剪：返回新数组，不改传入的消息
  view(messages: readonly AgentMessage[]): AgentMessage[] {
    return applyPrunes(messages, this.#placeholders);
  }

  // 每次请求之前：免费时机一次裁光，否则按价格比算账。新的裁剪先交 write 写进会话记录、再生效（write 抛错即不生效，
  // 错误照抛）；返回本次请求用的上下文与新的裁剪记录（没裁为 undefined）
  beforeRequest(
    messages: readonly AgentMessage[],
    write: (record: PruneRecord) => void = () => {}
  ): { messages: AgentMessage[]; record?: PruneRecord } {
    let record: PruneRecord | undefined;
    if (this.settings.enabled) {
      const trigger = this.#changed ?? (this.#idle(messages) ? "idle" : undefined);
      record = this.#prune(messages, trigger ?? "paid", this.#observe(messages), write);
      this.#changed = undefined;
    }
    this.#lastRequestAt = this.#now();
    return { messages: this.view(messages), ...(record !== undefined ? { record } : {}) };
  }

  // 压缩之前：一次裁光候选（压缩时机关着或总开关关着时不裁）；先写后生效同 beforeRequest
  beforeCompaction(
    messages: readonly AgentMessage[],
    write: (record: PruneRecord) => void = () => {}
  ): PruneRecord | undefined {
    if (!this.settings.enabled || !this.settings.onCompaction) return undefined;
    return this.#prune(messages, "compaction", this.#observe(messages), write);
  }

  // usage（估算所用的那条助手消息）之后裁掉的 token：那份 usage 量的是裁剪之前发出的上下文，估算时从中减去。没有可用的
  // usage 时整段按裁剪后的消息估算，不必减；裁剪器没见过的 usage 出现在各次裁剪之后，也不必减
  unsentTokens(usage: AgentMessage | undefined): number {
    if (usage === undefined || this.#pruned.length === 0) return 0;
    const seq = this.#usageSeq.get(usageKey(usage));
    if (seq === undefined) return 0;
    return this.#pruned.reduce((sum, entry) => (entry.seq >= seq ? sum + entry.tokens : sum), 0);
  }

  seed(): PruneSeed {
    return {
      placeholders: [...this.#placeholders],
      ...(this.#signature !== undefined ? { signature: this.#signature } : {}),
    };
  }

  // 登记这份上下文估算所用的 usage，返回它的编号（没有可用的 usage 为 −1）
  #observe(messages: readonly AgentMessage[]): number {
    const usage = freshUsageMessage(messages);
    if (usage === undefined) return -1;
    const key = usageKey(usage);
    const seen = this.#usageSeq.get(key);
    if (seen !== undefined) return seen;
    this.#usageSeq.set(key, this.#usageSeq.size);
    return this.#usageSeq.size - 1;
  }

  #idle(messages: readonly AgentMessage[]): boolean {
    const retention = this.settings.retentionSeconds;
    if (!this.settings.onIdle || retention === undefined) return false;
    const last = this.#lastRequestAt ?? lastAssistantTime(messages);
    return last !== undefined && this.#now() - last > retention * 1000;
  }

  #prune(
    messages: readonly AgentMessage[],
    trigger: PruneTrigger,
    usageSeq: number,
    write: (record: PruneRecord) => void
  ): PruneRecord | undefined {
    const view = this.view(messages);
    const sizes = view.map((message) => estimateTokens(message));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    // 决策 373：较大的旧结果只在免费时机裁
    const paid = trigger === "paid";
    let candidates = findCandidates(
      messages,
      view,
      sizes,
      this.#placeholders,
      this.settings,
      !paid
    );
    // 先算定各项的占位：命令输出要补落盘的现在补，补不成的不裁；付费时机去掉它们后重新选起点
    const outputs = new Map<string, SavedOutput | undefined>();
    let chosen: Candidate[] = [];
    for (;;) {
      chosen = paid ? choosePaid(candidates, sizes, total, this.settings) : candidates;
      const failed = new Set<string>();
      for (const candidate of chosen) {
        if (outputs.has(candidate.toolCallId)) continue;
        const output = this.#outputOf(candidate);
        if (output === null) failed.add(candidate.toolCallId);
        else outputs.set(candidate.toolCallId, output);
      }
      if (failed.size === 0) break;
      candidates = candidates.filter((candidate) => !failed.has(candidate.toolCallId));
    }
    if (chosen.length === 0) return undefined;
    const items: PruneItem[] = chosen.map((candidate) => ({
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      reason: candidate.reason,
      tokens: candidate.tokens,
      placeholder: placeholderOf(candidate, outputs.get(candidate.toolCallId)),
    }));
    const next = new Map(this.#placeholders);
    for (const item of items) next.set(item.toolCallId, item.placeholder);
    const after = applyPrunes(messages, next).reduce(
      (sum, message) => sum + estimateTokens(message),
      0
    );
    const prunedTokens = Math.max(0, total - after);
    const first = chosen.reduce((min, candidate) => Math.min(min, candidate.index), view.length);
    const rewriteTokens = Math.max(0, after - prefixTokens(sizes, first));
    const prunedAt = this.#now();
    const record: PruneRecord = {
      trigger,
      items,
      priceRatio: this.settings.priceRatio,
      horizonTurns: this.settings.horizonTurns,
      prunedTokens,
      rewriteTokens,
      estimatedCost: !paid ? 0 : (this.settings.priceRatio - 1) * rewriteTokens,
      estimatedSaving: this.settings.horizonTurns * prunedTokens,
      tokensBefore: total,
      tokensAfter: after,
      prunedAt,
    };
    // 先写进会话记录，再生效：写不成就不裁，内存与记录不会对不上
    write(record);
    for (const item of items) this.#placeholders.set(item.toolCallId, item.placeholder);
    this.#forgetReads(messages, chosen);
    this.#pruned.push({ seq: usageSeq, tokens: prunedTokens });
    return record;
  }

  // 命令输出的落盘位置：已落盘的用原位置；没截断的非空输出现在补落盘；空输出不落盘（undefined）；补不成为 null
  #outputOf(candidate: Candidate): SavedOutput | undefined | null {
    if (candidate.toolName !== "run_command") return undefined;
    const details = candidate.result.details as Details;
    const saved = savedOutputOf(details);
    if (saved !== undefined) return saved;
    if (details?.outputBytes === 0) return undefined;
    if (details?.truncated !== false || typeof details.output !== "string") return null;
    if (details.output === "") return undefined;
    try {
      const uri = this.#effects.saveOutput?.(details.output);
      return uri !== undefined
        ? { uri, bytes: Buffer.byteLength(details.output, "utf8"), partial: false }
        : null;
    } catch {
      return null;
    }
  }

  // 裁掉的读取：上下文里再没有同一文件没裁的读写结果时，不再算读过
  #forgetReads(messages: readonly AgentMessage[], chosen: readonly Candidate[]): void {
    const forget = this.#effects.forgetRead;
    if (forget === undefined) return;
    const live = new Set<string>();
    for (const message of messages) {
      if (message.role !== "toolResult" || this.#placeholders.has(message.toolCallId)) continue;
      const path = resolvedPathOf(message);
      if (FILE_TOOLS.has(message.toolName) && path !== undefined) live.add(path);
    }
    for (const candidate of chosen) {
      const path = resolvedPathOf(candidate.result);
      if (candidate.toolName === "read_file" && path !== undefined && !live.has(path)) {
        forget(path);
      }
    }
  }
}

// 助手消息的身份：整条内容的摘要（深拷贝与会话还原后不变；两条回复要时间戳、内容与 usage 全都相同才会混同）
function usageKey(message: AgentMessage): string {
  return createHash("sha1").update(JSON.stringify(message)).digest("base64");
}

// 按工具调用号把工具结果的正文换成占位（返回新数组，不改传入的消息）
export function applyPrunes(
  messages: readonly AgentMessage[],
  placeholders: ReadonlyMap<string, string>
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const text = placeholders.get(message.toolCallId);
    return text === undefined ? message : { ...message, content: [{ type: "text", text }] };
  });
}

// 从会话记录（主分支的条目）取续跑的起点：各条裁剪记录的占位，与最后一个 Run 开始条目的模型、工具集与系统提示
export function pruneSeedFromEntries(entries: readonly object[]): PruneSeed {
  const placeholders: Array<readonly [string, string]> = [];
  let signature: RunSignature | undefined;
  for (const entry of entries as ReadonlyArray<Record<string, unknown>>) {
    if (entry.type !== "custom") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (entry.customType === SessionEntryType.Prune && Array.isArray(data?.items)) {
      for (const item of data.items as Array<Record<string, unknown>>) {
        if (typeof item.toolCallId === "string" && typeof item.placeholder === "string") {
          placeholders.push([item.toolCallId, item.placeholder]);
        }
      }
    } else if (entry.customType === SessionEntryType.RunStart && data !== undefined) {
      const model = data.model as { provider?: unknown; id?: unknown } | undefined;
      if (Array.isArray(data.advertisedTools) && typeof data.systemPrompt === "string") {
        signature = {
          model: `${String(model?.provider)}/${String(model?.id)}`,
          tools: data.advertisedTools.map(String),
          systemPrompt: data.systemPrompt,
        };
      }
    }
  }
  return { placeholders, ...(signature !== undefined ? { signature } : {}) };
}

// 候选：保护轮之外、没裁过、没被中断、命令输出找得回的工具结果，按位置排序；large 为 false 时不含较大的旧结果
function findCandidates(
  messages: readonly AgentMessage[],
  view: readonly AgentMessage[],
  sizes: readonly number[],
  pruned: ReadonlyMap<string, string>,
  settings: ContextPruneSettings,
  large: boolean
): Candidate[] {
  // 工具调用号 → 第几条助手消息与调用参数
  const calls = new Map<string, { turn: number; args: Record<string, unknown> }>();
  let turns = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") calls.set(block.id, { turn: turns, args: block.arguments });
    }
    turns += 1;
  }
  const firstProtected = turns - settings.protectTurns;
  const candidates: Candidate[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "toolResult" || pruned.has(message.toolCallId)) return;
    const call = calls.get(message.toolCallId);
    // 找不到所属调用的、保护轮之内的、被中断补上的、命令输出找不回的不裁
    if (call === undefined || call.turn >= firstProtected) return;
    if ((message.details as Details)?.pigeonInterrupted === true) return;
    if (message.toolName === "run_command" && !outputRecoverable(message)) return;
    const tokens = sizes[index] ?? 0;
    const reason = classify(messages, index, message, tokens, settings);
    if (reason === undefined || (reason === "large" && !large)) return;
    const candidate: Candidate = {
      index,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      reason,
      tokens,
      saved: 0,
      result: message,
      args: call.args,
    };
    const stub = view[index] as ToolResultMessage;
    const details = message.details as Details;
    const standIn = savedOutputOf(details) ?? {
      uri: URI_STAND_IN,
      bytes: typeof details?.outputBytes === "number" ? details.outputBytes : 0,
      partial: false,
    };
    const placeholder = placeholderOf(candidate, standIn);
    const saved =
      tokens - estimateTokens({ ...stub, content: [{ type: "text", text: placeholder }] });
    if (saved > 0) candidates.push({ ...candidate, saved });
  });
  return candidates;
}

// 命令输出裁掉之后找得回：已落盘，或没截断（整段在 details 里，可补落盘）；截断了而全文没落盘的找不回
function outputRecoverable(result: ToolResultMessage): boolean {
  const details = result.details as Details;
  if (savedOutputOf(details) !== undefined) return true;
  return details?.truncated === false && typeof details.output === "string";
}

function classify(
  messages: readonly AgentMessage[],
  index: number,
  result: ToolResultMessage,
  tokens: number,
  settings: ContextPruneSettings
): PruneItem["reason"] | undefined {
  if (settings.staleReads && isStaleRead(messages, index, result)) return "stale";
  if (isEmptyResult(result)) return "empty";
  return tokens >= settings.minResultTokens ? "large" : undefined;
}

// 过时读取：之后同一文件被整体覆写，或被一次覆盖它全部行的读取取代
function isStaleRead(
  messages: readonly AgentMessage[],
  index: number,
  result: ToolResultMessage
): boolean {
  if (result.toolName !== "read_file" || result.isError) return false;
  const window = readWindowOf(result);
  if (window === undefined) return false;
  for (let later = index + 1; later < messages.length; later++) {
    const message = messages[later];
    if (message?.role !== "toolResult" || message.isError) continue;
    if (resolvedPathOf(message) !== window.path) continue;
    if (message.toolName === "write_file") return true;
    const next = message.toolName === "read_file" ? readWindowOf(message) : undefined;
    if (next !== undefined && next.from <= window.from && next.to >= window.to) return true;
  }
  return false;
}

// 无事发生：零命中的搜索与检索、没有结果也没有答案的网页搜索、退出码 0 且没有输出也没有文件变化的命令
function isEmptyResult(result: ToolResultMessage): boolean {
  if (result.isError) return false;
  const details = result.details as Details;
  if (result.toolName === "web_search") {
    return details?.results === 0 && details.answered === false;
  }
  if (SEARCH_TOOLS.has(result.toolName)) return details?.total === 0;
  return (
    result.toolName === "run_command" &&
    details?.exitCode === 0 &&
    details.outputBytes === 0 &&
    !hasFileChanges(details)
  );
}

// 命令前后有文件变化（或差异不完整、取证方式另有说明，即说不准没有变化）
function hasFileChanges(details: Details): boolean {
  const changes = details?.fileChanges as
    | {
        added?: unknown[];
        removed?: unknown[];
        modified?: unknown[];
        truncated?: boolean;
        note?: string;
      }
    | undefined;
  if (changes === undefined) return true;
  return (
    (changes.added?.length ?? 0) > 0 ||
    (changes.removed?.length ?? 0) > 0 ||
    (changes.modified?.length ?? 0) > 0 ||
    changes.truncated === true ||
    changes.note !== undefined
  );
}

function savedOutputOf(details: Details): SavedOutput | undefined {
  const saved = details?.savedOutput as Partial<SavedOutput> | undefined;
  return typeof saved?.uri === "string"
    ? { uri: saved.uri, bytes: Number(saved.bytes ?? 0), partial: saved.partial === true }
    : undefined;
}

// 付费时机（候选里已没有较大的旧结果）：从新到旧累加非顺带候选的裁掉量，逐个起点检查下限与不等式，取预计净省最大的起点；起点及之后的候选
// （含顺带的无事发生结果）一起裁
function choosePaid(
  candidates: readonly Candidate[],
  sizes: readonly number[],
  total: number,
  settings: ContextPruneSettings
): Candidate[] {
  const core = candidates.filter((candidate) => candidate.reason !== "empty");
  const ratio = settings.priceRatio;
  const horizon = settings.horizonTurns;
  let best: { start: number; net: number } | undefined;
  let pruned = 0;
  for (let k = core.length - 1; k >= 0; k--) {
    const candidate = core[k] as Candidate;
    pruned += candidate.saved;
    const rewrite = total - prefixTokens(sizes, candidate.index) - pruned;
    if (pruned < settings.minBatchTokens) continue;
    const net = horizon * pruned - (ratio - 1) * rewrite;
    if (net >= 0 && (best === undefined || net > best.net)) {
      best = { start: candidate.index, net };
    }
  }
  if (best === undefined) return [];
  const start = best.start;
  return candidates.filter((candidate) => candidate.index >= start);
}

// 固定格式的占位：原来是什么（工具、对象、大小、为什么裁）与找回方式；命令带文件变化的另保留文件变化清单
export function placeholderOf(
  candidate: Pick<Candidate, "toolName" | "reason" | "tokens" | "result" | "args">,
  output: SavedOutput | undefined
): string {
  const what = describeCall(candidate);
  const why =
    candidate.reason === "stale"
      ? "之后又读过或整体覆写过"
      : candidate.reason === "empty"
        ? "没有结果"
        : "较大的旧结果";
  const head = `[已裁剪] 这里原是 ${candidate.toolName} 的结果（${what}；约 ${candidate.tokens} token；${why}），为节省上下文已移出。找回：${recoveryOf(candidate, output)}`;
  return `${head}${fileChangesOf(candidate)}`;
}

function describeCall(candidate: Pick<Candidate, "toolName" | "result" | "args">): string {
  const { args } = candidate;
  const details = candidate.result.details as Details;
  switch (candidate.toolName) {
    case "read_file": {
      const window = readWindowOf(candidate.result);
      const range = window !== undefined ? `，第 ${window.from}–${window.to} 行` : "";
      return `读取 ${clip(String(args.path ?? ""))}${range}`;
    }
    case "run_command": {
      const exit = details?.exitCode !== undefined ? `，退出码 ${String(details.exitCode)}` : "";
      return `命令 ${clip(String(args.command ?? ""))}${exit}`;
    }
    case "grep":
    case "glob":
      return `搜索 ${clip(String(args.pattern ?? ""))}${args.path !== undefined ? ` 于 ${clip(String(args.path))}` : ""}`;
    case "web_search":
      return `搜索 ${clip(String(args.query ?? ""))}`;
    default:
      return `参数 ${clip(JSON.stringify(args))}`;
  }
}

function recoveryOf(
  candidate: Pick<Candidate, "toolName" | "result">,
  output: SavedOutput | undefined
): string {
  const { toolName } = candidate;
  if (toolName === "read_file")
    return "需要时用 read_file 重新读取（覆盖这个文件之前也须重新读取）。";
  if (toolName === "run_command") {
    if (output === undefined) return "这条命令没有输出。";
    const saved = output.partial
      ? `已保存的是输出的前 ${output.bytes} 字节（全文超过落盘上限），存为 ${output.uri}`
      : `完整输出存为 ${output.uri}`;
    return `${saved}，可用 read_file 读取（若已被清理，需要重新运行）。`;
  }
  return SEARCH_TOOLS.has(toolName) ? "需要时重新搜索。" : "需要时重新调用。";
}

// 命令结果正文里的文件变化一段（有变化或说不准时原样保留，换掉的只是输出部分）
function fileChangesOf(candidate: Pick<Candidate, "toolName" | "result">): string {
  if (candidate.toolName !== "run_command") return "";
  if (!hasFileChanges(candidate.result.details as Details)) return "";
  const text = candidate.result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const at = text.lastIndexOf(FILE_CHANGES_HEAD);
  return at >= 0 ? text.slice(at) : "";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CLIP_CHARS ? `${flat.slice(0, CLIP_CHARS)}…` : flat;
}

function resolvedPathOf(result: ToolResultMessage): string | undefined {
  const path = (result.details as Details)?.resolvedPath;
  return typeof path === "string" ? path : undefined;
}

// 读取的文件与行范围（含首尾）
function readWindowOf(
  result: ToolResultMessage
): { path: string; from: number; to: number } | undefined {
  const details = result.details as Details;
  const path = resolvedPathOf(result);
  const from = details?.offset;
  const lines = details?.returnedLines;
  if (path === undefined || typeof from !== "number" || typeof lines !== "number") return undefined;
  return { path, from, to: from + Math.max(0, lines - 1) };
}

function prefixTokens(sizes: readonly number[], index: number): number {
  let sum = 0;
  for (let i = 0; i < index; i++) sum += sizes[i] ?? 0;
  return sum;
}

function lastAssistantTime(messages: readonly AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message.timestamp;
  }
  return undefined;
}
