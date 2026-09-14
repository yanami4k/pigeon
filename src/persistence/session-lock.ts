// 会话打开锁（M5.5 S1，决策 040 多窗口小修）：一个会话文件同一时刻只有一个写入进程。
// 锁文件 <sessionId>.lock 记持有进程 pid；先写临时文件再硬链接成锁文件，锁文件一出现就是完整内容
// （不存在"读到半截锁"的窗口）。持有进程仍存活 → 拒绝打开；已死（崩溃残留）或内容畸形 → 接管。
// 同进程内可重入：本进程按锁路径计数，最后一个写入实例关闭才删锁；进程内的重复恢复由 application
// 层拒绝。已知局限：pid 被系统复用给无关进程时会误判为存活，报错信息给出锁文件路径供人工清理。
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionId } from "../state/ids.ts";

export class EventLogLockedError extends Error {}

interface LockHolder {
  pid: number;
  acquiredAt: number;
}

// 本进程已持有的锁：锁路径 → 打开中的写入实例数
const heldLocks = new Map<string, number>();

export function sessionLockPath(dir: string, sessionId: SessionId | string): string {
  return join(dir, `${sessionId}.lock`);
}

// 取得会话锁，返回幂等的释放函数
export function acquireSessionLock(dir: string, sessionId: SessionId): () => void {
  const lockPath = sessionLockPath(dir, sessionId);
  const count = heldLocks.get(lockPath);
  if (count !== undefined) {
    heldLocks.set(lockPath, count + 1);
    return releaser(lockPath);
  }
  // 争用重试上限：两个进程同时判定残留并接管时，硬链接只让一方成功，另一方重读后按存活拒绝
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (tryCreateLock(lockPath)) {
      heldLocks.set(lockPath, 1);
      return releaser(lockPath);
    }
    const holder = readHolder(lockPath);
    if (holder === "missing") {
      continue;
    }
    if (holder !== "malformed" && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
      throw new EventLogLockedError(
        `会话已被另一个进程打开（pid ${holder.pid}）：${lockPath}。` +
          "关闭那个窗口后再恢复；确认该进程已不存在时可删除锁文件"
      );
    }
    // 残留锁：持有进程已死、内容畸形，或 pid 与本进程相同但本进程并未持有（pid 复用）
    rmSync(lockPath, { force: true });
  }
  throw new EventLogLockedError(`会话锁争用，多次重试仍未取得：${lockPath}`);
}

function releaser(lockPath: string): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const count = heldLocks.get(lockPath) ?? 0;
    if (count > 1) {
      heldLocks.set(lockPath, count - 1);
      return;
    }
    heldLocks.delete(lockPath);
    // 只删自己的锁：残留被别的进程接管后不误删
    const holder = readHolder(lockPath);
    if (holder !== "missing" && holder !== "malformed" && holder.pid === process.pid) {
      rmSync(lockPath, { force: true });
    }
  };
}

function tryCreateLock(lockPath: string): boolean {
  const tempPath = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const holder: LockHolder = { pid: process.pid, acquiredAt: Date.now() };
  const fd = openSync(tempPath, "wx");
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tempPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(tempPath);
  }
}

function readHolder(lockPath: string): LockHolder | "missing" | "malformed" {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid, acquiredAt: Number(parsed.acquiredAt) }
      : "malformed";
  } catch {
    return "malformed";
  }
}

// 信号 0 只探测不投递：ESRCH = 进程不存在；EPERM = 存在但无权限（按存活处理）
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
