// 打转检测的装配（决策 305–308）：把判定挂到运行面的整轮观察口上。提醒作一条用户消息进模型的下一轮（经运行面的通知队列，
// 本轮结束时转入上游的 steer 队列，会话记录里留作一条用户消息）；叫停交给调用方（各入口按 307 各自交代）。
// 提醒与各入口的说明文字在此一处。
import type { WorkerWatcherFactory } from "../orchestration/workers.ts";
import type { TurnRoundNotice } from "../pi-runtime/adapter.ts";
import { type ComparedRound, LoopDetector, type LoopVerdict } from "../state/loop-guard.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import { summarizeArgs } from "./format.ts";

export const LOOP_REMINDER_PREFIX = "[Loop reminder] ";
// 决策 428 之前的说法：回看旧会话时据此认出程序通知
export const LEGACY_LOOP_REMINDER_PREFIX = "[打转提醒] ";

// 结果摘要取前几行，每行至多多少字符
const RESULT_HEAD_LINES = 3;
const RESULT_LINE_CHARS = 200;

// 叫停时交给各入口的事实
export interface LoopStop {
  count: number;
  alternating: boolean;
  pattern: readonly ComparedRound[];
}

function clip(line: string): string {
  const chars = [...line];
  return chars.length <= RESULT_LINE_CHARS
    ? line
    : `${chars.slice(0, RESULT_LINE_CHARS).join("")}…`;
}

// english：给模型看的提醒与 worker 失败原因用英文（决策 428）；给人看的叫停说明照旧中文
function callLine(call: ComparedRound["calls"][number], english: boolean): string {
  return `${call.toolName} ${summarizeArgs(call.args, english)}`;
}

function resultHead(call: ComparedRound["calls"][number]): string {
  const result = call.result;
  if (result === undefined) {
    return "(no result)";
  }
  const lines = result.text.split("\n");
  const head = lines.slice(0, RESULT_HEAD_LINES).map(clip);
  const more = lines.length > RESULT_HEAD_LINES ? `\n    … (${lines.length} lines in total)` : "";
  const text = result.text === "" ? "(empty)" : head.join("\n    ") + more;
  return `${result.isError ? "Error" : "Result"}: ${text}`;
}

// 提醒里的调用与结果：每条调用一行，其下缩进给结果的前几行；两轮一循环时分两段
function patternDetail(stop: Pick<LoopStop, "pattern" | "alternating">): string {
  const block = (round: ComparedRound) =>
    round.calls.map((call) => `- ${callLine(call, true)}\n    ${resultHead(call)}`).join("\n");
  if (stop.alternating && stop.pattern.length === 2) {
    const [first, second] = stop.pattern;
    return `Round 1:\n${block(first as ComparedRound)}\nRound 2:\n${block(second as ComparedRound)}`;
  }
  return stop.pattern.map(block).join("\n");
}

// 调用的一行摘要（叫停说明用）：多条以"；"相连（english 时以 "; "）
export function loopCallsSummary(stop: Pick<LoopStop, "pattern">, english = false): string {
  return stop.pattern
    .flatMap((round) => round.calls.map((call) => callLine(call, english)))
    .join(english ? "; " : "；");
}

function repeatLead(stop: Pick<LoopStop, "count" | "alternating">): string {
  return stop.alternating
    ? `In the last ${stop.count} rounds, your tool calls and their results have alternated between the same two rounds without any change:`
    : `In the last ${stop.count} consecutive rounds, your tool calls and their results were exactly the same as in the round before:`;
}

const NO_NEW_INFORMATION = "Repeating the same calls will not bring any new information.";

