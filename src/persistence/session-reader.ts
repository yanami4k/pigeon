// 新会话存储的只读读取器（决策 181 / 210）：凡读非本进程所写会话的地方都用它，只有正在写该会话的进程用 pi 的打开。
// pi 的打开遇到写了一半的末行会原子改写文件删去它；读一个正被另一进程追加的会话时，这会删掉对方刚写到一半的行，
// 写者下一条接上后文件断号、此后无法加载。本读取器从不写文件：
// - 逐行解析文件头（pi v4）与各条变更（entry / record / lane / fact），按 seq 重放出条目、通道、会话名与标签；
// - 不完整的末行跳过、不告警（写者可能正在追加它）；
// - 不认识的条目类型、record 类型与变更种类记告警并跳过这一条，不让整个文件读失败；被跳过的条目从树上摘掉，
//   以它为父的条目改接到它的父条目上，指向它的通道回退到它的父条目；中段坏行同样告警跳过。
// 会话文件照 pi 原生布局存放：<会话根>/--<工作目录编码>--/<创建时间>_<会话号>.jsonl。按会话号定位靠列目录匹配文件名，
// 不逐个读文件首行；会话根下遗留的旧格式平铺文件（sess_*.jsonl 等）不在任何子目录里，不会被列举。
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { SessionEntryType } from "../state/session-entries.ts";

// pi v4 的七种条目类型与九种 record 类型（上游读盘白名单，pi-agent-core 0.84.4 jsonl/codec.js）
const ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "active_tools_change",
  "compaction",
  "branch_summary",
  "custom",
]);
const RECORD_TYPES: ReadonlySet<string> = new Set([
  "operation_started",
  "abort_requested",
  "operation_finished",
  "step_attempt",
  "tool_started",
  "queue_enqueued",
  "queue_cancelled",
  "write_deferred",
  "usage",
]);

// 会话号与文件名（同上游 jsonl/repo.js：会话号只含字母数字与 . _ -，首尾为字母数字；时间为 ISO 串、冒号与点换成短横）
const SESSION_FILE_NAME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\.jsonl$/;

