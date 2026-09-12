// Session 列表（M4 S5，D1/D5）：列目录（ULID 字典序即时间序）+ since/until 按 ULID 时间
// 分量预筛（不读文件）+ 逐文件物化求摘要 + tool/class 过滤。正确性优先于速度（D1：跨
// session 搜索扫多文件的代价由最小过滤器定位消化）。摘要与过滤判据在 state/session-summary.ts。
import {
  matchesSessionFilters,
  type SessionListFilters,
  type SessionSummary,
  sessionCreatedAt,
  summarizeSession,
} from "../state/session-summary.ts";
import { listSessionIds, materializeSession } from "./event-log.ts";

export function listSessionSummaries(
  dir: string,
  filters: SessionListFilters = {}
): SessionSummary[] {
  const summaries: SessionSummary[] = [];
  for (const sessionId of listSessionIds(dir)) {
    const createdAt = sessionCreatedAt(sessionId);
    if (filters.since !== undefined && createdAt < filters.since) {
      continue;
    }
    if (filters.until !== undefined && createdAt > filters.until) {
      continue;
    }
    const summary = summarizeSession(materializeSession(dir, sessionId));
    if (matchesSessionFilters(summary, filters)) {
      summaries.push(summary);
    }
  }
  return summaries;
}
