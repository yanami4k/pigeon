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

// 决策 428：给模型看的说法为英文
export const BUDGET_REMINDER_TEXT =
  "Less than 20% of the total time budget is left: prioritize a deliverable result (leave your changes in a usable state and state your conclusions clearly), and do not start long-running tasks.";

export function budgetRemainingMs(budget: WallClockBudget, now = budget.now()): number {
  return Math.max(0, budget.startedAt + budget.totalMs - now);
}

function spanText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 120 ? `${seconds} seconds` : `${Math.floor(seconds / 60)} minutes`;
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
    `This run has a wall-clock budget of ${spanText(budget.totalMs)} and is stopped when it runs out. As of this status, about ${spanText(elapsed)} has been used and about ${spanText(remaining)} is left.`,
    "The latest values of this section are appended each time the remaining time drops by another fifth of the total budget, or when other status changes.",
    ...(options.runCommand
      ? [
          `A run_command timeout longer than the remaining time is shortened to the remaining time (keeping ${COMMAND_BUDGET_MARGIN_MS / 1000} seconds for wrapping up), and the result says so.`,
        ]
      : []),
  ].join("\n");
  const reminder = remaining < budget.totalMs * BUDGET_REMINDER_FRACTION;
  return {
    sections: [
      ["Time budget", text],
      ...(reminder ? [["Time reminder", BUDGET_REMINDER_TEXT] as [StatusSectionName, string]] : []),
    ],
    keys: new Map([["Time budget", `${budget.startedAt}+${budget.totalMs}#${tier}`]]),
  };
}
