// 终端界面启动时在后台静默补做复盘（决策 283、284）：启动后立即可用，补做不挡输入；进度在消息区给一行。
// - 找未复盘的会话：以会话存储里有没有以该会话为父、跑完了的收尾复盘为准（192 的口径，不另设登记）。跑完指复盘会话里
//   复盘那次 Run 的收尾条目为正常完成或撞复盘上限；失败、被中止、没有收尾的不算，留待重试。候选只取顶层会话（没有父会话：
//   worker、分叉分支与复盘会话自己都不算）、跑过运行、最近一次运行开着推送记忆、有消息的；本进程当前会话与还被别的进程
//   开着（会话锁被存活进程持有）的不补。
// - 三道闸（284，数值见 .pigeon/review-backfill.json）：只补上线时刻（首次以新版本启动时记在治理根）之后创建的会话；
//   最后动静超过 7 天的视为过时，记下跳过、以后不再补；每次启动最多补 5 个，从最近有动静的开始，其余留到下次。
// - 每个会话补做前先领租约（persistence/review-backfill-store.ts），领不到即跳过；补做失败记下原因与次数，之后的启动重试。
// - 读代码的根：本机会话从退出快照检出临时工作树，沙箱会话从交回的分支检出；没有快照的读当前工作目录并在复盘记录里注明；
//   临时工作树用完删除。复盘本身沿用现有复盘运行面（只放行 read_file 与 update_memory，上限与模板不变），种类记收尾。

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { sandboxBranch } from "../execution/sandbox.ts";
import {
  addDetachedWorktree,
  branchTip,
  commitExists,
  removeWorktree,
} from "../execution/workdir-snapshot.ts";
import { type ReviewVerdictInput, reviewVerdictText } from "../memory/review-text.ts";
import {
  acquireBackfillLease,
  clearBackfillRecord,
  ensureBackfillSince,
  loadReviewBackfillSettings,
  readBackfillRecord,
  releaseBackfillLease,
  writeBackfillRecord,
} from "../persistence/review-backfill-store.ts";
import { acquireSessionFileLock, SessionLockedError } from "../persistence/session-lock.ts";
import {
  branchEntries,
  listSessionFiles,
  readSessionFile,
  type StoredEntry,
} from "../persistence/session-reader.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SessionId } from "../state/ids.ts";
import type { ReviewReadSource } from "../state/learned-memory.ts";
import type { ReviewBackfillSettings } from "../state/review-backfill.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import {
  type ExitData,
  ExitDataSchema,
  type RunEndData,
  type RunStartData,
  SessionEntryType,
  type VerificationData,
} from "../state/session-entries.ts";
import { noMcpSession } from "./mcp.ts";
import { DEFAULT_REVIEW_BUDGET, type ReviewBudget, runMemoryReview } from "./memory-review.ts";
import { repairFailureSummary } from "./repair-loop.ts";
import { dropExitSnapshotRef } from "./tui-exit.ts";
import { failureDetail } from "./warnings.ts";
import { createDetachedRuntime } from "./workers.ts";
import { sessionsDirOf } from "./workspace.ts";

// 复盘跑完的收尾方式：正常完成或撞复盘上限（撞上限前写入的记忆照常保留）
const FINISHED_ENDINGS: ReadonlySet<string> = new Set([
  "completed",
  "turn-limit",
  "wall-clock-limit",
  "token-limit",
]);

// 一个待补做的会话
export interface BackfillCandidate {
  sessionId: SessionId;
  path: string;
  createdAt: number;
  // 主分支上最后一条条目的时刻
  lastActivityAt: number;
}

function customData<T>(entry: StoredEntry, type: string): T | undefined {
  return entry.type === "custom" && entry.customType === type ? (entry.data as T) : undefined;
}

