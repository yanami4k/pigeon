// Session Search 的两个 read 档工具（M5 S2，决策 038）：模型访问完整历史的唯一入口。
//   - search_sessions：关键词检索命中流，默认上限 20 条并有总字节上限，超限提示收窄，不做分页状态；
//   - read_session_entry：按条目号返回一条消息的完整内容块，满足 §3.3 结论回查原文。
// 两者经只读读取器读新会话存储（决策 181 / 185）；agent 可见的说明与输出冻结，只去掉了治理邻居与正文哈希两部分。
// 两者都是 read 档（§3.9 第 5 档自动放行），调用天然落 tool.proposed / tool.settled——模型翻了
// 哪些旧账在 trace 可见。范围只限本项目 .pigeon/sessions，目录由装配根注入。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  hasLegacyEventFile,
  listSessionRefs,
  readSessionView,
} from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import type { ViewBlock, ViewMessage } from "../state/session-view.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { createSessionSearch, type SessionSearchHit } from "./session-search.ts";

export const SEARCH_SESSIONS_TOOL = "search_sessions";
export const READ_SESSION_ENTRY_TOOL = "read_session_entry";
export const DEFAULT_SEARCH_TOOL_LIMIT = 20;
// 总字节上限：命中列表进模型上下文前的硬边界（片段约 200 字 × 20 条的量级）
export const DEFAULT_SEARCH_TOOL_MAX_BYTES = 16 * 1024;

// 域错误（模型侧给错 entryId 等）：与环境异常区分。M5.5 S5（决策 050）：带归类标记，
// tools/error-kind.ts 读标记归 domain（tools 不反向 import 本层）
export class SessionToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const SearchSessionsParamsSchema = Type.Object({
  keywords: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 }),
  role: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult")])
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_SEARCH_TOOL_LIMIT })),
});
export type SearchSessionsParams = Static<typeof SearchSessionsParamsSchema>;

export const ReadSessionEntryParamsSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
});
export type ReadSessionEntryParams = Static<typeof ReadSessionEntryParamsSchema>;

export interface SearchSessionsDetails {
  hits: SessionSearchHit[];
  // 命中数达到上限（结果可能不全）
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

export interface SessionToolsOptions {
  sessionsDir: string;
  maxHits?: number;
  maxBytes?: number;
}

function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatHit(hit: SessionSearchHit): string {
  const tool = hit.toolName !== undefined ? `（${hit.toolName}）` : "";
  return (
    `- ${hit.entryId}｜会话 ${hit.sessionId}｜${hit.runId} 第 ${hit.runSeq} 条｜${hit.role}${tool}｜${isoTime(hit.timestamp)}\n` +
    `  ${hit.snippet}`
  );
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
      "检索本项目历史会话的消息正文（用户输入、模型回复与思维链、工具输出）。关键词大小写不敏感、" +
      "按字面子串匹配、多个关键词须同时出现；不支持正则。结果从新到旧，最多 20 条。" +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文。",
    parameters: SearchSessionsParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<SearchSessionsDetails>> {
      const args = Value.Parse(SearchSessionsParamsSchema, params);
      const limit = Math.min(args.limit ?? maxHits, maxHits);
      const hits: SessionSearchHit[] = [];
      const blocks: string[] = [];
      let bytes = 0;
      let byteCapped = false;
      const search = createSessionSearch(options.sessionsDir).search(
        { keywords: args.keywords, ...(args.role !== undefined ? { roles: [args.role] } : {}) },
        { limit }
      );
      for await (const hit of search) {
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
      const limited = !byteCapped && hits.length >= limit;
      const keywordList = args.keywords.join("、");
      const lines: string[] = [];
      if (hits.length === 0 && !byteCapped) {
        lines.push(`没有命中（关键词：${keywordList}）。可以换同义词或减少关键词再试。`);
      } else {
        lines.push(`命中 ${hits.length} 条（关键词：${keywordList}；从新到旧）：`, ...blocks);
        if (limited) {
          lines.push(`已达 ${limit} 条上限，结果可能不全；请增加关键词或加 role 过滤收窄。`);
        }
        if (byteCapped) {
          lines.push(
            `输出已达 ${maxBytes} 字节上限，只列出前 ${hits.length} 条；请增加关键词或加 role 过滤收窄。`
          );
        }
        lines.push("片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { hits, limited, byteCapped },
      };
    },
  };
}

function renderBlock(block: ViewBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
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
    if (!hasLegacyEventFile(sessionsDir, ref.sessionId)) {
      continue;
    }
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
      "按 entryId 读取历史会话里一条消息的完整原文（含思维链与工具输出）。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。",
    parameters: ReadSessionEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadSessionEntryDetails>> {
      const args = Value.Parse(ReadSessionEntryParamsSchema, params);
      const found = findMessage(options.sessionsDir, args.entryId, args.sessionId);
      if (found === null) {
        throw new SessionToolError(
          `未找到 entry ${args.entryId}（只查本项目 .pigeon/sessions；entryId 应来自 search_sessions 的命中）`
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

// 装配根注册用的元数据：两个工具都是 read 档，路径活动范围 = 本项目会话目录
export function sessionToolRegistrations(sessionsDir: string): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "roots" as const, roots: [sessionsDir] },
    executionMode: "parallel" as const,
  };
  return [
    {
      name: SEARCH_SESSIONS_TOOL,
      description: "检索本项目历史会话的消息正文（关键词字面匹配）",
      parameters: SearchSessionsParamsSchema,
      ...base,
    },
    {
      name: READ_SESSION_ENTRY_TOOL,
      description: "按 entryId 读取历史消息原文",
      parameters: ReadSessionEntryParamsSchema,
      ...base,
    },
  ];
}
