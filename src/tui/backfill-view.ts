// 后台补做复盘的显示（决策 283、284、286）：进度只进状态栏（第几个、共几个、花了多少）；消息区只留失败与"全部补完"各一行，
// 一个都不用补时什么也不说。补的是别的会话，花费不并入当前会话。
import type { BackfillProgress, ReviewBackfillSummary } from "../application/review-backfill.ts";
import { type BackfillStatus, formatCost } from "./status-bar.ts";

// 状态栏上的补做段：正在补某一个时显示，否则不显示
export function backfillStatusOf(progress: BackfillProgress): BackfillStatus | undefined {
  return progress.current !== undefined ? progress : undefined;
}

// 补做结束时消息区的一行；没有要说的返回 undefined
export function backfillSummaryLine(
  summary: ReviewBackfillSummary,
  last: BackfillProgress | undefined
): string | undefined {
  if (summary.failed.length > 0) {
    return `后台补做复盘：${summary.failed.length} 个失败，留待下次启动重试（首个原因：${summary.failed[0]?.error ?? "未知"}）`;
  }
  if (summary.planned > 0 && summary.completed.length === summary.planned) {
    const cost = last !== undefined ? formatCost(last.cost, false) : "$0";
    return `后台补做复盘：全部补完（${summary.planned} 个，花费 ${cost}）`;
  }
  return undefined;
}
