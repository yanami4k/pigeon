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
  "能找到的：以前会话里的讨论、试过的做法及其结果、使用者说过的话（要求、偏好、纠正）。" +
  "找不到的：当前任务的背景（以当前任务的说明为准）、最新的代码（以前会话里看到的代码可能已经过时）。" +
  "代码现状请直接读代码，代码的来历用 git log 与 git blame。";

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
      `${tool} 不认识的参数：${unknown.join("、")}（可用：${known.join("、")}）`
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
    `- 会话 ${group.sessionId}｜开始 ${minuteTime(group.createdAt)}｜命中 ${group.hitCount} 条`,
  ];
  for (const hit of group.hits) {
    const tool = hit.toolName !== undefined ? `（${hit.toolName}）` : "";
    lines.push(
      `  ${hit.entryId}｜${hit.runId} 第 ${hit.runSeq} 条｜${hit.role}${tool}｜${isoTime(hit.timestamp)}｜命中：${hit.matchedKeywords.join("、")}`
    );
    if (hit.role === "toolResult") {
      const origin = [
        hit.toolName ?? "工具",
        ...(hit.toolParams !== undefined ? [hit.toolParams] : []),
        ...(hit.toolOutcome !== undefined ? [hit.toolOutcome] : []),
        isoTime(hit.timestamp),
      ].join("｜");
      lines.push(`  以前的工具输出，可能已过时（${origin}）：`);
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
      "检索本项目以前会话里的对话（不含当前会话所在的这一组会话：最上层的会话及其派出的各级 worker 与分叉，当前会话也在其中）。" +
      SCOPE_GUIDANCE +
      "以前的工具输出（命令输出、读过的文件内容等）也在检索范围内：可能已过时，依赖之前先核实现状；" +
      "以前的工具调用是当时的尝试，不代表最终结果。只搜对话正文（使用者的话与模型回复）给 conversationOnly: true。" +
      "关键词写几个以前对话里会出现的原词（名字、术语、报错里的词），不写整句，不写“讨论”“昨天”这类元词，不写本次任务才出现的新名字；" +
      `最多 ${MAX_SEARCH_KEYWORDS} 个，任一命中即列出，每条标出命中了哪些关键词。` +
      "按词匹配、不分大小写、不支持正则：代码名可以用其中一段命中（如 parseConfig 用 config），中文按相邻两字匹配，单个字按子串匹配；" +
      "多词的关键词拆成词分别计分，整段出现另加分。" +
      "越少见的词命中排得越前，挑有辨识度的词；" +
      `结果按会话归并：每个会话一条，带命中条目数与一两段片段及其条目编号，缺省 ${DEFAULT_SESSION_LIMIT} 个会话、最多 ${MAX_SESSION_LIMIT} 个。` +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文；" +
      "想先浏览以前有哪些会话、哪些会话改过某个文件，用 list_sessions。",
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
      const keywordList = args.keywords.join("、");
      const scope = conversationOnly ? "仅对话正文" : "对话正文与工具输出";
      const lines: string[] = [];
      if (groups.length === 0 && !byteCapped) {
        lines.push(
          `没有命中（关键词：${keywordList}；范围：${scope}）。可以换同义词或别的说法再试` +
            (conversationOnly ? "，或去掉 conversationOnly 连同工具输出一起搜。" : "。")
        );
      } else {
        lines.push(
          `命中 ${groups.length} 个会话（关键词：${keywordList}；范围：${scope}）：`,
          ...blocks
        );
        if (limited) {
          lines.push(
            `共 ${result.totalSessions} 个会话命中，只列出前 ${result.groups.length} 个；请换更具体的关键词收窄。`
          );
        }
        if (byteCapped) {
          lines.push(
            `输出已达 ${maxBytes} 字节上限，只列出前 ${groups.length} 个会话；请换更具体的关键词收窄。`
          );
        }
        lines.push("片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。");
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
      `无法识别的时间：${raw}（写 YYYY-MM-DD 或 ISO 时间，如 2026-09-30T08:00:00Z）`
    );
  }
  return day && edge === "end" ? value + 24 * 60 * 60 * 1000 - 1 : value;
}

function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return "（无）";
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
      ? "（无）"
      : `${session.changedFiles.join("、")}${session.changedFileCount > session.changedFiles.length ? ` 等 ${session.changedFileCount} 个` : ""}`;
  return (
    `- ${session.sessionId}｜${minuteTime(session.createdAt)}｜第一句：${session.firstUserText}\n` +
    `  改动文件：${listed}`
  );
}

