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
  // headless 终态；准备快照或装配出错为 error
  status: HeadlessStatus | "error";
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
  error?: string;
}

// 每行必有的字段（机检用；runner 写出的行三个 061 字段恒在场）
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
] as const satisfies readonly (keyof EvalResultLine)[];

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
