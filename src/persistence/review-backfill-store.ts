// 后台补做复盘（决策 283、284）与复盘模型（296）在治理根下的读写：配置 .pigeon/memory-review.json（人手写，只读；缺失即缺省，
// 畸形响亮失败，形态同 web.json）与状态目录 .pigeon/review-backfill/（上线时刻、租约、补做记录）。
// 租约：每个会话一个租约文件 leases/<会话号>.json，写明持有者（进程号与本次启动的随机标识）与时刻，过了到期时刻即视为失效。
// 读、判、写三步在同一把按会话号的独占锁里做（exclusive-lock.ts：持有进程已死即接管），同时开着的几个 Pigeon 不会同时领到
// 同一个会话；锁只在这三步之间持有，复盘期间靠租约文件本身挡住别的进程。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  type BackfillLease,
  BackfillLeaseSchema,
  type BackfillRecord,
  BackfillRecordSchema,
  BackfillSinceSchema,
  MEMORY_REVIEW_CONFIG_VERSION,
  type MemoryReviewConfigFile,
  MemoryReviewConfigFileSchema,
  type ReviewBackfillSettings,
  type ReviewModel,
  reviewBackfillSettings,
} from "../state/review-backfill.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "./exclusive-lock.ts";

export class MemoryReviewConfigError extends Error {}

export function memoryReviewConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "memory-review.json");
}

export function reviewBackfillDir(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "review-backfill");
}

// 读配置：补做的生效数值与复盘模型（没指定即缺省）；文件缺失取缺省，畸形响亮失败
export function loadMemoryReviewConfig(governanceRoot: string): {
  backfill: ReviewBackfillSettings;
  reviewModel?: ReviewModel;
} {
  const path = memoryReviewConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return { backfill: reviewBackfillSettings(undefined) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MemoryReviewConfigError(
      `复盘配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(MemoryReviewConfigFileSchema, raw)) {
    const problems = [...Value.Errors(MemoryReviewConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new MemoryReviewConfigError(
      `复盘配置校验失败（当前格式版本 ${MEMORY_REVIEW_CONFIG_VERSION}）：${path}：${problems}`
    );
  }
  const file = raw as MemoryReviewConfigFile;
  return {
    backfill: reviewBackfillSettings(file),
    ...(file.reviewModel !== undefined ? { reviewModel: { ...file.reviewModel } } : {}),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// 上线时刻：已记下即读出；还没有（首次以新版本启动）即以 now 记下。并发首次启动时以先写成的为准（wx 独占创建）
export function ensureBackfillSince(governanceRoot: string, now: number): number {
  const path = join(reviewBackfillDir(governanceRoot), "since.json");
  const existing = readJson(path);
  if (Value.Check(BackfillSinceSchema, existing)) {
    return existing.since;
  }
  mkdirSync(reviewBackfillDir(governanceRoot), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify({ version: 1, since: now })}\n`, { flag: "wx" });
    return now;
  } catch {
    // 别的进程刚写成，或文件畸形：读得出即用它，读不出按本次时刻覆盖
    const again = readJson(path);
    if (Value.Check(BackfillSinceSchema, again)) {
      return again.since;
    }
    writeJson(path, { version: 1, since: now });
    return now;
  }
}

function leasePath(governanceRoot: string, sessionId: string): string {
  return join(reviewBackfillDir(governanceRoot), "leases", `${sessionId}.json`);
}

function leaseLockPath(governanceRoot: string, sessionId: string): string {
  return join(reviewBackfillDir(governanceRoot), "leases", `${sessionId}.lock`);
}

// 在按会话号的独占锁里执行；锁被别的存活进程拿着时返回 undefined（当作领不到）
function underLeaseLock<T>(
  governanceRoot: string,
  sessionId: string,
  body: () => T
): T | undefined {
  let release: () => void;
  try {
    release = acquireExclusiveLock(
      leaseLockPath(governanceRoot, sessionId),
      `补做复盘的租约正被另一个进程处理：${sessionId}`
    );
  } catch (error) {
    if (error instanceof ExclusiveLockError) {
      return undefined;
    }
    throw error;
  }
  try {
    return body();
  } finally {
    release();
  }
}

// 当前有效的租约（没有或已失效为 undefined）
export function readLiveLease(
  governanceRoot: string,
  sessionId: string,
  now: number
): BackfillLease | undefined {
  const lease = readJson(leasePath(governanceRoot, sessionId));
  return Value.Check(BackfillLeaseSchema, lease) && lease.expiresAt > now ? lease : undefined;
}

// 领租约：没有有效租约（或有效租约就是本持有者的）即写入新租约并返回它；别人持有返回 undefined
export function acquireBackfillLease(input: {
  governanceRoot: string;
  sessionId: string;
  holder: string;
  now: number;
  leaseMs: number;
}): BackfillLease | undefined {
  return underLeaseLock(input.governanceRoot, input.sessionId, () => {
    const live = readLiveLease(input.governanceRoot, input.sessionId, input.now);
    if (live !== undefined && live.holder !== input.holder) {
      return undefined;
    }
    const lease: BackfillLease = {
      version: 1,
      sessionId: input.sessionId,
      holder: input.holder,
      pid: process.pid,
      acquiredAt: input.now,
      expiresAt: input.now + input.leaseMs,
    };
    writeJson(leasePath(input.governanceRoot, input.sessionId), lease);
    return lease;
  });
}

// 交还租约：只删自己的（已被别人在失效后接手的不动）
export function releaseBackfillLease(input: {
  governanceRoot: string;
  sessionId: string;
  holder: string;
}): void {
  underLeaseLock(input.governanceRoot, input.sessionId, () => {
    const lease = readJson(leasePath(input.governanceRoot, input.sessionId));
    if (Value.Check(BackfillLeaseSchema, lease) && lease.holder === input.holder) {
      rmSync(leasePath(input.governanceRoot, input.sessionId), { force: true });
    }
  });
}

function recordPath(governanceRoot: string, sessionId: string): string {
  return join(reviewBackfillDir(governanceRoot), "records", `${sessionId}.json`);
}

export function readBackfillRecord(
  governanceRoot: string,
  sessionId: string
): BackfillRecord | undefined {
  const record = readJson(recordPath(governanceRoot, sessionId));
  return Value.Check(BackfillRecordSchema, record) ? record : undefined;
}

export function writeBackfillRecord(governanceRoot: string, record: BackfillRecord): void {
  writeJson(recordPath(governanceRoot, record.sessionId), record);
}

export function clearBackfillRecord(governanceRoot: string, sessionId: string): void {
  rmSync(recordPath(governanceRoot, sessionId), { force: true });
}
