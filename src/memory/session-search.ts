// Session Search 内容级检索（M5 S2，决策 038；决策 339、384 改进）：给 agent 一个能翻本项目旧会话的检索。
// - 范围：本项目会话根下的全部会话，排除当前会话所在的整棵会话树（沿文件头的父会话上溯到根，根与它的各级 worker、分叉都排除；
//   续接的会话与当前是同一文件，同样排除）。
// - 打分（决策 384 ②）：BM25（k1=1.2、b=0.15，写作代码常量；b 的依据见常量处注释），同分按消息时间从新到旧。
//   切分查询与正文同一套（state/session-search-tokens.ts）：英文小写；代码名整体保留并拆段；中文重叠二元组，
//   单字中文查询退回子串匹配；多词关键词拆词分别计分，原样整段出现另加分（整段当作一个额外的词进 BM25）。
// - 工具输出（决策 384）：缺省在检索范围内，命中在工具输出上的片段带来历（工具名、关键参数、退出码或出错、时间，
//   取自会话记录）并标"以前的工具输出，可能已过时"；只搜对话正文以 conversationOnly 显式打开。
//   计分做法是内部参数 toolOutputMode：同等计分（equal）、工具输出打折（discount，系数 TOOL_OUTPUT_DISCOUNT）、
//   只在正文零命中时回退去搜（fallback）；缺省值 DEFAULT_TOOL_OUTPUT_MODE 由离线重放选定（审计记录）。
//   检索三件自身的输出永不进检索（抽取口径见 state/session-search-text.ts）。
// - 结果按会话归并（决策 384）：每个会话一条，带命中条目数与一两段片段及其条目编号；会话先后按聚合分
//   （各命中分数以几何折扣求和），片段约 400 字，挑覆盖命中词最多的窗口，必要时拼两段；不用 LLM 摘要。
// - 每个会话的可搜文本、词频表与目录信息按文件大小与修改时间缓存（persistence/session-search-cache.ts），再次检索只读缓存。
// 命中只是线索（§3.3）：结论须经 read_session_entry 回查原文。
// 分支会话文件开头从来源复制来的历史不重复产出命中（它属于来源会话）。跑批器作废重做时把作废尝试的会话文件移出会话根，
// 检索自然看不到它们。
import { listSessionRefs, sessionRefTime } from "../persistence/session-catalog.ts";
import { listSessionFiles, readSessionHeader } from "../persistence/session-reader.ts";
import {
  createSessionSearchSource,
  pruneSessionSearchCache,
  type SessionSearchCacheOptions,
  type SessionSearchEntry,
  type SessionSearchSource,
} from "../persistence/session-search-cache.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { SearchDoc } from "../state/session-search-text.ts";
import { tokenizeSearchText } from "../state/session-search-tokens.ts";

// 消息角色：检索只产出这三种
export type SessionMessageRole = "user" | "assistant" | "toolResult";

// 片段窗口（字符）：覆盖命中词最多的一段约 400 字，必要时拼两段
export const DEFAULT_SNIPPET_CHARS = 400;

// BM25 参数（决策 384 ②：k1 取常见缺省 1.2）。b 偏离常见缺省 0.75 取 0.15：长度归一过强会把
// 只提到一两次的长文档（题面、长工具输出）压到短文档之后，离线重放里会话级前 5／前 20 明显更差
//（b=0.75 时 73.9%／90.4%，b=0.3 时 76.6%／92.6%，b=0.15 时 79.3%／94.1%；依据见当次施工审计）
export const BM25_K1 = 1.2;
export const BM25_B = 0.15;

// 工具输出的计分做法（决策 384）：同等计分、打折、只在正文零命中时回退去搜
export type ToolOutputMode = "equal" | "discount" | "fallback";
// 打折做法的系数（决策 384 给的例子值）
export const TOOL_OUTPUT_DISCOUNT = 0.5;
// 缺省做法：三种都实现成内部参数，缺省由离线重放的结果选定（决策 384；重放结果见当次施工审计）
export const DEFAULT_TOOL_OUTPUT_MODE: ToolOutputMode = "equal";

