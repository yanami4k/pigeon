// 打转判定（决策 305、306）：纯逻辑，无 IO。
// 指纹：一轮的全部工具调用（工具名加参数；参数按键名递归排序后序列化，调用之间保持原顺序）与各条返回结果（正文加是否报错，
// 按 toolCallId 对上调用）。豁免工具的调用与结果从指纹里去掉。
// 计数：与上一轮指纹相同计一次、连续累计，不同清零（连续计数）；另记前两轮，与前两轮相同且与上一轮不同计一次、连续累计，
// 不同清零（两轮一循环的交替计数）；两种计数取大者为这一轮的计数。
// 没有工具调用的轮：两种计数与前两轮的记录一并清零。去掉豁免调用后为空的轮：不计数也不清零，记录不动。
// 触发：计数从阈值以下升到阈值时各触发一次（提醒、再提醒、叫停）；模式变了计数即清零，之后再打转照常再次触发
import type { LoopGuardSettings } from "./loop-guard-config.ts";

export interface LoopRoundCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface LoopRoundResult {
  toolCallId: string;
  isError: boolean;
  // 结果里文本块的拼接
  text: string;
}

// 一轮：一条助手消息里的工具调用与它们的返回结果
export interface LoopRound {
  calls: readonly LoopRoundCall[];
  results: readonly LoopRoundResult[];
}

// 去掉豁免后参与比较的一轮（调用与按调用顺序对上的结果；没有结果的调用 result 缺省）
export interface ComparedRound {
  calls: ReadonlyArray<{ toolName: string; args: unknown; result?: LoopRoundResult }>;
}

export type RoundShape =
  | { kind: "no-calls" }
  | { kind: "exempt-only" }
  | { kind: "calls"; fingerprint: string; round: ComparedRound };

// 参数的规范序列化：对象按键名排序（递归），数组保序；undefined 与函数照 JSON 的口径丢弃
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function roundShape(round: LoopRound, exemptTools: ReadonlySet<string>): RoundShape {
  if (round.calls.length === 0) {
    return { kind: "no-calls" };
  }
  const kept = round.calls.filter((call) => !exemptTools.has(call.toolName));
  if (kept.length === 0) {
    return { kind: "exempt-only" };
  }
  const results = new Map(round.results.map((result) => [result.toolCallId, result]));
  const compared: ComparedRound = {
    calls: kept.map((call) => {
      const result = results.get(call.toolCallId);
      return {
        toolName: call.toolName,
        args: call.args,
        ...(result !== undefined ? { result } : {}),
      };
    }),
  };
  const fingerprint = JSON.stringify(
    compared.calls.map((call) => [
      call.toolName,
      canonicalJson(call.args),
      call.result === undefined ? null : [call.result.isError, call.result.text],
    ])
  );
  return { kind: "calls", fingerprint, round: compared };
}

export type LoopAction = "remind" | "warn" | "stop";

// 一轮之后的判定：action 缺省即不必做什么
export interface LoopVerdict {
  count: number;
  action?: LoopAction;
  // 重复的模式：连续重复时为这一轮，两轮一循环时为上一轮与这一轮（按发生先后）
  pattern: readonly ComparedRound[];
  alternating: boolean;
}

export class LoopDetector {
  readonly #settings: Pick<LoopGuardSettings, "remindAt" | "warnAt" | "stopAt">;
  readonly #exempt: ReadonlySet<string>;
  #previous: { fingerprint: string; round: ComparedRound } | undefined;
  #beforePrevious: { fingerprint: string; round: ComparedRound } | undefined;
  #same = 0;
  #alternate = 0;

  constructor(settings: Pick<LoopGuardSettings, "remindAt" | "warnAt" | "stopAt" | "exemptTools">) {
    this.#settings = settings;
    this.#exempt = new Set(settings.exemptTools);
  }

  count(): number {
    return Math.max(this.#same, this.#alternate);
  }

  observe(round: LoopRound): LoopVerdict {
    const shape = roundShape(round, this.#exempt);
    if (shape.kind === "exempt-only") {
      return { count: this.count(), pattern: [], alternating: false };
    }
    if (shape.kind === "no-calls") {
      this.#previous = undefined;
      this.#beforePrevious = undefined;
      this.#same = 0;
      this.#alternate = 0;
      return { count: 0, pattern: [], alternating: false };
    }
    const before = this.count();
    const previous = this.#previous;
    const { fingerprint } = shape;
    this.#same = previous?.fingerprint === fingerprint ? this.#same + 1 : 0;
    this.#alternate =
      this.#beforePrevious?.fingerprint === fingerprint && previous?.fingerprint !== fingerprint
        ? this.#alternate + 1
        : 0;
    this.#beforePrevious = previous;
    this.#previous = { fingerprint, round: shape.round };
    const count = this.count();
    const alternating = this.#alternate > this.#same;
    const pattern =
      alternating && previous !== undefined ? [previous.round, shape.round] : [shape.round];
    const crossed = (threshold: number) => before < threshold && count >= threshold;
    const { remindAt, warnAt, stopAt } = this.#settings;
    const action: LoopAction | undefined = crossed(stopAt)
      ? "stop"
      : crossed(warnAt)
        ? "warn"
        : crossed(remindAt)
          ? "remind"
          : undefined;
    return { count, pattern, alternating, ...(action !== undefined ? { action } : {}) };
  }
}
