// 整文件原子替换（M5.5 S1，决策 040 多窗口小修）：同目录临时文件写满并 fsync 后改名覆盖目标。
// 任何时刻目标路径上要么是旧文件、要么是新文件，写到一半崩溃只留下临时文件（读方不看它）。
// 写入函数可注入：测试以"写一半即抛"模拟进程在写盘中途死亡。
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

export interface AtomicWriteIo {
  write(fd: number, data: string): void;
}

const defaultIo: AtomicWriteIo = {
  write(fd, data) {
    writeSync(fd, data);
  },
};

export function writeFileAtomic(path: string, data: string, io: AtomicWriteIo = defaultIo): void {
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    io.write(fd, data);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