// 定稿文字：两版提醒、终端界面的叫停说明、worker 的打转原因、pigeon run 的收尾说明
export const LOOP_GUARD_TEXTS = {
  remind: (stop: LoopStop) =>
    `${LOOP_REMINDER_PREFIX}${repeatLead(stop)}\n${patternDetail(stop)}\n` +
    `${NO_NEW_INFORMATION} Try a different approach: check whether your assumptions hold, use another method, or first read the relevant code and output; ` +
    "if you really cannot make progress, stop and summarize what you know and where you are stuck.",
  warn: (stop: LoopStop, left: number) =>
    `${LOOP_REMINDER_PREFIX}This is the second reminder. ${repeatLead(stop)}\n${patternDetail(stop)}\n` +
    `${NO_NEW_INFORMATION} If they repeat for ${left} more rounds, this run will be stopped. ` +
    "Switch to a different approach now; if you really cannot make progress, stop and summarize what you know and where you are stuck.",
  // 终端界面：消息区的叫停说明
  tuiStopped: (stop: LoopStop) =>
    `[打转] 检测到打转：连续 ${stop.count} 轮重复同样的工具调用与结果，本轮已叫停。重复的调用：${loopCallsSummary(stop)}。` +
    "会话照常可用，可以给出下一步的指示；想让它接着做，直接说“继续”。",
  // worker：交回与通知里的失败原因（套 271 定稿的失败文字："worker X（角色）失败：<原因>。分支 … 上可能有部分改动。"）
  workerReason: (stop: LoopStop) =>
    `stuck in a loop: the same tool calls and results repeated for ${stop.count} consecutive rounds, so it was stopped. Repeated calls: ${loopCallsSummary(stop, true)}`,
  // pigeon run：收尾说明（终态一行之后）
  runStopped: (stop: LoopStop) =>
    `检测到打转：连续 ${stop.count} 轮重复同样的工具调用与结果，本次运行已叫停。重复的调用：${loopCallsSummary(stop)}`,
};

// 挂打转检测的运行面：整轮观察口与通知队列
export interface LoopGuardTarget {
  subscribeRounds(listener: (round: TurnRoundNotice) => void): () => void;
  notify(text: string): unknown;
}

// 运行面句柄上可选的整轮观察口与通知 → 挂点；缺一即 undefined。按方法调用，保留句柄自己的 this
export function loopGuardTargetOf(runtime: {
  subscribeRounds?(listener: (round: TurnRoundNotice) => void): () => void;
  notify?(text: string): unknown;
}): LoopGuardTarget | undefined {
  if (runtime.subscribeRounds === undefined || runtime.notify === undefined) {
    return undefined;
  }
  return {
    subscribeRounds: (listener) => runtime.subscribeRounds?.(listener) ?? (() => {}),
    notify: (text) => runtime.notify?.(text),
  };
}

// 把打转检测挂到运行面上：提醒经通知进下一轮；计到叫停轮数时调用 onStop（每次叫停只调一次；叫停后计数照常，
// 调用方的中止使这次运行就此结束）。按 Run 计：换了 Run（人发了下一条、续跑）即从零开始。关掉时不挂、返回空的退订
export function attachLoopGuard(
  target: LoopGuardTarget,
  settings: LoopGuardSettings | undefined,
  onStop: (stop: LoopStop) => void,
  // 提醒递出时另交一份原文（终端界面据此在消息区显示成系统消息，同 worker 通知的样式）
  onReminder?: (text: string) => void
): () => void {
  if (settings === undefined || !settings.enabled) {
    return () => {};
  }
  let detector = new LoopDetector(settings);
  let runId: string | undefined;
  return target.subscribeRounds((round) => {
    if (round.runId !== runId) {
      runId = round.runId;
      detector = new LoopDetector(settings);
    }
    // 决策 367：截断且没有工具调用的回复（续跑时从上下文去掉）不算一轮，不清零计数
    if (round.truncated === true) {
      return;
    }
    const verdict: LoopVerdict = detector.observe(round);
    const stop: LoopStop = {
      count: verdict.count,
      alternating: verdict.alternating,
      pattern: verdict.pattern,
    };
    const remind = (text: string): void => {
      target.notify(text);
      onReminder?.(text);
    };
    switch (verdict.action) {
      case "remind":
        remind(LOOP_GUARD_TEXTS.remind(stop));
        return;
      case "warn":
        remind(LOOP_GUARD_TEXTS.warn(stop, settings.stopAt - verdict.count));
        return;
      case "stop":
        onStop(stop);
        return;
      default:
        return;
    }
  });
}

// worker 的打转观察者（307）：经编排器的观察者接入点挂上；提醒经 worker 的通知进它的下一轮，叫停以 looping 失败交回
// （原因写明重复的调用；分支上可能有部分改动由失败文字交代），不自动重试。运行面不提供整轮观察口或通知时不起作用
export function loopGuardWatcher(settings: LoopGuardSettings): WorkerWatcherFactory {
  return (_worker, control, runtime) => {
    const target = loopGuardTargetOf(runtime);
    if (target === undefined) {
      return { observe: () => {} };
    }
    const detach = attachLoopGuard(target, settings, (stop) =>
      control.stop("looping", LOOP_GUARD_TEXTS.workerReason(stop))
    );
    return { observe: () => {}, dispose: detach };
  };
}
