// 会话检索的可搜文本与目录信息（决策 339；决策 384 改进）：从一个会话的原生视图抽出检索与会话目录要用的全部内容。
// 纯函数、无 IO，抽取结果按会话文件缓存（persistence/session-search-cache.ts），检索与目录只读抽取结果，不再碰原生视图。
// - 对话正文：使用者的话与模型回复的文字；不含思考内容与工具调用（名字与参数）。
// - 工具输出：工具结果的文字，与正文分开存放；缺省与正文一起搜（计分做法见 memory/session-search.ts 的
//   toolOutputMode），只搜对话正文以参数显式打开。每条工具输出带来历（工具名、关键参数摘要、退出码或出错），
//   命中时片段前据以标"以前的工具输出，可能已过时"。
// - 每条消息带切分好的词频表（session-search-tokens.ts，查询与正文同一套），BM25 的 tf 直接取之。
// - 会话检索三件工具（search_sessions、read_session_entry、list_sessions）自身的输出永不进检索（工具输出里也不收）；
//   它们的调用是助手消息里的工具调用块，本就不进正文。
// - 目录信息：会话号、开始时间、第一句使用者的话、改动过的文件（edit_file 与 write_file 成功写入的 path，与 run_command
//   结果 details 里文件变化报告的新增、删除、修改）。
// 分支会话开头从来源复制来的历史不在原生视图的消息里（属于来源会话），这里自然不抽。
import { tokenizeSearchText } from "./session-search-tokens.ts";
import type { SessionView, ViewBlock, ViewMessage, ViewToolCall } from "./session-view.ts";
import { isStatusMessage } from "./status-text.ts";

export const SEARCH_SESSIONS_TOOL = "search_sessions";
export const READ_SESSION_ENTRY_TOOL = "read_session_entry";
export const LIST_SESSIONS_TOOL = "list_sessions";
// 自身的调用与输出永不进检索的工具
export const SESSION_SEARCH_TOOL_NAMES: readonly string[] = [
  SEARCH_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  LIST_SESSIONS_TOOL,
];

// 一条可搜的消息
export interface SearchDoc {
  entryId: string;
  runId: string;
  runSeq: number;
  role: string;
  timestamp: number;
  text: string;
  // 词频表（决策 384 切分，抽取时算好随缓存存）：词 → 出现次数；length 为词数合计（BM25 的文档长）
  tokens: Record<string, number>;
  length: number;
  toolName?: string;
  // 工具输出的来历（找得到对应调用时给）：关键参数摘要（截断）与结果（"退出码 N" 或 "出错"）
  toolParams?: string;
  toolOutcome?: string;
}

export interface SessionCatalogInfo {
  sessionId: string;
  // 文件头里的父会话（派出它的会话，或分叉的来源会话）；主会话没有
  parentSessionId?: string;
  // 会话开始时间（毫秒；与会话排序同一口径，由调用方给出）
  createdAt: number;
  // 第一句使用者的话（原文，不截断；没有为空串）
  firstUserText: string;
  // 改动过的文件，按首次出现的先后，去重
  changedFiles: string[];
}

export interface SessionSearchExtract {
  info: SessionCatalogInfo;
  conversation: SearchDoc[];
  toolOutput: SearchDoc[];
}