// 扫一遍会话存储（只看上线之后创建的文件）：已有跑完的收尾复盘的来源会话，与可补的顶层会话
function scanSessionStore(
  governanceRoot: string,
  since: number
): { reviewed: Set<string>; candidates: BackfillCandidate[] } {
  const reviewed = new Set<string>();
  const candidates: BackfillCandidate[] = [];
  for (const file of listSessionFiles(sessionsDirOf(governanceRoot))) {
    // 闸一：上线之前创建的会话不补（它们的复盘会话也一定在上线之后才建，照样读得到）
    if (file.createdAt < since) {
      continue;
    }
    let view: ReturnType<typeof readSessionFile>;
    try {
      view = readSessionFile(file.path);
    } catch {
      continue;
    }
    if (view === undefined) {
      continue;
    }
    const main = branchEntries(view, view.lanes.get("main") ?? null);
    const starts = main
      .map((entry) => customData<RunStartData>(entry, SessionEntryType.RunStart))
      .filter((data): data is RunStartData => data !== undefined);
    // 复盘会话：分叉复制来的来源历史也在文件里，复盘那次 Run 是带复盘标记的那一条
    const review = starts.find((data) => data.memoryReview !== undefined);
    if (review !== undefined) {
      const parent = view.header.parentSessionId;
      const finished = main.some((entry) => {
        const end = customData<RunEndData>(entry, SessionEntryType.RunEnd);
        return end !== undefined && end.runId === review.runId && FINISHED_ENDINGS.has(end.ending);
      });
      if (parent !== undefined && review.memoryReview?.kind === "closing" && finished) {
        reviewed.add(parent);
      }
      continue;
    }
    if (view.header.parentSessionId !== undefined) {
      continue;
    }
    if (starts.at(-1)?.learnedMemory === undefined) {
      continue;
    }
    if (!main.some((entry) => entry.type === "message")) {
      continue;
    }
    const lastActivityAt = main.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
    candidates.push({
      sessionId: file.sessionId as SessionId,
      path: file.path,
      createdAt: file.createdAt,
      lastActivityAt,
    });
  }
  return { reviewed, candidates };
}

// 这个会话是否已有跑完的收尾复盘（领到租约之后再核对一次：别的进程可能刚补完、交还了租约）
export function hasFinishedReview(
  governanceRoot: string,
  since: number,
  sessionId: string
): boolean {
  return scanSessionStore(governanceRoot, since).reviewed.has(sessionId);
}

// 待补的（按最后动静从新到旧）与这次判为过时的
export function findBackfillCandidates(input: {
  governanceRoot: string;
  now: number;
  since: number;
  settings: ReviewBackfillSettings;
  exclude?: ReadonlySet<string>;
}): { due: BackfillCandidate[]; stale: BackfillCandidate[] } {
  const { reviewed, candidates } = scanSessionStore(input.governanceRoot, input.since);
  const due: BackfillCandidate[] = [];
  const stale: BackfillCandidate[] = [];
  for (const candidate of candidates) {
    if (reviewed.has(candidate.sessionId) || input.exclude?.has(candidate.sessionId)) {
      continue;
    }
    if (readBackfillRecord(input.governanceRoot, candidate.sessionId)?.status === "stale") {
      continue;
    }
    // 闸二：过时
    if (input.now - candidate.lastActivityAt > input.settings.maxAgeMs) {
      stale.push(candidate);
    } else {
      due.push(candidate);
    }
  }
  due.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { due, stale };
}

// 会话是否还被别的存活进程开着（会话锁被持有）；本进程持有的锁可重入，不算
function openElsewhere(path: string): boolean {
  try {
    acquireSessionFileLock(path)();
    return false;
  } catch (error) {
    return error instanceof SessionLockedError;
  }
}

// 来源会话里最后一条退出条目（数据不合 schema 的不认）
function lastExitOf(main: readonly StoredEntry[]): ExitData | undefined {
  for (let index = main.length - 1; index >= 0; index -= 1) {
    const data = customData<unknown>(main[index] as StoredEntry, SessionEntryType.Exit);
    if (data !== undefined && Value.Check(ExitDataSchema, data)) {
      return data;
    }
  }
  return undefined;
}

// 读代码的来处：沙箱会话读交回的分支（退出条目记的提交；没有退出条目时取交回分支的最新提交），本机会话读退出快照；
// 都没有（或提交已不在仓库里）时读当前工作目录并写明原因
export function readSourceOf(
  governanceRoot: string,
  sessionId: string,
  exit: ExitData | undefined
): ReviewReadSource {
  const workdir = exit?.workdir;
  if (workdir?.kind === "sandbox" && commitExists(governanceRoot, workdir.commit)) {
    return { kind: "sandbox-branch", branch: workdir.branch, commit: workdir.commit };
  }
  if (workdir?.kind === "snapshot") {
    return commitExists(governanceRoot, workdir.commit)
      ? { kind: "exit-snapshot", commit: workdir.commit }
      : { kind: "workdir", reason: "退出快照的提交已不在仓库里" };
  }
  const branch = sandboxBranch(sessionId);
  const tip = branchTip(governanceRoot, branch);
  if (tip !== undefined) {
    return { kind: "sandbox-branch", branch, commit: tip };
  }
  if (workdir?.kind === "none") {
    return { kind: "workdir", reason: `退出时没有快照：${workdir.reason}` };
  }
  if (workdir?.kind === "sandbox") {
    return { kind: "workdir", reason: "沙箱交回的提交已不在仓库里" };
  }
  return { kind: "workdir", reason: "会话没有退出记录（进程可能被直接结束）" };
}

