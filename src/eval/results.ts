// Eval 结果行（M6.5 S4，决策 060）：results.jsonl 每次运行一行，是 M9 统计的原始数据，入库。
// 字段：任务 id、条件、第几次、是否 holdout、sessionId、runId、终态、三值判决、是否误报、轮次、工具调用数、
// 需审批次数、usage、耗时、失败分类；运行本身出错时另带 error。报告只由这些行决定，可复算。
// 决策 061：新增编辑模式、harness 版本（Pigeon 仓库 HEAD 短号与是否有未提交改动）与过程指标。
// 061 之前写下的旧行没有这三个字段：读取时编辑模式按 hashline 补齐；过程指标由对照报告从会话账本复算。
import { existsSync, readFileSync } from "node:fs";
import type { HeadlessStatus } from "../application/headless.ts";
import type { EvalVerdict, TurnUsage } from "../state/runtime-events.ts";
import { type EditMode, LEGACY_RESULT_EDIT_MODE } from "../tools/edit-mode.ts";
import type { ProcessMetrics } from "./process.ts";
import type { EvalCondition } from "./task.ts";

export interface HarnessRef {
  commit: string;
  dirty: boolean;
}

export interface ProgressCount {
  passed: number;
  total: number;
}

export interface TestProgress {
  target: ProgressCount;
  regression?: ProgressCount;
}

function progressCount(value: unknown): ProgressCount | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { passed, total } = value as Record<string, unknown>;
  return typeof passed === "number" &&
    typeof total === "number" &&
    Number.isInteger(passed) &&
    Number.isInteger(total) &&
    passed >= 0 &&
    total >= passed
    ? { passed, total }
    : undefined;
}

// 从判据命令尾行 JSON 里取连续指标；形状不对一律不收（不猜）
export function parseTestProgress(details: unknown): TestProgress | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const progress = (details as Record<string, unknown>).progress;
  if (typeof progress !== "object" || progress === null) {
    return undefined;
  }
  const target = progressCount((progress as Record<string, unknown>).target);
  if (target === undefined) {
    return undefined;
  }
  const rawRegression = (progress as Record<string, unknown>).regression;
  const regression = progressCount(rawRegression);
  if (rawRegression !== undefined && regression === undefined) {
    return undefined;
  }
  return { target, ...(regression !== undefined ? { regression } : {}) };
}

// 确定性错误的类别（与报告里的中文名一一对应）
export type DeterministicError = "context-overflow";

export const DETERMINISTIC_ERROR_LABELS: Readonly<Record<DeterministicError, string>> = {
  "context-overflow": "上下文超长",
};

export interface EvalResultLine {
  taskId: string;
  condition: EvalCondition;
  // 061 之前的旧行缺省，读取时按 hashline 补齐
  editMode?: EditMode;
  attempt: number;
  holdout: boolean;
  sessionId: string;
  // 运行面没装起来时为 null
  runId: string | null;
  // headless 终态；error = 这次运行没有产出可用结果（环境准备、装配、模型服务或判据设施出错），不是任务的成败
  // refused = 内容审核类拒答：独立状态，不判分、不补跑（占续跑键）、不计入成败统计
  status: HeadlessStatus | "error" | "refused";
  verdict: EvalVerdict;
  falsePositive: boolean;
  turns: number;
  toolCalls: number;
  approvalsNeeded: number;
  usage: TurnUsage;
  // agent 运行耗时（不含快照准备与验证）
  durationMs: number;
  // 失败四分类：null = 正常收尾；cancelled:breaker = 治理熔断
  failureClass: string | null;
  // 061 之前的旧行缺省
  harnessRef?: HarnessRef;
  process?: ProcessMetrics;
  // M9（决策 102）：题源自带的难度标记（自造题没有）
  difficulty?: string;
  // M9：空补丁——判决仍为失败，标注用于区分"改了没改对"与"根本没改"；只在为真时在场
  emptyPatch?: true;
  // M9：撞了哪个上限（与终态同值，便于筛选）。有验证结论时验证压过运行终态（072 的推论）：
  // 撞上限但判分通过的计为通过，报告里单列计数；只在撞上限时在场
  limitHit?: "turn-limit" | "wall-clock-limit" | "token-limit";
  // M9：确定性错误——模型请求以重跑必复现的错误收尾（目前只认上下文超长）。不是错误行：照常判分、占续跑键
  // 不补跑，终态仍是 failed；只在出现时在场
  deterministicError?: DeterministicError;
  // M9：连续指标——判据报告的用例通过数（目标用例：这次改动应当修好的；回归用例：原本就过、不应弄坏的）。
  // 判决仍是三值；这里只回答"离通过有多远"。判据没给或形状不对时缺省
  testProgress?: TestProgress;
  // M9：整次运行的墙钟耗时（环境准备、agent 运行、判分与清理）。新写的行必带；此前写下的行缺省，读侧容忍
  wallMs?: number;
  // 决策 142 / 143：回炉开启时在场——用了几轮、这一步里验证门的最终结论（不是判据的判决）、是否撤回、
  // 撤回是否因预算先于轮数用尽而提前、这一步是否收尾、撤回时工作区是否真的恢复（没恢复成时附原因）。
  // 回炉关闭时缺省，行形状与此前一致
  repair?: {
    rounds: number;
    verdict?: EvalVerdict;
    closed: boolean;
    reverted: boolean;
    budgetExhausted: boolean;
    restored: boolean;
    restoreError?: string;
  };
  // 决策 134：接入结构化记忆时在场——开局给了哪几条、每轮回炉给了哪几条（条目编号）；未接入时缺省
  structuredMemory?: {
    opening: string[];
    repair: string[][];
  };
  error?: string;
}

