// 会话历史投影（M5 S2，决策 045）：/resume 与重启后渲染全部历史——正文（含 thinking）与治理
// 投影按落盘时序交织；安全上限默认 500 行可配，超出时最早部分折叠为一行提示；单条正文有渲染
// 上限；toolResult 默认折叠只显示工具名与摘要；无 contentHash 的旧会话头部提示"M5 前会话，
// 无正文"，治理投影照画。纯投影：输出结构化行，TUI 渲染面与 cli 的 --with-content 各自排版；
// 终端净化在各自边界（036）。措辞与 TUI 实时流同口径（轮次标记、工具行、thinking 前缀）。
import { join } from "node:path";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import { asSessionId } from "../state/ids.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import { failureBadge, summarizeArgs } from "./format.ts";

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

const DISK_TRUNCATED = "（落盘时已截断）";

// 一条内容记录的渲染行（TUI 历史与 cli --with-content 共用）
export function contentRecordLines(
  record: MessageContentRecord,
  entryChars: number = DEFAULT_HISTORY_ENTRY_CHARS
): HistoryLine[] {
  if (record.role === "system") {
    return [];
  }
  if (record.role === "toolResult") {
    const chars = record.blocks.reduce(
      (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
      0
    );
    return [
      {
        kind: "toolResult",
        text: `[result] ${record.toolName ?? "?"} ${record.isError === true ? "error" : "ok"}（${chars} 字符，已折叠）`,
      },
    ];
  }
  const lines: HistoryLine[] = [];
  const textKind: HistoryLineKind = record.role === "user" ? "user" : "assistant";
  const prefix =
    record.role === "user" ? "> " : record.role === "assistant" ? "" : `[${record.role}] `;
  for (const block of record.blocks) {
    if (block.type === "thinking") {
      if (block.omitted === true) {
        lines.push({ kind: "thinking", text: `~ thinking（未持久化，${block.bytes ?? 0} 字节）` });
      } else if (block.redacted === true) {
        lines.push({ kind: "thinking", text: "~ thinking（provider 已编辑）" });
      } else {
        lines.push({
          kind: "thinking",
          text: `~ ${clip(block.thinking, entryChars)}${block.truncated ? DISK_TRUNCATED : ""}`,
        });
      }
    } else if (block.type === "text") {
      if (block.text.length === 0) {
        continue;
      }
      lines.push({
        kind: textKind,
        text: `${prefix}${clip(block.text, entryChars)}${block.truncated ? DISK_TRUNCATED : ""}`,
      });
    } else if (block.type === "image") {
      lines.push({
        kind: textKind,
        text: `${prefix}[image ${block.mimeType} ${block.bytes} 字节]`,
      });
    } else if (block.type === "unknown") {
      lines.push({ kind: textKind, text: `${prefix}[未知块 ${block.originalType}]` });
    }
    // toolCall 块不单独成行：工具行由 tool.proposed / tool.settled 投影给出
  }
  return lines;
}

// 会话内容记录：entryId → 记录（同一 entryId 多条时以最后一条为准）
export function loadContentRecords(
  root: string,
  sessionId: string
): ReadonlyMap<string, MessageContentRecord> {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const path = JsonlEventLog.contentFilePathFor(sessionsDir, asSessionId(sessionId));
  const records = new Map<string, MessageContentRecord>();
  for (const record of readMessageContentFileDetailed(path).records) {
    records.set(record.entryId, record);
  }
  return records;
}

export function loadSessionHistory(
  root: string,
  sessionId: string,
  options: SessionHistoryOptions = {}
): HistoryLine[] {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const entryChars = options.entryChars ?? DEFAULT_HISTORY_ENTRY_CHARS;
  const sessionsDir = join(root, ".pigeon", "sessions");
  const materialized = materializeSession(sessionsDir, asSessionId(sessionId));
  const contents = loadContentRecords(root, sessionId);
  const gapEntries = new Set<string>(materialized.contentGaps.map((gap) => gap.entryId));
  const runBadges = new Map<string, string>(
    materialized.classification.runs.map((run) => [run.runId, failureBadge(run.failure)])
  );
  const body: HistoryLine[] = [];
  const toolLines = new Map<string, HistoryLine>();
  let legacyEntries = 0;
  for (const record of materialized.records) {
    switch (record.kind) {
      case "entry": {
        if (record.contentHash === undefined) {
          legacyEntries += 1;
          break;
        }
        const content = contents.get(record.id);
        if (gapEntries.has(record.id) || content === undefined) {
          body.push({
            kind: "notice",
            text: `[正文缺失] 第 ${record.runSeq} 条 ${record.role}（内容文件无记录或哈希不符）`,
          });
          break;
        }
        body.push(...contentRecordLines(content, entryChars));
        break;
      }
      case "turn.completed":
        body.push({ kind: "marker", text: `-- turn: ${record.payload.stopReason} --` });
        break;
      case "tool.proposed": {
        const line: HistoryLine = {
          kind: "tool",
          text: `$ ${record.payload.toolName} ${summarizeArgs(record.payload.args)}`,
        };
        toolLines.set(`${record.runId}\n${record.payload.toolCallId}`, line);
        body.push(line);
        break;
      }
      case "tool.settled": {
        const payload = record.payload;
        const state = payload.isError
          ? `-> error${payload.errorKind !== undefined ? ` [${payload.errorKind}]` : ""}`
          : "-> ok";
        const existing = toolLines.get(`${record.runId}\n${payload.toolCallId}`);
        if (existing !== undefined) {
          existing.text += ` ${state}`;
        } else {
          body.push({ kind: "tool", text: `$ ${payload.toolName} ${state}` });
        }
        break;
      }
      case "decision":
        body.push({
          kind: "marker",
          text: `[已拒绝] ${record.toolName}：${record.decision.reason ?? "无理由"}`,
        });
        break;
      case "run.ended":
        body.push({
          kind: "marker",
          text: `== run ended | 分类：${runBadges.get(record.runId) ?? "未知"} ==`,
        });
        break;
      default:
        break;
    }
  }
  const lines: HistoryLine[] = [];
  if (legacyEntries > 0) {
    lines.push({
      kind: "notice",
      text:
        legacyEntries === materialized.entries.length
          ? "[M5 前会话，无正文：以下只有治理投影]"
          : `[其中 ${legacyEntries} 条为 M5 前记录，无正文]`,
    });
  }
  if (body.length > limit) {
    lines.push({
      kind: "notice",
      text: `[更早 ${body.length - limit} 条未展开，/search 可查]`,
    });
    lines.push(...body.slice(body.length - limit));
  } else {
    lines.push(...body);
  }
  return lines;
}
