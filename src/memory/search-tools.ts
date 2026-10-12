// Session Search 的三件 read 档工具（M5 S2，决策 038；决策 339、384 改进）：模型访问以前会话的入口。
//   - search_sessions：关键词检索（BM25 打分，同分从新到旧；切分与正文同一套），结果按会话归并——每个会话一条，
//     带命中条目数与一两段片段及其条目编号；缺省列 5 个会话、最多 10 个，并有总字节上限，超限提示收窄，不做分页状态；
//     工具输出缺省在检索范围内（命中的片段带来历并标"以前的工具输出，可能已过时"），只搜对话正文给 conversationOnly: true；
//   - read_session_entry：按条目号读回一条消息的原文，单次有上限、给出总长度、可按偏移续读，可选读前后若干条消息
//     （满足 §3.3 结论回查原文；可读任一会话，含当前会话）；
//   - list_sessions：会话目录，列出以前的会话及其开始时间、第一句使用者的话与改动过的文件，可按时间与文件筛选。
// 不认识的参数一律报错说明，不静默丢弃（决策 384：诊断里模型传过不存在的 sessionId，被静默丢弃）。
// 检索与目录排除当前会话所在的整棵会话树，三件工具自身的输出永不进检索；可搜文本与词频表按会话文件缓存（决策 339 ⑥、384）。
// 三者都是 read 档（§3.9 第 5 档自动放行），调用天然落 tool.proposed / tool.settled——模型翻了
// 哪些旧账在 trace 可见。范围只限本项目 .pigeon/state/sessions，目录与缓存位置由装配根注入。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { listSessionRefs, readSessionView } from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import { pigeonRel } from "../state/paths.ts";
import {
  LIST_SESSIONS_TOOL,
  normalizeChangedPath,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  type SessionCatalogInfo,
} from "../state/session-search-text.ts";
import type { SessionView, ViewBlock, ViewMessage } from "../state/session-view.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { listSessionDirectory } from "./session-directory.ts";
import {
  type CurrentSession,
  createSessionSearch,
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
  type SessionSearchGroup,
} from "./session-search.ts";

export { LIST_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL };
// 总字节上限：命中列表进模型上下文前的硬边界（决策 384：照旧设一个）
export const DEFAULT_SEARCH_TOOL_MAX_BYTES = 16 * 1024;
export const MAX_SEARCH_KEYWORDS = 8;
// 会话目录的条数上限与第一句话的截断长度（字符）
export const DEFAULT_LIST_SESSIONS_LIMIT = 20;
export const FIRST_USER_TEXT_CHARS = 60;
// 会话目录里每个会话最多列出的改动文件数
const LISTED_FILES = 10;
// read_session_entry：单次读取上限（字符，决策 384：约 4,000）、可调到的上限与前后消息的条数与各自截断
export const READ_ENTRY_CHARS = 4_000;
export const MAX_READ_ENTRY_CHARS = 8_000;
export const READ_CONTEXT_MAX = 5;
export const READ_CONTEXT_CHARS = 1_000;

// 三件工具共同的说明：能找到的、找不到的，以及代码现状与来历去哪里看
const SCOPE_GUIDANCE =
  "What you can find: discussions in earlier sessions, approaches tried and their results, and what the user said (requests, preferences, corrections). " +
  "What you cannot find: the background of the current task (the current task's description is authoritative) and the latest code (code seen in earlier sessions may be out of date). " +
  "For the current state of the code, read the code directly; for its history, use git log and git blame.";

// 条数与名词：1 session、2 sessions
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// 域错误（模型侧给错 entryId 等）：与环境异常区分。M5.5 S5（决策 050）：带归类标记，
// tools/error-kind.ts 读标记归 domain（tools 不反向 import 本层）
export class SessionToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 决策 384：不认识的参数报错说明，不静默丢弃
function rejectUnknownParams(tool: string, params: unknown, known: readonly string[]): void {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return;
  }
  const unknown = Object.keys(params).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new SessionToolError(
      `Unknown parameters for ${tool}: ${unknown.join(", ")} (available: ${known.join(", ")})`
    );
  }
}

