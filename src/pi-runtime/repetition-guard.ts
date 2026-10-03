// 流式重复检测（决策 367）：包在模型调用（StreamFn）外层，与服务商无关；只看正文与思考的增量，不看工具参数。
// 正文与思考各用一个检测器，判据两种（参数见 state/runaway-config.ts，缺省照 omp）：
// - 逐字周期：每隔 checkIntervalChars 个新字符，看最近 windowChars 个字符的末尾能否由同一单元首尾相接重复构成
//   （单元须含文字，纯标点、数字、空白的分隔线不算）；对反转的尾部求 Z 数组，一次线性扫描得到每个周期长度的重复跨度
// - 段落相似度：按空行切段，段与最近若干段比较词三元组的 Jaccard 相似度，攒够段数后近似段达门槛即命中。
//   切词与 omp 不同：omp 只留 ASCII 字母数字，中文段落会被整段忽略；这里中日韩文字逐字成词，其余按字母数字连写成词
// 命中时：掐断模式中止内层请求，以截至命中处的内容、停止原因 length 收尾本条回复（运行面按撞上限交给续跑）；
// 只记录模式照常转发，本条回复里每个通道的每种判据只报第一次。每次报告经 onHit 交给运行面写会话记录
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { RepetitionGuardMode, RepetitionGuardParams } from "../state/runaway-config.ts";

export type RepetitionChannel = "text" | "thinking";
export type RepetitionCriterion = "cycle" | "paragraph";

// 一次命中。位置是本条回复里该通道的字符偏移
export interface RepetitionHit {
  criterion: RepetitionCriterion;
  channel: RepetitionChannel;
  // 逐字周期：单元长度；段落相似度：命中段的长度
  periodChars: number;
  // 逐字周期：完整重复的遍数；段落相似度：近似段数（含本段）
  repeats: number;
  // 重复的起点：逐字周期为窗口内重复跨度的起点，段落相似度为最早一个近似段的起点
  startChar: number;
  // 触发时该通道已收到的字符数
  atChar: number;
}

type DetectorHit = Omit<RepetitionHit, "channel">;

