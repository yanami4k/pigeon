// Session Search 的三件 read 档工具（M5 S2，决策 038；决策 339 改进）：模型访问以前会话的入口。
//   - search_sessions：关键词检索（任一命中，按命中关键词数排序），默认上限 20 条并有总字节上限，超限提示收窄，不做分页状态；
//     缺省只搜对话正文，工具输出以 includeToolOutput 显式打开；
//   - read_session_entry：按条目号返回一条消息的完整内容块，满足 §3.3 结论回查原文（可读任一会话，含当前会话）；
//   - list_sessions：会话目录，列出以前的会话及其开始时间、第一句使用者的话与改动过的文件，可按时间与文件筛选。
// 检索与目录排除当前会话所在的整棵会话树，三件工具自身的输出永不进检索；可搜文本按会话文件缓存（决策 339 ⑥）。
// 三者都是 read 档（§3.9 第 5 档自动放行），调用天然落 tool.proposed / tool.settled——模型翻了
// 哪些旧账在 trace 可见。范围只限本项目 .pigeon/state/sessions，目录与缓存位置由装配根注入。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { listSessionRefs, readSessionView } from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import { pigeonRel } from "../state/paths.ts";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  type SessionCatalogInfo,
} from "../state/session-search-text.ts";
import type { ViewBlock, ViewMessage } from "../state/session-view.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { listSessionDirectory } from "./session-directory.ts";
import {
  type CurrentSession,
  createSessionSearch,
  type SessionSearchHit,
} from "./session-search.ts";

export { LIST_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL };
export const DEFAULT_SEARCH_TOOL_LIMIT = 20;
// 总字节上限：命中列表进模型上下文前的硬边界（片段约 200 字 × 20 条的量级）
export const DEFAULT_SEARCH_TOOL_MAX_BYTES = 16 * 1024;
export const MAX_SEARCH_KEYWORDS = 8;
// 会话目录的条数上限与第一句话的截断长度（字符）
export const DEFAULT_LIST_SESSIONS_LIMIT = 20;
export const FIRST_USER_TEXT_CHARS = 60;
// 会话目录里每个会话最多列出的改动文件数
const LISTED_FILES = 10;

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

export const SearchSessionsParamsSchema = Type.Object({
  keywords: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: MAX_SEARCH_KEYWORDS,
  }),
  // 决策 339 ②：工具输出缺省不搜，显式打开
  includeToolOutput: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_SEARCH_TOOL_LIMIT })),
});
export type SearchSessionsParams = Static<typeof SearchSessionsParamsSchema>;

export const ReadSessionEntryParamsSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
});
export type ReadSessionEntryParams = Static<typeof ReadSessionEntryParamsSchema>;

export const ListSessionsParamsSchema = Type.Object({
  since: Type.Optional(Type.String({ minLength: 1 })),
  until: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_LIST_SESSIONS_LIMIT })),
});
export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;

export interface SearchSessionsDetails {
  hits: SessionSearchHit[];
  // 命中总条数（排序前、不受上限限制）
  total: number;
  // 命中数超过上限（只列出了前若干条）
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
  maxHits?: number;
  maxBytes?: number;
}

function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function minuteTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

function formatHit(hit: SessionSearchHit): string {
  const tool = hit.toolName !== undefined ? `（${hit.toolName}）` : "";
  return (
    `- ${hit.entryId}｜会话 ${hit.sessionId}｜${hit.runId} 第 ${hit.runSeq} 条｜${hit.role}${tool}｜${isoTime(hit.timestamp)}｜命中：${hit.matchedKeywords.join("、")}\n` +
    `  ${hit.snippet}`
  );
}

function cacheOf(options: SessionToolsOptions): { cacheDir?: string } {
  return options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {};
}

