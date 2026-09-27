// Session 摘要投影（M4 S5，D5：派生不落库——每个字段都可从 Event Log 重算；默认安静：
// 创建时间 + Run 数；唯一突出项 = 待对账）。纯函数：输入是冷物化结果，输出摘要；
// 列目录与逐文件物化在 persistence/session-list.ts。创建时间取自 SessionId 内嵌 ULID
// 的 48 位毫秒分量（与首条记录时间戳同刻，且对「启动即建文件、崩溃于首事件前」的
// 空会话仍有定义）。
import type { SessionId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";

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
  // M5 S5（决策 044）：本会话 turn.completed usage 的合计（M5 前的记录无 usage，计 0）
  totalTokens: number;
  totalCost: number;
  // M5.5 S4（决策 040）：本会话是 worker 时在场（会话头派生）
  worker?: { name: string; role: string; parentSessionId: SessionId };
  // M5.5 S4：本会话派出过 worker 时在场；unsettled = 有 child.spawned 无 child.settled
  children?: { count: number; unsettled: number };
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

// 单会话摘要：按文件序去重 Run / 工具名 / 失败分类，待对账 = 未确证悬账数
export function summarizeSession(materialized: MaterializedSession): SessionSummary {
  const sessionId = materialized.sessionId;
  const createdAt = sessionCreatedAt(sessionId);
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
    } else if (record.kind === "tool.proposed") {
      // 决策 1（M4 S6 G）：读层调用只留事件级记录——toolNames 兼从 tool.proposed
      // 派生，纯读会话同样可被 --tool 过滤找到（治理行不是工具使用的唯一证据）
      const name = record.payload.toolName;
      if (!toolNameSeen.has(name)) {
        toolNameSeen.add(name);
        toolNames.push(name);
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
  let totalTokens = 0;
  let totalCost = 0;
  for (const event of materialized.runtimeEvents) {
    if (event.kind === "turn.completed" && event.payload.usage !== undefined) {
      totalTokens += event.payload.usage.totalTokens;
      totalCost += event.payload.usage.cost.total;
    }
  }
  const summary: SessionSummary = {
    sessionId,
    createdAt,
    runCount: runIds.size,
    toolNames,
    failureClasses,
    pendingReconcile: materialized.reconcile.unknown.length,
    totalTokens,
    totalCost,
    ...(materialized.sessionHeader !== undefined
      ? {
          worker: {
            name: materialized.sessionHeader.worker.name,
            role: materialized.sessionHeader.worker.role,
            parentSessionId: materialized.sessionHeader.parentSessionId,
          },
        }
      : {}),
    ...(materialized.children.length > 0
      ? {
          children: {
            count: materialized.children.length,
            unsettled: materialized.children.filter((child) => child.settled === undefined).length,
          },
        }
      : {}),
  };
  return summary;
}

// 最小过滤器求值（多条件叠加为与）；since/until 也可在读文件前按 ULID 时间分量预筛
export function matchesSessionFilters(
  summary: Pick<SessionSummary, "createdAt" | "toolNames" | "failureClasses">,
  filters: SessionListFilters
): boolean {
  if (filters.since !== undefined && summary.createdAt < filters.since) {
    return false;
  }
  if (filters.until !== undefined && summary.createdAt > filters.until) {
    return false;
  }
  if (filters.tool !== undefined && !summary.toolNames.includes(filters.tool)) {
    return false;
  }
  if (filters.class !== undefined && !summary.failureClasses.includes(filters.class)) {
    return false;
  }
  return true;
}