const CONVERSATION_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(SESSION_SEARCH_TOOL_NAMES);
// 成功调用即改动了参数里的 path 的工具
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file"]);
const RUN_COMMAND_TOOL = "run_command";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 只取文字块：思考、工具调用、图片与未知块都不进可搜文本
export function textOfBlocks(blocks: readonly ViewBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// 工具输出的来历：关键参数摘要（调用参数 JSON 压平截断）与结果（退出码取自结果 details，出错优先）
const TOOL_PARAMS_CHARS = 100;

function docOf(message: ViewMessage, text: string, call?: ViewToolCall): SearchDoc {
  const provenance = message.role === "toolResult";
  const params =
    !provenance || call?.arguments === undefined
      ? undefined
      : JSON.stringify(call.arguments).replace(/\s+/g, " ");
  const details = provenance && isObject(message.raw.details) ? message.raw.details : undefined;
  const outcome =
    message.isError === true
      ? "出错"
      : typeof details?.exitCode === "number"
        ? `退出码 ${details.exitCode}`
        : undefined;
  const tokens = tokenizeSearchText(text);
  let length = 0;
  for (const count of tokens.values()) {
    length += count;
  }
  return {
    entryId: message.entryId,
    runId: message.runId,
    runSeq: message.runSeq,
    role: message.role,
    timestamp: message.timestamp,
    text,
    tokens: Object.fromEntries(tokens),
    length,
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(params !== undefined && params !== ""
      ? {
          toolParams:
            params.length > TOOL_PARAMS_CHARS ? `${params.slice(0, TOOL_PARAMS_CHARS)}…` : params,
        }
      : {}),
    ...(outcome !== undefined ? { toolOutcome: outcome } : {}),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// 改动过的文件：edit_file 成功写入的 path；run_command 结果 details 里的文件变化报告
// 文件路径的规范写法：反斜杠换成正斜杠、去掉开头的 ./。存储与会话目录的路径筛选共用
export function normalizeChangedPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function changedFilesOf(view: SessionView): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const normalized = normalizeChangedPath(file);
    if (normalized !== "" && !seen.has(normalized)) {
      seen.add(normalized);
      files.push(normalized);
    }
  };
  for (const run of view.runs) {
    for (const call of run.toolCalls) {
      const result = call.result;
      if (result === undefined || result.isError === true) {
        continue;
      }
      if (FILE_WRITE_TOOLS.has(call.toolName)) {
        const path = isObject(call.arguments) ? call.arguments.path : undefined;
        if (typeof path === "string") {
          add(path);
        }
      } else if (call.toolName === RUN_COMMAND_TOOL) {
        const details = result.raw.details;
        const changes = isObject(details) ? details.fileChanges : undefined;
        if (isObject(changes)) {
          for (const file of [
            ...stringList(changes.added),
            ...stringList(changes.modified),
            ...stringList(changes.removed),
          ]) {
            add(file);
          }
        }
      }
    }
  }
  return files;
}

export function extractSessionSearch(view: SessionView, createdAt: number): SessionSearchExtract {
  const conversation: SearchDoc[] = [];
  const toolOutput: SearchDoc[] = [];
  // 工具调用号 → 调用（工具输出的来历取关键参数用）
  const callByToolCallId = new Map<string, ViewToolCall>();
  for (const run of view.runs) {
    for (const call of run.toolCalls) {
      callByToolCallId.set(call.toolCallId, call);
    }
  }
  let firstUserText: string | undefined;
  for (const message of view.messages) {
    if (CONVERSATION_ROLES.has(message.role)) {
      const text = textOfBlocks(message.blocks);
      // 决策 363：开工状态块与状态追加（按消息上的标记认）不是对话，不进检索、不当第一句
      if (isStatusMessage(message.raw)) {
        continue;
      }
      if (message.role === "user" && firstUserText === undefined && text.trim() !== "") {
        firstUserText = text;
      }
      if (text !== "") {
        conversation.push(docOf(message, text));
      }
    } else if (message.role === "toolResult") {
      if (message.toolName !== undefined && SEARCH_TOOLS.has(message.toolName)) {
        continue;
      }
      const text = textOfBlocks(message.blocks);
      if (text !== "") {
        toolOutput.push(
          docOf(
            message,
            text,
            message.toolCallId !== undefined ? callByToolCallId.get(message.toolCallId) : undefined
          )
        );
      }
    }
  }
  return {
    info: {
      sessionId: view.sessionId,
      ...(view.parentSessionId !== undefined ? { parentSessionId: view.parentSessionId } : {}),
      createdAt,
      firstUserText: firstUserText ?? "",
      changedFiles: changedFilesOf(view),
    },
    conversation,
    toolOutput,
  };
}