// 检索行为版本（决策 384）：进跑批身份头，检索行为一变即升，旧身份头缺这一项即判为不同条件
export const SESSION_SEARCH_VERSION = "v2";

// 归并后缺省列出的会话数与每个会话至多给出的片段条数
export const DEFAULT_SESSION_LIMIT = 5;
export const MAX_SESSION_LIMIT = 10;
export const GROUP_SNIPPET_HITS = 2;
// 全局条目级排序保留的条数（/search 与离线重放用；归并分组不受此限）
export const RANKED_HITS_CAP = 50;

export interface SessionSearchQuery {
  // 任一关键词命中即可；大小写不敏感；多词关键词拆词计分、整段出现另加分
  keywords: readonly string[];
  // 打开后只搜对话正文；缺省工具输出也在范围内（计分做法见 toolOutputMode）
  conversationOnly?: boolean;
  // 工具输出的计分做法（内部参数；缺省 DEFAULT_TOOL_OUTPUT_MODE）
  toolOutputMode?: ToolOutputMode;
  // 角色过滤（在搜索范围之内再筛）；给了 toolResult 即连同工具输出一起搜
  roles?: readonly SessionMessageRole[];
  // 当前会话：它所在的整棵会话树都不搜
  current?: CurrentSession;
  // 会话创建时间范围（毫秒，含两端）
  since?: number;
  until?: number;
}

export interface SessionSearchOptions {
  // 归并后列出的会话数上限（缺省 DEFAULT_SESSION_LIMIT）
  sessionLimit?: number;
  // 全局条目级排序保留的条数（缺省 RANKED_HITS_CAP；离线重放测量真实名次时放大）
  rankedLimit?: number;
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
  // BM25 分数（打折做法下工具输出已乘系数）
  score: number;
  // 该条目的文档长（词数；重放分析用）
  docLength: number;
  // 命中的关键词（按查询里的先后，取查询里的写法）
  matchedKeywords: string[];
  // 工具输出的来历（命中在工具输出上且找得到对应调用时给）
  toolName?: string;
  toolParams?: string;
  toolOutcome?: string;
}

// 归并分组里的命中：带片段
export interface SessionSearchGroupHit extends SessionSearchHit {
  snippet: string;
}

// 一个会话的归并结果
export interface SessionSearchGroup {
  sessionId: SessionId;
  createdAt: number;
  // 该会话命中的条目数（不只列出的这几条）
  hitCount: number;
  // 分数最高的至多 GROUP_SNIPPET_HITS 条，各带一段片段
  hits: SessionSearchGroupHit[];
}

export interface SessionSearchResult {
  // 按会话归并后的前 sessionLimit 个会话（以各会话分数最高的命中排先后）
  groups: SessionSearchGroup[];
  // 命中条目总数与该及会话总数（不受上限限制）
  totalHits: number;
  totalSessions: number;
  // 全局条目级排序的前 RANKED_HITS_CAP 条（无片段）
  ranked: SessionSearchHit[];
}

export interface SessionSearch {
  search(query: SessionSearchQuery, options?: SessionSearchOptions): Promise<SessionSearchResult>;
}

export interface NormalizedKeyword {
  // 查询里的写法（去首尾空白）
  original: string;
  lower: string;
  // 基础词（切分产出，去重）
  terms: string[];
  // 单字中文：二元组配不上，退回子串匹配
  singles: string[];
  // 多词关键词的原样整段（小写）：出现另加分
  phrase?: string;
}

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

