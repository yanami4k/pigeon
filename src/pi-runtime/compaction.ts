// 上下文压缩（决策 188、189、218）：复用 pi-agent-core 0.84.4 公开的压缩函数（prepareCompaction、compact、
// buildSessionContext、shouldCompact、estimateTokens、calculateContextTokens），不经 AgentHarness（其 compact 是桩）。
// - 触发：上下文 token 数大于触发点即压缩；触发点缺省为模型窗口减预留（218：产品缺省），可配置调低（集成冒烟用）。
//   保留最近约 keepRecentTokens 的消息原样，其余由模型写成摘要。
// - 窗口（决策 422）：运行参数显式给的 > 本次所用模型的元数据（state/model-info.ts 的 contextWindow：设置、接入模块声明、
//   pi-ai 目录）> 缺省；来源随配置写进 Run 开始条目。
// - 摘要请求（决策 424）：经调用方给的模型接入（与主请求同一个 streamFn：同一网关、同一计量与重试），两种发法，见下文
//   "摘要请求的两种发法"。切点（prepareCompaction）、保留段、压缩条目与还原（buildSessionContext）两种发法相同。
// - 记录：压缩条目写进会话文件（原始消息保留，179）；替换后的上下文由 buildSessionContext 从会话树还原（上游口径）。
//   条目的 details 除上游的读过、改过的文件外，另记这次摘要请求的发法（summaryRequest）。
// - 待摘要段为空时不调用模型（compact 自己不拦）。压缩真正执行之前调用压缩前回调（192、207），回调失败不阻断压缩。
import {
  type AgentMessage,
  buildSessionContext,
  CompactionError,
  type CompactionPreparation,
  type CompactionSettings,
  type CompactResult,
  calculateContextTokens,
  compact,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type Entry,
  estimateTokens,
  type FileOperations,
  prepareCompaction,
  type StreamFn,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  contentText,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelInfoSource, Sourced } from "../state/model-info.ts";
import { DEEPSEEK_CONTEXT_WINDOW } from "./deepseek-model.ts";
import { fixTemperature } from "./sampling.ts";

// 模型窗口的缺省：运行参数没给、模型元数据也取不到时用（数值同产品缺省模型 DeepSeek 的官方窗口 1M）
export const DEFAULT_CONTEXT_WINDOW = DEEPSEEK_CONTEXT_WINDOW;

// 窗口的来源（决策 422）：运行参数显式给出、模型元数据的一层（设置、接入模块声明、pi-ai 目录）、缺省
export type ContextWindowSource = "explicit" | ModelInfoSource | "default";

// 本次运行用的压缩配置（写进 Run 开始条目）
export interface CompactionConfig {
  // 模型窗口
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  // 预留（摘要提示与输出）；缺省 16384
  reserveTokens: number;
  // 压缩后原样保留的最近消息量；缺省 20000
  keepRecentTokens: number;
  // 触发点：上下文 token 数大于它即压缩；缺省为窗口减预留
  thresholdTokens: number;
}

// 运行参数可显式给的项（窗口的来源由解析时定）
export type CompactionConfigInput = Partial<Omit<CompactionConfig, "contextWindowSource">>;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`上下文压缩的${name}需要正整数：${value}`);
  }
  return value;
}

// 缺省值补齐并校验：窗口须大于预留，触发点给出时须小于窗口。modelWindow 为本次所用模型元数据里的窗口（带来源）
export function resolveCompactionConfig(
  input: CompactionConfigInput = {},
  modelWindow?: Sourced<number>
): CompactionConfig {
  const [window, contextWindowSource]: [number, ContextWindowSource] =
    input.contextWindow !== undefined
      ? [input.contextWindow, "explicit"]
      : modelWindow !== undefined && modelWindow.source !== "unknown"
        ? [modelWindow.value, modelWindow.source]
        : [DEFAULT_CONTEXT_WINDOW, "default"];
  const contextWindow = positiveInteger("模型窗口", window);
  const reserveTokens = positiveInteger(
    "预留量",
    input.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens
  );
  const keepRecentTokens = positiveInteger(
    "保留量",
    input.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
  );
  if (contextWindow <= reserveTokens) {
    throw new Error(
      `上下文压缩的模型窗口（${contextWindow}，来源 ${contextWindowSource}）须大于预留量（${reserveTokens}）`
    );
  }
  const thresholdTokens = positiveInteger(
    "触发点",
    input.thresholdTokens ?? contextWindow - reserveTokens
  );
  if (thresholdTokens >= contextWindow) {
    throw new Error(
      `上下文压缩的触发点（${thresholdTokens}）须小于模型窗口（${contextWindow}，来源 ${contextWindowSource}）`
    );
  }
  return { contextWindow, contextWindowSource, reserveTokens, keepRecentTokens, thresholdTokens };
}

