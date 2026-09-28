// Session Search 内容级检索（M5 S2，决策 038）：给 agent 一个能翻本项目旧会话的 grep。
// 全文扫描：按会话从新到旧，经只读读取器逐个读新会话存储的会话文件（决策 181 / 185），搜消息条目；关键词大小写不敏感
// 子串匹配、多词为与、不接受正则（模型给正则是 ReDoS 面，元字符一律按字面）；对外只暴露命中流
// 接口，将来换成索引或语义检索时换实现不换调用方（查询是结构化对象、命中预留 score）。
// 命中只是线索（§3.3）：结论须经 read_session_entry 回查原文。
// 分支会话文件开头从来源复制来的历史不重复产出命中（它属于来源会话）。跑批器作废重做时把作废尝试的会话文件移出会话根，
// 检索自然看不到它们。
// 无状态、无索引、无后台：扫描结果不落盘（015 派生不落库）。
import {
  listSessionRefs,
  readSessionView,
  sessionRefTime,
} from "../persistence/session-catalog.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { matchesSessionFilters, type SessionListFilters } from "../state/session-summary.ts";
import { summarizeSessionView, type ViewBlock } from "../state/session-view.ts";

// 消息角色：pi 消息的三种与上游扩展消息的四种，另有 system（不对应会话里的消息，检索从不产出）
export type SessionMessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "system"
  | "custom"
  | "bashExecution"
  | "branchSummary"
  | "compactionSummary";

// 片段窗口（字符）：命中关键词附近约 200 字
export const DEFAULT_SNIPPET_CHARS = 200;

export interface SessionSearchQuery {
  // 多词为与；大小写不敏感；按字面子串匹配
  keywords: readonly string[];
  // 角色过滤；缺省 = 除 system 以外全部角色（system prompt 每会话重复一份，搜它只是噪声）
  roles?: readonly SessionMessageRole[];
  // 复用会话列表的工具 / 分类 / 时间过滤（M4 SessionListFilters）
  filters?: SessionListFilters;
}

export interface SessionSearchOptions {
  // 命中数上限：达到即停止扫描（上限即停，不读后续文件）
  limit?: number;
  snippetChars?: number;
}

export interface SessionSearchHit {
  sessionId: SessionId;
  // 新存储里的条目号
  entryId: string;
  runId: RunId;
  runSeq: number;
  role: SessionMessageRole;
  // 条目写入时刻
  timestamp: number;
  snippet: string;
  toolName?: string;
  // 语义检索（M10）的相关度预留；全文扫描不给
  score?: number;
}

export interface SessionSearch {
  search(
    query: SessionSearchQuery,
    options?: SessionSearchOptions
  ): AsyncIterable<SessionSearchHit>;
}

const DEFAULT_ROLES: readonly SessionMessageRole[] = [
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
];

// 关键词规范化：去首尾空白、转小写、丢空词；一个都不剩响亮拒绝（空查询不是"全部"）
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const normalized = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
  if (normalized.length === 0) {
    throw new Error("Session Search 至少需要一个关键词");
  }
  return normalized;
}

// 字面子串匹配（多词为与）：includes 不解释任何元字符
export function matchesAllKeywords(
  haystackLower: string,
  keywordsLower: readonly string[]
): boolean {
  return keywordsLower.every((keyword) => haystackLower.includes(keyword));
}

// 可检索文本：text 与 thinking 正文、工具调用名；图片与未知块不可检索
export function searchableText(blocks: readonly ViewBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "thinking") {
      parts.push(block.thinking);
    } else if (block.type === "toolCall") {
      parts.push(block.name);
    }
  }
  return parts.join("\n");
}

// 命中片段：空白压成单空格；以最早出现的关键词为锚取窗口，两端被裁时加省略号
export function buildSnippet(
  text: string,
  keywordsLower: readonly string[],
  chars: number = DEFAULT_SNIPPET_CHARS
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) {
    return flat;
  }
  const lower = flat.toLowerCase();
  let anchor = -1;
  for (const keyword of keywordsLower) {
    const index = lower.indexOf(keyword);
    if (index >= 0 && (anchor < 0 || index < anchor)) {
      anchor = index;
    }
  }
  const end = Math.min(flat.length, Math.max(0, anchor) - Math.floor(chars / 3) + chars);
  const start = Math.max(0, end - chars);
  const clippedEnd = Math.min(flat.length, start + chars);
  return `${start > 0 ? "…" : ""}${flat.slice(start, clippedEnd)}${clippedEnd < flat.length ? "…" : ""}`;
}

export function createSessionSearch(sessionsDir: string): SessionSearch {
  return {
    search: (query, options = {}) => scanSessions(sessionsDir, query, options),
  };
}

async function* scanSessions(
  sessionsDir: string,
  query: SessionSearchQuery,
  options: SessionSearchOptions
): AsyncGenerator<SessionSearchHit> {
  const keywords = normalizeKeywords(query.keywords);
  const roles = new Set<string>(query.roles ?? DEFAULT_ROLES);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const filters = query.filters ?? {};
  if (limit <= 0) {
    return;
  }
  let emitted = 0;
  // 从新到旧（会话创建时间序）
  for (const ref of listSessionRefs(sessionsDir).reverse()) {
    const createdAt = sessionRefTime(ref);
    if (filters.since !== undefined && createdAt < filters.since) {
      continue;
    }
    if (filters.until !== undefined && createdAt > filters.until) {
      continue;
    }
    const view = readSessionView(ref);
    if (view === undefined) {
      continue;
    }
    if (
      (filters.tool !== undefined || filters.class !== undefined) &&
      !matchesSessionFilters(summarizeSessionView(view), filters)
    ) {
      continue;
    }
    for (const message of view.messages) {
      if (!roles.has(message.role)) {
        continue;
      }
      const text = searchableText(message.blocks);
      if (!matchesAllKeywords(text.toLowerCase(), keywords)) {
        continue;
      }
      yield {
        sessionId: view.sessionId,
        entryId: message.entryId,
        runId: message.runId,
        runSeq: message.runSeq,
        role: message.role as SessionMessageRole,
        timestamp: message.timestamp,
        snippet: buildSnippet(text, keywords, snippetChars),
        ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      };
      emitted += 1;
      if (emitted >= limit) {
        return;
      }
    }
  }
}