const SEARCH_SESSIONS_PARAM_NAMES = ["keywords", "conversationOnly", "limit"] as const;
export const SearchSessionsParamsSchema = Type.Object({
  keywords: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: MAX_SEARCH_KEYWORDS,
  }),
  // 决策 384：工具输出缺省在检索范围内；打开后只搜对话正文
  conversationOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SESSION_LIMIT })),
});
export type SearchSessionsParams = Static<typeof SearchSessionsParamsSchema>;

const READ_SESSION_ENTRY_PARAM_NAMES = [
  "entryId",
  "sessionId",
  "offset",
  "maxChars",
  "before",
  "after",
] as const;
export const ReadSessionEntryParamsSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  // 正文偏移（字符）：续读上一条没显示完的部分
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  // 单次读取上限（字符），缺省 READ_ENTRY_CHARS
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_ENTRY_CHARS })),
  // 连同该条之前、之后的若干条消息（各自截断到 READ_CONTEXT_CHARS 字）
  before: Type.Optional(Type.Integer({ minimum: 0, maximum: READ_CONTEXT_MAX })),
  after: Type.Optional(Type.Integer({ minimum: 0, maximum: READ_CONTEXT_MAX })),
});
export type ReadSessionEntryParams = Static<typeof ReadSessionEntryParamsSchema>;

const LIST_SESSIONS_PARAM_NAMES = ["since", "until", "path", "limit"] as const;
export const ListSessionsParamsSchema = Type.Object({
  since: Type.Optional(Type.String({ minLength: 1 })),
  until: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_LIST_SESSIONS_LIMIT })),
});
export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;

export interface SearchSessionsDetails {
  groups: SessionSearchGroup[];
  // 命中条目总数与命中会话总数（归并排序前、不受上限限制）
  totalHits: number;
  totalSessions: number;
  // 命中会话数超过上限（只列出了前若干个）
  limited: boolean;
  // 输出达到总字节上限而提前停止
  byteCapped: boolean;
}

export interface ReadSessionEntryDetails {
  sessionId: SessionId;
  entryId: string;
  runId: string;
  runSeq: number;
  role: string;
  // 正文总长度（字符）与本次显示的起点；truncated 时可用 offset 续读
  totalChars: number;
  offset: number;
  truncated: boolean;
}

// 会话目录里的一个会话：与给模型的文本同样截断（details 随工具结果存进会话文件，不带全文与全部文件）
export interface ListedSession {
  sessionId: string;
  createdAt: number;
  // 截断后的第一句（空白压平，超长加省略号；没有为"（无）"）
  firstUserText: string;
  // 至多前 10 个改动文件
  changedFiles: string[];
  // 改动文件总数
  changedFileCount: number;
}

export interface ListSessionsDetails {
  sessions: ListedSession[];
  // 符合条件的会话总数
  total: number;
  // 超过上限，只列出了最新的若干个
  limited: boolean;
}

export interface SessionToolsOptions {
  sessionsDir: string;
  // 决策 339 ⑥：可搜文本与目录信息的缓存目录；缺省不缓存
  cacheDir?: string;
  // 决策 339 ①：当前会话（检索与目录排除它所在的整棵会话树；read_session_entry 不受影响）
  current?: CurrentSession;
  maxSessions?: number;
  maxBytes?: number;
}

function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function minuteTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

// 一个会话的归并结果：第一行给会话号、开始时间与命中条目数，其后至多两段命中，各带条目编号与片段；
// 命中在工具输出上的片段前加一行来历并标"以前的工具输出，可能已过时"（决策 384）
function formatGroup(group: SessionSearchGroup): string {
  const lines = [
    `- Session ${group.sessionId} | started ${minuteTime(group.createdAt)} | ${group.hitCount} matching ${group.hitCount === 1 ? "entry" : "entries"}`,
  ];
  for (const hit of group.hits) {
    const tool = hit.toolName !== undefined ? ` (${hit.toolName})` : "";
    lines.push(
      `  ${hit.entryId} | ${hit.runId} #${hit.runSeq} | ${hit.role}${tool} | ${isoTime(hit.timestamp)} | matched: ${hit.matchedKeywords.join(", ")}`
    );
    if (hit.role === "toolResult") {
      const origin = [
        hit.toolName ?? "tool",
        ...(hit.toolParams !== undefined ? [hit.toolParams] : []),
        ...(hit.toolOutcome !== undefined ? [hit.toolOutcome] : []),
        isoTime(hit.timestamp),
      ].join(" | ");
      lines.push(`  Earlier tool output, may be out of date (${origin}):`);
    }
    lines.push(`  ${hit.snippet}`);
  }
  return lines.join("\n");
}

