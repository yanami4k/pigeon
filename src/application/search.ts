// /search 命令层（M5 S2，决策 038）：人的入口，cli REPL 与 tui 共用同一份解析与排版
// （同 030 / 031 方向）；输出是纯字符串，命中片段经 sanitizeTerminalText 净化后才出命令层
//（036：正文是半信任内容）。检索本身在 memory/session-search.ts，本层不另起扫描。
// 迁移之前的旧格式会话不检索，末尾给一行计数提示（187 / 211）。
import {
  createSessionSearch,
  type SessionMessageRole,
  type SessionSearchHit,
} from "../memory/session-search.ts";
import { legacySessionsNote } from "../persistence/session-catalog.ts";
import { sessionSearchCacheDirOf, sessionsDirOf } from "../state/paths.ts";
import { sanitizeTerminalText } from "./format.ts";

export const DEFAULT_SEARCH_COMMAND_LIMIT = 20;

const SEARCHABLE_ROLES: readonly string[] = ["user", "assistant", "toolResult"];

const USAGE =
  "用法：/search <关键词...> [--tool-output] [--role user|assistant|toolResult] [--limit N]" +
  "（任一命中即列出，按命中的关键词数排序；大小写不敏感，按字面匹配；缺省只搜对话正文，--tool-output 连同工具输出一起搜）\n";

export interface SearchCommandOptions {
  // 工作区根（会话目录在 <root>/.pigeon/state/sessions/，缓存在 <root>/.pigeon/state/search-cache/）
  root: string;
  // /search 之后的词元
  args: readonly string[];
}

function formatHit(hit: SessionSearchHit): string {
  const time = new Date(hit.timestamp).toISOString().slice(0, 16).replace("T", " ");
  const tool = hit.toolName !== undefined ? `（${hit.toolName}）` : "";
  return (
    `${time}  ${hit.sessionId}  第 ${hit.runSeq} 条 ${hit.role}${tool}  ${hit.entryId}  命中：${hit.matchedKeywords.join("、")}\n` +
    `  ${hit.snippet}`
  );
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<string> {
  const keywords: string[] = [];
  let role: SessionMessageRole | undefined;
  let limit = DEFAULT_SEARCH_COMMAND_LIMIT;
  let includeToolOutput = false;
  const { args } = options;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--tool-output") {
      includeToolOutput = true;
    } else if (token === "--role") {
      const value = args[++index];
      if (value === undefined || !SEARCHABLE_ROLES.includes(value)) {
        throw new Error(
          `未知角色：${value ?? "（缺取值）"}（可选：${SEARCHABLE_ROLES.join("/")}）`
        );
      }
      role = value as SessionMessageRole;
    } else if (token === "--limit") {
      const raw = args[++index];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--limit 需要正整数：${raw ?? "（缺取值）"}`);
      }
      limit = value;
    } else if (token !== undefined) {
      keywords.push(token);
    }
  }
  if (keywords.length === 0) {
    return USAGE;
  }
  const sessionsDir = sessionsDirOf(options.root);
  const { hits, total } = await createSessionSearch(sessionsDir, {
    cacheDir: sessionSearchCacheDirOf(options.root),
  }).search(
    { keywords, includeToolOutput, ...(role !== undefined ? { roles: [role] } : {}) },
    { limit }
  );
  const keywordList = keywords.join("、");
  const scope = includeToolOutput || role === "toolResult" ? "对话正文与工具输出" : "对话正文";
  const lines: string[] =
    hits.length === 0
      ? [`没有命中（关键词：${keywordList}；范围：${scope}）`]
      : [
          `命中 ${hits.length} 条（关键词：${keywordList}；范围：${scope}；按命中的关键词数从多到少，同数从新到旧）`,
          ...hits.map(formatHit),
        ];
  if (total > hits.length) {
    lines.push(`共 ${total} 条命中，只列出前 ${hits.length} 条；换更具体的关键词或 --role 收窄`);
  }
  const legacy = legacySessionsNote(sessionsDir);
  if (legacy !== undefined) {
    lines.push(legacy);
  }
  // 036 终端边界：片段来自模型正文与工具输出，控制序列在命令层出口可见化
  return sanitizeTerminalText(`${lines.join("\n")}\n`);
}
