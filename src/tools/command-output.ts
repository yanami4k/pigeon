// 命令输出的头尾保留与全文落盘（决策 356）：run_command 的输出超过开头加末尾两段时，结果里留开头一小段与末尾一大段，中间
// 注明省略的行数；完整输出存进会话自己的落盘目录（.pigeon/state/outputs/<会话号>/<编号>.log），结果给出虚拟路径
// pigeon://outputs/<编号> 与总行数，模型用 read_file 读需要的那段。虚拟路径由 Pigeon 自己解析，只能指向本会话的落盘目录：
// 只认 pigeon://outputs/ 加正整数编号，别的写法（含 ..、绝对路径、子目录）一律拒绝。落盘目录设总量上限，满了删最旧的。
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export const OUTPUTS_URI_PREFIX = "pigeon://outputs/";

// 虚拟路径不合规或指向的文件已不在（域错误：模型给的路径不对）
export class OutputPathError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export function isOutputsUri(inputPath: string): boolean {
  return inputPath.startsWith("pigeon://");
}

const FILE_PATTERN = /^([1-9][0-9]*)\.log$/;

export interface OutputSlot {
  id: number;
  file: string;
  uri: string;
}

// 本会话的落盘目录
export class CommandOutputStore {
  readonly dir: string;
  readonly maxBytes: number;
  #last: number | undefined;

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
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
          bytes = statSync(file).size;
        } catch {
          // 并发删掉了，按 0 计
        }
        return { id: Number(match[1]), file, bytes };
      })
      .sort((a, b) => a.id - b.id);
  }

  // 下一条输出的落盘位置（编号接着目录里已有的最大编号；没写成也不占号）
  next(): OutputSlot {
    if (this.#last === undefined) {
      this.#last = this.#entries().at(-1)?.id ?? 0;
    }
    const id = this.#last + 1;
    mkdirSync(this.dir, { recursive: true });
    return { id, file: path.join(this.dir, `${id}.log`), uri: `${OUTPUTS_URI_PREFIX}${id}` };
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

  // 虚拟路径 → 落盘文件
  resolve(uri: string): string {
    const name = uri.startsWith(OUTPUTS_URI_PREFIX) ? uri.slice(OUTPUTS_URI_PREFIX.length) : "";
    if (!/^[1-9][0-9]*$/.test(name)) {
      throw new OutputPathError(
        `虚拟路径只能是 ${OUTPUTS_URI_PREFIX}<编号>（run_command 结果里给出的那个）：${uri}`
      );
    }
    const file = path.join(this.dir, `${name}.log`);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // 落到下面
    }
    throw new OutputPathError(`${uri} 不存在（编号不对，或已因落盘总量上限被清理）`);
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
