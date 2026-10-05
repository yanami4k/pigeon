// 会话历史投影（M5 S2，决策 045）：/resume 与重启后渲染全部历史——正文（含 thinking）、轮次标记、工具行与 Run 收尾
// 按会话文件里的顺序交织；安全上限默认 500 行可配，超出时最早部分折叠为一行提示；单条正文有渲染上限；toolResult 默认
// 折叠只显示工具名与摘要。经只读读取器读新会话存储（决策 181），分支会话只画它自己的部分（开头从来源复制的历史属于
// 来源会话）。纯投影：输出结构化行，TUI 渲染面与 cli 的 --with-content 各自排版；终端净化在各自边界（036）。
// 措辞与 TUI 实时流同口径（轮次标记、工具行、thinking 前缀）。
import {
  hasLegacySessionFile,
  LEGACY_READER_HINT,
  loadSessionView,
} from "../persistence/session-catalog.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  PREVIOUS_TRUNCATION_RESUME_PROMPTS,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_RESUME_PROMPT,
} from "../state/runaway-config.ts";
import type { ViewMessage } from "../state/session-view.ts";
import { isStatusMessage, statusSummary } from "../state/status-text.ts";
import { failureBadge, summarizeArgs } from "./format.ts";
import { LOOP_REMINDER_PREFIX } from "./loop-guard.ts";
import { SCRIPT_NOTICE_PREFIX } from "./script-texts.ts";
import { WORKER_NOTICE_PREFIX } from "./worker-notices.ts";

export const DEFAULT_HISTORY_LIMIT = 500;
// 单条正文的渲染上限（字符）：超出折叠并标注，原文用 /search 与读原文工具取
export const DEFAULT_HISTORY_ENTRY_CHARS = 4000;

export type HistoryLineKind =
  | "notice"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "toolResult"
  | "marker";

export interface HistoryLine {
  kind: HistoryLineKind;
  text: string;
}

export interface SessionHistoryOptions {
  limit?: number;
  entryChars?: number;
}

function clip(text: string, chars: number): string {
  return text.length <= chars
    ? text
    : `${text.slice(0, chars)}…（已截断显示，共 ${text.length} 字符）`;
}

// 进模型上下文的程序通知（打转提醒、worker 通知、脚本通知）以用户消息存下；回看时同实时一样显示成系统行
function isProgramNotice(text: string): boolean {
  return (
    text.startsWith(LOOP_REMINDER_PREFIX) ||
    text.startsWith(WORKER_NOTICE_PREFIX) ||
    text.startsWith(SCRIPT_NOTICE_PREFIX)
  );
}

// 撞上限续跑时运行面追加过的提示（现行两种加此前各版）
const CONTINUATION_PROMPTS: ReadonlySet<string> = new Set([
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_RESUME_PROMPT,
  ...PREVIOUS_TRUNCATION_RESUME_PROMPTS,
]);