function cacheOf(options: SessionToolsOptions): { cacheDir?: string } {
  return options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {};
}

export function createSearchSessionsTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof SearchSessionsParamsSchema, SearchSessionsDetails> {
  const maxSessions = options.maxSessions ?? DEFAULT_SESSION_LIMIT;
  const maxBytes = options.maxBytes ?? DEFAULT_SEARCH_TOOL_MAX_BYTES;
  return {
    name: SEARCH_SESSIONS_TOOL,
    label: SEARCH_SESSIONS_TOOL,
    description:
      "Search the conversations in this project's earlier sessions (excluding the group of sessions the current session belongs to: " +
      "the top-level session and the workers and forks it spawned at every level, the current session included). " +
      SCOPE_GUIDANCE +
      " Earlier tool output (command output, contents of files that were read, and so on) is also searched: it may be out of date, so verify the current state before relying on it; " +
      "earlier tool calls were attempts at the time and do not represent the final result. To search only the conversation text (the user's words and the model's replies), pass conversationOnly: true. " +
      "For keywords, give a few exact words likely to appear in the earlier conversation (names, terms, words from error messages); " +
      'do not write whole sentences, meta words such as "discussion" or "yesterday", or new names that appear only in this task; ' +
      `at most ${MAX_SEARCH_KEYWORDS} keywords; a session is listed if any keyword matches, and each hit shows which keywords it matched. ` +
      "Matching is by word, case-insensitive, with no regular expressions: a code name can be matched by one of its parts (for example, config for parseConfig), " +
      "Chinese text is matched by pairs of adjacent characters, and a single character is matched as a substring; " +
      "a multi-word keyword is split into words that are scored separately, with extra score when the whole phrase appears. " +
      "Hits on rarer words rank higher, so choose distinctive words; " +
      `results are grouped by session: one item per session, with the number of matching entries and one or two snippets with their entry IDs; ${DEFAULT_SESSION_LIMIT} sessions by default, at most ${MAX_SESSION_LIMIT}. ` +
      "Snippets are only leads: conclusions must be checked against the original text with read_session_entry by entryId; " +
      "to first browse which earlier sessions exist and which sessions changed a given file, use list_sessions.",
    parameters: SearchSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<SearchSessionsDetails>> {
      rejectUnknownParams(SEARCH_SESSIONS_TOOL, params, SEARCH_SESSIONS_PARAM_NAMES);
      const args = Value.Parse(SearchSessionsParamsSchema, params);
      // 模型给的 limit 只受硬上限夹；maxSessions 是模型没给时的缺省
      const sessionLimit = Math.min(args.limit ?? maxSessions, MAX_SESSION_LIMIT);
      const conversationOnly = args.conversationOnly === true;
      const result = await createSessionSearch(options.sessionsDir, cacheOf(options)).search(
        {
          keywords: args.keywords,
          conversationOnly,
          ...(options.current !== undefined ? { current: options.current } : {}),
        },
        { sessionLimit }
      );
      const groups: SessionSearchGroup[] = [];
      const blocks: string[] = [];
      let bytes = 0;
      let byteCapped = false;
      for (const group of result.groups) {
        const block = formatGroup(group);
        const size = Buffer.byteLength(block, "utf8") + 1;
        if (bytes + size > maxBytes) {
          byteCapped = true;
          break;
        }
        bytes += size;
        blocks.push(block);
        groups.push(group);
      }
      const limited = result.totalSessions > result.groups.length;
      const keywordList = args.keywords.join(", ");
      const scope = conversationOnly
        ? "conversation text only"
        : "conversation text and tool output";
      const lines: string[] = [];
      if (groups.length === 0 && !byteCapped) {
        lines.push(
          `No matches (keywords: ${keywordList}; scope: ${scope}). Try synonyms or other wording` +
            (conversationOnly ? ", or drop conversationOnly to search tool output as well." : ".")
        );
      } else {
        lines.push(
          `Matches in ${counted(groups.length, "session")} (keywords: ${keywordList}; scope: ${scope}):`,
          ...blocks
        );
        if (limited) {
          lines.push(
            `${counted(result.totalSessions, "session")} matched; only the first ${result.groups.length} are listed. Use more specific keywords to narrow the search.`
          );
        }
        if (byteCapped) {
          lines.push(
            `The output reached the ${maxBytes}-byte limit; only the first ${counted(groups.length, "session")} are listed. Use more specific keywords to narrow the search.`
          );
        }
        lines.push(
          "Snippets are only leads: read the original text with read_session_entry by entryId; conclusions must be checked against the original text."
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          groups,
          totalHits: result.totalHits,
          totalSessions: result.totalSessions,
          limited,
          byteCapped,
        },
      };
    },
  };
}

