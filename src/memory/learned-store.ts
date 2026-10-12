// 学到的记忆的存取（决策 332；沿用 Q13 的锁内读改写）：两层各一个文件、各一把锁，读文件、跨进程锁内读改写、原子写
// （同目录临时文件加改名）。
// - 位置：项目级在治理根的 .pigeon/state/memory.md，用户级在 ~/.pigeon/state/memory.md（主目录可注入，测试指到临时目录）。
// - 锁：同一层的多个写入方（并行的会话、/memory edit）靠一把独占锁串行；写满判定在锁内做，拿到锁后现读现判。
//   锁被占时等它释放（写一次只需几毫秒），等满仍拿不到即报错；/memory edit 保存时不设上限，可由人取消。
//   同步的读路径（旧格式的一次性迁移，决策 431）只试一次、不等（tryMemoryLock）。
// - 迁移备份（决策 431）：项目级进用户级本项目的迁移备份目录，用户级进 user/ 目录（见 persistence/migration-backup.ts）。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import {
  migrationBackupLocation,
  userMigrationBackupLocation,
} from "../persistence/migration-backup.ts";
import { sha256Hex } from "../state/hashing.ts";
import {
  projectMemoryLockPathOf,
  projectMemoryPathOf,
  userMemoryLockPathOf,
  userMemoryPathOf,
} from "../state/paths.ts";
import { MEMORY_DISPLAY_PATHS, type MemoryLayer } from "./learned.ts";

// 等锁的上限与间隔
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

// 一层的位置：文件、锁、展示写法与旧格式迁移时的备份目录（决策 431）
export interface MemoryLocation {
  layer: MemoryLayer;
  file: string;
  lock: string;
  display: string;
  backupDir: string;
}

// 备份目录里的名字（相对 .pigeon 的写法，两层相同、目录不同）
export const MEMORY_BACKUP_NAME = path.join("state", "memory.md");

// 记忆锁被占时报错里的说法
const MEMORY_LOCK_DETAIL = "学到的记忆正被另一处写入";

export function memoryLocation(
  layer: MemoryLayer,
  input: { governanceRoot: string; homeDir?: string }
): MemoryLocation {
  const home = input.homeDir ?? homedir();
  if (layer === "project") {
    return {
      layer,
      file: projectMemoryPathOf(input.governanceRoot),
      lock: projectMemoryLockPathOf(input.governanceRoot),
      display: MEMORY_DISPLAY_PATHS.project,
      backupDir: migrationBackupLocation(input.governanceRoot, home),
    };
  }
  return {
    layer,
    file: userMemoryPathOf(home),
    lock: userMemoryLockPathOf(home),
    display: MEMORY_DISPLAY_PATHS.user,
    backupDir: userMigrationBackupLocation(home),
  };
}

// 记忆文件的原文与身份；文件不在时 exists 为 false、原文为空
export interface MemoryFileRead {
  exists: boolean;
  text: string;
  bytes: number;
  hash: string;
}

export function readMemoryFile(file: string): MemoryFileRead {
  if (!existsSync(file)) {
    return { exists: false, text: "", bytes: 0, hash: sha256Hex("") };
  }
  const raw = readFileSync(file);
  return { exists: true, text: raw.toString("utf8"), bytes: raw.length, hash: sha256Hex(raw) };
}

export function writeMemoryFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
}

// 已分配过的最大编号（决策 382：删掉的编号不再分配——最大号被删后，新条目从记下的最大号继续，不回头用旧号）。
// 一层一个小文件（<memory.md>.maxid，在锁内读改写）；文件不在或内容不是正整数按 0 算
export function readMemoryMaxId(file: string): number {
  try {
    const value = Number(readFileSync(`${file}.maxid`, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeMemoryMaxId(file: string, id: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(`${file}.maxid`, `${id}\n`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 只试一次、不等：拿到即返回释放函数；锁被占（ExclusiveLockError）或建不了锁文件即抛错。同步的读路径用
export function tryMemoryLock(lockPath: string): () => void {
  return acquireExclusiveLock(lockPath, MEMORY_LOCK_DETAIL);
}

// 等锁途中被取消（signal 触发）：没有拿到锁，work 没有执行
export class MemoryLockAbortedError extends Error {}

// 等锁的附加选项：取消信号；第一次没拿到锁时回调一次（调用方据此决定何时提示在等）
export interface MemoryLockWait {
  signal?: AbortSignal;
  onContended?: () => void;
}

// 在一层的记忆锁内执行一次读改写；锁被占时轮询等待，等满仍拿不到即抛错（waitMs 为 Infinity 即不设上限），
// 等待途中被取消即抛 MemoryLockAbortedError
export async function withMemoryLock<T>(
  lockPath: string,
  work: () => T,
  waitMs: number = LOCK_WAIT_MS,
  wait: MemoryLockWait = {}
): Promise<T> {
  const deadline = Date.now() + waitMs;
  let contended = false;
  for (;;) {
    if (wait.signal?.aborted === true) {
      throw new MemoryLockAbortedError("等锁途中已取消");
    }
    let release: (() => void) | undefined;
    try {
      release = acquireExclusiveLock(lockPath, MEMORY_LOCK_DETAIL);
    } catch (error) {
      if (!(error instanceof ExclusiveLockError) || Date.now() >= deadline) {
        throw error;
      }
      if (!contended) {
        contended = true;
        wait.onContended?.();
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      return work();
    } finally {
      release();
    }
  }
}