// 关键词规范化：去首尾空白、丢空词、按小写去重；一个都不剩响亮拒绝（空查询不是"全部"）
export function normalizeKeywords(keywords: readonly string[]): NormalizedKeyword[] {
  const normalized: NormalizedKeyword[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const original = keyword.trim();
    const lower = original.toLowerCase();
    if (lower.length === 0 || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    const singles: string[] = [];
    for (const run of lower.matchAll(CJK_RUN)) {
      if (run[0].length === 1) {
        singles.push(run[0]);
      }
    }
    normalized.push({
      original,
      lower,
      terms: [...tokenizeSearchText(lower).keys()],
      singles,
      ...(lower.split(/\s+/).filter((word) => word !== "").length >= 2 ? { phrase: lower } : {}),
    });
  }
  if (normalized.length === 0) {
    throw new Error("Session Search 至少需要一个关键词");
  }
  if (normalized.every((keyword) => keyword.terms.length === 0 && keyword.singles.length === 0)) {
    throw new Error("Session Search 关键词里没有可检索的词（只含标点等不切词的字符）");
  }
  return normalized;
}

// 子串出现次数（单字中文退回与原样整段加分的 tf）
function countOccurrences(haystackLower: string, needle: string): number {
  let count = 0;
  let index = haystackLower.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystackLower.indexOf(needle, index + needle.length);
  }
  return count;
}

// 一个关键词在一条文档上的命中面（片段选窗口用）：整段（若在）、基础词、单字中文，按长到短
function surfacesOf(keyword: NormalizedKeyword): string[] {
  return [
    ...(keyword.phrase !== undefined ? [keyword.phrase] : []),
    ...keyword.terms,
    ...keyword.singles,
  ]
    .filter((surface, index, all) => all.indexOf(surface) === index)
    .sort((a, b) => b.length - a.length);
}

// 命中片段：空白压成单空格；挑覆盖命中关键词最多的窗口，有未覆盖的命中词时再拼一段，两端被裁加省略号
export function buildSnippet(
  text: string,
  keywords: readonly NormalizedKeyword[],
  chars: number = DEFAULT_SNIPPET_CHARS
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) {
    return flat;
  }
  const lower = flat.toLowerCase();
  // 每个关键词的出现位置（任一命中面）
  const positions = keywords.map((keyword) => {
    const found: number[] = [];
    for (const surface of surfacesOf(keyword)) {
      let index = lower.indexOf(surface);
      while (index >= 0) {
        found.push(index);
        index = lower.indexOf(surface, index + Math.max(1, surface.length));
      }
    }
    return found;
  });
  const windowAt = (
    covered: ReadonlySet<number>,
    length: number
  ): { start: number; hits: number[]; total: number } | undefined => {
    let best: { start: number; hits: number[]; total: number } | undefined;
    const anchors = new Set<number>([0]);
    for (const found of positions) {
      for (const position of found) {
        anchors.add(position);
      }
    }
    const maxStart = Math.max(0, flat.length - length);
    for (const anchor of anchors) {
      const start = Math.min(Math.max(0, anchor - Math.floor(length / 3)), maxStart);
      const hits: number[] = [];
      let total = 0;
      for (let index = 0; index < positions.length; index++) {
        if (covered.has(index)) {
          continue;
        }
        const inWindow = (positions[index] as number[]).filter(
          (position) => position >= start && position < start + length
        );
        if (inWindow.length > 0) {
          hits.push(index);
          total += inWindow.length;
        }
      }
      if (
        hits.length > 0 &&
        (best === undefined ||
          hits.length > best.hits.length ||
          (hits.length === best.hits.length && total > best.total))
      ) {
        best = { start, hits, total };
      }
    }
    return best;
  };
  const slice = (start: number, length: number): string => {
    const end = Math.min(flat.length, start + length);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  };
  const first = windowAt(new Set(), chars);
  if (first === undefined) {
    return slice(0, chars);
  }
  const remaining = new Set(first.hits);
  const uncoveredAll = positions.some((found, index) => found.length > 0 && !remaining.has(index));
  if (!uncoveredAll) {
    return slice(first.start, chars);
  }
  // 一段盖不全：两段各约一半，前段重挑、后段盖剩下的
  const half = Math.floor(chars / 2);
  const head = windowAt(new Set(), half) as { start: number; hits: number[] };
  const tail = windowAt(new Set(head.hits), half);
  if (tail === undefined || tail.start === head.start) {
    return slice(head.start, chars);
  }
  return [head, tail]
    .sort((a, b) => a.start - b.start)
    .map((part) => slice(part.start, half))
    .join(" … ");
}

