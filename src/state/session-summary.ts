// Session 摘要的形状与过滤判据（M4 S5，D5：派生不落库——每个字段都可从会话重算；默认安静：创建时间 + Run 数）。
// 摘要由 state/session-view.ts 从会话存储投影，列目录在 persistence/session-list.ts。创建时间取自 SessionId 内嵌 ULID
// 的 48 位毫秒分量（对「启动即建文件、崩溃于首条记录前」的空会话仍有定义）。
import type { SessionId } from "./ids.ts";

// 失败四分类的类别名（D7 判据表；「治理熔断」是取消的子类，不另立类别）
export type SessionSummaryFailureClass = "cancelled" | "business" | "infrastructure" | "unknown";

// 会话摘要（D5：无第二套事实，全部字段可从会话重算）
export interface SessionSummary {
  sessionId: SessionId;
  // Unix 毫秒（ULID 时间分量解码）
  createdAt: number;
  // 出现过的 runId 去重计数（空会话 = 0）
  runCount: number;
  // 本会话用过的工具名（按出现序去重）
  toolNames: string[];
  // 本会话出现过的失败分类（Run 级 + 工具级，按出现序去重；正常收尾不入列）
  failureClasses: SessionSummaryFailureClass[];
  // 本会话助手消息 usage 的合计
  totalTokens: number;
  totalCost: number;
  // M5.5 S4（决策 040）：本会话是 worker 时在场（会话头派生）
  worker?: { name: string; role: string; parentSessionId: SessionId };
  // M5.5 S4：本会话派出过 worker 时在场；unsettled = 有派出无收尾
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
