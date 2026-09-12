// Session 列表投影（M4 S5，D5：派生不落库——每次从 Event Log 现算，不写任何文件；
// 默认安静：创建时间 + Run 数；唯一突出项 = 待对账）。列表 = 列目录（D1：ULID 字典序
// 即时间序）+ 逐文件流式物化求值；过滤器最小集（tool / class / since / until）在
// 投影上求值，正确性优先于速度（D1：跨 session 搜索扫多文件的代价由最小过滤器定位消化）。
// 创建时间取自 SessionId 内嵌 ULID 的 48 位毫秒分量（与首条记录时间戳同刻，且对
// 「启动即建文件、崩溃于首事件前」的空会话仍有定义）。

import type { SessionId } from "../state/ids.ts";
import { listSessionIds, materializeSession } from "./event-log.ts";

// 失败四分类的类别名（D7 判据表；「治理熔断」是取消的子类，不另立类别）
export type SessionSummaryFailureClass = "cancelled" | "business" | "infrastructure" | "unknown";

// 会话摘要：一次物化的派生视图（D5：无第二套事实，全部字段可从 Event Log 重算）
export interface SessionSummary {
  sessionId: SessionId;
  // Unix 毫秒（ULID 时间分量解码）
  createdAt: number;
  // 出现过的 runId 去重计数（空会话 = 0）
  runCount: number;
  // 本会话用过的工具名（intent/decision 记录按文件序去重）
  toolNames: string[];
  // 本会话出现过的失败分类（Run 级 + ToolExecution 级，按出现序去重；正常收尾不入列）
  failureClasses: SessionSummaryFailureClass[];
  // 待对账数 = 未确证的 OutcomeUnknown 悬账（intent 无 receipt 且无 resolution）
  pendingReconcile: number;
}

// 最小过滤器（CLI --tool / --class / --since / --until 的投影层形状；多条件叠加为与）
export interface SessionListFilters {
  tool?: string;
  class?: SessionSummaryFailureClass;
  // 创建时间闭区间（Unix 毫秒）
  since?: number;
  until?: number;
}

// Crockford Base32 字母表（与 ids.ts 同表；解码 ULID 时间分量用）
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// 解码 SessionId 内嵌 ULID 的 48 位毫秒时间（前 10 字符，大端序）——与 ids.ts 编码互逆
export function sessionCreatedAt(sessionId: SessionId): number {
  const ulid = sessionId.slice("sess_".length, "sess_".length + 10);
  let time = 0;
  for (const ch of ulid) {
    time = time * 32 + CROCKFORD.indexOf(ch);
  }
  return time;
}

// 逐会话投影：列目录（时间序）→ since/until 先按 ULID 时间分量预筛（不读文件）→
// 物化单文件求摘要 → tool/class 过滤。空文件是合法会话（启动即建文件，崩溃于首事件前）。
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
    const materialized = materializeSession(dir, sessionId);
    const runIds = new Set<string>();
    const toolNames: string[] = [];
    const toolNameSeen = new Set<string>();
    for (const record of materialized.records) {
      // grant 族 runId 可选（REPL 时段事件无活动 Run）：有 runId 才计入 Run 集合
      if (record.runId !== undefined) {
        runIds.add(record.runId);
      }
      if (record.kind === "intent" || record.kind === "decision") {
        if (!toolNameSeen.has(record.toolName)) {
          toolNameSeen.add(record.toolName);
          toolNames.push(record.toolName);
        }
      }
    }
    const failureClasses: SessionSummaryFailureClass[] = [];
    const failureSeen = new Set<string>();
    for (const classification of materialized.classification.runs) {
      if (classification.failure !== null) {
        const category = classification.failure.category;
        if (!failureSeen.has(category)) {
          failureSeen.add(category);
          failureClasses.push(category);
        }
      }
    }
    for (const classification of materialized.classification.toolExecutions) {
      if (classification.failure !== null) {
        const category = classification.failure.category;
        if (!failureSeen.has(category)) {
          failureSeen.add(category);
          failureClasses.push(category);
        }
      }
    }
    const summary: SessionSummary = {
      sessionId,
      createdAt,
      runCount: runIds.size,
      toolNames,
      failureClasses,
      pendingReconcile: materialized.reconcile.unknown.length,
    };
    if (filters.tool !== undefined && !toolNames.includes(filters.tool)) {
      continue;
    }
    if (filters.class !== undefined && !failureClasses.includes(filters.class)) {
      continue;
    }
    summaries.push(summary);
  }
  return summaries;
}