// 验证结论：来源主分支上最后一条验证记录，按收尾复盘的同一填法（242、250）
export function backfillVerdict(main: readonly StoredEntry[]): string {
  let last: VerificationData | undefined;
  for (const entry of main) {
    last = customData<VerificationData>(entry, SessionEntryType.Verification) ?? last;
  }
  if (last === undefined) {
    return reviewVerdictText({ ran: false });
  }
  const steps = last.steps ?? [];
  const faulted = steps.filter((step) => step.toolFault === true);
  const input: ReviewVerdictInput = {
    ran: true,
    verdict: last.verdict,
    faultedSteps: faulted.map((step) => step.name),
    allFaulted: steps.length > 0 && faulted.length === steps.length,
    failureSummary: repairFailureSummary({
      command: last.command.join(" "),
      outcome: { exitCode: last.exitCode, output: last.output, truncated: last.truncated },
      ...(last.steps !== undefined ? { steps: last.steps } : {}),
    }),
  };
  return reviewVerdictText(input);
}

export interface ReviewBackfillRequest {
  governanceRoot: string;
  // 本进程的当前会话（不补）
  currentSessionId?: SessionId;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  persistThinking?: boolean;
  memoryLimitChars?: number;
  budget?: ReviewBudget;
  // 进度一行（消息区）
  progress?: (line: string) => void;
  abortSignal?: AbortSignal;
  now?: () => number;
  // 本次启动的持有者标识（租约里记它）；缺省随机
  holder?: string;
  // 测试注入：常驻 Memory 与 Skill 的根、家目录
  homeDir?: string;
}

export interface ReviewBackfillSummary {
  // 这次打算补几个（进度的分母）
  planned: number;
  completed: SessionId[];
  failed: Array<{ sessionId: SessionId; error: string }>;
  // 这次判为过时、记下跳过的
  stale: SessionId[];
  // 别的进程在补或还开着，这次跳过的
  busy: SessionId[];
}