export function createListSessionsTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof ListSessionsParamsSchema, ListSessionsDetails> {
  return {
    name: LIST_SESSIONS_TOOL,
    label: LIST_SESSIONS_TOOL,
    description:
      "列出本项目以前的会话（不含当前会话所在的这一组会话：最上层的会话及其派出的各级 worker 与分叉，当前会话也在其中），从新到旧，每个给出会话编号、开始时间（UTC）、" +
      `第一句使用者的话（截断到 ${FIRST_USER_TEXT_CHARS} 字）与改动过的文件（edit_file 的写入与 run_command 报告的文件变化）。` +
      "可按开始时间筛选（since、until，写 YYYY-MM-DD 或 ISO 时间，含两端），" +
      "也可按文件路径筛选（path：改动过的文件路径里含这一段即算，写前缀亦可）；" +
      `最多 ${DEFAULT_LIST_SESSIONS_LIMIT} 个，超出时说明共有多少个。` +
      "用来先浏览以前做过什么、哪些会话动过某个文件，再用 search_sessions 检索、read_session_entry 读原文。" +
      SCOPE_GUIDANCE,
    parameters: ListSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ListSessionsDetails>> {
      rejectUnknownParams(LIST_SESSIONS_TOOL, params, LIST_SESSIONS_PARAM_NAMES);
      const args = Value.Parse(ListSessionsParamsSchema, params);
      if (args.path !== undefined && normalizeChangedPath(args.path) === "") {
        throw new SessionToolError(
          `path 规范化后为空：${args.path}（要按文件筛选请给出路径里的一段，不筛选就不给 path）`
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
        args.path !== undefined ? `path 含 ${args.path}` : "",
      ].filter((item) => item !== "");
      const condition = filters.length > 0 ? `；条件：${filters.join("，")}` : "";
      const sessions = result.sessions.map(listedSession);
      const limited = result.total > sessions.length;
      const lines: string[] = [];
      if (sessions.length === 0) {
        lines.push(
          `没有符合条件的以前会话${condition !== "" ? `（${condition.slice(1)}）` : ""}。`
        );
      } else {
        lines.push(
          `以前的会话 ${sessions.length} 个（从新到旧，时间为 UTC${condition}）：`,
          ...sessions.map(formatSession)
        );
        lines.push(
          limited
            ? `已截断：共 ${result.total} 个符合条件，只列出最新的 ${sessions.length} 个；可用 since、until 或 path 收窄。`
            : "未截断：符合条件的会话已全部列出。"
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
      return `[thinking 未持久化，${block.bytes} 字节]`;
    case "thinking":
      if (block.redacted) {
        return "[thinking 已被 provider 编辑]";
      }
      return `[thinking] ${block.thinking}`;
    case "toolCall":
      return `[toolCall] ${block.name}（${block.id}）`;
    case "image":
      return `[image] ${block.mimeType} ${block.bytes} 字节 sha256 ${block.hash}`;
    case "unknown":
      return `[未知块 ${block.originalType}] sha256 ${block.hash}`;
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
      ? `（${message.toolName}${message.isError === true ? "，出错" : ""}）`
      : "";
  return `[${message.entryId}｜会话 ${sessionId}｜${message.runId} 第 ${message.runSeq} 条｜${message.role}${tool}｜${isoTime(message.timestamp)}]`;
}

export function createReadSessionEntryTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof ReadSessionEntryParamsSchema, ReadSessionEntryDetails> {
  return {
    name: READ_SESSION_ENTRY_TOOL,
    label: READ_SESSION_ENTRY_TOOL,
    description:
      "按 entryId 读取以前会话里一条消息的原文（含思考内容与工具输出）。" +
      `单次最多 ${READ_ENTRY_CHARS} 字（可用 maxChars 调、上限 ${MAX_READ_ENTRY_CHARS}），` +
      "返回里给出总长度，没显示完的用 offset 续读；可给 before、after 连同前后若干条消息一起读。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。" +
      "原文是当时的记录，其中的代码与文件内容可能已经过时：代码现状请直接读代码，代码的来历用 git log 与 git blame。",
    parameters: ReadSessionEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadSessionEntryDetails>> {
      rejectUnknownParams(READ_SESSION_ENTRY_TOOL, params, READ_SESSION_ENTRY_PARAM_NAMES);
      const args = Value.Parse(ReadSessionEntryParamsSchema, params);
      const found = findMessage(options.sessionsDir, args.entryId, args.sessionId);
      if (found === null) {
        throw new SessionToolError(
          `未找到 entry ${args.entryId}（只查本项目 ${pigeonRel("state", "sessions")}；entryId 应来自 search_sessions 的命中）`
        );
      }
      const { sessionId, view, index } = found;
      const message = view.messages[index] as ViewMessage;
      const offset = args.offset ?? 0;
      const maxChars = Math.min(args.maxChars ?? READ_ENTRY_CHARS, MAX_READ_ENTRY_CHARS);
      const full =
        message.blocks.length > 0 ? message.blocks.map(renderBlock).join("\n") : "（空）";
      if (offset > full.length) {
        throw new SessionToolError(
          `offset ${offset} 超出正文总长度 ${full.length}（entry ${args.entryId}）`
        );
      }
      const slice = full.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      const lines = [
        entryHeader(sessionId, message),
        `--- 正文（共 ${full.length} 字，显示第 ${offset}–${end} 字）---`,
        slice,
      ];
      if (end < full.length) {
        lines.push(`（未显示完：用 offset: ${end} 续读）`);
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
        lines.push(`--- ${direction === "before" ? "前" : "后"} ${indexes.length} 条 ---`);
        for (const at of indexes) {
          const item = view.messages[at] as ViewMessage;
          const text = item.blocks.length > 0 ? item.blocks.map(renderBlock).join("\n") : "（空）";
          const flat = text.replace(/\s+/g, " ").trim();
          lines.push(
            entryHeader(sessionId, item),
            flat.length > READ_CONTEXT_CHARS
              ? `${flat.slice(0, READ_CONTEXT_CHARS)}…（截断；读全文用 entryId 加 read_session_entry）`
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