// 时间参数：YYYY-MM-DD 按 UTC 当天（since 取当天开始，until 取当天结束），其余按 ISO 时间解析
export function parseListTime(raw: string, edge: "start" | "end"): number {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const value = Date.parse(day ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(value)) {
    throw new SessionToolError(
      `Unrecognized time: ${raw} (give YYYY-MM-DD or an ISO time, such as 2026-09-30T08:00:00Z)`
    );
  }
  return day && edge === "end" ? value + 24 * 60 * 60 * 1000 - 1 : value;
}

function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return "(none)";
  }
  return flat.length > FIRST_USER_TEXT_CHARS ? `${flat.slice(0, FIRST_USER_TEXT_CHARS)}…` : flat;
}

function listedSession(info: SessionCatalogInfo): ListedSession {
  return {
    sessionId: info.sessionId,
    createdAt: info.createdAt,
    firstUserText: firstWords(info.firstUserText),
    changedFiles: info.changedFiles.slice(0, LISTED_FILES),
    changedFileCount: info.changedFiles.length,
  };
}

function formatSession(session: ListedSession): string {
  const listed =
    session.changedFileCount === 0
      ? "(none)"
      : `${session.changedFiles.join(", ")}${session.changedFileCount > session.changedFiles.length ? ` (${session.changedFileCount} files in total)` : ""}`;
  return (
    `- ${session.sessionId} | ${minuteTime(session.createdAt)} | first message: ${session.firstUserText}\n` +
    `  changed files: ${listed}`
  );
}