// 一条消息的正文渲染行（TUI 历史与 cli --with-content 共用）
export function messageLines(
  message: ViewMessage,
  entryChars: number = DEFAULT_HISTORY_ENTRY_CHARS
): HistoryLine[] {
  if (message.role === "system") {
    return [];
  }
  if (message.role === "toolResult") {
    const chars = message.blocks.reduce(
      (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
      0
    );
    return [
      {
        kind: "toolResult",
        text: `[result] ${message.toolName ?? "?"} ${message.isError === true ? "error" : "ok"}（${chars} 字符，已折叠）`,
      },
    ];
  }
  const lines: HistoryLine[] = [];
  const textKind: HistoryLineKind = message.role === "user" ? "user" : "assistant";
  const prefix =
    message.role === "user" ? "> " : message.role === "assistant" ? "" : `[${message.role}] `;
  for (const block of message.blocks) {
    if (block.type === "omitted-thinking") {
      lines.push({ kind: "thinking", text: `~ thinking（未持久化，${block.bytes} 字节）` });
    } else if (block.type === "thinking") {
      lines.push({
        kind: "thinking",
        text: block.redacted
          ? "~ thinking（provider 已编辑）"
          : `~ ${clip(block.thinking, entryChars)}`,
      });
    } else if (block.type === "text") {
      if (block.text.length === 0) {
        continue;
      }
      // 决策 363：开工状态块与状态追加（按消息上的标记认）不是人输入的话，回看时只显示一行（哪几节）
      if (isStatusMessage(message.raw)) {
        lines.push({ kind: "notice", text: statusSummary(block.text) });
        continue;
      }
      // 进模型上下文的程序通知（打转提醒、worker 通知、脚本通知）虽以用户消息存下，回看时同实时一样显示成系统行，不像人输入的话
      if (message.role === "user" && isProgramNotice(block.text)) {
        lines.push({ kind: "notice", text: clip(block.text, entryChars) });
        continue;
      }
      // 撞上限续跑（决策 367）时运行面追加的提示：同样不是人输入的话；旧会话记录里的旧版提示照样认出
      if (message.role === "user" && CONTINUATION_PROMPTS.has(block.text)) {
        lines.push({ kind: "notice", text: `续跑提示：${block.text}` });
        continue;
      }
      lines.push({ kind: textKind, text: `${prefix}${clip(block.text, entryChars)}` });
    } else if (block.type === "image") {
      lines.push({
        kind: textKind,
        text: `${prefix}[image ${block.mimeType} ${block.bytes} 字节]`,
      });
    } else if (block.type === "unknown") {
      lines.push({ kind: textKind, text: `${prefix}[未知块 ${block.originalType}]` });
    }
    // toolCall 块不单独成行：工具行由助手消息之后的工具行给出
  }
  return lines;
}

export function loadSessionHistory(
  root: string,
  sessionId: string,
  options: SessionHistoryOptions = {}
): HistoryLine[] {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const entryChars = options.entryChars ?? DEFAULT_HISTORY_ENTRY_CHARS;
  const sessionsDir = sessionsDirOf(root);
  const view = loadSessionView(sessionsDir, sessionId);
  if (view === undefined) {
    return [
      {
        kind: "notice",
        text: hasLegacySessionFile(sessionsDir, sessionId)
          ? `[旧格式会话（迁移之前创建），这里不显示历史；${LEGACY_READER_HINT}]`
          : "[该会话在会话存储里没有记录，这里不显示历史]",
      },
    ];
  }
  const runBadges = new Map<string, string>(
    view.runs.map((run) => [run.runId, failureBadge(run.failure)])
  );
  const body: HistoryLine[] = [];
  const toolLines = new Map<string, HistoryLine>();
  for (const item of view.items) {
    if (item.kind === "message") {
      const message = item.message;
      if (message.role === "toolResult") {
        // 工具行补上结果（同实时流：先落定、再出结果消息）
        const state = message.isError === true ? "-> error" : "-> ok";
        const existing = toolLines.get(`${message.runId}\n${message.toolCallId ?? ""}`);
        if (existing !== undefined) {
          existing.text += ` ${state}`;
        } else {
          body.push({ kind: "tool", text: `$ ${message.toolName ?? "?"} ${state}` });
        }
      }
      body.push(...messageLines(message, entryChars));
      if (message.role === "assistant") {
        body.push({ kind: "marker", text: `-- turn: ${message.stopReason ?? "?"} --` });
        for (const block of message.blocks) {
          if (block.type === "toolCall") {
            const line: HistoryLine = {
              kind: "tool",
              text: `$ ${block.name} ${summarizeArgs(block.arguments)}`,
            };
            toolLines.set(`${message.runId}\n${block.id}`, line);
            body.push(line);
          }
        }
      }
    } else if (item.kind === "run-end") {
      body.push({
        kind: "marker",
        text: `== run ended | 分类：${runBadges.get(item.data.runId) ?? "未知"} ==`,
      });
    }
  }
  if (body.length <= limit) {
    return body;
  }
  return [
    { kind: "notice", text: `[更早 ${body.length - limit} 条未展开，/search 可查]` },
    ...body.slice(body.length - limit),
  ];
}