const LETTER = /[\p{L}\p{Extended_Pictographic}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const NON_WORD = /[^\p{L}\p{N}_]+/u;
const SEGMENT_BOUNDARY = /\n\s*\n/;
// 段内的标题行与整行粗体标题不参与比较（措辞常变，会掩盖重复；同 omp）
const HEADING_LINE = /^[ \t]*#{1,6}[ \t].*$/gm;
const BOLD_TITLE_LINE = /^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm;

export class RepetitionDetector {
  readonly #params: RepetitionGuardParams;
  #tail = "";
  #received = 0;
  #sinceScan = 0;
  #pending = "";
  #pendingStart = 0;
  readonly #segments: Array<{ shingles: Set<string>; start: number }> = [];
  #segmentCount = 0;

  constructor(params: RepetitionGuardParams) {
    this.#params = params;
  }

  // 收一段增量；命中返回命中信息
  push(delta: string): DetectorHit | undefined {
    if (delta === "") {
      return undefined;
    }
    this.#received += delta.length;
    this.#tail = (this.#tail + delta).slice(-this.#params.windowChars);
    this.#sinceScan += delta.length;
    if (this.#sinceScan >= this.#params.checkIntervalChars) {
      this.#sinceScan = 0;
      const cycle = this.#scanCycle();
      if (cycle !== undefined) {
        return cycle;
      }
    }
    return this.#feedSegments(delta, false);
  }

  // 一个内容块结束：不足一个检查间隔的尾巴补查一次，未切出的段一并比较
  flush(): DetectorHit | undefined {
    if (this.#sinceScan > 0) {
      this.#sinceScan = 0;
      const cycle = this.#scanCycle();
      if (cycle !== undefined) {
        return cycle;
      }
    }
    return this.#feedSegments("", true);
  }

  #scanCycle(): DetectorHit | undefined {
    const params = this.#params;
    const text = this.#tail;
    const reach = suffixMatchLengths(text);
    const maxPeriod = Math.min(params.maxPeriodChars, Math.floor(text.length / 2));
    for (let period = 1; period <= maxPeriod; period += 1) {
      const span = period + (reach[period] ?? 0);
      const repeats = Math.floor(span / period);
      const short = period <= params.shortPeriodChars;
      const minRepeats = short ? params.shortMinRepeats : params.minRepeats;
      const minChars = short ? params.shortMinRepeatedChars : params.minRepeatedChars;
      if (repeats < minRepeats || repeats * period < minChars) {
        continue;
      }
      if (!LETTER.test(text.slice(text.length - period))) {
        continue;
      }
      return {
        criterion: "cycle",
        periodChars: period,
        repeats,
        startChar: this.#received - span,
        atChar: this.#received,
      };
    }
    return undefined;
  }

  #feedSegments(delta: string, final: boolean): DetectorHit | undefined {
    const params = this.#params;
    this.#pending += delta;
    for (;;) {
      const boundary = SEGMENT_BOUNDARY.exec(this.#pending);
      let raw: string;
      let consumed: number;
      if (boundary !== null) {
        raw = this.#pending.slice(0, boundary.index);
        consumed = boundary.index + boundary[0].length;
      } else if (this.#pending.length > params.segmentMaxChars) {
        raw = this.#pending.slice(0, params.segmentMaxChars);
        consumed = raw.length;
      } else if (final && this.#pending !== "") {
        raw = this.#pending;
        consumed = raw.length;
      } else {
        return undefined;
      }
      const start = this.#pendingStart;
      this.#pending = this.#pending.slice(consumed);
      this.#pendingStart += consumed;
      for (let offset = 0; offset < raw.length; offset += params.segmentMaxChars) {
        const hit = this.#consumeSegment(
          raw.slice(offset, offset + params.segmentMaxChars),
          start + offset
        );
        if (hit !== undefined) {
          return hit;
        }
      }
    }
  }

  #consumeSegment(raw: string, start: number): DetectorHit | undefined {
    const params = this.#params;
    const words = segmentWords(raw.replace(HEADING_LINE, "").replace(BOLD_TITLE_LINE, ""));
    if (words.join(" ").length < params.segmentMinChars) {
      return undefined;
    }
    const shingles = trigrams(words);
    let cluster = 1;
    let earliest = start;
    for (const previous of this.#segments) {
      if (jaccard(shingles, previous.shingles) >= params.similarity) {
        cluster += 1;
        earliest = Math.min(earliest, previous.start);
      }
    }
    this.#segments.push({ shingles, start });
    if (this.#segments.length > params.segmentWindow) {
      this.#segments.shift();
    }
    this.#segmentCount += 1;
    if (this.#segmentCount < params.minSegments || cluster < params.minCluster) {
      return undefined;
    }
    return {
      criterion: "paragraph",
      periodChars: raw.length,
      repeats: cluster,
      startChar: earliest,
      atChar: this.#received,
    };
  }
}

// reach[p]：文本末尾与"整体前移 p 个字符"的文本末尾最长相同的字符数——末尾以 p 为周期的跨度即 p + reach[p]。
// 即反转文本的 Z 数组，按下标从末尾取字符，不另建反转串
function suffixMatchLengths(text: string): Int32Array {
  const n = text.length;
  const reach = new Int32Array(n);
  let left = 0;
  let right = 0;
  for (let i = 1; i < n; i += 1) {
    let k = i < right ? Math.min(right - i, reach[i - left] ?? 0) : 0;
    while (i + k < n && text.charCodeAt(n - 1 - k) === text.charCodeAt(n - 1 - i - k)) {
      k += 1;
    }
    reach[i] = k;
    if (i + k > right) {
      left = i;
      right = i + k;
    }
  }
  return reach;
}

// 段落切词：小写；中日韩文字逐字成词，其余按字母数字连写成词；不含字母的词（纯数字）去掉
function segmentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(CJK, " $& ")
    .split(NON_WORD)
    .filter((word) => LETTER.test(word));
}