function settingsOf(config: CompactionConfig): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: config.reserveTokens,
    keepRecentTokens: config.keepRecentTokens,
  };
}

// 判定：上游的 shouldCompact（上下文 token 数大于窗口减预留）；触发点调低时以"触发点加预留"作窗口传入，口径不变
export function exceedsThreshold(tokens: number, config: CompactionConfig): boolean {
  return shouldCompact(tokens, config.thresholdTokens + config.reserveTokens, settingsOf(config));
}

function validUsageTokens(message: AgentMessage): number | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
    return undefined;
  }
  const tokens = calculateContextTokens(assistant.usage);
  return tokens > 0 ? tokens : undefined;
}

// 上下文的 token 数估算：同上游 estimateContextTokens（最后一条正常助手消息的 usage，加其后消息按字符估算），
// 只多一条：最近一次压缩摘要之前的助手 usage 已过期（它们量的是压缩前的整段上下文，保留段里的助手消息仍带着），
// 不拿来用，没有新鲜 usage 时整段按字符估算。否则压缩刚完成、保留段里还带着旧 usage，下一轮会被判为仍然超限
export function contextTokens(messages: readonly AgentMessage[]): number {
  const { index: usageIndex, tokens: usageTokens } = freshUsage(messages);
  let trailing = 0;
  for (let index = usageIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message !== undefined) {
      trailing += estimateTokens(message);
    }
  }
  return usageTokens + trailing;
}

// 估算所用的那条助手消息（决策 361：在它之后裁掉的量还算在这份 usage 里）；没有可用的 usage 为 undefined
export function freshUsageMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  const { index } = freshUsage(messages);
  return index >= 0 ? messages[index] : undefined;
}

// 最近一次压缩摘要之后最后一条正常助手消息的位置与 usage；没有为 -1
function freshUsage(messages: readonly AgentMessage[]): { index: number; tokens: number } {
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "compactionSummary") {
      summaryIndex = index;
      break;
    }
  }
  let usageIndex = -1;
  let usageTokens = 0;
  for (let index = messages.length - 1; index > summaryIndex; index--) {
    const message = messages[index];
    const tokens = message !== undefined ? validUsageTokens(message) : undefined;
    if (tokens === undefined) {
      continue;
    }
    // 摘要之后的保留段也带旧 usage：以摘要的时间为界，界前产生的不算
    const summary = summaryIndex >= 0 ? messages[summaryIndex] : undefined;
    if (summary !== undefined && (message?.timestamp ?? 0) < summary.timestamp) {
      continue;
    }
    usageIndex = index;
    usageTokens = tokens;
    break;
  }
  return { index: usageIndex, tokens: usageTokens };
}

// 摘要请求的 Models 适配：只实现 completeSimple，经给定的 streamFn 发出并取回终态消息。其余方法上游压缩不用，调用即报错
export function summaryModels(streamFn: StreamFn): Models {
  const models: Pick<Models, "completeSimple"> = {
    completeSimple: async (model, context, options) =>
      (await streamFn(model, context, options)).result(),
  };
  return new Proxy(models as Models, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      if (typeof property === "symbol" || property === "then") {
        return undefined;
      }
      return () => {
        throw new Error(`摘要请求的模型适配只实现 completeSimple，不支持 ${property}`);
      };
    },
  });
}

// 待摘要段是否为空（历史段与被切开那一轮的前段都没有消息）：为空时不调用模型
export function isEmptyPreparation(preparation: CompactionPreparation): boolean {
  return (
    preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0
  );
}