export interface CurrentSession {
  sessionId: string;
  // 父会话（worker 的派出方、分叉的来源）；不给时读当前会话文件的文件头
  parentSessionId?: string;
}

export interface PastSessionsFilter {
  current?: CurrentSession;
  // 会话创建时间范围（毫秒，含两端）
  since?: number;
  until?: number;
}

// 当前会话所在的整棵会话树：沿父会话上溯一次找到根（父会话没有记录或成环即止），再按子会话表从根广度优先走一遍。
// 两步都带已访问集合：会话头损坏成环时照样终止，环上与环下挂着的会话都算在这一家里
export function sessionFamily(
  current: string,
  parentOf: ReadonlyMap<string, string | undefined>
): Set<string> {
  const climbed = new Set<string>([current]);
  let root = current;
  for (;;) {
    const parent = parentOf.get(root);
    if (parent === undefined || climbed.has(parent)) {
      break;
    }
    climbed.add(parent);
    root = parent;
  }
  const children = new Map<string, string[]>();
  for (const [id, parent] of parentOf) {
    if (parent !== undefined) {
      const list = children.get(parent);
      if (list === undefined) {
        children.set(parent, [id]);
      } else {
        list.push(id);
      }
    }
  }
  const family = new Set<string>([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index] as string) ?? []) {
      if (!family.has(child)) {
        family.add(child);
        queue.push(child);
      }
    }
  }
  // 当前会话不在表里（文件还没写出、也没给父会话）时根就是它自己，上面已收下
  family.add(current);
  return family;
}

// 以前的会话（从旧到新）：时间窗口内的会话读可搜内容（经缓存），窗口外的只读文件头取父会话（判会话树用）；
// 排除当前会话所在的会话树；顺手清理缓存
export function loadPastSessions(
  sessionsDir: string,
  source: SessionSearchSource,
  filter: PastSessionsFilter,
  parts: { toolOutput: boolean },
  cacheDir?: string
): SessionSearchEntry[] {
  const refs = listSessionRefs(sessionsDir);
  const current = filter.current;
  const loaded: SessionSearchEntry[] = [];
  const parentOf = new Map<string, string | undefined>();
  for (const ref of refs) {
    const createdAt = sessionRefTime(ref);
    const inWindow =
      (filter.since === undefined || createdAt >= filter.since) &&
      (filter.until === undefined || createdAt <= filter.until);
    const isCurrent = current !== undefined && ref.sessionId === current.sessionId;
    if (isCurrent || !inWindow) {
      // 当前会话正在写、窗口外的会话不在结果里：不抽取、不缓存，只取文件头里的父会话
      parentOf.set(
        ref.sessionId,
        (isCurrent ? current?.parentSessionId : undefined) ??
          readSessionHeader(ref.path)?.parentSessionId
      );
      continue;
    }
    const entry = source.load(ref, parts);
    if (entry === undefined) {
      continue;
    }
    parentOf.set(entry.info.sessionId, entry.info.parentSessionId);
    loaded.push(entry);
  }
  if (current !== undefined && current.parentSessionId !== undefined) {
    parentOf.set(current.sessionId, current.parentSessionId);
  }
  const family =
    current !== undefined ? sessionFamily(current.sessionId, parentOf) : new Set<string>();
  if (cacheDir !== undefined) {
    pruneSessionSearchCache(
      cacheDir,
      () => new Set(listSessionFiles(sessionsDir).map((file) => file.sessionId))
    );
  }
  return loaded.filter((entry) => !family.has(entry.info.sessionId));
}

interface ScoredDoc {
  doc: SearchDoc;
  sessionId: string;
  createdAt: number;
  // 会话从旧到新的序号与会话内的先后：同分同时刻时的次序
  order: number;
  score: number;
  matched: string[];
}

