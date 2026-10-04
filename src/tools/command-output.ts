// 命令输出的头尾保留与全文落盘（决策 356）：run_command 的输出超过开头加末尾两段时，结果里留开头一小段与末尾一大段，中间
// 注明省略的行数；完整输出存进会话自己的落盘目录（.pigeon/state/outputs/<会话号>/<编号>.log），结果给出虚拟路径
// pigeon://outputs/<会话号>/<编号> 与总行数，模型用 read_file 读需要的那段。
// 虚拟路径由 Pigeon 自己解析：只认 pigeon://outputs/ 加会话号加正整数编号，会话须是本会话或其分叉来源（分支会话复制来的
// 历史里的路径仍指向来源会话的输出）；别的写法（..、绝对路径、子目录、别的会话）一律拒绝。
// 落盘目录在工作区的 .pigeon/state 里，命令改得动：从治理根的 .pigeon 起逐级 lstat，任何一级被换成链接即拒绝；读用
// O_NOFOLLOW 打开，新建用独占创建（见 local-host.ts 的收集器），不跟随链接。落盘目录设总量上限，满了删最旧的。
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export const OUTPUTS_URI_PREFIX = "pigeon://outputs/";

// 虚拟路径不合规、不是可读的会话、指向的文件已不在，或落盘目录被换成了链接（域错误）
export class OutputPathError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export function isOutputsUri(inputPath: string): boolean {
  return inputPath.startsWith("pigeon://");
}

// Windows 没有 O_NOFOLLOW：那里靠打开前的逐级 lstat
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const FILE_PATTERN = /^([1-9][0-9]*)\.log$/;
const URI_PATTERN = /^pigeon:\/\/outputs\/([A-Za-z0-9_-]+)\/([1-9][0-9]*)$/;

export interface OutputSlot {
  id: number;
  file: string;
  uri: string;
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

  #entries(): Array<{ id: number; file: string; bytes: number }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => FILE_PATTERN.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => {
        const file = path.join(this.dir, match[0]);
        let bytes = 0;
        try {
          bytes = lstatSync(file).size;
        } catch {
          // 并发删掉了，按 0 计
        }
        return { id: Number(match[1]), file, bytes };
      })
      .sort((a, b) => a.id - b.id);
  }

  // 本会话落盘目录里现有文件的总字节数
  totalBytes(): number {
    return this.#entries().reduce((sum, entry) => sum + entry.bytes, 0);
  }

  // 下一条输出的落盘位置（编号接着目录里已有的最大编号；没写成也不占号）。落盘目录被换成链接即抛 OutputPathError
  next(): OutputSlot {
    this.#assertNoLinks(this.dir);
    mkdirSync(this.dir, { recursive: true });
    this.#assertNoLinks(this.dir);
    if (this.#last === undefined) {
      this.#last = this.#entries().at(-1)?.id ?? 0;
    }
    const id = this.#last + 1;
    return {
      id,
      file: path.join(this.dir, `${id}.log`),
      uri: `${OUTPUTS_URI_PREFIX}${this.#sessionId}/${id}`,
    };
  }

  // 写成一条：占号，按总量上限从最旧的删起（刚写的这条不删）
  commit(slot: OutputSlot): void {
    this.#last = Math.max(this.#last ?? 0, slot.id);
    const entries = this.#entries();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (total <= this.maxBytes || entry.id === slot.id) break;
      try {
        unlinkSync(entry.file);
      } catch {
        // 已不在
      }
      total -= entry.bytes;
    }
  }

  // 虚拟路径 → 落盘文件（各级不得是链接）
  resolve(uri: string): string {
    const match = URI_PATTERN.exec(uri);
    if (match === null) {
      throw new OutputPathError(
        `虚拟路径只能是 ${OUTPUTS_URI_PREFIX}<会话号>/<编号>（run_command 结果里给出的那个）：${uri}`
      );
    }
    const [, session, id] = match as unknown as [string, string, string];
    if (session !== this.#sessionId) {
      this.#readable ??= new Set(this.#ancestors?.() ?? []);
    }
    if (session !== this.#sessionId && !this.#readable?.has(session)) {
      throw new OutputPathError(`${uri} 是别的会话的输出：只能读本会话及其分叉来源存下的输出`);
    }
    const file = path.join(this.#outputsRoot, session, `${id}.log`);
    this.#assertNoLinks(file);
    try {
      if (lstatSync(file).isFile()) return file;
    } catch {
      // 落到下面
    }
    throw new OutputPathError(`${uri} 不存在（编号不对，或已因落盘总量上限被清理）`);
  }

  // 只读需要的窗口：逐行流过整个文件计行数与哈希，只留 [offset, offset + limit) 的行；不跟随链接
  async readWindow(uri: string, offset: number, limit: number): Promise<OutputWindow> {
    const file = this.resolve(uri);
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      throw new OutputPathError(
        `${uri} 打不开（${(error as NodeJS.ErrnoException).code ?? "未知错误"}），可能已被换成链接或清理`
      );
    }
    const hash = createHash("sha256");
    const stream = createReadStream("", { fd, autoClose: true });
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    const lines: string[] = [];
    let totalLines = 0;
    try {
      for await (const line of createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      })) {
        totalLines += 1;
        if (totalLines >= offset && totalLines < offset + limit) lines.push(line);
      }
    } finally {
      // autoClose：流结束或销毁时关掉 fd（不另行 close，免得关到被复用的 fd）
      stream.destroy();
    }
    return { file, totalLines, lines, sha256: hash.digest("hex") };
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