// 补一个会话：检出读取根、分叉复盘、删除读取根
async function backfillOne(
  request: ReviewBackfillRequest,
  candidate: BackfillCandidate
): Promise<{ ok: true } | { ok: false; aborted: boolean; error: string }> {
  const view = readSessionFile(candidate.path);
  if (view === undefined) {
    return { ok: false, aborted: false, error: "会话文件读不出来" };
  }
  const main = branchEntries(view, view.lanes.get("main") ?? null);
  const systemPrompt = main
    .map((entry) => customData<RunStartData>(entry, SessionEntryType.RunStart))
    .filter((data): data is RunStartData => data !== undefined)
    .at(-1)?.systemPrompt;
  if (systemPrompt === undefined) {
    return { ok: false, aborted: false, error: "会话里没有 Run 开始条目" };
  }
  const readFrom = readSourceOf(request.governanceRoot, candidate.sessionId, lastExitOf(main));
  let readRoot = request.governanceRoot;
  let tempDir: string | undefined;
  try {
    if (readFrom.kind !== "workdir") {
      tempDir = mkdtempSync(join(tmpdir(), "pigeon-backfill-"));
      addDetachedWorktree(request.governanceRoot, tempDir, readFrom.commit);
      readRoot = tempDir;
    }
    const budget = request.budget ?? DEFAULT_REVIEW_BUDGET;
    const outcome = await runMemoryReview({
      kind: "closing",
      governanceRoot: request.governanceRoot,
      sourceSessionId: candidate.sessionId,
      verdict: backfillVerdict(main),
      budget,
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
      open: (review) =>
        createDetachedRuntime({
          sessionId: review.sessionId,
          governanceRoot: request.governanceRoot,
          // 复盘的 read_file 读退出那一刻的代码
          workspaceRoot: readRoot,
          streamFn: request.streamFn,
          provider: request.provider,
          modelId: request.modelId,
          yolo: false,
          ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(request.persistThinking !== undefined
            ? { persistThinking: request.persistThinking }
            : {}),
          ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
          initialMessages: review.initialMessages,
          reviewSession: {
            kind: "closing",
            systemPrompt,
            sourceSessionId: candidate.sessionId,
            covers: review.covers,
            backfill: { readFrom },
          },
          learnedMemory: {
            conflict: "interactive",
            ...(request.memoryLimitChars !== undefined
              ? { limitChars: request.memoryLimitChars }
              : {}),
            review: false,
          },
          budget: { maxTurns: budget.maxTurns, wallClockMs: budget.wallClockMs },
          // 补做不起 MCP server：复盘只用 read_file 与 update_memory
          startMcp: noMcpSession,
        }),
    });
    if (outcome.status === "completed" || outcome.hitLimit) {
      return { ok: true };
    }
    return {
      ok: false,
      aborted: outcome.status === "aborted",
      error: outcome.error ?? outcome.status,
    };
  } catch (error) {
    return { ok: false, aborted: false, error: failureDetail(error) };
  } finally {
    if (tempDir !== undefined) {
      removeWorktree(request.governanceRoot, tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runReviewBackfill(
  request: ReviewBackfillRequest
): Promise<ReviewBackfillSummary> {
  const now = request.now ?? Date.now;
  const holder = request.holder ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  const summary: ReviewBackfillSummary = {
    planned: 0,
    completed: [],
    failed: [],
    stale: [],
    busy: [],
  };
  const settings = loadReviewBackfillSettings(request.governanceRoot);
  const since = ensureBackfillSince(request.governanceRoot, now());
  const { due, stale } = findBackfillCandidates({
    governanceRoot: request.governanceRoot,
    now: now(),
    since,
    settings,
    exclude: new Set(request.currentSessionId !== undefined ? [request.currentSessionId] : []),
  });
  for (const candidate of stale) {
    writeBackfillRecord(request.governanceRoot, {
      version: 1,
      sessionId: candidate.sessionId,
      status: "stale",
      lastActivityAt: candidate.lastActivityAt,
      skippedAt: now(),
    });
    dropExitSnapshotRef(request.governanceRoot, candidate.sessionId);
    summary.stale.push(candidate.sessionId);
  }
  // 闸三：每次最多补 maxPerLaunch 个
  summary.planned = Math.min(due.length, settings.maxPerLaunch);
  let attempted = 0;
  for (const candidate of due) {
    if (attempted >= settings.maxPerLaunch || stopped(request)) {
      break;
    }
    if (openElsewhere(candidate.path)) {
      summary.busy.push(candidate.sessionId);
      continue;
    }
    const lease = acquireBackfillLease({
      governanceRoot: request.governanceRoot,
      sessionId: candidate.sessionId,
      holder,
      now: now(),
      leaseMs: settings.leaseMs,
    });
    if (lease === undefined) {
      summary.busy.push(candidate.sessionId);
      continue;
    }
    try {
      if (hasFinishedReview(request.governanceRoot, since, candidate.sessionId)) {
        continue;
      }
      attempted += 1;
      const result = await backfillOne(request, candidate);
      if (result.ok) {
        clearBackfillRecord(request.governanceRoot, candidate.sessionId);
        dropExitSnapshotRef(request.governanceRoot, candidate.sessionId);
        summary.completed.push(candidate.sessionId);
      } else if (result.aborted && stopped(request)) {
        // 终端界面退出打断了补做：不算失败，下次启动照常补
        break;
      } else {
        const previous = readBackfillRecord(request.governanceRoot, candidate.sessionId);
        writeBackfillRecord(request.governanceRoot, {
          version: 1,
          sessionId: candidate.sessionId,
          status: "failed",
          failures: (previous?.status === "failed" ? previous.failures : 0) + 1,
          lastError: result.error,
          lastFailedAt: now(),
        });
        summary.failed.push({ sessionId: candidate.sessionId, error: result.error });
      }
    } finally {
      releaseBackfillLease({
        governanceRoot: request.governanceRoot,
        sessionId: candidate.sessionId,
        holder,
      });
    }
    request.progress?.(backfillProgressLine(summary));
  }
  return summary;
}

// 进度一行："后台补做复盘：已完成 2/5"；有失败时注明个数与去向
export function backfillProgressLine(summary: ReviewBackfillSummary): string {
  const done = summary.completed.length + summary.failed.length;
  const failed =
    summary.failed.length > 0 ? `（其中 ${summary.failed.length} 个失败，留待下次启动重试）` : "";
  return `后台补做复盘：已完成 ${done}/${summary.planned}${failed}`;
}

// 终端界面已退出、补做被叫停
function stopped(request: ReviewBackfillRequest): boolean {
  return request.abortSignal?.aborted === true;
}
