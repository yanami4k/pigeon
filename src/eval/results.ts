// Eval 结果行（M6.5 S4，决策 060）：results.jsonl 每次运行一行，是 M9 统计的原始数据，入库。
// 字段：任务 id、条件、第几次、是否 holdout、sessionId、runId、终态、三值判决、是否误报、轮次、工具调用数、
// 需审批次数、usage、耗时、失败分类；运行本身出错时另带 error。报告只由这些行决定，可复算。
import { existsSync, readFileSync } from "node:fs";
import type { HeadlessStatus } from "../application/headless.ts";
import type { EvalVerdict, TurnUsage } from "../state/runtime-events.ts";
import type { EvalCondition } from "./task.ts";

export interface EvalResultLine {
  taskId: string;
  condition: EvalCondition;
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
  error?: string;
}

// 每行必有的字段（机检用）
export const EVAL_RESULT_FIELDS = [
  "taskId",
  "condition",
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
] as const satisfies readonly (keyof EvalResultLine)[];

// 读 results.jsonl；末行半截（进程死于写到一半）按未写入容忍，其余坏行响亮失败
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
    try {
      lines.push(JSON.parse(text) as EvalResultLine);
    } catch (error) {
      if (index === raw.length - 1) {
        break;
      }
      throw new Error(
        `results.jsonl 第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return lines;
}
