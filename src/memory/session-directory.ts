// 会话目录（决策 339 ⑤）：列出本项目以前的会话，供 agent 先浏览再细查。每个会话给出会话号、开始时间、第一句使用者的话
// 与改动过的文件（抽取口径见 state/session-search-text.ts），可按开始时间范围与文件路径（子串，前缀亦然）筛选，从新到旧，
// 有条数上限并报出是否截断。排除当前会话；目录信息与检索共用同一份缓存（persistence/session-search-cache.ts）。
import {
  createSessionSearchSource,
  type SessionSearchCacheOptions,
} from "../persistence/session-search-cache.ts";
import type { SessionCatalogInfo } from "../state/session-search-text.ts";
import { candidateRefs } from "./session-search.ts";

export interface SessionDirectoryQuery {
  excludeSessionId?: string;
  // 会话开始时间范围（毫秒，含两端）
  since?: number;
  until?: number;
  // 改动过的文件路径里含这一段（大小写敏感的字面子串）
  path?: string;
}

export interface SessionDirectoryResult {
  // 从新到旧的前 limit 个
  sessions: SessionCatalogInfo[];
  // 符合条件的会话总数
  total: number;
}

export function listSessionDirectory(
  sessionsDir: string,
  query: SessionDirectoryQuery,
  limit: number,
  cache: SessionSearchCacheOptions = {}
): SessionDirectoryResult {
  const source = createSessionSearchSource(cache);
  const matched: SessionCatalogInfo[] = [];
  const needle = query.path?.replace(/\\/g, "/");
  for (const ref of candidateRefs(sessionsDir, query).reverse()) {
    const entry = source.load(ref, { toolOutput: false });
    if (entry === undefined) {
      continue;
    }
    if (
      needle !== undefined &&
      needle !== "" &&
      !entry.info.changedFiles.some((file) => file.includes(needle))
    ) {
      continue;
    }
    matched.push(entry.info);
  }
  return { sessions: matched.slice(0, Math.max(0, limit)), total: matched.length };
}