// —— 摘要请求的两种发法（决策 424）——
// 接续式：沿用原会话——与下一次主请求同一个模型对象、系统提示、工具与消息（运行面按主请求的转换给出），选项同主请求（推理档位、
// 温度等），末尾追加一条摘要指令（用户消息），前缀与上一次主请求逐字节相同，命中服务方的前缀缓存。不带 toolChoice：实测
// 带 none 时服务方把工具定义从提示里拿掉，前缀对不上、缓存全不命中；"只写摘要、不调工具"由摘要指令约束。推理档位不改，免得
// 服务方因思考设置不同而换一种方式组织历史、前缀对不上。只取一条回复：回复里有工具调用、没有文字或请求出错时作废，改走一次
// 独立式。
// 独立式：上游 compact 的做法——待摘要部分另组成一条请求、配专门的摘要系统提示，不请求推理。用于：因上下文超长触发（422，
// 整段已放不下）、整段放不下（见 fitsWindow）、没有会话可接、接续式作废。
// 两种发法的切点、保留段、压缩条目与还原相同；摘要文本的结构沿用上游（含被切开一轮的处理，见 summaryInstruction）。

// 运行面给出的会话：这段会话此刻发出时的 token 数（与压缩判定同一口径的估算，判定放不放得下）与按需组装的接续式请求
export interface ConversationSource {
  tokens: number;
  build(): { model: Model<Api>; context: Context; options: SimpleStreamOptions };
}

// 走独立式的原因：超长触发、没有会话可接、整段放不下、接续式请求出错（含被拒）、回复里有工具调用、回复没有文字
export type StandaloneReason =
  | "overflow"
  | "no-conversation"
  | "no-room"
  | "failed"
  | "tool-call"
  | "empty";

// 记进压缩条目 details.summaryRequest 的发法
export type SummaryRequestRecord =
  | { mode: "continuation" }
  | { mode: "standalone"; reason: StandaloneReason };

// 接续式摘要指令的开头（固定，识别用）与通用要求（取上游摘要系统提示的要求，另加不调工具）
export const SUMMARY_INSTRUCTION_HEAD =
  "Context checkpoint request: the conversation above is about to be compacted.";
const INSTRUCTION_RULES = `Earlier messages will be replaced by a summary that another LLM will use to continue the work.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. Do NOT call any tools. ONLY output the summary, as plain text.`;

// 摘要的结构与该保留什么：取上游 pi-agent-core 0.84.4 的摘要提示词（首段改为指向上方的会话；更新式里上一次的摘要就在会话开头）
const SUMMARY_FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const NEW_SUMMARY = `Create a structured context checkpoint summary of the conversation above.

Use this EXACT format:

${SUMMARY_FORMAT}`;

const UPDATE_SUMMARY = `The conversation above begins with an existing summary of earlier, already compacted work (in <summary> tags). Update that structured summary with the new information from the messages after it. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

${SUMMARY_FORMAT}`;

// 被切开一轮的摘要：取上游的"一轮前段"提示词；上游把它与历史摘要以这一段相接
const TURN_SEPARATOR = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const TURN_QUOTE_CHARS = 200;

function turnPrompt(quote: string): string {
  const turn =
    quote === ""
      ? "The turn in progress"
      : `The turn that begins with the message <turn-start>${quote}</turn-start>`;
  return `${turn} is too large to keep: its earlier part will be dropped and only its most recent part is kept verbatim after the summary.

Summarize that turn to provide context for the kept part:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the earlier part of the turn]

## Context for Suffix
- [Information needed to understand the kept recent work]

Be concise. Focus on what's needed to understand the kept part.`;
}

// 一轮开头那条消息的文字（按交给模型的形态取，空白并成一个空格，限长），用来在指令里指明是哪一轮
function turnQuote(message: AgentMessage | undefined): string {
  const [llm] = message !== undefined ? convertToLlm([message]) : [];
  const text = llm !== undefined ? contentText(llm.content, " ").replace(/\s+/g, " ").trim() : "";
  return text.length > TURN_QUOTE_CHARS ? `${text.slice(0, TURN_QUOTE_CHARS)}…` : text;
}

