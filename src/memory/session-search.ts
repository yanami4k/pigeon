// Session Search 内容级检索（M5 S2，决策 038；决策 339 改进）：给 agent 一个能翻本项目旧会话的 grep。
// - 范围：本项目会话根下的全部会话，排除当前会话（调用方给出会话号；续接的会话与当前是同一文件，同样排除）。
// - 缺省只搜对话正文（使用者的话与模型回复的文字，不含思考与工具调用）；工具输出须显式打开。会话检索三件工具自身的
//   输出永不进检索（抽取口径见 state/session-search-text.ts）。
// - 关键词大小写不敏感、按字面子串匹配、不接受正则（模型给正则是 ReDoS 面，元字符一律按字面）；任一命中即算，
//   按命中的不同关键词数从多到少排序，同数按消息时间从新到旧；每条命中带它命中了哪些关键词。
// - 每个会话的可搜文本按文件大小与修改时间缓存（persistence/session-search-cache.ts），再次检索只读缓存。
// 命中只是线索（§3.3）：结论须经 read_session_entry 回查原文。
// 分支会话文件开头从来源复制来的历史不重复产出命中（它属于来源会话）。跑批器作废重做时把作废尝试的会话文件移出会话根，
// 检索自然看不到它们。
import { listSessionRefs, sessionRefTime } from "../persistence/session-catalog.ts";
import type { SessionFileRef } from "../persistence/session-reader.ts";
import {
  createSessionSearchSource,
  type SessionSearchCacheOptions,
  type SessionSearchSource,
} from "../persistence/session-search-cache.ts";
import type { RunId, SessionId } from "../state/ids.ts";

// 消息角色：检索只产出这三种
export type SessionMessageRole = "user" | "assistant" | "toolResult";

// 片段窗口（字符）：命中关键词附近约 200 字
export const DEFAULT_SNIPPET_CHARS = 200;

export interface SessionSearchQuery {
  // 任一命中即可；大小写不敏感；按字面子串匹配
  keywords: readonly string[];
  // 打开后连同工具输出一起搜；缺省只搜对话正文
  includeToolOutput?: boolean;
  // 角色过滤（在搜索范围之内再筛）；给了 toolResult 即连同工具输出一起搜
  roles?: readonly SessionMessageRole[];
  // 不搜的会话（当前会话）
  excludeSessionId?: string;
  // 会话创建时间范围（毫秒，含两端）
  since?: number;
  until?: number;
}

export interface SessionSearchOptions {
  // 结果条数上限：排序后取前若干条
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
  // 命中的关键词（按查询里的先后，取查询里的写法）
  matchedKeywords: string[];
  toolName?: string;
  // 语义检索（M10）的相关度预留；全文扫描不给
  score?: number;
}

export interface SessionSearchResult {
  // 排序后的前 limit 条
  hits: SessionSearchHit[];
  // 命中总条数（不受 limit 限制）
  total: number;
}

export interface SessionSearch {
  search(query: SessionSearchQuery, options?: SessionSearchOptions): Promise<SessionSearchResult>;
}

export interface NormalizedKeyword {
  // 查询里的写法（去首尾空白）
  original: string;
  lower: string;
}

// 关键词规范化：去首尾空白、丢空词、按小写去重；一个都不剩响亮拒绝（空查询不是"全部"）
export function normalizeKeywords(keywords: readonly string[]): NormalizedKeyword[] {
  const normalized: NormalizedKeyword[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const original = keyword.trim();
    const lower = original.toLowerCase();
    if (lower.length > 0 && !seen.has(lower)) {
      seen.add(lower);
      normalized.push({ original, lower });
    }
  }
  if (normalized.length === 0) {
    throw new Error("Session Search 至少需要一个关键词");
  }
  return normalized;
}

// 字面子串匹配：includes 不解释任何元字符；返回命中的关键词
export function matchedKeywords(
  haystackLower: string,
  keywords: readonly NormalizedKeyword[]
): NormalizedKeyword[] {
  return keywords.filter((keyword) => haystackLower.includes(keyword.lower));
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

// 会话根下要看的会话（从旧到新）：排除给定会话，按创建时间范围预筛（不读文件）
export function candidateRefs(
  sessionsDir: string,
  filter: { excludeSessionId?: string; since?: number; until?: number }
): SessionFileRef[] {
  return listSessionRefs(sessionsDir).filter((ref) => {
    if (filter.excludeSessionId !== undefined && ref.sessionId === filter.excludeSessionId) {
      return false;
    }
    const createdAt = sessionRefTime(ref);
    return (
      (filter.since === undefined || createdAt >= filter.since) &&
      (filter.until === undefined || createdAt <= filter.until)
    );
  });
}

interface Ranked {
  hit: Omit<SessionSearchHit, "snippet">;
  text: string;
  // 会话从旧到新的序号与会话内的先后：同数同时刻时的次序
  order: number;
}

export function createSessionSearch(
  sessionsDir: string,
  cache: SessionSearchCacheOptions = {}
): SessionSearch {
  const source = createSessionSearchSource(cache);
  return {
    search: async (query, options = {}) => runSearch(sessionsDir, source, query, options),
  };
}

function runSearch(
  sessionsDir: string,
  source: SessionSearchSource,
  query: SessionSearchQuery,
  options: SessionSearchOptions
): SessionSearchResult {
  const keywords = normalizeKeywords(query.keywords);
  const roles = query.roles !== undefined ? new Set<string>(query.roles) : undefined;
  const toolOutput = query.includeToolOutput === true || roles?.has("toolResult") === true;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const ranked: Ranked[] = [];
  let order = 0;
  for (const ref of candidateRefs(sessionsDir, query)) {
    const entry = source.load(ref, { toolOutput });
    if (entry === undefined) {
      continue;
    }
    for (const doc of [...entry.conversation, ...(entry.toolOutput ?? [])]) {
      order += 1;
      if (roles !== undefined && !roles.has(doc.role)) {
        continue;
      }
      const matched = matchedKeywords(doc.text.toLowerCase(), keywords);
      if (matched.length === 0) {
        continue;
      }
      ranked.push({
        hit: {
          sessionId: entry.info.sessionId as SessionId,
          entryId: doc.entryId,
          runId: doc.runId as RunId,
          runSeq: doc.runSeq,
          role: doc.role as SessionMessageRole,
          timestamp: doc.timestamp,
          matchedKeywords: matched.map((keyword) => keyword.original),
          ...(doc.toolName !== undefined ? { toolName: doc.toolName } : {}),
        },
        text: doc.text,
        order,
      });
    }
  }
  // 命中的不同关键词数从多到少；同数按消息时间从新到旧；同一时刻按会话与会话内先后从后到前
  ranked.sort(
    (a, b) =>
      b.hit.matchedKeywords.length - a.hit.matchedKeywords.length ||
      b.hit.timestamp - a.hit.timestamp ||
      b.order - a.order
  );
  const hits = ranked.slice(0, Math.max(0, limit)).map(({ hit, text }) => ({
    ...hit,
    snippet: buildSnippet(
      text,
      keywords.filter((k) => hit.matchedKeywords.includes(k.original)).map((k) => k.lower),
      snippetChars
    ),
  }));
  return { hits, total: ranked.length };
}
