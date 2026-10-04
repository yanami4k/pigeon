// 命令输出的头尾保留与全文落盘（决策 356）：run_command 的输出超过开头加末尾两段时，结果里留开头一小段与末尾一大段，中间
// 注明省略的行数；完整输出存进会话自己的落盘目录（.pigeon/state/outputs/<会话号>/<编号>.log），结果给出虚拟路径
// pigeon://outputs/<会话号>/<编号> 与总行数，模型用 read_file 读需要的那段。
// 虚拟路径由 Pigeon 自己解析：只认 pigeon://outputs/ 加会话号加正整数编号，会话须是本会话或其分叉来源（分支会话复制来的
// 历史里的路径仍指向来源会话的输出）；别的写法（..、绝对路径、子目录、别的会话）一律拒绝。
// 落盘目录在工作区的 .pigeon/state 里，命令改得动（换成符号链接、硬链接、改内容），lstat 与打开之间也有竞态，Windows 又没有
// O_NOFOLLOW，所以读取只认 Pigeon 自己写下的内容：每写成一份，在会话自己的索引（落盘目录里的 index.json）记下它的身份
// （设备号、inode、大小、写入字节的 sha256）；读时打开后 fstat 核对设备号、inode 与大小，读完核对哈希，任何一项不符即拒绝。
// 索引本身同样改得动，但要让它认下别的文件，得先算出那个文件的 sha256，即先读得到它，不另防。
// 写入先写临时名（独占新建、不跟随链接），写成后改名为 <编号>.log；出错删掉临时文件、编号照常前进。写入侧若被引到别处，
// 写的只是命令自己的输出，不超出命令本身的权限，不另防。落盘目录设总量上限（按索引计），满了从最旧的删起：只删索引里记过、
// lstat 看来是普通文件且设备号、inode、大小与记录一致的文件，不一致的不删、只从索引里去掉。
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { OutputFileIdentity } from "./workspace-host.ts";

export const OUTPUTS_URI_PREFIX = "pigeon://outputs/";

// 虚拟路径不合规、不是可读的会话、指向的文件已不在或已被改动，或落盘目录被换成了链接（域错误）
export class OutputPathError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export function isOutputsUri(inputPath: string): boolean {
  return inputPath.startsWith("pigeon://");
}

// Windows 没有 O_NOFOLLOW：那里靠身份核对
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const FILE_PATTERN = /^([1-9][0-9]*)\.log$/;
const URI_PATTERN = /^pigeon:\/\/outputs\/([A-Za-z0-9_-]+)\/([1-9][0-9]*)$/;
const INDEX_FILE = "index.json";
const CHANGED = "落盘文件已被改动（不是 Pigeon 写下的那份），拒绝读取";

export interface OutputSlot {
  id: number;
  // 写成后的文件
  file: string;
  // 写入时用的临时文件（收集器往这里写，提交时改名为 file）
  temp: string;
  uri: string;
}

// 索引里的一条：编号、大小与写下时的身份
export interface OutputRecord extends OutputFileIdentity {
  id: number;
  size: number;
}

export interface CommandOutputStoreOptions {
  // 逐级检查链接的起点（治理根）；落盘目录须在它之下
  base: string;
  // 各会话落盘目录的上一级（.pigeon/state/outputs）
  outputsRoot: string;
  sessionId: string;
  // 本会话落盘总量上限（字节）
  maxBytes: number;
  // 除本会话外还可读其输出的会话（分叉来源一路往上）；用到时才取一次
  ancestors?: () => readonly string[];
}

// 落盘文件的一个窗口：总行数、[offset, offset + limit) 的行与全文哈希（按字节）
export interface OutputWindow {
  file: string;
  totalLines: number;
  lines: string[];
  sha256: string;
}

export class CommandOutputStore {
  readonly dir: string;
  readonly maxBytes: number;
  readonly #base: string;
  readonly #outputsRoot: string;
  readonly #sessionId: string;
  readonly #ancestors: (() => readonly string[]) | undefined;
  #readable: ReadonlySet<string> | undefined;
  // 本会话的索引（编号 → 记录）；首次用到时从索引文件读入（续跑的会话接着用）
  #index: Map<number, OutputRecord> | undefined;
  #last: number | undefined;

