// 学到的记忆旧格式的一次性迁移（决策 431）：决策 431 之前的记忆文件是中文文件头、条目尾巴为
// `〔2026-10-01 · 终端界面 · 会话 sess_…〕`。旧格式只在这里认读；日常读写路径只认新格式（learned.ts）。
// - 判定：文件头里有旧的标题行或注释行，或条目区里有任何一行以旧尾巴结尾，即为旧格式。
// - 转换（纯函数）：旧标题行与注释行换成新文件头的对应行（文件头里人加的别的行原样）；每条的旧尾巴换成新尾巴，来源
//   "终端界面"→tui、"命令行对话"→cli，认不出的来源原样保留；编号、内容、日期、会话号不变，没有尾巴的条目照旧没有；
//   CRLF 规范成 LF（与工具写回一致）。转换结果不再是旧格式，再转换即原样（幂等）。
// - 落盘：在这一层的记忆锁内现读，仍是旧格式即先把原文复制进迁移备份目录（不覆盖已有备份），再整份原子改写；已是新格式
//   的文件不碰、不备份。
// - 读路径（readMemoryLayer）：拿不到锁（另一处正在写、只试一次不等）或备份、改写出错时，这一次在内存里转换后照常读出、
//   不写文件，经 report 给人一行告警，下次读到时再试；改写成功同样经 report 说一行备份位置。
import { readFileSync } from "node:fs";
import { ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import { copyToMigrationBackup } from "../persistence/migration-backup.ts";
import { sha256Hex } from "../state/hashing.ts";
import { MEMORY_FILE_HEADERS, MEMORY_LAYERS, type MemoryLayer, originTail } from "./learned.ts";
import {
  MEMORY_BACKUP_NAME,
  type MemoryFileRead,
  type MemoryLocation,
  readMemoryFile,
  tryMemoryLock,
  writeMemoryFile,
} from "./learned-store.ts";

// 旧文件头（决策 332 至 431 之间写下的）：标题行与注释行
const LEGACY_HEADER_LINES: Readonly<Record<MemoryLayer, readonly [string, string]>> = {
  project: [
    "# 学到的记忆（本项目）",
    "<!-- 由 Pigeon 的 update_memory 维护，也可以用终端界面的 /memory edit project 修改。一行一条：编号、内容，〔〕里是记下的日期、来源与会话编号。 -->",
  ],
  user: [
    "# 学到的记忆（所有项目）",
    "<!-- 由 Pigeon 的 update_memory 维护，也可以用终端界面的 /memory edit user 修改。一行一条：编号、内容，〔〕里是记下的日期、来源与会话编号。 -->",
  ],
};

// 旧文件头的各行 → 新文件头的对应行
const HEADER_LINE_MAP: ReadonlyMap<string, string> = new Map(
  MEMORY_LAYERS.flatMap((layer) => {
    const [title, comment] = MEMORY_FILE_HEADERS[layer].split("\n");
    const [oldTitle, oldComment] = LEGACY_HEADER_LINES[layer];
    return [
      [oldTitle, title as string],
      [oldComment, comment as string],
    ];
  })
);

// 旧来源名 → 英文短名；不在其中的照原文
export const LEGACY_SOURCE_NAMES: Readonly<Record<string, string>> = {
  终端界面: "tui",
  命令行对话: "cli",
};

// 以旧尾巴结尾的条目行：编号与内容、日期、来源、会话号
const LEGACY_TAIL_LINE =
  /^(- \[[PU][1-9]\d*\] .*\S) 〔(\d{4}-\d{2}-\d{2}) · ([^·〔〕]+?) · 会话 ([^\s·〔〕]+)〕$/;

// 条目区的起点（第一个以"- "开头的行的行号，从 0 起）；没有为行数
function entriesStart(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.startsWith("- "));
  return index < 0 ? lines.length : index;
}