function trigrams(words: readonly string[]): Set<string> {
  if (words.length < 3) {
    return new Set(words.length > 0 ? [words.join(" ")] : []);
  }
  const shingles = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i += 1) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return shingles;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) {
    if (large.has(item)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

export interface RepetitionGuardOptions {
  params: RepetitionGuardParams;
  mode: RepetitionGuardMode;
  // 每次报告的命中；自身抛异常不影响模型调用
  onHit: (hit: RepetitionHit) => void;
}

// 包装模型调用：内层请求用自己的中止口（与调用方的中止信号合并），掐断时只中止内层请求
export function guardRepetition(streamFn: StreamFn, options: RepetitionGuardOptions): StreamFn {
  return async (model, context, callOptions) => {
    const cutter = new AbortController();
    const caller = callOptions?.signal;
    const signal = caller !== undefined ? AbortSignal.any([caller, cutter.signal]) : cutter.signal;
    const inner = await streamFn(model, context, { ...callOptions, signal });
    const outer = createAssistantMessageEventStream();
    void relay(inner, outer, cutter, options);
    return outer;
  };
}

async function relay(
  inner: AssistantMessageEventStream,
  outer: AssistantMessageEventStream,
  cutter: AbortController,
  options: RepetitionGuardOptions
): Promise<void> {
  const detectors: Record<RepetitionChannel, RepetitionDetector> = {
    text: new RepetitionDetector(options.params),
    thinking: new RepetitionDetector(options.params),
  };
  const reported = new Set<string>();
  // 已转发的正文与思考增量按内容块累计：事件积压时 partial（内层流就地更新的同一个对象）可能已经走在前面，
  // 掐断时命中块的内容以这里为准
  const streamed = new Map<number, string>();
  let last: AssistantMessage | undefined;
  try {
    for await (const event of inner) {
      outer.push(event);
      if (event.type === "done" || event.type === "error") {
        return;
      }
      last = event.partial;
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        streamed.set(event.contentIndex, (streamed.get(event.contentIndex) ?? "") + event.delta);
      }
      const found = inspect(event, detectors);
      if (found === undefined) {
        continue;
      }
      if (options.mode === "log") {
        const key = `${found.channel}:${found.criterion}`;
        if (!reported.has(key)) {
          reported.add(key);
          report(options, found);
        }
        continue;
      }
      report(options, found);
      cutter.abort();
      outer.push({
        type: "done",
        reason: "length",
        message: cutMessage(event.partial, found.contentIndex, streamed.get(found.contentIndex)),
      });
      return;
    }
    outer.end(await inner.result());
  } catch (error) {
    // 转发或检测自身出错：以出错收尾本条回复（不留悬挂的流）
    outer.push({
      type: "error",
      reason: "error",
      error: {
        ...(last ?? emptyPartial()),
        content: last !== undefined ? structuredClone(last.content) : [],
        stopReason: "error",
        errorMessage: `流式重复检测出错：${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      },
    });
  }
}

// 只看正文与思考：增量喂给对应通道，块结束时补查；命中时带上命中的内容块下标
function inspect(
  event: AssistantMessageEvent,
  detectors: Record<RepetitionChannel, RepetitionDetector>
): (RepetitionHit & { contentIndex: number }) | undefined {
  let channel: RepetitionChannel;
  let hit: DetectorHit | undefined;
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      channel = event.type === "text_delta" ? "text" : "thinking";
      hit = detectors[channel].push(event.delta);
      break;
    case "text_end":
    case "thinking_end":
      channel = event.type === "text_end" ? "text" : "thinking";
      hit = detectors[channel].flush();
      break;
    default:
      return undefined;
  }
  return hit !== undefined ? { ...hit, channel, contentIndex: event.contentIndex } : undefined;
}

function report(options: RepetitionGuardOptions, found: RepetitionHit & { contentIndex: number }) {
  const { contentIndex: _index, ...hit } = found;
  try {
    options.onHit(hit);
  } catch {
    // 记录方的异常不影响模型调用
  }
}

// 截至命中处的内容（深拷贝，不与内层流共享对象）：命中块之前的块照取，命中块的文字取已转发的增量，之后的块不要；
// 停止原因记为撞输出上限
function cutMessage(
  partial: AssistantMessage,
  contentIndex: number,
  streamedText: string | undefined
): AssistantMessage {
  const content = structuredClone(partial.content.slice(0, contentIndex + 1));
  const block = content[contentIndex];
  if (block?.type === "text") {
    block.text = streamedText ?? "";
  } else if (block?.type === "thinking") {
    block.thinking = streamedText ?? "";
  }
  return { ...partial, content, stopReason: "length", timestamp: Date.now() };
}

function emptyPartial(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.now(),
  };
}
