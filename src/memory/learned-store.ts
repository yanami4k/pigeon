// 学到的记忆的存取（决策 190、191；施工默认 Q13）：读 MEMORY.md、跨进程锁内读改写、原子写（同目录临时文件加改名）。
// - 锁：多个会话同时写（干活的 agent 与复盘、并行的会话）靠一把独占锁串行；写满判定在锁内做，拿到锁后现读现判，
//   不会两边各自判定"还放得下"再先后写爆。锁文件放在 learned/ 目录之外，跑批器按步快照整个目录时不会带上它。
//   锁被占时等它释放（写一次只需几毫秒），等满仍拿不到即报错。
// - 下一个编号：存在 learned/ 目录内的 next-id 文件（跑批器的快照一并带上；不进推送文字）。人删了它或写坏了，
//   按现有最大编号续（D 审计 2.4）。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import { sha256Hex } from "../state/hashing.ts";
import { MEMORY_FILE_NAME, memoryFactsOfText } from "./learned.ts";

export const NEXT_ID_FILE_NAME = "next-id";
// 等锁的上限与间隔
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

export function learnedDirOf(governanceRoot: string): string {
  return path.join(governanceRoot, ".pigeon", "learned");
}

export function memoryFileOf(governanceRoot: string): string {
  return path.join(learnedDirOf(governanceRoot), MEMORY_FILE_NAME);
}

function lockFileOf(governanceRoot: string): string {
  return path.join(governanceRoot, ".pigeon", "learned.lock");
}

function nextIdFileOf(governanceRoot: string): string {
  return path.join(learnedDirOf(governanceRoot), NEXT_ID_FILE_NAME);
}

// MEMORY.md 的原文与身份；文件不在时 exists 为 false、原文为空
export interface MemoryFileRead {
  exists: boolean;
  text: string;
  bytes: number;
  hash: string;
}

export function readMemoryFile(governanceRoot: string): MemoryFileRead {
  const file = memoryFileOf(governanceRoot);
  if (!existsSync(file)) {
    return { exists: false, text: "", bytes: 0, hash: sha256Hex("") };
  }
  const raw = readFileSync(file);
  return { exists: true, text: raw.toString("utf8"), bytes: raw.length, hash: sha256Hex(raw) };
}

// 字节数、条数与条目区字符数（跑批器结果行的 memoryAtStart / memoryAtEnd 口径）；文件不在记 0
export function memoryFileFacts(governanceRoot: string): {
  bytes: number;
  entries: number;
  entryChars: number;
} {
  const read = readMemoryFile(governanceRoot);
  return { bytes: read.bytes, ...memoryFactsOfText(read.text) };
}

// 另存的下一个编号；不在或写坏为 undefined
export function readStoredNextId(governanceRoot: string): number | undefined {
  try {
    const value = Number(readFileSync(nextIdFileOf(governanceRoot), "utf8").trim());
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

// 写入：先写下一个编号、再写 MEMORY.md（两者之间崩溃只会让编号多跳一个，不会复用）
export function writeMemory(governanceRoot: string, text: string, nextId: number): void {
  mkdirSync(learnedDirOf(governanceRoot), { recursive: true });
  writeFileAtomic(nextIdFileOf(governanceRoot), `${nextId}\n`);
  writeFileAtomic(memoryFileOf(governanceRoot), text);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 在记忆锁内执行一次读改写；锁被占时轮询等待，等满仍拿不到即抛错
export async function withMemoryLock<T>(
  governanceRoot: string,
  work: () => T,
  waitMs: number = LOCK_WAIT_MS
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let release: (() => void) | undefined;
    try {
      release = acquireExclusiveLock(lockFileOf(governanceRoot), "学到的记忆正被另一处写入");
    } catch (error) {
      if (!(error instanceof ExclusiveLockError) || Date.now() >= deadline) {
        throw error;
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
