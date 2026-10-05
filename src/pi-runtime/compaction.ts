// 上下文压缩（决策 188、189、218）：复用 pi-agent-core 0.84.4 公开的压缩函数（prepareCompaction、compact、
// buildSessionContext、shouldCompact、estimateTokens、calculateContextTokens），不经 AgentHarness（其 compact 是桩）。
// - 触发：上下文 token 数大于触发点即压缩；触发点缺省为模型窗口减预留（218：产品缺省，DeepSeek 1M 窗口下约 98 万，
//   实际几乎不触发），可配置调低（集成冒烟用）。保留最近约 keepRecentTokens 的消息原样，其余由模型写成摘要。
// - 摘要请求：经调用方给的模型接入（与主请求同一个 streamFn：同一网关、同一计量与花费上限）；Models 适配只实现
//   completeSimple。不请求推理（关思考），输出上限按上游规则取 0.8 倍预留与模型输出上限的较小者。
// - 记录：压缩条目写进会话文件（原始消息保留，179）；替换后的上下文由 buildSessionContext 从会话树还原（上游口径）。
// - 待摘要段为空时不调用模型（compact 自己不拦）。压缩真正执行之前调用压缩前回调（192、207），回调失败不阻断压缩。
import {
  type AgentMessage,
  buildSessionContext,
  type CompactionPreparation,
  type CompactionSettings,
  type CompactResult,
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  type Entry,
  estimateTokens,
  prepareCompaction,
  type StreamFn,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { DEEPSEEK_CONTEXT_WINDOW } from "./deepseek-model.ts";

// 模型窗口的产品缺省：产品缺省模型 DeepSeek 的官方窗口（1M）
export const DEFAULT_CONTEXT_WINDOW = DEEPSEEK_CONTEXT_WINDOW;

// 本次运行用的压缩配置（写进 Run 开始条目）
export interface CompactionConfig {
  // 模型窗口
  contextWindow: number;
  // 预留（摘要提示与输出）；缺省 16384
  reserveTokens: number;
  // 压缩后原样保留的最近消息量；缺省 20000
  keepRecentTokens: number;
  // 触发点：上下文 token 数大于它即压缩；缺省为窗口减预留
  thresholdTokens: number;
}

export type CompactionConfigInput = Partial<CompactionConfig>;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`上下文压缩的${name}需要正整数：${value}`);
  }
  return value;
}

// 缺省值补齐并校验：窗口须大于预留，触发点给出时须小于窗口
export function resolveCompactionConfig(input: CompactionConfigInput = {}): CompactionConfig {
  const contextWindow = positiveInteger("模型窗口", input.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const reserveTokens = positiveInteger(
    "预留量",
    input.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens
  );
  const keepRecentTokens = positiveInteger(
    "保留量",
    input.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
  );
  if (contextWindow <= reserveTokens) {
    throw new Error(`上下文压缩的模型窗口（${contextWindow}）须大于预留量（${reserveTokens}）`);
  }
  const thresholdTokens = positiveInteger(
    "触发点",
    input.thresholdTokens ?? contextWindow - reserveTokens
  );
  if (thresholdTokens >= contextWindow) {
    throw new Error(`上下文压缩的触发点（${thresholdTokens}）须小于模型窗口（${contextWindow}）`);
  }
  return { contextWindow, reserveTokens, keepRecentTokens, thresholdTokens };
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

// 压缩要用的会话存储能力：读主分支（此前排队的写入都已落盘，从根到叶）、写一条压缩条目并返回写入后的主分支。
// 会话没有打开或读写失败时返回 undefined（失败已由存储告警）
export interface CompactionStore {
  branch(): Promise<readonly Entry[] | undefined>;
  appendCompaction(result: CompactResult): Promise<readonly Entry[] | undefined>;
}

// 触发位置：一次 Run 内轮与轮之间、一次 Run 开始之前、手动 /compact
export type CompactionTrigger = "turn" | "run-start" | "manual";

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
  // 摘要请求的模型接入：与主请求同一个
  streamFn: StreamFn;
  // 摘要请求的模型对象：上游按它的输出上限与是否支持推理定请求选项
  model: Model<Api>;
  beforeCompaction?: BeforeCompaction;
}

export class ContextCompactor {
  readonly config: CompactionConfig;
  readonly #models: Models;
  readonly #model: Model<Api>;
  readonly #beforeCompaction: BeforeCompaction | undefined;

  constructor(options: ContextCompactorOptions) {
    this.config = options.config;
    this.#models = summaryModels(options.streamFn);
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
    input: {
      trigger: CompactionTrigger;
      tokens: number;
      customInstructions?: string;
      signal: AbortSignal;
      onHookError: (error: unknown) => void;
    }
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
      const result = await compact(
        preparation,
        this.#models,
        this.#model,
        input.customInstructions,
        input.signal
      );
      if (!result.ok) {
        return { kind: "failed", stage: "summary", error: result.error };
      }
      const after = await store.appendCompaction(result.value);
      if (after === undefined) {
        return { kind: "failed", stage: "store", error: new Error("压缩条目没有写进会话文件") };
      }
      const messages = buildSessionContext([...after]).messages;
      return {
        kind: "compacted",
        trigger: input.trigger,
        tokensBefore: result.value.tokensBefore,
        tokensAfter: contextTokens(messages),
        messages,
      };
    } catch (error) {
      return { kind: "failed", stage: "summary", error };
    }
  }
}