// 工作目录 → 会话根下的子目录名（同上游 jsonlSessionDirectoryName）
export function sessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// 创建时间与会话号 → 文件名（同上游 sessionFileName）
export function sessionFileName(createdAt: number, sessionId: string): string {
  return `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

export interface SessionFileRef {
  sessionId: string;
  path: string;
  // 文件名里的创建时间（毫秒）
  createdAt: number;
}

function parseFileName(name: string): { sessionId: string; createdAt: number } | undefined {
  const match = SESSION_FILE_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [date, time] = (match[1] ?? "").split("T");
  const [hh, mm, ss, ms] = (time ?? "").replace(/Z$/, "").split("-");
  const createdAt = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(createdAt) ? undefined : { sessionId: match[2] ?? "", createdAt };
}

// 列出会话根下全部会话文件（按创建时间、再按路径排序）。只看文件名，不读内容；会话根不存在即空清单
export function listSessionFiles(sessionsRoot: string): SessionFileRef[] {
  if (!existsSync(sessionsRoot)) {
    return [];
  }
  const files: SessionFileRef[] = [];
  for (const directory of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      continue;
    }
    const directoryPath = join(sessionsRoot, directory.name);
    for (const file of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!file.isFile()) {
        continue;
      }
      const parsed = parseFileName(file.name);
      if (parsed !== undefined) {
        files.push({ ...parsed, path: join(directoryPath, file.name) });
      }
    }
  }
  return files.sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));
}

// 按会话号定位会话文件（会话号精确匹配）
export function locateSessionFile(
  sessionsRoot: string,
  sessionId: string
): SessionFileRef | undefined {
  return listSessionFiles(sessionsRoot).find((file) => file.sessionId === sessionId);
}

export interface SessionHeaderView {
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
}

// 树上的一条条目：pi 条目的公共字段加该类型的其余字段（message 条目的 message、custom 条目的 customType 与 data 等）
export interface StoredEntry {
  type: string;
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  [field: string]: unknown;
}

export interface SessionFileView {
  path: string;
  header: SessionHeaderView;
  // 按 seq 排列的条目（被跳过的不在其中）
  entries: StoredEntry[];
  entriesById: ReadonlyMap<string, StoredEntry>;
  // 通道 → 叶条目
  lanes: ReadonlyMap<string, string | null>;
  name?: string;
  labels: ReadonlyMap<string, string>;
  // 被跳过的行的说明（第几行、为什么）
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(line: string): SessionHeaderView | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.kind !== "header" ||
    value.version !== 4 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.cwd !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    cwd: value.cwd,
    ...(typeof value.parentSessionId === "string"
      ? { parentSessionId: value.parentSessionId }
      : {}),
    ...(isObject(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

// 决策 304：只读会话文件的文件头（首行），不读全文——会话树在全部会话里找一家人时用。按块读到首个换行为止，
// 首行超过上限、文件头不合法或读不了返回 undefined。从不写文件
const HEADER_READ_LIMIT = 1 << 20;

export function readSessionHeader(path: string): SessionHeaderView | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(16 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const piece = chunk.subarray(0, read);
      const newline = piece.indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(piece.subarray(0, newline)));
        return parseHeader(Buffer.concat(chunks).toString("utf8"));
      }
      chunks.push(Buffer.from(piece));
      total += read;
      if (total > HEADER_READ_LIMIT) return undefined;
    }
    // 只有一行且没有换行：写者可能正写着文件头
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 读一个会话文件；没有合法文件头（空文件、文件头写了一半、版本不是 4）返回 undefined。从不写文件
export function readSessionFile(path: string): SessionFileView | undefined {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const header = lines.length > 0 ? parseHeader(lines[0] ?? "") : undefined;
  if (header === undefined) {
    return undefined;
  }
  const entries: StoredEntry[] = [];
  const entriesById = new Map<string, StoredEntry>();
  const usedIds = new Set<string>();
  // 被跳过的条目 → 它（解析后）的父条目：子条目与通道经它改接
  const spliced = new Map<string, string | null>();
  const lanes = new Map<string, string | null>([["main", null]]);
  const labels = new Map<string, string>();
  let name: string | undefined;
  const warnings: string[] = [];
  let lastSeq = 0;
  const resolve = (id: string | null): string | null =>
    id !== null && spliced.has(id) ? (spliced.get(id) ?? null) : id;

  for (let index = 1; index < lines.length; index++) {
    const lineNo = index + 1;
    const skip = (reason: string) => warnings.push(`第 ${lineNo} 行${reason}，已跳过`);
    let value: unknown;
    try {
      value = JSON.parse(lines[index] ?? "");
    } catch {
      // 不完整的末行：写者可能正在追加它，照 181 跳过、不告警
      if (index !== lines.length - 1) {
        skip("不是合法 JSON");
      }
      continue;
    }
    if (!isObject(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) <= lastSeq) {
      skip("缺少递增的 seq");
      continue;
    }
    const seq = value.seq as number;
    lastSeq = seq;
    if (value.kind === "entry") {
      const type = value.type;
      const id = value.id;
      if (typeof id !== "string" || typeof type !== "string") {
        skip("的条目缺少 id 或类型");
        continue;
      }
      const parentId = resolve(typeof value.parentId === "string" ? value.parentId : null);
      if (!ENTRY_TYPES.has(type)) {
        spliced.set(id, parentId);
        for (const [lane, leaf] of lanes) {
          if (leaf === id) lanes.set(lane, parentId);
        }
        skip(`是不认识的条目类型 ${type}`);
        continue;
      }
      if (usedIds.has(id)) {
        skip(`的条目号 ${id} 重复`);
        continue;
      }
      const { kind: _kind, lane, ...fields } = value;
      const entry = { ...fields, type, id, parentId, seq } as StoredEntry;
      usedIds.add(id);
      entries.push(entry);
      entriesById.set(id, entry);
      if (typeof lane === "string") {
        lanes.set(lane, id);
      }
    } else if (value.kind === "record") {
      if (typeof value.type !== "string" || !RECORD_TYPES.has(value.type)) {
        skip(`是不认识的 record 类型 ${String(value.type)}`);
        continue;
      }
      if (typeof value.id === "string") {
        usedIds.add(value.id);
      }
    } else if (value.kind === "lane") {
      if (typeof value.lane !== "string") {
        skip("的通道变更缺少通道名");
        continue;
      }
      lanes.set(value.lane, resolve(typeof value.leafId === "string" ? value.leafId : null));
    } else if (value.kind === "fact") {
      if (value.fact === "name") {
        name = typeof value.name === "string" ? value.name : undefined;
      } else if (value.fact === "label" && typeof value.targetId === "string") {
        if (typeof value.label === "string") {
          labels.set(value.targetId, value.label);
        } else {
          labels.delete(value.targetId);
        }
      } else {
        skip(`是不认识的事实种类 ${String(value.fact)}`);
      }
    } else {
      skip(`是不认识的变更种类 ${String(value.kind)}`);
    }
  }
  return {
    path,
    header,
    entries,
    entriesById,
    lanes,
    ...(name !== undefined ? { name } : {}),
    labels,
    warnings,
  };
}

// 从根到某条目（含）的分支条目；leafId 为 null 即空分支。父条目缺失时止于断处
export function branchEntries(view: SessionFileView, leafId: string | null): StoredEntry[] {
  const path: StoredEntry[] = [];
  const visited = new Set<string>();
  let current = leafId === null ? undefined : view.entriesById.get(leafId);
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : view.entriesById.get(current.parentId);
  }
  return path.reverse();
}

// 分叉点 (runId, runSeq) 在一条分支上对应的消息条目号：Run 开始条目之后按消息条数数到第 runSeq 条。
// 条目号 runSeq 从 1 起、每条消息都占一个（含中止与上游合成的失败消息），与运行面的累计序号一致
export function messageEntryAt(
  branch: readonly StoredEntry[],
  runId: string,
  runSeq: number
): string | undefined {
  let inRun = false;
  let count = 0;
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SessionEntryType.RunStart) {
      inRun = isObject(entry.data) && entry.data.runId === runId;
      count = 0;
    } else if (inRun && entry.type === "message") {
      count += 1;
      if (count === runSeq) {
        return entry.id;
      }
    }
  }
  return undefined;
}
