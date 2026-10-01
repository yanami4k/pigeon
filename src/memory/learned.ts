// 学到的记忆的文件格式（决策 190、229）：.pigeon/learned/MEMORY.md，文件头为标题加一行注释，其后每条三行——
// 带编号的事实、引用、理由。本模块只做纯函数：解析、序列化、计字符、按条新增替换删除与写满判定，无 IO。
// - 逐字往返：解析保留文件头原文与"最后一条之后有没有换行"，未改动的文件序列化回去逐字相同。
// - 条目区从第一个以"- "开头的行起，到文件尾都必须是规范的三行一组；不合规即报出第一处不对的行号（人手改坏时
//   工具据此拒绝写入，推送照原文推入）。文件头只认第一个"- "行之前的内容，原样保留、不校验。
// - 上限只计条目区（文件头不计），单位为字符，按 Unicode 码点计（191、223）。
// - 编号 L<n> 由工具分配、删除后不复用（229）；"下一个编号"另存（见 learned-store.ts），这里只给出按现有最大编号的下限。

export const MEMORY_FILE_NAME = "MEMORY.md";
// 展示路径（推送段、Run 开始条目与工具说明里的写法）
export const MEMORY_DISPLAY_PATH = pigeonRel("state", "learned", "MEMORY.md");
// 上限缺省：223 按校准实测定取值规则之前，临时取 12,000 字符
export const DEFAULT_MEMORY_LIMIT_CHARS = 12_000;

// 文件头（229，B 第 5 节原文）：新建文件时写入；已有文件的文件头原样保留
import { pigeonRel } from "../state/paths.ts";
export const MEMORY_FILE_HEADER =
  "# 学到的记忆\n" +
  "<!-- 由 Pigeon 的 update_memory 维护，也可以直接查看、修改、删除。每条三行：事实 / 引用 / 理由；编号只用于定位，不表示先后或重要性。 -->\n" +
  "\n";

export interface MemoryEntry {
  id: number;
  fact: string;
  refs: string[];
  reason: string;
}

export interface MemoryDocument {
  // 第一条之前的原文（含换行）
  header: string;
  entries: MemoryEntry[];
  // 最后一条之后有没有换行（逐字往返用；工具写入时一律补上）
  finalNewline: boolean;
}

export type ParsedMemory =
  | { ok: true; doc: MemoryDocument }
  // line：第一处格式不对的行号（从 1 起）
  | { ok: false; line: number };

const FACT_LINE = /^- \[L([1-9]\d*)\] 事实：(.+)$/;
const REFS_LINE = /^ {2}引用：(.+)$/;
const REASON_LINE = /^ {2}理由：(.+)$/;
const REFS_SEPARATOR = ", ";

// 条目区的起点：第一个以"- "开头的行的字符偏移；没有即 -1
function entriesOffset(text: string): number {
  if (text.startsWith("- ")) {
    return 0;
  }
  const found = text.indexOf("\n- ");
  return found < 0 ? -1 : found + 1;
}

export function parseMemory(text: string): ParsedMemory {
  const offset = entriesOffset(text);
  if (offset < 0) {
    return { ok: true, doc: { header: text, entries: [], finalNewline: false } };
  }
  const header = text.slice(0, offset);
  const firstLine = header === "" ? 1 : header.split("\n").length;
  const lines = text.slice(offset).split("\n");
  // 以换行结尾时 split 多出一个空串：它表示"最后一条之后有换行"，不是一行内容
  const finalNewline = lines.at(-1) === "";
  if (finalNewline) {
    lines.pop();
  }
  const entries: MemoryEntry[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < lines.length; index += 3) {
    const fact = FACT_LINE.exec(lines[index] ?? "");
    if (fact === null) {
      return { ok: false, line: firstLine + index };
    }
    const id = Number(fact[1]);
    if (!Number.isSafeInteger(id) || seen.has(id)) {
      return { ok: false, line: firstLine + index };
    }
    const refs = index + 1 < lines.length ? REFS_LINE.exec(lines[index + 1] ?? "") : null;
    if (refs === null) {
      return { ok: false, line: firstLine + index + 1 };
    }
    const reason = index + 2 < lines.length ? REASON_LINE.exec(lines[index + 2] ?? "") : null;
    if (reason === null) {
      return { ok: false, line: firstLine + index + 2 };
    }
    seen.add(id);
    entries.push({
      id,
      fact: fact[2] as string,
      refs: (refs[1] as string).split(REFS_SEPARATOR),
      reason: reason[1] as string,
    });
  }
  return { ok: true, doc: { header, entries, finalNewline } };
}

export function entryId(id: number): string {
  return `L${id}`;
}

export function serializeEntry(entry: MemoryEntry): string {
  return (
    `- [${entryId(entry.id)}] 事实：${entry.fact}\n` +
    `  引用：${entry.refs.join(REFS_SEPARATOR)}\n` +
    `  理由：${entry.reason}`
  );
}

// 条目区的原文：各条之间以换行相接，按 finalNewline 决定末尾有无换行；没有条目为空串
export function serializeEntries(entries: readonly MemoryEntry[], finalNewline: boolean): string {
  if (entries.length === 0) {
    return "";
  }
  return entries.map(serializeEntry).join("\n") + (finalNewline ? "\n" : "");
}

export function serializeMemory(doc: MemoryDocument): string {
  return doc.header + serializeEntries(doc.entries, doc.finalNewline);
}

// 字符数：按 Unicode 码点计
export function countChars(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

// 文件原文的条目区（第一个"- "行起到文件尾）：推送照它原样放入，上限与条数都按它算。格式坏了也照原文取
export function entriesSection(text: string): string {
  const offset = entriesOffset(text);
  return offset < 0 ? "" : text.slice(offset);
}

// 按原文算的条目事实（格式坏了也能算）：条数为以"- [L编号]"开头的行数，字符数为条目区的码点数
export function memoryFactsOfText(text: string): { entries: number; entryChars: number } {
  const section = entriesSection(text);
  return {
    entries: (section.match(/^- \[L\d+\]/gm) ?? []).length,
    entryChars: countChars(section),
  };
}

// 写入后的文件原文：文件头不以换行结尾时补一个（否则第一条会接在文件头最后一行后面），末尾一律带换行
export function renderForWrite(doc: MemoryDocument): string {
  const header = doc.header === "" || doc.header.endsWith("\n") ? doc.header : `${doc.header}\n`;
  return header + serializeEntries(doc.entries, true);
}

// 条目区的已用字符数（按写入后的样子算：末尾带换行）
export function usedChars(entries: readonly MemoryEntry[]): number {
  return countChars(serializeEntries(entries, true));
}

// 一条的字符数（连同它结尾的换行，即加入条目区时增加的量）
export function entryChars(entry: MemoryEntry): number {
  return countChars(serializeEntry(entry)) + 1;
}

// 下一个编号的下限：现有最大编号加一
export function nextIdFloor(entries: readonly MemoryEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

// 两条完全相同：事实、引用、理由三项都相同
export function sameContent(
  a: Pick<MemoryEntry, "fact" | "refs" | "reason">,
  b: Pick<MemoryEntry, "fact" | "refs" | "reason">
): boolean {
  return (
    a.fact === b.fact &&
    a.reason === b.reason &&
    a.refs.length === b.refs.length &&
    a.refs.every((ref, index) => ref === b.refs[index])
  );
}