// 切点落在一轮中间（同上游 compact 的判断）；切点之前有没有要摘要的历史（上一次的摘要也算：它在会话开头，模型看得到）
function splitTurn(preparation: CompactionPreparation): boolean {
  return preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0;
}
function hasHistory(preparation: CompactionPreparation): boolean {
  return preparation.messagesToSummarize.length > 0 || preparation.previousSummary !== undefined;
}

// 接续式摘要指令。与上游 compact 的对应：没切开一轮——一份摘要（有上一次的摘要即更新式）；切开一轮且之前有历史——一份摘要，
// 其后以上游的分隔接上那一轮的摘要（上游是两次请求、两段相接，这里一次回复写出同样的两段）；切开一轮且之前没有历史——只写那一轮
// 的摘要，由 composeSummary 照上游补上"No prior history."与分隔。重点（手动压缩的附加说明）同上游写作 Additional focus
export function summaryInstruction(
  preparation: CompactionPreparation,
  customInstructions?: string
): string {
  const split = splitTurn(preparation);
  const history = hasHistory(preparation);
  const parts = [`${SUMMARY_INSTRUCTION_HEAD}\n\n${INSTRUCTION_RULES}`];
  if (history || !split) {
    parts.push(preparation.previousSummary !== undefined ? UPDATE_SUMMARY : NEW_SUMMARY);
  }
  if (customInstructions !== undefined && customInstructions !== "") {
    parts.push(`Additional focus: ${customInstructions}`);
  }
  if (split) {
    const turn = turnPrompt(turnQuote(preparation.turnPrefixMessages[0]));
    parts.push(
      history
        ? `After the summary, write a line "---", then a line "**Turn Context (split turn):**", then the following.\n\n${turn}`
        : turn
    );
  }
  return parts.join("\n\n");
}

// 读过与改过的文件（同上游 compact：prepareCompaction 收集的文件操作，改过的不再列入读过的，各自排序；附在摘要末尾的格式同上游）
function fileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileLists(lists: { readFiles: string[]; modifiedFiles: string[] }): string {
  const sections = [
    ...(lists.readFiles.length > 0
      ? [`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`]
      : []),
    ...(lists.modifiedFiles.length > 0
      ? [`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`]
      : []),
  ];
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

// 接续式回复组成压缩结果（形状同上游 compact 的结果）
function continuationResult(
  preparation: CompactionPreparation,
  reply: AssistantMessage,
  text: string
): CompactResult {
  const lists = fileLists(preparation.fileOps);
  const body =
    splitTurn(preparation) && !hasHistory(preparation)
      ? `No prior history.${TURN_SEPARATOR}${text}`
      : text;
  return {
    summary: body + formatFileLists(lists),
    tokensBefore: preparation.tokensBefore,
    usage: reply.usage,
    retainedTail: preparation.retainedTail,
    details: { ...lists, summaryRequest: { mode: "continuation" } satisfies SummaryRequestRecord },
  };
}

// 摘要的输出上限：同上游（0.8 倍预留与模型输出上限的较小者；模型上限不为正时只按预留）
export function summaryMaxTokens(reserveTokens: number, model: Model<Api>): number {
  return Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
  );
}

// 整段放得下：这段会话此刻的 token 数 + 摘要指令（按字符估算）+ 摘要的输出上限 不超过模型窗口
export function fitsWindow(
  conversationTokens: number,
  instruction: UserMessage,
  maxTokens: number,
  contextWindow: number
): boolean {
  return conversationTokens + estimateTokens(instruction) + maxTokens <= contextWindow;
}

// 压缩要用的会话存储能力：读主分支（此前排队的写入都已落盘，从根到叶）、写一条压缩条目并返回写入后的主分支。
// 会话没有打开或读写失败时返回 undefined（失败已由存储告警）
export interface CompactionStore {
  branch(): Promise<readonly Entry[] | undefined>;
  appendCompaction(result: CompactResult): Promise<readonly Entry[] | undefined>;
}