  constructor(options: CommandOutputStoreOptions) {
    this.#base = path.resolve(options.base);
    this.#outputsRoot = path.resolve(options.outputsRoot);
    this.#sessionId = options.sessionId;
    this.dir = path.join(this.#outputsRoot, options.sessionId);
    this.maxBytes = options.maxBytes;
    this.#ancestors = options.ancestors;
  }

  // 从治理根起到 target 的各级里已存在的不得是链接
  #assertNoLinks(target: string): void {
    const rel = path.relative(this.#base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new OutputPathError(`落盘目录不在治理根之下：${target}`);
    }
    let current = this.#base;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch {
        return;
      }
      if (stat.isSymbolicLink()) {
        throw new OutputPathError(`落盘目录里的 ${current} 被换成了链接，拒绝读写`);
      }
    }
  }

  // 读某个会话的索引文件；没有、读不了或格式不对都按空索引（格式不对的条目跳过）
  #readIndex(session: string): Map<number, OutputRecord> {
    const file = path.join(this.#outputsRoot, session, INDEX_FILE);
    const index = new Map<number, OutputRecord>();
    let parsed: unknown;
    try {
      this.#assertNoLinks(file);
      const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
      try {
        parsed = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
    } catch {
      return index;
    }
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries)) return index;
    for (const entry of entries as unknown[]) {
      const record = asRecord(entry);
      if (record !== undefined) index.set(record.id, record);
    }
    return index;
  }

  #ownIndex(): Map<number, OutputRecord> {
    this.#index ??= this.#readIndex(this.#sessionId);
    return this.#index;
  }

  // 索引整体写进临时文件（独占新建、不跟随链接）再改名
  #writeIndex(): void {
    this.#assertNoLinks(this.dir);
    const records = [...this.#ownIndex().values()].sort((a, b) => a.id - b.id);
    const temp = path.join(this.dir, `.${INDEX_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600
    );
    try {
      writeFileSync(fd, `${JSON.stringify({ entries: records })}\n`);
    } catch (error) {
      closeSync(fd);
      removeQuietly(temp);
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(temp, path.join(this.dir, INDEX_FILE));
    } catch (error) {
      removeQuietly(temp);
      throw error;
    }
  }

  // 本会话落盘总量（按索引计）
  totalBytes(): number {
    let total = 0;
    for (const record of this.#ownIndex().values()) total += record.size;
    return total;
  }

  // 下一条输出的落盘位置：编号接着索引与目录里已有的最大编号，取号即占号（决策 365：后台作业取号后要到结束才写成，
  // 其间别的作业与前台命令不得拿到同一编号）；没用上的号经 release 退回（只在它仍是最新的号时）。
  // 落盘目录被换成链接即抛 OutputPathError
  next(): OutputSlot {
    this.#assertNoLinks(this.dir);
    mkdirSync(this.dir, { recursive: true });
    this.#assertNoLinks(this.dir);
    if (this.#last === undefined) {
      let last = 0;
      for (const id of this.#ownIndex().keys()) last = Math.max(last, id);
      for (const name of safeReaddir(this.dir)) {
        const match = FILE_PATTERN.exec(name);
        if (match !== null) last = Math.max(last, Number(match[1]));
      }
      this.#last = last;
    }
    const id = this.#last + 1;
    this.#last = id;
    return {
      id,
      file: path.join(this.dir, `${id}.log`),
      temp: path.join(this.dir, `.${id}.${randomBytes(6).toString("hex")}.tmp`),
      uri: `${OUTPUTS_URI_PREFIX}${this.#sessionId}/${id}`,
    };
  }

  // 写成一条：临时文件改名为 <编号>.log，核对改名后仍是写下的那个文件，记进索引，按总量上限从最旧的删起（刚写的这条
  // 不删），再写回索引文件。任何一步出错即删掉临时文件、不记索引，编号照常前进，抛出原因
  commit(slot: OutputSlot, written: OutputFileIdentity & { bytes: number }): void {
    this.#last = Math.max(this.#last ?? 0, slot.id);
    const index = this.#ownIndex();
    try {
      this.#assertNoLinks(this.dir);
      renameSync(slot.temp, slot.file);
      const stat = lstatSync(slot.file, { bigint: true });
      if (!stat.isFile() || !sameIdentity(stat, { ...written, size: written.bytes })) {
        throw new OutputPathError(CHANGED);
      }
      index.set(slot.id, {
        id: slot.id,
        size: written.bytes,
        dev: written.dev,
        ino: written.ino,
        sha256: written.sha256,
      });
      this.#evict(slot.id);
      this.#writeIndex();
    } catch (error) {
      index.delete(slot.id);
      removeQuietly(slot.temp);
      throw error;
    }
  }

  // 取了号没用上（输出没超过头尾两段、不落盘）：它仍是最新的号即退回，免得编号无谓地跳；之后已有人取号的不退
  release(slot: OutputSlot): void {
    if (this.#last === slot.id) this.#last = slot.id - 1;
  }

  // 没写成（打开或写入出错）：删掉临时文件，编号照常前进
  discard(slot: OutputSlot): void {
    this.#last = Math.max(this.#last ?? 0, slot.id);
    try {
      this.#assertNoLinks(this.dir);
    } catch {
      return;
    }
    removeQuietly(slot.temp);
  }

  // 总量超过上限时从最旧的删起；只删 lstat 看来是普通文件、身份与记录一致的，不一致的不删、只从索引里去掉
  #evict(keep: number): void {
    const index = this.#ownIndex();
    let total = this.totalBytes();
    for (const record of [...index.values()].sort((a, b) => a.id - b.id)) {
      if (total <= this.maxBytes) break;
      if (record.id === keep) continue;
      const file = path.join(this.dir, `${record.id}.log`);
      try {
        const stat = lstatSync(file, { bigint: true });
        if (stat.isFile() && sameIdentity(stat, record)) unlinkSync(file);
      } catch {
        // 已不在
      }
      index.delete(record.id);
      total -= record.size;
    }
  }

  // 虚拟路径 → 落盘文件与索引里的记录（各级不得是链接；索引里没有即不存在）
  resolve(uri: string): { file: string; record: OutputRecord } {
    const match = URI_PATTERN.exec(uri);
    if (match === null) {
      throw new OutputPathError(
        `虚拟路径只能是 ${OUTPUTS_URI_PREFIX}<会话号>/<编号>（run_command 结果里给出的那个）：${uri}`
      );
    }
    const [, session, idText] = match as unknown as [string, string, string];
    if (session !== this.#sessionId) {
      this.#readable ??= new Set(this.#ancestors?.() ?? []);
    }
    if (session !== this.#sessionId && !this.#readable?.has(session)) {
      throw new OutputPathError(`${uri} 是别的会话的输出：只能读本会话及其分叉来源存下的输出`);
    }
    const file = path.join(this.#outputsRoot, session, `${idText}.log`);
    this.#assertNoLinks(file);
    const index = session === this.#sessionId ? this.#ownIndex() : this.#readIndex(session);
    const record = index.get(Number(idText));
    if (record === undefined) {
      throw new OutputPathError(`${uri} 不存在（编号不对，或已因落盘总量上限被清理）`);
    }
    return { file, record };
  }

  // 只读需要的窗口：流过整个文件，只按 \n 分行（与 run_command 的总行数同一口径；\r\n 去掉行尾的 \r，单独的 \r 不算
  // 断行），只留 [offset, offset + limit) 的行。打开后核对设备号、inode 与大小，读完核对字节数与哈希，不符即拒绝
  async readWindow(uri: string, offset: number, limit: number): Promise<OutputWindow> {
    const { file, record } = this.resolve(uri);
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      throw new OutputPathError(
        `${uri} 打不开（${(error as NodeJS.ErrnoException).code ?? "未知错误"}），可能已被换成链接或清理`
      );
    }
    let same: boolean;
    try {
      same = sameIdentity(fstatSync(fd, { bigint: true }), record);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    if (!same) {
      closeSync(fd);
      throw new OutputPathError(`${uri}：${CHANGED}`);
    }
    const hash = createHash("sha256");
    const inWindow = (line: number) => line >= offset && line < offset + limit;
    const lines: string[] = [];
    let pending: Buffer[] = [];
    let current = 1;
    let bytes = 0;
    let lastByte: number | undefined;
    // autoClose：流结束或销毁时关掉 fd（不另行 close，免得关到被复用的 fd）
    const stream = createReadStream("", { fd, autoClose: true });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk);
        bytes += chunk.length;
        if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
        let start = 0;
        for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
          if (inWindow(current)) {
            pending.push(chunk.subarray(start, nl));
            lines.push(decodeLine(pending));
            pending = [];
          }
          current += 1;
          start = nl + 1;
        }
        if (start < chunk.length && inWindow(current)) pending.push(chunk.subarray(start));
      }
    } finally {
      stream.destroy();
    }
    const unterminated = lastByte !== undefined && lastByte !== 0x0a;
    if (unterminated && inWindow(current)) lines.push(decodeLine(pending));
    const sha256 = hash.digest("hex");
    if (bytes !== record.size || sha256 !== record.sha256) {
      throw new OutputPathError(`${uri}：${CHANGED}`);
    }
    return { file, totalLines: current - 1 + (unterminated ? 1 : 0), lines, sha256 };
  }
}

