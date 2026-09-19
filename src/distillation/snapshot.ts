// 提炼器输入快照（M7 S4，决策 076）：把一组尝试物化成冻结的对比输入。
// - 沿用 M6 单条正文截断（头尾保留、标注省略字符数）；
// - 每侧上限 24,000 字符，共享前缀另设 12,000 字符上限（076 修订），超出从最早处整条丢弃并标注省略条数与字符数；
// - 任务描述只喂一次：任务所在那条（task 指向的会话、Run 的第 1 条）在前缀与两侧里一律不再重复；
// - 分叉场景以分叉点为界：共享前缀单列、只喂一次，来源侧从分叉点之后开始；
// - 独立尝试不做分歧步对齐：两侧按各自条目号原样列出；
// - Run 内局部对（人写拒绝、域错误后紧跟的成功重试，决策 073）按侧单列，只取范围内的。
// 省略处保留条目号，可用 distill_entry 按侧与条目号回查原文。
import path from "node:path";
import {
  materializeSession,
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import {
  clampText,
  ENTRY_TEXT_MAX_CHARS,
  renderBlocks,
  type SnapshotEntry,
} from "../review/snapshot.ts";
import type { DistillAttemptScope, DistillTarget } from "../state/distill.ts";
import { DISTILL_ENTRY_TOOL } from "../state/distill.ts";
import { collectLocalPairs, type LocalPair } from "../state/episode.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { MessageContentRecord } from "../state/message-content.ts";

// 每侧上限（字符）：超出从最早处丢弃
export const DISTILL_SIDE_MAX_CHARS = 24_000;
// 共享前缀上限（决策 076 修订）：两侧是对照物本身，削任一侧都使对比失真；前缀是背景，削它最安全。
// 最坏总量由约 72,000 字符降到约 60,000，给提炼器的推理与产出留余量
export const DISTILL_PREFIX_MAX_CHARS = 12_000;

export interface DistillSectionSnapshot {
  sessionId: SessionId;
  runId: RunId;
  from: number;
  to: number;
  entries: SnapshotEntry[];
  omittedEntries: number;
  omittedChars: number;
}

export interface DistillSideSnapshot extends DistillSectionSnapshot {
  label: string;
  localPairs: LocalPair[];
}

export interface DistillSnapshot {
  target: DistillTarget;
  taskText?: string;
  prefix?: DistillSectionSnapshot;
  successful?: DistillSideSnapshot;
  failed?: DistillSideSnapshot;
}

export function sessionsDirOf(governanceRoot: string): string {
  return path.join(governanceRoot, ".pigeon", "sessions");
}

// 一次 Run 的正文记录（按条目号升序，不含 system prompt 记录）
export function runContentRecords(
  governanceRoot: string,
  sessionId: SessionId,
  runId: RunId
): MessageContentRecord[] {
  return readMessageContentFileDetailed(
    sessionContentFilePath(sessionsDirOf(governanceRoot), sessionId)
  )
    .records.filter((record) => record.runId === runId && record.role !== "system")
    .sort((left, right) => left.runSeq - right.runSeq);
}

// 同任务比对：每次尝试的第 1 条都是同一任务描述，两侧一律不重复；分叉：只跳过任务所在的那一条
function isTaskEntry(target: DistillTarget, sessionId: SessionId, runId: RunId, runSeq: number) {
  if (runSeq !== 1) {
    return false;
  }
  return (
    target.kind === "task" || (target.task.sessionId === sessionId && target.task.runId === runId)
  );
}

function section(
  target: DistillTarget,
  scope: { governanceRoot: string; sessionId: SessionId; runId: RunId; from: number; to: number },
  records: readonly MessageContentRecord[],
  maxChars: number
): DistillSectionSnapshot {
  const rendered: SnapshotEntry[] = records
    .filter(
      (record) =>
        record.runSeq >= scope.from &&
        record.runSeq <= scope.to &&
        !isTaskEntry(target, scope.sessionId, scope.runId, record.runSeq)
    )
    .map((record) => {
      const { text, storedTruncated } = renderBlocks(record);
      const clamped = clampText(text, ENTRY_TEXT_MAX_CHARS, DISTILL_ENTRY_TOOL);
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
  let total = rendered.reduce((sum, entry) => sum + entry.text.length, 0);
  let omittedEntries = 0;
  let omittedChars = 0;
  let start = 0;
  while (total > maxChars && start < rendered.length) {
    const dropped = rendered[start] as SnapshotEntry;
    total -= dropped.text.length;
    omittedChars += dropped.text.length;
    omittedEntries += 1;
    start += 1;
  }
  return {
    sessionId: scope.sessionId,
    runId: scope.runId,
    from: scope.from,
    to: scope.to,
    entries: rendered.slice(start),
    omittedEntries,
    omittedChars,
  };
}

function side(target: DistillTarget, scope: DistillAttemptScope): DistillSideSnapshot {
  const records = runContentRecords(scope.governanceRoot, scope.sessionId, scope.runId);
  const toolResultSeqs = new Map<string, number>();
  for (const record of records) {
    if (record.toolCallId !== undefined) {
      toolResultSeqs.set(record.toolCallId, record.runSeq);
    }
  }
  const session = materializeSession(sessionsDirOf(scope.governanceRoot), scope.sessionId, {
    content: false,
  });
  const inRange = (runSeq: number | undefined) =>
    runSeq === undefined || (runSeq >= scope.from && runSeq <= scope.to);
  const localPairs = collectLocalPairs(session, scope.runId, toolResultSeqs).filter((pair) =>
    inRange(pair.runSeq)
  );
  return {
    ...section(target, scope, records, DISTILL_SIDE_MAX_CHARS),
    label: scope.label,
    localPairs,
  };
}

export function buildDistillSnapshot(target: DistillTarget): DistillSnapshot {
  const taskRecord = runContentRecords(
    target.task.governanceRoot,
    target.task.sessionId,
    target.task.runId
  ).find((record) => record.runSeq === 1);
  const prefix = target.sharedPrefix;
  return {
    target,
    ...(taskRecord !== undefined ? { taskText: renderBlocks(taskRecord).text } : {}),
    ...(prefix !== undefined
      ? {
          prefix: section(
            target,
            prefix,
            runContentRecords(prefix.governanceRoot, prefix.sessionId, prefix.runId),
            DISTILL_PREFIX_MAX_CHARS
          ),
        }
      : {}),
    ...(target.successful !== undefined ? { successful: side(target, target.successful) } : {}),
    ...(target.failed !== undefined ? { failed: side(target, target.failed) } : {}),
  };
}

function renderEntries(lines: string[], snapshot: DistillSectionSnapshot): void {
  if (snapshot.omittedEntries > 0) {
    lines.push(
      `（最早的 ${snapshot.omittedEntries} 条已省略，共 ${snapshot.omittedChars} 字符；需要时用 ${DISTILL_ENTRY_TOOL} 按条目号回查）`
    );
  }
  for (const entry of snapshot.entries) {
    const tool =
      entry.toolName !== undefined
        ? `（${entry.toolName}${entry.isError === true ? "，出错" : ""}）`
        : "";
    const stored = entry.storedTruncated ? "（落盘时已截断）" : "";
    lines.push(`[第 ${entry.runSeq} 条 ${entry.role}${tool}]${stored}`, entry.text);
  }
}

function renderLocalPairs(lines: string[], pairs: readonly LocalPair[]): void {
  if (pairs.length === 0) {
    return;
  }
  lines.push("Run 内局部对（只可提炼为教训）：");
  for (const pair of pairs) {
    if (pair.kind === "human-rejection") {
      lines.push(
        `- 人写拒绝：${pair.toolName}${pair.runSeq !== undefined ? `（第 ${pair.runSeq} 条）` : ""}，理由：${pair.reason}`
      );
    } else {
      lines.push(
        `- 域错误后成功重试：${pair.toolName} 第 ${pair.failedRunSeq ?? "?"} 条出错 → 第 ${pair.runSeq ?? "?"} 条成功`
      );
    }
  }
}

function renderSide(lines: string[], name: string, snapshot: DistillSideSnapshot): void {
  lines.push(
    `--- ${name}（标签 ${snapshot.label}，会话 ${snapshot.sessionId}，${snapshot.runId}，第 ${snapshot.from}–${snapshot.to} 条）---`
  );
  renderEntries(lines, snapshot);
  renderLocalPairs(lines, snapshot.localPairs);
}

export function renderDistillSnapshot(snapshot: DistillSnapshot): string {
  const { target } = snapshot;
  const lines = [
    target.kind === "task"
      ? `提炼对象：同一任务的独立尝试${target.taskKey !== undefined ? `（任务标识 ${target.taskKey}）` : ""}；两侧按各自条目号列出，不做步骤对齐`
      : "提炼对象：会话树分叉；共享前缀之后两条分支各自走的路",
    "--- 任务描述（只出现一次）---",
    snapshot.taskText ?? "（任务描述缺失）",
  ];
  if (snapshot.prefix !== undefined) {
    lines.push(
      `--- 共享前缀（分叉点之前，两侧共有，只出现一次；第 ${snapshot.prefix.from}–${snapshot.prefix.to} 条）---`
    );
    renderEntries(lines, snapshot.prefix);
  }
  if (snapshot.successful !== undefined) {
    renderSide(lines, "成功侧", snapshot.successful);
  } else {
    lines.push("--- 成功侧：无（只能提炼教训）---");
  }
  if (snapshot.failed !== undefined) {
    renderSide(lines, "失败侧", snapshot.failed);
  } else {
    lines.push("--- 失败侧：无 ---");
  }
  if (target.others.length > 0) {
    lines.push("--- 其余同组尝试（不进对比，仅供参考）---");
    for (const other of target.others) {
      lines.push(`- 会话 ${other.sessionId} ${other.runId}：${other.label}`);
    }
  }
  return lines.join("\n");
}
