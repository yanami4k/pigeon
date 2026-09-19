// Run 冻结快照（M6 S1，决策 064 子裁决 ⑤）：把被审的那一次 Run 物化成只读快照——对话增量、
// Trace 投影与 Receipt 摘要。Reviewer 的只读范围就绑定在这份快照上：不做跨会话检索（整棵会话树归 M7）。
//
// 两级截断（子裁决 ③ 的实测支撑：8 轮增量中位约 9.2k 字符，正文里 89% 是工具结果，按条截断即可控住输入）：
// - 单条正文超过 ENTRY_TEXT_MAX_CHARS：头尾保留、中间标注省略字符数；
// - 整份增量超过 SNAPSHOT_TOTAL_MAX_CHARS：从最早处整条丢弃并标注省略条数与字符数。
// 两种省略都保留条目号（Run 内 runSeq），可用 review_entry 按号回查原文——省略不等于证据消失。
import {
  materializeSession,
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import type { Receipt } from "../state/receipt.ts";
import { buildSessionTrace, type TraceToolCall } from "../state/trace.ts";

// 单条正文上限（字符）：超出按头尾保留
export const ENTRY_TEXT_MAX_CHARS = 2000;
// 整份增量上限（字符）：超出从最早处丢弃
export const SNAPSHOT_TOTAL_MAX_CHARS = 24_000;
// 增量之外额外带的前情条数（上次审阅点之前保留少量上下文）
export const PRELUDE_ENTRIES = 4;

export interface SnapshotEntry {
  // Run 内条目号（权威键 (runId, runSeq)）：省略与回查都按它定位
  runSeq: number;
  entryId: string;
  role: string;
  toolName?: string;
  isError?: boolean;
  text: string;
  // 本条正文被头尾截断（中间标注了省略字符数）
  truncated: boolean;
  // 落盘时正文块自身已截断（与本模块的截断区分：那是账本里的事实）
  storedTruncated: boolean;
}

export interface SnapshotReceipt {
  receiptId: string;
  executionId: string;
  toolCallId: string;
  approvedBy: string;
  executed: boolean;
  isError: boolean;
  summary: string;
}

export interface RunSnapshot {
  sessionId: SessionId;
  runId: RunId;
  // 增量起点（上次审阅点的条目号）；首次审阅缺省
  sinceRunSeq?: number;
  // 本 Run 已完成的轮次数（turn.completed 计数）
  turns: number;
  entries: SnapshotEntry[];
  toolCalls: TraceToolCall[];
  receipts: SnapshotReceipt[];
  // 从最早处丢弃的条数与字符数（整份超限所致）
  omittedEntries: number;
  omittedChars: number;
}

export interface BuildRunSnapshotInput {
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  // 上次审阅点：只取其后的条目，另带 PRELUDE_ENTRIES 条前情
  sinceRunSeq?: number;
  entryChars?: number;
  totalChars?: number;
}

// 单条正文：头尾保留，中间标注省略字符数（省略处不伪装成完整正文）。M7 提炼器沿用同一口径，回查工具名由调用方给
export function clampText(
  text: string,
  limit: number,
  entryTool = "review_entry"
): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  const omitted = text.length - limit;
  return {
    text: `${text.slice(0, head)}…（省略 ${omitted} 字符，用 ${entryTool} 按条目号回查原文）…${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

// 正文块 → 人读文本：与账本里的落盘截断标记一并带出（§3.3：截断内容不得支撑确定性结论）
export function renderBlocks(record: MessageContentRecord): {
  text: string;
  storedTruncated: boolean;
} {
  const parts: string[] = [];
  let storedTruncated = false;
  for (const block of record.blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      storedTruncated ||= block.truncated;
    } else if (block.type === "thinking") {
      if (block.omitted === true) {
        parts.push("[thinking 未持久化]");
      } else if (block.redacted === true) {
        parts.push("[thinking 已被 provider 编辑]");
      } else {
        parts.push(`[thinking] ${block.thinking}`);
        storedTruncated ||= block.truncated;
      }
    } else if (block.type === "toolCall") {
      parts.push(`[toolCall] ${block.name}`);
    } else if (block.type === "image") {
      parts.push(`[image] ${block.mimeType} ${block.bytes} 字节`);
    } else {
      parts.push(`[未知块 ${block.originalType}]`);
    }
  }
  return { text: parts.join("\n"), storedTruncated };
}

export function buildRunSnapshot(input: BuildRunSnapshotInput): RunSnapshot {
  const entryChars = input.entryChars ?? ENTRY_TEXT_MAX_CHARS;
  const totalChars = input.totalChars ?? SNAPSHOT_TOTAL_MAX_CHARS;
  const session = materializeSession(input.sessionsDir, input.sessionId, { content: false });
  // 正文取自旁置内容文件：记录自带 runId 与 runSeq（与 entry 族同一权威键），按 Run 直接筛
  const contentPath = sessionContentFilePath(input.sessionsDir, input.sessionId);
  const records = readMessageContentFileDetailed(contentPath)
    .records.filter((record) => record.runId === input.runId && record.role !== "system")
    .sort((left, right) => left.runSeq - right.runSeq);
  // 增量起点：上次审阅点之后，另带一小段前情
  const from =
    input.sinceRunSeq !== undefined ? Math.max(1, input.sinceRunSeq - PRELUDE_ENTRIES + 1) : 1;
  const selected = records.filter((record) => record.runSeq >= from);

  const rendered: SnapshotEntry[] = selected.map((record) => {
    const { text, storedTruncated } = renderBlocks(record);
    const clamped = clampText(text, entryChars);
    return {
      runSeq: record.runSeq,
      entryId: record.entryId,
      role: record.role,
      ...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
      ...(record.isError !== undefined ? { isError: record.isError } : {}),
      text: clamped.text,
      truncated: clamped.truncated,
      storedTruncated,
    };
  });

  // 整份超限：从最早处整条丢弃，保留最近的条目（省略条数与字符数如实标注）
  let total = rendered.reduce((sum, entry) => sum + entry.text.length, 0);
  let omittedEntries = 0;
  let omittedChars = 0;
  let start = 0;
  while (total > totalChars && start < rendered.length) {
    const dropped = rendered[start] as SnapshotEntry;
    total -= dropped.text.length;
    omittedChars += dropped.text.length;
    omittedEntries += 1;
    start += 1;
  }
  const entries = rendered.slice(start);

  // Trace 投影（单 Run）：工具调用连同治理记录的挂载关系
  const trace = buildSessionTrace(session, { runId: input.runId });
  const run = trace.runs[0];
  const toolCalls = run?.toolCalls ?? [];
  const turns = (run?.turns ?? []).filter((turn) => turn.completed !== undefined).length;

  // Receipt 摘要：冷物化里的 receipts 被剥了信封，按 Run 汇总须回记录上过滤
  const receipts: SnapshotReceipt[] = session.records
    .filter((record) => record.kind === "receipt" && record.runId === input.runId)
    .map((record) => (record as { receipt: Receipt }).receipt)
    .map((receipt) => ({
      receiptId: receipt.id,
      executionId: receipt.executionId,
      toolCallId: receipt.toolCallId,
      approvedBy: receipt.approvedBy,
      executed: receipt.executed,
      isError: receipt.isError,
      summary: receipt.summary,
    }));

  return {
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.sinceRunSeq !== undefined ? { sinceRunSeq: input.sinceRunSeq } : {}),
    turns,
    entries,
    toolCalls,
    receipts,
    omittedEntries,
    omittedChars,
  };
}