// 触发位置：一次 Run 内轮与轮之间、一次 Run 开始之前、模型请求因上下文超长出错之后（决策 422）、手动 /compact
export type CompactionTrigger = "turn" | "run-start" | "overflow" | "manual";

export interface BeforeCompactionInfo {
  trigger: CompactionTrigger;
  // 触发时的上下文 token 数估算
  tokens: number;
  // 手动压缩给的重点
  customInstructions?: string;
  // 压缩被中断时置位
  signal: AbortSignal;
}

// 压缩前回调（192、207 压缩前复盘的挂点）：待摘要段非空、摘要请求发出之前调用并等待；
// 调用时此前的消息都已写进会话文件。抛错或拒绝交给调用方提示，压缩照常进行
export type BeforeCompaction = (info: BeforeCompactionInfo) => void | Promise<void>;

export type CompactionOutcome =
  | {
      kind: "compacted";
      trigger: CompactionTrigger;
      tokensBefore: number;
      tokensAfter: number;
      // 压缩后的上下文（由会话树还原）
      messages: AgentMessage[];
    }
  | { kind: "skipped"; reason: "nothing-to-summarize" | "store-unavailable" }
  // stage：出在哪一步——准备（会话树形状不对）、摘要（摘要请求失败或被中止）、写入（压缩条目没写进会话文件）
  | { kind: "failed"; stage: "prepare" | "summary" | "store"; error: unknown };

export interface ContextCompactorOptions {
  config: CompactionConfig;
  // 摘要请求的模型接入：与主请求同一个（不带温度、单轮输出上限等包装）
  streamFn: StreamFn;
  // 独立式摘要请求的采样温度（不请求推理，温度总能生效）；接续式的温度同主请求，随会话的选项给出
  temperature?: number;
  // 摘要请求的模型对象：上游按它的输出上限与是否支持推理定独立式的请求选项；两种发法的输出上限都按它的输出上限取
  model: Model<Api>;
  beforeCompaction?: BeforeCompaction;
}

// 一次压缩的输入：触发位置、触发时的 token 数、手动压缩的重点、中止信号、压缩前回调故障的去处，以及运行面给的会话（接续式用）
export interface CompactionRunInput {
  trigger: CompactionTrigger;
  tokens: number;
  customInstructions?: string;
  signal: AbortSignal;
  onHookError: (error: unknown) => void;
  conversation?: ConversationSource;
}

type SummaryAttempt =
  | { kind: "done"; result: CompactResult }
  | { kind: "aborted"; error: unknown }
  | { kind: "standalone"; reason: StandaloneReason };

export class ContextCompactor {
  readonly config: CompactionConfig;
  readonly #streamFn: StreamFn;
  readonly #models: Models;
  readonly #model: Model<Api>;
  readonly #beforeCompaction: BeforeCompaction | undefined;