// 每行必有的字段（机检用；runner 新写出的行恒在场——旧文件里的行可能缺 061 的三个字段与 M9 的 wallMs）
export const EVAL_RESULT_FIELDS = [
  "taskId",
  "condition",
  "editMode",
  "attempt",
  "holdout",
  "sessionId",
  "runId",
  "status",
  "verdict",
  "falsePositive",
  "turns",
  "toolCalls",
  "approvalsNeeded",
  "usage",
  "durationMs",
  "failureClass",
  "harnessRef",
  "process",
  // M9：新写的行必带；读侧容忍旧文件缺失（难度随任务源可选，不在此列）
  "wallMs",
] as const satisfies readonly (keyof EvalResultLine)[];

// 续跑键：（任务、条件、编辑模式、第几次）；旧行缺编辑模式按 hashline
export function resultLineKey(
  line: Pick<EvalResultLine, "taskId" | "condition" | "editMode" | "attempt">
): string {
  return `${line.taskId}\n${line.condition}\n${line.editMode ?? LEGACY_RESULT_EDIT_MODE}\n${line.attempt}`;
}

// 错误行：这次运行没能产出结果（准备环境、装配或跑批设施自身出错），不是模型的成败。
// 撞上限、模型侧失败等 headless 终态不在此列——它们是这次运行的真实结果
export function isErrorResultLine(line: Pick<EvalResultLine, "status">): boolean {
  return line.status === "error";
}

// 已完成的键：只有非错误行占键。错误行留在文件里不删不改，但重跑同一输出目录时它的键会被补跑
export function completedResultKeys(lines: readonly EvalResultLine[]): Set<string> {
  return new Set(lines.filter((line) => !isErrorResultLine(line)).map(resultLineKey));
}

// 读侧口径：同一个键取最后一条非错误行（其后再出现的错误行不盖掉它）；只有错误行的键取最后一条错误行，
// 使未完成的键仍在报告里可见。顺序按键首次出现
export function effectiveResultLines(lines: readonly EvalResultLine[]): EvalResultLine[] {
  const chosen = new Map<string, EvalResultLine>();
  for (const line of lines) {
    const key = resultLineKey(line);
    const current = chosen.get(key);
    if (current === undefined || !isErrorResultLine(line) || isErrorResultLine(current)) {
      chosen.set(key, line);
    }
  }
  return [...chosen.values()];
}

// 读 results.jsonl；末行半截（进程死于写到一半）按未写入容忍，其余坏行响亮失败；旧行编辑模式按 hashline 补齐
export function readResultLines(file: string): EvalResultLine[] {
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8").split("\n");
  const lines: EvalResultLine[] = [];
  for (const [index, text] of raw.entries()) {
    if (text.trim() === "") {
      continue;
    }
    let parsed: EvalResultLine;
    try {
      parsed = JSON.parse(text) as EvalResultLine;
    } catch (error) {
      if (index === raw.length - 1) {
        break;
      }
      throw new Error(
        `results.jsonl 第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
      );
    }
    // 旧行没有 editMode：那些运行确实是 hashline 跑的，按 hashline 补齐，不跟随缺省编辑模式（决策 062）
    lines.push(
      parsed.editMode === undefined ? { ...parsed, editMode: LEGACY_RESULT_EDIT_MODE } : parsed
    );
  }
  return lines;
}
