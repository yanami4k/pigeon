// 独占锁（M8 收口补遗）：一把锁同一时刻只许一个持有者，**不可重入**。
//
// 与会话打开锁（session-lock.ts，决策 040）的区别正在这里：会话锁按进程内计数重入，因为同一个
// 进程里可以有多个 JsonlEventLog 实例写同一个会话文件；而这把锁要挡的恰恰是同一个进程里的两件事
// ——人工触发的 `pigeon verify` 与无人值守的自动验证可能同时验同一条候选，会话锁的同进程重入
// 在这里正好是漏洞。故实现上不维护进程内计数：靠锁文件本身的独占建立，同进程再取一样被拒。
//
// 残留处理与会话锁同口径：锁文件记持有进程 pid，持有者仍存活则拒绝；已死或内容畸形即接管。
// 已知局限相同——pid 被系统复用给无关进程时会误判为存活，报错给出锁文件路径供人工清理。
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class ExclusiveLockError extends Error {}

interface LockHolder {
  pid: number;
  acquiredAt: number;
}

function readHolder(path: string): LockHolder | "missing" | "malformed" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockHolder).pid === "number"
    ) {
      return parsed as LockHolder;
    }
  } catch {
    // 落到畸形
  }
  return "malformed";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 先写临时文件再硬链接成锁文件（与会话锁同一手法）：锁文件一出现就带着完整的持有者记录。
// 不能分"独占创建空文件、再写内容"两步——那中间的 0 字节窗口会被另一个进程读成损坏锁并直接接管，
// 结果两个进程同时认为自己持锁，而独占锁挡的恰恰就是这个
function tryCreate(path: string, holder: LockHolder): boolean {
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "wx");
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tempPath, path);
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

// 取锁；返回幂等的释放函数。detail 是给人看的一句话，拒绝时连同锁文件路径一起报出
export function acquireExclusiveLock(path: string, detail: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const holder: LockHolder = { pid: process.pid, acquiredAt: Date.now() };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (tryCreate(path, holder)) {
      return releaser(path, holder.acquiredAt);
    }
    const current = readHolder(path);
    if (current === "missing") {
      continue;
    }
    if (current !== "malformed" && isProcessAlive(current.pid)) {
      throw new ExclusiveLockError(`${detail}（持有进程 pid ${current.pid}，锁文件 ${path}）`);
    }
    // 残留锁：持有进程已死或内容畸形
    rmSync(path, { force: true });
  }
  throw new ExclusiveLockError(`取锁争用，多次重试仍未取得：${path}`);
}

// 只删自己那一把：被别人接管之后重复释放不误删
function releaser(path: string, acquiredAt: number): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = readHolder(path);
    if (
      current !== "missing" &&
      current !== "malformed" &&
      current.pid === process.pid &&
      current.acquiredAt === acquiredAt
    ) {
      rmSync(path, { force: true });
    }
  };
}
