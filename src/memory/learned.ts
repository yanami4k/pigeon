// 学到的记忆的文件格式（决策 332、431）：两层各一个文件——项目级 .pigeon/state/memory.md、用户级 ~/.pigeon/state/memory.md。
// 文件头为标题加一行注释（英文），其后一行一条：`- [P3] 内容 (recorded 2026-10-01 · tui · session sess_…)`。agent 只写内容，
// 编号、日期、来源（入口的英文短名）与会话编号由工具补上；尾巴一段可缺（人手加的条目），编号不可缺。本模块只做纯函数：解析、
// 序列化、计字符与写满判定，无 IO。决策 431 之前的旧格式（中文文件头、〔日期 · 终端界面 · 会话 X〕尾巴）只由迁移代码
// （memory-migration.ts）认读并一次性改写，这里只认新格式。
// - 编号：项目级以 P 开头、用户级以 U 开头，后接正整数；一层之内不重复。新编号取现有最大编号加一，且删掉的编号
//   不再分配（决策 382：已分配过的最大编号另记在 memory.md 旁的 .maxid 小文件里，见 update-memory-tool.ts）。
// - 逐字往返：解析保留文件头原文与最后一条之后的换行、空行（文件尾），规范写法的文件序列化回去逐字相同。
// - 尾巴：行末最后一段 ` (recorded 日期 · 来源 · session 会话号)` 才算；内容本身可以带任何括号，连同形如尾巴的文字——
//   内容在前、尾巴取最后一段，工具写入的条目总带一段真尾巴，解析时内容里那段原样留在内容里。没有尾巴的人手条目若以形如
//   尾巴的文字结尾，即按尾巴读出，序列化回去逐字相同。
// - 条目区从第一个以"- "开头的行起，到文件尾都必须是规范的条目行；不合规即报出第一处不对的行号（人手改坏时工具据此拒绝
//   写入，推送照原文推入）。文件头只认第一个"- "行之前的内容，原样保留、不校验。
// - 上限只计条目区（文件头不计），单位为字符，按 Unicode 码点计；尾巴一段也计在内（它同样推送给模型）。

import { pigeonRel, userPigeonRel } from "../state/paths.ts";

export type MemoryLayer = "project" | "user";
export const MEMORY_LAYERS: readonly MemoryLayer[] = ["project", "user"];

// 编号前缀与给人看的层名
export const MEMORY_LAYER_PREFIX: Readonly<Record<MemoryLayer, string>> = {
  project: "P",
  user: "U",
};
export const MEMORY_LAYER_LABELS: Readonly<Record<MemoryLayer, string>> = {
  project: "项目级",
  user: "用户级",
};

// 展示路径（推送段、工具说明与 /memory 里的写法）
export const MEMORY_DISPLAY_PATHS: Readonly<Record<MemoryLayer, string>> = {
  project: pigeonRel("state", "memory.md"),
  user: userPigeonRel("state", "memory.md"),
};

// 记忆文字的版本（推送段、工具说明、写满被拒的文字）：随 Run 开始条目落盘。v1 为决策 191–233 的原文（三行一条、单层），
// v2 为决策 328、329、331、332 的文字；v3 为决策 363 改的几句（推送段搬进开工状态块，会话中被改动时整段追加）；
// v4 为决策 428 的英文改写（意思逐句照旧；记忆文件的文件头与条目尾巴是落盘格式，不在其列）；v5 为决策 431：条目尾巴改为
// 英文的 (recorded 日期 · 来源 · session 会话号)、来源取英文短名，推送段里讲尾巴的那句随之改写
export const MEMORY_TEXT_VERSION = "v5";

// 新建文件时写入的文件头；已有文件的文件头原样保留（决策 431 之前的中文文件头由迁移换成这里的）
export const MEMORY_FILE_HEADERS: Readonly<Record<MemoryLayer, string>> = {
  project:
    "# Learned memory (this project)\n" +
    "<!-- Maintained by Pigeon's update_memory; you can also edit it with /memory edit project in the terminal UI. One entry per line: ID and content, followed by (recorded date · source · session ID). -->\n" +
    "\n",
  user:
    "# Learned memory (all projects)\n" +
    "<!-- Maintained by Pigeon's update_memory; you can also edit it with /memory edit user in the terminal UI. One entry per line: ID and content, followed by (recorded date · source · session ID). -->\n" +
    "\n",
};

// 条目的来处（工具补在行内）：日期（YYYY-MM-DD）、来源（入口的英文短名，如 tui、cli；人手写的或迁移时认不出的照原文）、会话编号
export interface MemoryOrigin {
  date: string;
  source: string;
  sessionId: string;
}

export interface MemoryEntry {
  id: number;
  content: string;
  // 人手加的条目可以没有来处
  origin?: MemoryOrigin;
}

export interface MemoryDocument {
  // 第一条之前的原文（含换行）
  header: string;
  entries: MemoryEntry[];
  // 最后一条之后的原文（换行与空行；逐字往返用，工具写入时规整为一个换行）
  trailer: string;
}

export type ParsedMemory =
  | { ok: true; doc: MemoryDocument }
  // line：第一处格式不对的行号（从 1 起）
  | { ok: false; line: number };

const ORIGIN_SEPARATOR = " · ";
const ENTRY_LINE = /^- \[([PU])([1-9]\d*)\] (.+)$/;
// 尾巴：内容（贪婪）之后的最后一段；来源不含"·"，会话号不含空白与"·"
const ORIGIN_TAIL = /^(.*\S) \(recorded (\d{4}-\d{2}-\d{2}) · ([^·]+?) · session ([^\s·]+)\)$/;