export function isLegacyMemoryText(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = entriesStart(lines);
  return lines.some((line, index) =>
    index < start ? HEADER_LINE_MAP.has(line) : LEGACY_TAIL_LINE.test(line)
  );
}

// 整份转换成新格式（不是旧格式的原文只规范换行）
export function convertLegacyMemoryText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = entriesStart(lines);
  return lines
    .map((line, index) => {
      if (index < start) {
        return HEADER_LINE_MAP.get(line) ?? line;
      }
      const match = LEGACY_TAIL_LINE.exec(line);
      if (match === null) {
        return line;
      }
      const source = match[3] as string;
      return (
        (match[1] as string) +
        originTail({
          date: match[2] as string,
          source: LEGACY_SOURCE_NAMES[source] ?? source,
          sessionId: match[4] as string,
        })
      );
    })
    .join("\n");
}

function readOfText(text: string): MemoryFileRead {
  return { exists: true, text, bytes: Buffer.byteLength(text), hash: sha256Hex(text) };
}

// 一层改写后的读数；backup 为这次迁移的备份位置（这次没有迁移时不在）
export type MigratedMemoryRead = MemoryFileRead & { backup?: string };

// 锁内（调用方已持有这一层的记忆锁）：现读；旧格式即先备份原文、再整份改写成新格式，返回改写后的读数。
// 备份或改写出错即抛出（调用方不得在没有备份时覆盖旧文件）
export function migrateMemoryFileLocked(location: MemoryLocation): MigratedMemoryRead {
  const current = readMemoryFile(location.file);
  if (!current.exists || !isLegacyMemoryText(current.text)) {
    return current;
  }
  // 备份与转换用同一份原文字节（锁内现读）
  const raw = readFileSync(location.file);
  const converted = convertLegacyMemoryText(raw.toString("utf8"));
  const backup = copyToMigrationBackup(location.backupDir, MEMORY_BACKUP_NAME, raw);
  writeMemoryFile(location.file, converted);
  return { ...readOfText(converted), backup };
}

// 给人看的一行（迁移成功、没能落盘）
export type MemoryMigrationReport = (line: string) => void;

const stderrReport: MemoryMigrationReport = (line) => {
  process.stderr.write(`${line}\n`);
};

export function memoryMigratedText(location: MemoryLocation, backup: string): string {
  return `[记忆] ${location.display} 是旧格式，已一次性改写成新格式；原文件备份在 ${backup}`;
}

export function memoryMigrationPendingText(location: MemoryLocation, reason: string): string {
  return `[记忆] ${location.display} 是旧格式，这次没能改写成新格式（${reason}）：本次在内存里按新格式读出，文件未动，下次读到时再试`;
}

function failureReason(error: unknown): string {
  if (error instanceof ExclusiveLockError) {
    return "另一处正在写这一层";
  }
  return error instanceof Error ? error.message : String(error);
}

// 日常读路径：读一层记忆文件；旧格式即一次性迁移（锁内备份、改写），之后按新格式读出。锁只试一次：拿不到或备份、改写
// 出错时这一次在内存里转换后读出、不写文件，经 report 告警，下次再试——不因此读不到记忆
export function readMemoryLayer(
  location: MemoryLocation,
  report: MemoryMigrationReport = stderrReport
): MemoryFileRead {
  const first = readMemoryFile(location.file);
  if (!first.exists || !isLegacyMemoryText(first.text)) {
    return first;
  }
  let release: () => void;
  try {
    release = tryMemoryLock(location.lock);
  } catch (error) {
    report(memoryMigrationPendingText(location, failureReason(error)));
    return readOfText(convertLegacyMemoryText(first.text));
  }
  try {
    const { backup, ...read } = migrateMemoryFileLocked(location);
    if (backup !== undefined) {
      report(memoryMigratedText(location, backup));
    }
    return read;
  } catch (error) {
    report(memoryMigrationPendingText(location, failureReason(error)));
    return readOfText(convertLegacyMemoryText(first.text));
  } finally {
    release();
  }
}