  constructor(options: ContextCompactorOptions) {
    this.config = options.config;
    this.#streamFn = options.streamFn;
    this.#models = summaryModels(
      options.temperature !== undefined
        ? fixTemperature(options.streamFn, options.temperature)
        : options.streamFn
    );
    this.#model = options.model;
    this.#beforeCompaction = options.beforeCompaction;
  }

  // 按当前上下文判定是否需要压缩，返回估算的 token 数与判定
  check(messages: readonly AgentMessage[]): { tokens: number; exceeds: boolean } {
    const tokens = contextTokens(messages);
    return { tokens, exceeds: exceedsThreshold(tokens, this.config) };
  }

  // 给定的 token 数是否超过触发点（决策 361：裁剪之后按裁掉的量重判）
  exceeds(tokens: number): boolean {
    return exceedsThreshold(tokens, this.config);
  }

  // 执行一次压缩：读主分支、准备、判空、压缩前回调、生成摘要、写压缩条目、按会话树还原上下文。
  // 从不抛：失败以 failed 返回，压缩前回调的故障交给 onHookError
  async run(
    store: CompactionStore | undefined,
    input: CompactionRunInput
  ): Promise<CompactionOutcome> {
    try {
      if (store === undefined) {
        return { kind: "skipped", reason: "store-unavailable" };
      }
      const entries = await store.branch();
      if (entries === undefined) {
        return { kind: "skipped", reason: "store-unavailable" };
      }
      const prepared = prepareCompaction([...entries], settingsOf(this.config));
      if (!prepared.ok) {
        return { kind: "failed", stage: "prepare", error: prepared.error };
      }
      const preparation = prepared.value;
      if (preparation === undefined || isEmptyPreparation(preparation)) {
        return { kind: "skipped", reason: "nothing-to-summarize" };
      }
      if (this.#beforeCompaction !== undefined) {
        try {
          await this.#beforeCompaction({
            trigger: input.trigger,
            tokens: input.tokens,
            ...(input.customInstructions !== undefined
              ? { customInstructions: input.customInstructions }
              : {}),
            signal: input.signal,
          });
        } catch (error) {
          input.onHookError(error);
        }
      }
      const attempt =
        input.trigger === "overflow"
          ? ({ kind: "standalone", reason: "overflow" } as const)
          : await this.#continuation(preparation, input);
      if (attempt.kind === "aborted") {
        return { kind: "failed", stage: "summary", error: attempt.error };
      }
      let result: CompactResult;
      if (attempt.kind === "done") {
        result = attempt.result;
      } else {
        const standalone = await compact(
          preparation,
          this.#models,
          this.#model,
          input.customInstructions,
          input.signal
        );
        if (!standalone.ok) {
          return { kind: "failed", stage: "summary", error: standalone.error };
        }
        const record: SummaryRequestRecord = { mode: "standalone", reason: attempt.reason };
        result = {
          ...standalone.value,
          details: { ...(standalone.value.details ?? {}), summaryRequest: record },
        };
      }
      const after = await store.appendCompaction(result);
      if (after === undefined) {
        return { kind: "failed", stage: "store", error: new Error("压缩条目没有写进会话文件") };
      }
      const messages = buildSessionContext([...after]).messages;
      return {
        kind: "compacted",
        trigger: input.trigger,
        tokensBefore: result.tokensBefore,
        tokensAfter: contextTokens(messages),
        messages,
      };
    } catch (error) {
      return { kind: "failed", stage: "summary", error };
    }
  }

  // 接续式摘要请求（决策 424）：没有会话、整段放不下、请求出错（含被拒、超长）、回复里有工具调用或没有文字时交回"走独立式"
  // 及原因；被中止的不改走。回复因输出上限截断但有文字时照收（同上游）
  async #continuation(
    preparation: CompactionPreparation,
    input: CompactionRunInput
  ): Promise<SummaryAttempt> {
    const conversation = input.conversation;
    if (conversation === undefined) {
      return { kind: "standalone", reason: "no-conversation" };
    }
    const instruction: UserMessage = {
      role: "user",
      content: [{ type: "text", text: summaryInstruction(preparation, input.customInstructions) }],
      timestamp: Date.now(),
    };
    const maxTokens = summaryMaxTokens(this.config.reserveTokens, this.#model);
    if (!fitsWindow(conversation.tokens, instruction, maxTokens, this.config.contextWindow)) {
      return { kind: "standalone", reason: "no-room" };
    }
    let reply: AssistantMessage;
    try {
      const { model, context, options } = conversation.build();
      const stream = await this.#streamFn(
        model,
        { ...context, messages: [...context.messages, instruction] },
        { ...options, maxTokens, signal: input.signal }
      );
      reply = await stream.result();
    } catch (error) {
      return input.signal.aborted
        ? { kind: "aborted", error }
        : { kind: "standalone", reason: "failed" };
    }
    if (reply.stopReason === "aborted" || input.signal.aborted) {
      return {
        kind: "aborted",
        error: new CompactionError("aborted", reply.errorMessage || "Summarization aborted"),
      };
    }
    if (reply.stopReason === "error") {
      return { kind: "standalone", reason: "failed" };
    }
    if (reply.content.some((block) => block.type === "toolCall")) {
      return { kind: "standalone", reason: "tool-call" };
    }
    const text = contentText(reply.content);
    if (text.trim() === "") {
      return { kind: "standalone", reason: "empty" };
    }
    return { kind: "done", result: continuationResult(preparation, reply, text) };
  }
}
