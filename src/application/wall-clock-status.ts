// 决策 418：墙钟预算对模型可见。只在设了墙钟预算的运行里（pigeon run --wall-clock）；未设预算时以下都不出现。
// - 开工状态块多一节「时间预算」：总预算、已用与剩余（不到两分钟按秒，否则按整分钟，都向下取整）。
// - 追加规则：这一节以"预算起点与总量 + 档位"为比对键（status-block.ts 的 StatusKeys），分钟数变了本身不追加；
//   剩余时间每跌破总预算的 80%、60%、40%、20% 一档，键变了，追加一次这一节；别的节有变化要追加时（git 状态等），
//   这一节随之带上当前的已用与剩余；压缩之后重发的完整块同样是当前值。
// - 剩余低于总预算的 20% 时另有一节「时间提醒」：正文固定，第一次出现时追加一次，之后不再重复（压缩之后的完整块照常在内）。
// - run_command 的超时超过剩余时间时按剩余时间缩短（余量见 tools/run-command.ts 的 COMMAND_BUDGET_MARGIN_MS），这一节写明。
import { COMMAND_BUDGET_MARGIN_MS } from "../tools/run-command.ts";
import type { StatusKeys, StatusSectionName } from "./status-block.ts";

export interface WallClockBudget {
  // 总预算（毫秒）
  totalMs: number;
  // 起算时刻（与 now 同一时钟）
  startedAt: number;
  // 时钟（测试注入）
  now: () => number;
}

// 档位：剩余时间占总预算的比例跌破这些值时各追加一次；最后一档即提醒的阈值
export const BUDGET_TIERS = [0.8, 0.6, 0.4, 0.2] as const;
export const BUDGET_REMINDER_FRACTION = 0.2;

export const BUDGET_REMINDER_TEXT =
  "剩余时间已不到总预算的 20%：优先拿出可交付的结果（让已有的改动处于可用状态、把结论写清楚），不要再启动耗时长的任务。";

export function budgetRemainingMs(budget: WallClockBudget, now = budget.now()): number {
  return Math.max(0, budget.startedAt + budget.totalMs - now);
}

function spanText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 120 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
}

// 状态块里与预算有关的几节及其比对键（同一时刻取一次时钟）
export function budgetStatus(
  budget: WallClockBudget,
  options: { runCommand: boolean }
): { sections: Array<[StatusSectionName, string]>; keys: StatusKeys } {
  const now = budget.now();
  const remaining = budgetRemainingMs(budget, now);
  const elapsed = Math.min(budget.totalMs, Math.max(0, now - budget.startedAt));
  const tier = BUDGET_TIERS.filter((fraction) => remaining < budget.totalMs * fraction).length;
  const text = [
    `本次运行的墙钟预算共 ${spanText(budget.totalMs)}，到点即中止。截至这条状态已用约 ${spanText(elapsed)}，剩余约 ${spanText(remaining)}。`,
    "剩余时间每少总预算的五分之一、或别的状态有变化时，会追加这一节的最新值。",
    ...(options.runCommand
      ? [
          `run_command 的超时超过剩余时间时按剩余时间缩短（留出 ${COMMAND_BUDGET_MARGIN_MS / 1000} 秒收尾），结果里会注明。`,
        ]
      : []),
  ].join("\n");
  const reminder = remaining < budget.totalMs * BUDGET_REMINDER_FRACTION;
  return {
    sections: [
      ["时间预算", text],
      ...(reminder ? [["时间提醒", BUDGET_REMINDER_TEXT] as [StatusSectionName, string]] : []),
    ],
    keys: new Map([["时间预算", `${budget.startedAt}+${budget.totalMs}#${tier}`]]),
  };
}