export function createListSessionsTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof ListSessionsParamsSchema, ListSessionsDetails> {
  return {
    name: LIST_SESSIONS_TOOL,
    label: LIST_SESSIONS_TOOL,
    description:
      "List this project's earlier sessions (excluding the group of sessions the current session belongs to: " +
      "the top-level session and the workers and forks it spawned at every level, the current session included), newest first. " +
      "Each shows the session ID, the start time (UTC), " +
      `the user's first message (truncated to ${FIRST_USER_TEXT_CHARS} characters), and the files changed (writes by edit_file and file changes reported by run_command). ` +
      "You can filter by start time (since, until; give YYYY-MM-DD or an ISO time; both ends inclusive) " +
      "or by file path (path: a session matches if a changed file's path contains this text; a prefix also works); " +
      `at most ${DEFAULT_LIST_SESSIONS_LIMIT} sessions; when there are more, the total is stated. ` +
      "Use it to first browse what was done before and which sessions touched a file, then search with search_sessions and read the original text with read_session_entry. " +
      SCOPE_GUIDANCE,
    parameters: ListSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ListSessionsDetails>> {
      rejectUnknownParams(LIST_SESSIONS_TOOL, params, LIST_SESSIONS_PARAM_NAMES);
      const args = Value.Parse(ListSessionsParamsSchema, params);
      if (args.path !== undefined && normalizeChangedPath(args.path) === "") {
        throw new SessionToolError(
          `path is empty after normalization: ${args.path} (to filter by file, give part of the path; to not filter, omit path)`
        );
      }
      const limit = Math.min(
        args.limit ?? DEFAULT_LIST_SESSIONS_LIMIT,
        DEFAULT_LIST_SESSIONS_LIMIT
      );
      const result = listSessionDirectory(
        options.sessionsDir,
        {
          ...(options.current !== undefined ? { current: options.current } : {}),
          ...(args.since !== undefined ? { since: parseListTime(args.since, "start") } : {}),
          ...(args.until !== undefined ? { until: parseListTime(args.until, "end") } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
        },
        limit,
        cacheOf(options)
      );
      const filters = [
        args.since !== undefined ? `since ${args.since}` : "",
        args.until !== undefined ? `until ${args.until}` : "",
        args.path !== undefined ? `path contains ${args.path}` : "",
      ].filter((item) => item !== "");
      const condition = filters.length > 0 ? `; filters: ${filters.join(", ")}` : "";
      const sessions = result.sessions.map(listedSession);
      const limited = result.total > sessions.length;
      const lines: string[] = [];
      if (sessions.length === 0) {
        lines.push(
          `No earlier sessions match${condition !== "" ? ` (${condition.slice(2)})` : ""}.`
        );
      } else {
        lines.push(
          `Earlier sessions: ${sessions.length} (newest first, times in UTC${condition}):`,
          ...sessions.map(formatSession)
        );
        lines.push(
          limited
            ? `Truncated: ${counted(result.total, "session")} match; only the newest ${sessions.length} are listed. Narrow the list with since, until, or path.`
            : "Not truncated: all matching sessions are listed."
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { sessions, total: result.total, limited },
      };
    },
  };
}

function renderBlock(block: ViewBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "omitted-thinking":
      return `[thinking not persisted, ${block.bytes} bytes]`;
    case "thinking":
      if (block.redacted) {
        return "[thinking redacted by the provider]";
      }
      return `[thinking] ${block.thinking}`;
    case "toolCall":
      return `[toolCall] ${block.name} (${block.id})`;
    case "image":
      return `[image] ${block.mimeType} ${block.bytes} bytes sha256 ${block.hash}`;
    case "unknown":
      return `[unknown block ${block.originalType}] sha256 ${block.hash}`;
  }
}

// 按条目号找消息：给了会话号只查该会话，否则从新到旧逐个会话查（分支会话的复制段不算，它属于来源会话）
function findMessage(
  sessionsDir: string,
  entryId: string,
  sessionId: string | undefined
): { sessionId: SessionId; view: SessionView; index: number } | null {
  const refs = listSessionRefs(sessionsDir)
    .reverse()
    .filter((ref) => sessionId === undefined || ref.sessionId === sessionId);
  for (const ref of refs) {
    const view = readSessionView(ref);
    const index = view?.messages.findIndex((item) => item.entryId === entryId) ?? -1;
    if (view !== undefined && index >= 0) {
      return { sessionId: view.sessionId, view, index };
    }
  }
  return null;
}

function entryHeader(sessionId: SessionId, message: ViewMessage): string {
  const tool =
    message.toolName !== undefined
      ? ` (${message.toolName}${message.isError === true ? ", error" : ""})`
      : "";
  return `[${message.entryId} | session ${sessionId} | ${message.runId} #${message.runSeq} | ${message.role}${tool} | ${isoTime(message.timestamp)}]`;
}

export function createReadSessionEntryTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof ReadSessionEntryParamsSchema, ReadSessionEntryDetails> {
  return {
    name: READ_SESSION_ENTRY_TOOL,
    label: READ_SESSION_ENTRY_TOOL,
    description:
      "Read the original text of one message from an earlier session by entryId (including thinking and tool output). " +
      `At most ${READ_ENTRY_CHARS} characters per read (adjustable with maxChars, up to ${MAX_READ_ENTRY_CHARS}); ` +
      "the result gives the total length, and you can continue reading what was not shown with offset; pass before and after to also read some messages before and after it. " +
      "entryId comes from search_sessions hits; you can add sessionId to locate it faster. " +
      "The original text is a record from that time, and the code and file contents in it may be out of date: for the current state of the code, read the code directly; for its history, use git log and git blame.",
    parameters: ReadSessionEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadSessionEntryDetails>> {
      rejectUnknownParams(READ_SESSION_ENTRY_TOOL, params, READ_SESSION_ENTRY_PARAM_NAMES);
      const args = Value.Parse(ReadSessionEntryParamsSchema, params);
      const found = findMessage(options.sessionsDir, args.entryId, args.sessionId);
      if (found === null) {
        throw new SessionToolError(
          `Entry ${args.entryId} not found (only this project's ${pigeonRel("state", "sessions")} is searched; entryId should come from a search_sessions hit)`
        );
      }
      const { sessionId, view, index } = found;
      const message = view.messages[index] as ViewMessage;
      const offset = args.offset ?? 0;
      const maxChars = Math.min(args.maxChars ?? READ_ENTRY_CHARS, MAX_READ_ENTRY_CHARS);
      const full =
        message.blocks.length > 0 ? message.blocks.map(renderBlock).join("\n") : "(empty)";
      if (offset > full.length) {
        throw new SessionToolError(
          `offset ${offset} is beyond the total text length ${full.length} (entry ${args.entryId})`
        );
      }
      const slice = full.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      const lines = [
        entryHeader(sessionId, message),
        `--- Text (${full.length} characters in total, showing ${offset}–${end}) ---`,
        slice,
      ];
      if (end < full.length) {
        lines.push(`(Not fully shown: continue with offset: ${end})`);
      }
      const context = (count: number, direction: "before" | "after"): void => {
        if (count === 0) {
          return;
        }
        const indexes: number[] = [];
        for (let step = 1; step <= count; step++) {
          const at = direction === "before" ? index - step : index + step;
          if (at >= 0 && at < view.messages.length) {
            indexes.push(at);
          }
        }
        // 该方向上没有消息（已在会话头尾）：不印分隔行
        if (indexes.length === 0) {
          return;
        }
        if (direction === "before") {
          indexes.reverse();
        }
        lines.push(`--- ${counted(indexes.length, "message")} ${direction} ---`);
        for (const at of indexes) {
          const item = view.messages[at] as ViewMessage;
          const text = item.blocks.length > 0 ? item.blocks.map(renderBlock).join("\n") : "(empty)";
          const flat = text.replace(/\s+/g, " ").trim();
          lines.push(
            entryHeader(sessionId, item),
            flat.length > READ_CONTEXT_CHARS
              ? `${flat.slice(0, READ_CONTEXT_CHARS)}… (truncated; to read the full text, use read_session_entry with its entryId)`
              : flat
          );
        }
      };
      context(args.before ?? 0, "before");
      context(args.after ?? 0, "after");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          sessionId,
          entryId: message.entryId,
          runId: message.runId,
          runSeq: message.runSeq,
          role: message.role,
          totalChars: full.length,
          offset,
          truncated: end < full.length,
        },
      };
    },
  };
}

// 装配根注册用的元数据：三件工具都是 read 档，路径活动范围 = 本项目会话目录
export function sessionToolRegistrations(sessionsDir: string): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "roots" as const, roots: [sessionsDir] },
    executionMode: "parallel" as const,
  };
  return [
    {
      name: SEARCH_SESSIONS_TOOL,
      description: "检索本项目以前会话（按会话归并，BM25 打分，工具输出也在范围内）",
      parameters: SearchSessionsParamsSchema,
      ...base,
    },
    {
      name: READ_SESSION_ENTRY_TOOL,
      description: "按 entryId 读取以前会话的消息原文（有上限，可分页续读）",
      parameters: ReadSessionEntryParamsSchema,
      ...base,
    },
    {
      name: LIST_SESSIONS_TOOL,
      description: "列出本项目以前的会话（可按时间与改动过的文件筛选）",
      parameters: ListSessionsParamsSchema,
      ...base,
    },
  ];
}
