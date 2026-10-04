// 本会话读过哪些文件（决策 358）：write_file 覆盖已存在的文件前须本会话读过它，且读后没被改过。按执行端解析后的规范路径，
// 记最近一次成功读取时整个文件字节的 sha256 与字节数（不存内容）；任何一次成功读取（含分段读取）都算读过，"读后未变"按读取当时
// 整个文件的哈希判断。edit_file、write_file 成功后按写成的内容更新记录。之后的上下文裁剪经 hasRead 与 forget 接上。
import { createHash } from "node:crypto";

export interface FileReadRecord {
  sha256: string;
  bytes: number;
  // 记录时刻（Unix 毫秒）
  at: number;
}

// 按文件字节算：解码后的字符串会把不同的非法字节都变成 U+FFFD，看不出变化
function digest(bytes: Uint8Array): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export class FileReadTracker {
  readonly #records = new Map<string, FileReadRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // 一次成功读取或写入后：bytes 为当时整个文件的字节
  record(resolvedPath: string, bytes: Uint8Array): void {
    this.#records.set(resolvedPath, { ...digest(bytes), at: this.#now() });
  }

  // 这个文件本会话是否算读过
  hasRead(resolvedPath: string): boolean {
    return this.#records.has(resolvedPath);
  }

  lastRead(resolvedPath: string): FileReadRecord | undefined {
    return this.#records.get(resolvedPath);
  }

  // 现在的内容与最近一次记录时相同
  unchangedSinceRead(resolvedPath: string, bytes: Uint8Array): boolean {
    const record = this.#records.get(resolvedPath);
    if (record === undefined) return false;
    const now = digest(bytes);
    return now.bytes === record.bytes && now.sha256 === record.sha256;
  }

  // 不再算读过（上下文裁剪掉了那次读取的结果时用）
  forget(resolvedPath: string): void {
    this.#records.delete(resolvedPath);
  }
}