export function createSearchSessionsTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof SearchSessionsParamsSchema, SearchSessionsDetails> {
  const maxHits = options.maxHits ?? DEFAULT_SEARCH_TOOL_LIMIT;
  const maxBytes = options.maxBytes ?? DEFAULT_SEARCH_TOOL_MAX_BYTES;
  return {
    name: SEARCH_SESSIONS_TOOL,
    label: SEARCH_SESSIONS_TOOL,
    description:
      "检索本项目以前会话里的对话（不含当前会话所在的这一组会话：派出它的会话、它派出的 worker 与分叉）。" +
      SCOPE_GUIDANCE +
      "缺省只搜对话正文（使用者的话与模型回复的文字，不含思考内容与工具调用）；" +
      "要连同以前的工具输出（命令输出、读过的文件内容等）一起搜，给 includeToolOutput: true。" +
      `关键词大小写不敏感、按字面子串匹配、不支持正则，最多 ${MAX_SEARCH_KEYWORDS} 个，任一命中即列出；` +
      `结果按命中的关键词数从多到少、同数从新到旧排序，每条标出命中了哪些关键词，最多 ${DEFAULT_SEARCH_TOOL_LIMIT} 条。` +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文；" +
      "想先浏览以前有哪些会话、哪些会话改过某个文件，用 list_sessions。",
    parameters: SearchSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<SearchSessionsDetails>> {
      const args = Value.Parse(SearchSessionsParamsSchema, params);
      const limit = Math.min(args.limit ?? maxHits, maxHits);
      const includeToolOutput = args.includeToolOutput === true;
      const result = await createSessionSearch(options.sessionsDir, cacheOf(options)).search(
        {
          keywords: args.keywords,
          includeToolOutput,
          ...(options.current !== undefined ? { current: options.current } : {}),
        },
        { limit }
      );
      const hits: SessionSearchHit[] = [];
      const blocks: string[] = [];
      let bytes = 0;
      let byteCapped = false;
      for (const hit of result.hits) {
        const block = formatHit(hit);
        const size = Buffer.byteLength(block, "utf8") + 1;
        if (bytes + size > maxBytes) {
          byteCapped = true;
          break;
        }
        bytes += size;
        blocks.push(block);
        hits.push(hit);
      }
      const limited = result.total > result.hits.length;
      const keywordList = args.keywords.join("、");
      const scope = includeToolOutput ? "对话正文与工具输出" : "对话正文";
      const lines: string[] = [];
      if (hits.length === 0 && !byteCapped) {
        lines.push(
          `没有命中（关键词：${keywordList}；范围：${scope}）。可以换同义词或别的说法再试` +
            (includeToolOutput ? "。" : "，或给 includeToolOutput: true 连同工具输出一起搜。")
        );
      } else {
        lines.push(
          `命中 ${hits.length} 条（关键词：${keywordList}；范围：${scope}；按命中的关键词数从多到少，同数从新到旧）：`,
          ...blocks
        );
        if (limited) {
          lines.push(
            `共 ${result.total} 条命中，只列出前 ${result.hits.length} 条；请换更具体的关键词收窄。`
          );
        }
        if (byteCapped) {
          lines.push(
            `输出已达 ${maxBytes} 字节上限，只列出前 ${hits.length} 条；请换更具体的关键词收窄。`
          );
        }
        lines.push("片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { hits, total: result.total, limited, byteCapped },
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
      "列出本项目以前的会话（不含当前会话所在的这一组会话：派出它的会话、它派出的 worker 与分叉），从新到旧，每个给出会话编号、开始时间（UTC）、" +
      `第一句使用者的话（截断到 ${FIRST_USER_TEXT_CHARS} 字）与改动过的文件（edit_file 的写入与 run_command 报告的文件变化）。` +
      "可按开始时间筛选（since、until，写 YYYY-MM-DD 或 ISO 时间，含两端），" +
      "也可按文件路径筛选（path：改动过的文件路径里含这一段即算，写前缀亦可）；" +
      `最多 ${DEFAULT_LIST_SESSIONS_LIMIT} 个，超出时说明共有多少个。` +
      "用来先浏览以前做过什么、哪些会话动过某个文件，再用 search_sessions 检索、read_session_entry 读原文。" +
      SCOPE_GUIDANCE,
    parameters: ListSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ListSessionsDetails>> {
      const args = Value.Parse(ListSessionsParamsSchema, params);
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
): { sessionId: SessionId; message: ViewMessage } | null {
  const refs = listSessionRefs(sessionsDir)
    .reverse()
    .filter((ref) => sessionId === undefined || ref.sessionId === sessionId);
  for (const ref of refs) {
    const view = readSessionView(ref);
    const message = view?.messages.find((item) => item.entryId === entryId);
    if (view !== undefined && message !== undefined) {
      return { sessionId: view.sessionId, message };
    }
  }
  return null;
}

export function createReadSessionEntryTool(
  options: SessionToolsOptions
): PigeonAgentTool<typeof ReadSessionEntryParamsSchema, ReadSessionEntryDetails> {
  return {
    name: READ_SESSION_ENTRY_TOOL,
    label: READ_SESSION_ENTRY_TOOL,
    description:
      "按 entryId 读取以前会话里一条消息的完整原文（含思考内容与工具输出）。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。" +
      "原文是当时的记录，其中的代码与文件内容可能已经过时：代码现状请直接读代码，代码的来历用 git log 与 git blame。",
    parameters: ReadSessionEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadSessionEntryDetails>> {
      const args = Value.Parse(ReadSessionEntryParamsSchema, params);
      const found = findMessage(options.sessionsDir, args.entryId, args.sessionId);
      if (found === null) {
        throw new SessionToolError(
          `未找到 entry ${args.entryId}（只查本项目 ${pigeonRel("state", "sessions")}；entryId 应来自 search_sessions 的命中）`
        );
      }
      const { sessionId, message } = found;
      const tool =
        message.toolName !== undefined
          ? `（${message.toolName}${message.isError === true ? "，出错" : ""}）`
          : "";
      const lines = [
        `[${message.entryId}｜会话 ${sessionId}｜${message.runId} 第 ${message.runSeq} 条｜${message.role}${tool}｜${isoTime(message.timestamp)}]`,
        "--- 正文 ---",
        ...(message.blocks.length > 0 ? message.blocks.map(renderBlock) : ["（空）"]),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          sessionId,
          entryId: message.entryId,
          runId: message.runId,
          runSeq: message.runSeq,
          role: message.role,
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
      description: "检索本项目以前会话的对话（关键词字面匹配，缺省不含工具输出）",
      parameters: SearchSessionsParamsSchema,
      ...base,
    },
    {
      name: READ_SESSION_ENTRY_TOOL,
      description: "按 entryId 读取以前会话的消息原文",
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
