// 本会话读过哪些文件（决策 358）：write_file 覆盖已存在的文件前须本会话读过它，且读后没被改过。按执行端解析后的规范路径，
// 记最近一次成功读取时整个文件的 sha256 与字节数（不存内容）；任何一次成功读取（含分段读取）都算读过，"读后未变"按读取当时
// 整个文件的哈希判断。edit_file、write_file 成功后按写成的内容更新记录。之后的上下文裁剪经 hasRead 与 forget 接上。
import { createHash } from "node:crypto";

export interface FileReadRecord {
  sha256: string;
  bytes: number;
  // 记录时刻（Unix 毫秒）
  at: number;
}

function digest(raw: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    bytes: Buffer.byteLength(raw, "utf8"),
  };
}

export class FileReadTracker {
  readonly #records = new Map<string, FileReadRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // 一次成功读取或写入后：raw 为当时整个文件的内容
  record(resolvedPath: string, raw: string): void {
    this.#records.set(resolvedPath, { ...digest(raw), at: this.#now() });
  }

  // 这个文件本会话是否算读过
  hasRead(resolvedPath: string): boolean {
    return this.#records.has(resolvedPath);
  }

  lastRead(resolvedPath: string): FileReadRecord | undefined {
    return this.#records.get(resolvedPath);
  }

  // 现在的内容与最近一次记录时相同
  unchangedSinceRead(resolvedPath: string, raw: string): boolean {
    const record = this.#records.get(resolvedPath);
    if (record === undefined) return false;
    const now = digest(raw);
    return now.bytes === record.bytes && now.sha256 === record.sha256;
  }

  // 不再算读过（上下文裁剪掉了那次读取的结果时用）
  forget(resolvedPath: string): void {
    this.#records.delete(resolvedPath);
  }
}