// 条目区的起点：第一个以"- "开头的行的字符偏移；没有即 -1
function entriesOffset(text: string): number {
  if (text.startsWith("- ")) {
    return 0;
  }
  const found = text.indexOf("\n- ");
  return found < 0 ? -1 : found + 1;
}

// 一行条目：编号前缀须与层相符；行末的尾巴按固定写法取出，取不出即整段算内容
function parseEntryLine(line: string, layer: MemoryLayer): MemoryEntry | undefined {
  const match = ENTRY_LINE.exec(line);
  if (match === null || match[1] !== MEMORY_LAYER_PREFIX[layer]) {
    return undefined;
  }
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) {
    return undefined;
  }
  const rest = (match[3] as string).trim();
  if (rest === "") {
    return undefined;
  }
  const tail = ORIGIN_TAIL.exec(rest);
  if (tail === null) {
    return { id, content: rest };
  }
  return {
    id,
    content: tail[1] as string,
    origin: { date: tail[2] as string, source: tail[3] as string, sessionId: tail[4] as string },
  };
}

export function parseMemory(text: string, layer: MemoryLayer): ParsedMemory {
  // Windows 编辑器存的 CRLF 先规范成 LF 再解析（写回即新格式）
  const normalized = text.replace(/\r\n/g, "\n");
  const offset = entriesOffset(normalized);
  if (offset < 0) {
    return { ok: true, doc: { header: normalized, entries: [], trailer: "" } };
  }
  const header = normalized.slice(0, offset);
  const firstLine = header === "" ? 1 : header.split("\n").length;
  const region = normalized.slice(offset);
  // 文件尾：最后一个非空行之后的换行与空行
  const trailerMatch = /\n[\s]*$/.exec(region);
  const trailer = trailerMatch !== null ? trailerMatch[0] : "";
  const lines = region.slice(0, region.length - trailer.length).split("\n");
  const entries: MemoryEntry[] = [];
  const seen = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const entry = parseEntryLine(line, layer);
    if (entry === undefined || seen.has(entry.id)) {
      return { ok: false, line: firstLine + index };
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, doc: { header, entries, trailer } };
}

export function entryId(layer: MemoryLayer, id: number): string {
  return `${MEMORY_LAYER_PREFIX[layer]}${id}`;
}

// 行末的尾巴（连同前导空格）：` (recorded 2026-10-01 · tui · session sess_…)`；迁移旧格式时同样经它写出
export function originTail(origin: MemoryOrigin): string {
  return ` (recorded ${[origin.date, origin.source, `session ${origin.sessionId}`].join(ORIGIN_SEPARATOR)})`;
}

export function serializeEntry(entry: MemoryEntry, layer: MemoryLayer): string {
  const tail = entry.origin === undefined ? "" : originTail(entry.origin);
  return `- [${entryId(layer, entry.id)}] ${entry.content}${tail}`;
}

// 条目区的原文：各条之间以换行相接，后接文件尾；没有条目为空串
export function serializeEntries(
  entries: readonly MemoryEntry[],
  layer: MemoryLayer,
  trailer: string
): string {
  if (entries.length === 0) {
    return "";
  }
  return entries.map((entry) => serializeEntry(entry, layer)).join("\n") + trailer;
}

export function serializeMemory(doc: MemoryDocument, layer: MemoryLayer): string {
  return doc.header + serializeEntries(doc.entries, layer, doc.trailer);
}

// 字符数：按 Unicode 码点计
export function countChars(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

// 文件原文的条目区（第一个"- "行起到文件尾）：推送照它原样放入。格式坏了也照原文取
export function entriesSection(text: string): string {
  const offset = entriesOffset(text);
  return offset < 0 ? "" : text.slice(offset);
}

// 按原文算的条目事实（格式坏了也能算）：条数为以"- [编号]"开头的行数，字符数为条目区去掉尾部空白后加一个换行的码点数
export function memoryFactsOfText(text: string): { entries: number; entryChars: number } {
  const section = entriesSection(text).trimEnd();
  return {
    entries: (section.match(/^- \[[PU]\d+\]/gm) ?? []).length,
    entryChars: section === "" ? 0 : countChars(section) + 1,
  };
}

// 写入后的文件原文：文件头不以换行结尾时补一个（否则第一条会接在文件头最后一行后面），末尾一律一个换行
export function renderForWrite(doc: MemoryDocument, layer: MemoryLayer): string {
  const header = doc.header === "" || doc.header.endsWith("\n") ? doc.header : `${doc.header}\n`;
  return header + serializeEntries(doc.entries, layer, "\n");
}

// 条目区的已用字符数（按写入后的样子算：每条连同结尾的换行）
export function usedChars(entries: readonly MemoryEntry[], layer: MemoryLayer): number {
  return entries.reduce((sum, entry) => sum + entryChars(entry, layer), 0);
}

// 一条的字符数（连同它结尾的换行，即加入条目区时增加的量）
export function entryChars(entry: MemoryEntry, layer: MemoryLayer): number {
  return countChars(serializeEntry(entry, layer)) + 1;
}

// 下一个编号：现有最大编号加一。决策 382：删掉的编号不再分配——调用方（update-memory-tool.ts）另取
// 已分配过的最大编号（.maxid 文件）加一作下界，两者取大
export function nextId(entries: readonly MemoryEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

// 本地日期（YYYY-MM-DD）
export function localDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