// 一个范围内的 BM25 统计：文档数、平均文档长、每个词的 df（整段与单字的 df 现查现算，见 scoreDocs）
interface ScopeStats {
  count: number;
  averageLength: number;
  df: Map<string, number>;
}

function scopeStats(docs: readonly SearchDoc[]): ScopeStats {
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const doc of docs) {
    totalLength += doc.length;
    for (const term of Object.keys(doc.tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return { count: docs.length, averageLength: docs.length > 0 ? totalLength / docs.length : 0, df };
}

function bm25(tf: number, df: number, stats: ScopeStats, docLength: number): number {
  const idf = Math.log(1 + (stats.count - df + 0.5) / (df + 0.5));
  const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / (stats.averageLength || 1));
  return (idf * (tf * (BM25_K1 + 1))) / norm;
}

// 给一个范围内的文档打分：返回 score > 0 的命中（matched 为命中的关键词，取查询里的写法）。
// stats 由调用方算好（同一进程里同一语料的统计可以复用，见 createSessionSearch）
function scoreDocs(
  entries: readonly { sessionId: string; createdAt: number; docs: SearchDoc[] }[],
  keywords: readonly NormalizedKeyword[],
  weight: (doc: SearchDoc) => number,
  stats: ScopeStats
): ScoredDoc[] {
  if (stats.count === 0) {
    return [];
  }
  // 整段与单字的 df 与原文小写化：只有这类特殊词在场才碰原文（量少：关键词至多 8 个）
  const needsText = keywords.some(
    (keyword) => keyword.singles.length > 0 || keyword.phrase !== undefined
  );
  const specialDf = new Map<string, number>();
  const specialDfOf = (surface: string): number => {
    let df = specialDf.get(surface);
    if (df === undefined) {
      df = 0;
      for (const entry of entries) {
        for (const doc of entry.docs) {
          if (doc.text.toLowerCase().includes(surface)) {
            df += 1;
          }
        }
      }
      specialDf.set(surface, df);
    }
    return df;
  };
  const hits: ScoredDoc[] = [];
  let order = 0;
  for (const entry of entries) {
    for (const doc of entry.docs) {
      order += 1;
      let score = 0;
      const matched: string[] = [];
      const docLength = doc.length;
      const lower = needsText ? doc.text.toLowerCase() : "";
      for (const keyword of keywords) {
        let keywordScore = 0;
        let hit = false;
        for (const term of keyword.terms) {
          const tf = doc.tokens[term] ?? 0;
          const df = stats.df.get(term) ?? 0;
          if (tf > 0 && df > 0) {
            hit = true;
            keywordScore += bm25(tf, df, stats, docLength);
          }
        }
        for (const single of keyword.singles) {
          const tf = countOccurrences(lower, single);
          if (tf > 0) {
            hit = true;
            keywordScore += bm25(tf, specialDfOf(single), stats, docLength);
          }
        }
        if (keyword.phrase !== undefined) {
          const tf = countOccurrences(lower, keyword.phrase);
          if (tf > 0) {
            keywordScore += bm25(tf, specialDfOf(keyword.phrase), stats, docLength);
          }
        }
        if (hit) {
          matched.push(keyword.original);
          score += keywordScore;
        }
      }
      if (score > 0) {
        hits.push({
          doc,
          sessionId: entry.sessionId,
          createdAt: entry.createdAt,
          order,
          score: score * weight(doc),
          matched,
        });
      }
    }
  }
  return hits;
}

// 排序：BM25 分数从高到低；同分按消息时间从新到旧；同一时刻按会话与会话内先后从后到前
function compareScored(a: ScoredDoc, b: ScoredDoc): number {
  return b.score - a.score || b.doc.timestamp - a.doc.timestamp || b.order - a.order;
}

function toHit(scored: ScoredDoc): SessionSearchHit {
  const { doc } = scored;
  return {
    sessionId: scored.sessionId as SessionId,
    entryId: doc.entryId,
    runId: doc.runId as RunId,
    runSeq: doc.runSeq,
    role: doc.role as SessionMessageRole,
    timestamp: doc.timestamp,
    score: scored.score,
    docLength: scored.doc.length,
    matchedKeywords: scored.matched,
    ...(doc.toolName !== undefined ? { toolName: doc.toolName } : {}),
    ...(doc.toolParams !== undefined ? { toolParams: doc.toolParams } : {}),
    ...(doc.toolOutcome !== undefined ? { toolOutcome: doc.toolOutcome } : {}),
  };
}

// BM25 的范围统计（df 与平均文档长）按语料指纹复用：同一次加载的会话对象集合没变就不重算。
// 指纹 = 各会话对象的身份序号组合（会话内容变了源会给出新对象，指纹随之变；见 persistence/session-search-cache.ts 的备忘录）
interface StatsMemo {
  statsOf(
    loaded: readonly SessionSearchEntry[],
    scope: string,
    docs: (entry: SessionSearchEntry) => SearchDoc[],
    roleFilter: (doc: SearchDoc) => boolean
  ): ScopeStats;
}

export function createSessionSearch(
  sessionsDir: string,
  cache: SessionSearchCacheOptions = {}
): SessionSearch {
  const source = createSessionSearchSource(cache);
  const memo = new Map<string, ScopeStats>();
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 0;
  const statsMemo: StatsMemo = {
    statsOf(loaded, scope, docs, roleFilter) {
      let hash = 0;
      for (const entry of loaded) {
        let id = objectIds.get(entry);
        if (id === undefined) {
          id = ++nextObjectId;
          objectIds.set(entry, id);
        }
        hash = (hash * 33 + id) | 0;
      }
      const key = `${scope}:${loaded.length}:${hash}`;
      const remembered = memo.get(key);
      if (remembered !== undefined) {
        return remembered;
      }
      const stats = scopeStats(loaded.flatMap((entry) => docs(entry).filter(roleFilter)));
      // 只留最近 16 份（一次运行里语料随时间单调变，旧的很少再用）
      if (memo.size >= 16) {
        memo.delete(memo.keys().next().value as string);
      }
      memo.set(key, stats);
      return stats;
    },
  };
  return {
    search: async (query, options = {}) =>
      runSearch(sessionsDir, source, query, options, cache.cacheDir, statsMemo),
  };
}

function runSearch(
  sessionsDir: string,
  source: SessionSearchSource,
  query: SessionSearchQuery,
  options: SessionSearchOptions,
  cacheDir: string | undefined,
  statsMemo: StatsMemo
): SessionSearchResult {
  const keywords = normalizeKeywords(query.keywords);
  const roles = query.roles !== undefined ? new Set<string>(query.roles) : undefined;
  const conversationOnly = query.conversationOnly === true && roles?.has("toolResult") !== true;
  const mode = query.toolOutputMode ?? DEFAULT_TOOL_OUTPUT_MODE;
  const sessionLimit = Math.max(0, options.sessionLimit ?? DEFAULT_SESSION_LIMIT);
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const wantToolOutput = !conversationOnly && mode !== "fallback";
  const roleFilter = (doc: SearchDoc): boolean => roles === undefined || roles.has(doc.role);
  const toEntries = (
    loaded: SessionSearchEntry[],
    pick: (entry: SessionSearchEntry) => SearchDoc[]
  ): { sessionId: string; createdAt: number; docs: SearchDoc[] }[] =>
    loaded.map((entry) => ({
      sessionId: entry.info.sessionId,
      createdAt: entry.info.createdAt,
      docs: pick(entry).filter(roleFilter),
    }));

  const loaded = loadPastSessions(
    sessionsDir,
    source,
    query,
    { toolOutput: wantToolOutput },
    cacheDir
  );
  let scored: ScoredDoc[];
  if (wantToolOutput) {
    // 同等计分或打折：正文与工具输出同一范围一起打分（df 与平均文档长按合并范围算）
    scored = scoreDocs(
      toEntries(loaded, (entry) => [...entry.conversation, ...(entry.toolOutput ?? [])]),
      keywords,
      (doc) => (mode === "discount" && doc.role === "toolResult" ? TOOL_OUTPUT_DISCOUNT : 1),
      statsMemo.statsOf(
        loaded,
        "both",
        (entry) => [...entry.conversation, ...(entry.toolOutput ?? [])],
        roleFilter
      )
    );
  } else {
    scored = scoreDocs(
      toEntries(loaded, (entry) => entry.conversation),
      keywords,
      () => 1,
      statsMemo.statsOf(loaded, "conv", (entry) => entry.conversation, roleFilter)
    );
    if (!conversationOnly && scored.length === 0) {
      // 回退做法：正文零命中时才去搜工具输出（统计口径只按工具输出算）
      const withTools = loadPastSessions(
        sessionsDir,
        source,
        query,
        { toolOutput: true },
        cacheDir
      );
      scored = scoreDocs(
        toEntries(withTools, (entry) => entry.toolOutput ?? []),
        keywords,
        () => 1,
        statsMemo.statsOf(withTools, "tools", (entry) => entry.toolOutput ?? [], roleFilter)
      );
    }
  }
  scored.sort(compareScored);

  // 按会话归并。会话的先后看聚合分：该会话各命中按分数从高到低、以几何折扣（第 1 条全值、第 2 条折半、
  // 第 3 条四分之一…，总和收敛于最高分的两倍）求和——一个会话里多处都谈到的不只凭最高分那条说话，
  // 命中特别多的会话也不能凭条数压过别人（离线重放的依据见当次施工审计）。
  // 同分按该会话最新命中的时刻从新到旧。每个会话留分数最高的至多 GROUP_SNIPPET_HITS 条做片段
  const sessionAgg = new Map<
    string,
    { score: number; count: number; latest: number; createdAt: number }
  >();
  const perSession = new Map<string, number>();
  for (const hit of scored) {
    const rankInSession = perSession.get(hit.sessionId) ?? 0;
    perSession.set(hit.sessionId, rankInSession + 1);
    const agg = sessionAgg.get(hit.sessionId);
    if (agg === undefined) {
      sessionAgg.set(hit.sessionId, {
        score: hit.score,
        count: 1,
        latest: hit.doc.timestamp,
        createdAt: hit.createdAt,
      });
    } else {
      agg.score += hit.score / 2 ** rankInSession;
      agg.count += 1;
      agg.latest = Math.max(agg.latest, hit.doc.timestamp);
    }
  }
  const sessionOrder = [...sessionAgg.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].latest - a[1].latest)
    .map(([sessionId]) => sessionId);
  const shownSessions = new Set(sessionOrder.slice(0, sessionLimit));
  const groupBySession = new Map<string, SessionSearchGroup>();
  for (const hit of scored) {
    if (!shownSessions.has(hit.sessionId)) {
      continue;
    }
    let group = groupBySession.get(hit.sessionId);
    if (group === undefined) {
      group = {
        sessionId: hit.sessionId as SessionId,
        createdAt: hit.createdAt,
        hitCount: sessionAgg.get(hit.sessionId)?.count ?? 0,
        hits: [],
      };
      groupBySession.set(hit.sessionId, group);
    }
    if (group.hits.length < GROUP_SNIPPET_HITS) {
      const matched = keywords.filter((keyword) => hit.matched.includes(keyword.original));
      group.hits.push({
        ...toHit(hit),
        snippet: buildSnippet(hit.doc.text, matched, snippetChars),
      });
    }
  }
  const groups = sessionOrder
    .filter((sessionId) => shownSessions.has(sessionId))
    .map((sessionId) => groupBySession.get(sessionId) as SessionSearchGroup);
  return {
    groups,
    totalHits: scored.length,
    totalSessions: sessionAgg.size,
    ranked: scored.slice(0, options.rankedLimit ?? RANKED_HITS_CAP).map(toHit),
  };
}