function sameIdentity(
  stat: { dev: bigint; ino: bigint; size: bigint },
  record: { dev: string; ino: string; size: number }
): boolean {
  return (
    String(stat.dev) === record.dev &&
    String(stat.ino) === record.ino &&
    stat.size === BigInt(record.size)
  );
}

// 索引文件里的一条；字段不全或类型不对时为 undefined
function asRecord(value: unknown): OutputRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, size, dev, ino, sha256 } = value as Record<string, unknown>;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof dev !== "string" ||
    typeof ino !== "string" ||
    typeof sha256 !== "string"
  ) {
    return undefined;
  }
  return { id, size, dev, ino, sha256 };
}

// 一行的字节解成文本；\r\n 结尾的去掉 \r
function decodeLine(pieces: Buffer[]): string {
  const line = Buffer.concat(pieces);
  const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
  return line.subarray(0, end).toString("utf8");
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 不在或删不掉
  }
}

// 结果里的输出段：开头之后、末尾之前注明省略；开头截在最后一个换行处，末尾从第一个换行之后起，免得半行
export interface OutputSection {
  head: string;
  tail: string;
  totalBytes: number;
  totalLines: number;
}

export function composeOutput(section: OutputSection): {
  text: string;
  omittedLines: number;
} {
  const headCut = section.head.lastIndexOf("\n");
  const head = headCut >= 0 ? section.head.slice(0, headCut + 1) : section.head;
  const tailCut = section.tail.indexOf("\n");
  const tail =
    tailCut >= 0 && tailCut < section.tail.length - 1
      ? section.tail.slice(tailCut + 1)
      : section.tail;
  const headLines = countNewlines(head);
  const tailLines = countNewlines(tail) + (tail !== "" && !tail.endsWith("\n") ? 1 : 0);
  const omittedLines = Math.max(0, section.totalLines - headLines - tailLines);
  const omittedBytes = Math.max(
    0,
    section.totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail)
  );
  const marker =
    `…（输出已截断：共 ${section.totalBytes} 字节、${section.totalLines} 行；` +
    `保留开头 ${headLines} 行与末尾 ${tailLines} 行，中间省略 ${omittedLines} 行、${omittedBytes} 字节）`;
  return {
    text: `${head}${head.endsWith("\n") || head === "" ? "" : "\n"}${marker}\n${tail}`,
    omittedLines,
  };
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}
