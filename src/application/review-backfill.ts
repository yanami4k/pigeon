// 终端界面启动时在后台静默补做复盘（决策 283、284、295、296）：启动后立即可用，补做不挡输入；进度在消息区给一行。
// - 要不要补（295）：以该会话为父、跑完了的各次复盘（压缩前、收尾、补做）覆盖到的最大条目之后仍有消息，就要补；补做过又被
//   续聊的会话按同一规则补新增部分（不另设登记）。跑完指复盘会话里复盘那次 Run 的收尾条目为正常完成或撞复盘上限；失败、
//   被中止、没有收尾的不算，留待重试。补做时仍给完整上下文，指令里写明第 N 条及之前已复盘。候选只取顶层会话（没有父会话：
//   worker、分叉分支与复盘会话自己都不算）、跑过运行、最近一次运行开着推送记忆、有消息的；本进程当前会话与还被别的进程
//   开着（会话锁被存活进程持有）的不补。
// - 三道闸（284，数值见 .pigeon/memory-review.json）：只补上线时刻（首次以新版本启动时记在治理根）之后创建的会话；
//   最后动静超过 7 天的视为过时，记下跳过、以后不再补；每次启动最多补 5 个，从最近有动静的开始，其余留到下次。
// - 每个会话补做前先领租约（persistence/review-backfill-store.ts），领不到即跳过；补做失败记下原因与次数，之后的启动重试。
// - 读代码的根：本机会话从退出快照检出临时工作树，沙箱会话从交回的分支检出；没有快照的读当前工作目录并在复盘记录里注明；
//   临时工作树用完删除。复盘本身沿用现有复盘运行面（只放行 read_file 与 update_memory，上限与模板不变），种类记收尾。
// - 模型（296）：配置里指定了复盘模型即用它，否则用本次启动的模型。
// - 结构化进度（286）：observe 在开始补第几个与每补完一个时给出（第几个、共几个、累计花费），终端界面据此在状态栏显示；
//   花费取复盘会话记录里模型回复自带的用量与价格，记在被补的会话名下，不并入当前会话。progress 的一行文字照旧。
//   warn 为补做运行面会话存储告警的出口（缺省标准错误输出）。

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
  loadMemoryReviewConfig,
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
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
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
import {
  DEFAULT_REVIEW_BUDGET,
  type ReviewBudget,
  type ReviewModelChoice,
  runMemoryReview,
} from "./memory-review.ts";
import { repairFailureSummary } from "./repair-loop.ts";
import {
  type CostTally,
  emptyCostTally,
  mergeCostTally,
  sessionCostTally,
} from "./session-cost.ts";
import { dropExitSnapshotRef } from "./tui-exit.ts";
import { failureDetail, type WarnSink } from "./warnings.ts";
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
  // 主分支上最后一条消息条目的序号
  lastMessageSeq: number;
}

// 以某会话为父、跑完了的各次复盘覆盖到的最大位置（295）
export interface ReviewedUpTo {
  entryId: string;
  seq: number;
}

function customData<T>(entry: StoredEntry, type: string): T | undefined {
  return entry.type === "custom" && entry.customType === type ? (entry.data as T) : undefined;
}

// 扫一遍会话存储（只看上线之后创建的文件）：各来源会话已复盘到的位置，与可补的顶层会话
function scanSessionStore(
  governanceRoot: string,
  since: number
): { reviewedUpTo: Map<string, ReviewedUpTo>; candidates: BackfillCandidate[] } {
  const reviewedUpTo = new Map<string, ReviewedUpTo>();
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
      const tag = review.memoryReview;
      const finished = main.some((entry) => {
        const end = customData<RunEndData>(entry, SessionEntryType.RunEnd);
        return end !== undefined && end.runId === review.runId && FINISHED_ENDINGS.has(end.ending);
      });
      if (parent === undefined || tag === undefined || !finished) {
        continue;
      }
      // 没有覆盖记录的收尾复盘（覆盖记录之前的版本写的）当作覆盖了整个会话，与此前"有收尾复盘即已复盘"的口径一致；
      // 没有覆盖记录的压缩前复盘不计
      const covered =
        tag.covers ??
        (tag.kind === "closing" ? { entryId: "", seq: Number.MAX_SAFE_INTEGER } : undefined);
      const previous = reviewedUpTo.get(parent);
      if (covered !== undefined && (previous === undefined || covered.seq > previous.seq)) {
        reviewedUpTo.set(parent, { entryId: covered.entryId, seq: covered.seq });
      }
      continue;
    }
    if (view.header.parentSessionId !== undefined) {
      continue;
    }
    if (starts.at(-1)?.learnedMemory === undefined) {
      continue;
    }
    const lastMessage = main.findLast((entry) => entry.type === "message");
    if (lastMessage === undefined) {
      continue;
    }
    const lastActivityAt = main.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
    candidates.push({
      sessionId: file.sessionId as SessionId,
      path: file.path,
      createdAt: file.createdAt,
      lastActivityAt,
      lastMessageSeq: lastMessage.seq,
    });
  }
  return { reviewedUpTo, candidates };
}

// 还要不要补（295）：已复盘到的位置之后仍有消息
function needsReview(candidate: BackfillCandidate, upTo: ReviewedUpTo | undefined): boolean {
  return upTo === undefined || candidate.lastMessageSeq > upTo.seq;
}

// 领到租约之后按同一口径再核对一次（别的进程可能刚补完、交还了租约）：还要补即返回已复盘到的位置（没有为 null），
// 不用补为 undefined
function recheck(
  governanceRoot: string,
  since: number,
  sessionId: string
): { upTo: ReviewedUpTo | null } | undefined {
  const scan = scanSessionStore(governanceRoot, since);
  const candidate = scan.candidates.find((item) => item.sessionId === sessionId);
  const upTo = scan.reviewedUpTo.get(sessionId);
  if (candidate === undefined || !needsReview(candidate, upTo)) {
    return undefined;
  }
  return { upTo: upTo ?? null };
}

// 待补的（按最后动静从新到旧）与这次判为过时的
export function findBackfillCandidates(input: {
  governanceRoot: string;
  now: number;
  since: number;
  settings: ReviewBackfillSettings;
  exclude?: ReadonlySet<string>;
}): { due: BackfillCandidate[]; stale: BackfillCandidate[] } {
  const { reviewedUpTo, candidates } = scanSessionStore(input.governanceRoot, input.since);
  const due: BackfillCandidate[] = [];
  const stale: BackfillCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !needsReview(candidate, reviewedUpTo.get(candidate.sessionId)) ||
      input.exclude?.has(candidate.sessionId)
    ) {
      continue;
    }
    // 记过过时跳过的不再补；之后又续聊过（最后动静晚于当时记下的）按新的动静重新判断
    const record = readBackfillRecord(input.governanceRoot, candidate.sessionId);
    if (record?.status === "stale" && record.lastActivityAt >= candidate.lastActivityAt) {
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

// "第 N 条"的 N：复盘看到的上下文里，已复盘位置（含）及之前的消息条数。上下文由会话主分支还原（压缩过的段落换成一条摘要
// 加保留段），所以取还原后的总条数，减去已复盘位置之后、且在最后一次压缩之后原样出现的消息条数
export function reviewedMessageCount(main: readonly StoredEntry[], upToSeq: number): number {
  const lastCompaction = main.reduce(
    (latest, entry) => (entry.type === "compaction" ? Math.max(latest, entry.seq) : latest),
    -1
  );
  const after = main.filter(
    (entry) => entry.type === "message" && entry.seq > Math.max(upToSeq, lastCompaction)
  ).length;
  return Math.max(1, sessionContextMessages(main).length - after);
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
  // 复盘模型（296）：配置里指定时在场；缺省用本次启动的 provider 与模型号
  reviewModel?: ReviewModelChoice;
  budget?: ReviewBudget;
  // 进度一行（消息区）
  progress?: (line: string) => void;
  // 结构化进度（286，状态栏）
  observe?: (progress: BackfillProgress) => void;
  // 补做运行面会话存储告警的出口（286）；缺省标准错误输出
  warn?: WarnSink;
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

// 结构化进度（286）：current 为正在补的第几个（1 起；没有在补时为 undefined），cost 为这次启动已补完的复盘的累计花费
export interface BackfillProgress {
  planned: number;
  current?: number;
  completed: number;
  failed: number;
  cost: CostTally;
}

// 补一个会话：检出读取根、分叉复盘、删除读取根
async function backfillOne(
  request: ReviewBackfillRequest,
  candidate: BackfillCandidate,
  upTo: ReviewedUpTo | null
): Promise<
  ({ ok: true } | { ok: false; aborted: boolean; error: string }) & { reviewSessionId?: SessionId }
> {
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
  // 此前的复盘已覆盖到的位置（295）：指令里写明第 N 条及之前已复盘，复盘记录记下它；仍给完整上下文
  const priorCovers =
    upTo !== null && upTo.seq !== Number.MAX_SAFE_INTEGER
      ? { ...upTo, messages: reviewedMessageCount(main, upTo.seq) }
      : undefined;
  // 复盘模型（296）：配置里指定了即用它，否则用本次启动的模型
  const model = request.reviewModel ?? { provider: request.provider, modelId: request.modelId };
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
      ...(priorCovers !== undefined ? { reviewedUpTo: priorCovers.messages } : {}),
      budget,
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
      open: (review) =>
        createDetachedRuntime({
          sessionId: review.sessionId,
          governanceRoot: request.governanceRoot,
          // 复盘的 read_file 读退出那一刻的代码
          workspaceRoot: readRoot,
          streamFn: request.streamFn,
          provider: model.provider,
          modelId: model.modelId,
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
            backfill: { readFrom, ...(priorCovers !== undefined ? { priorCovers } : {}) },
          },
          learnedMemory: {
            conflict: "interactive",
            ...(request.memoryLimitChars !== undefined
              ? { limitChars: request.memoryLimitChars }
              : {}),
            review: false,
          },
          budget: { maxTurns: budget.maxTurns, wallClockMs: budget.wallClockMs },
          ...(request.warn !== undefined ? { storeWarn: request.warn } : {}),
          // 补做不起 MCP server：复盘只用 read_file 与 update_memory
          startMcp: noMcpSession,
        }),
    });
    const reviewed = outcome.sessionId !== undefined ? { reviewSessionId: outcome.sessionId } : {};
    if (outcome.status === "completed" || outcome.hitLimit) {
      return { ok: true, ...reviewed };
    }
    return {
      ok: false,
      aborted: outcome.status === "aborted",
      error: outcome.error ?? outcome.status,
      ...reviewed,
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
  const settings = loadMemoryReviewConfig(request.governanceRoot).backfill;
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
  const cost = emptyCostTally();
  const observe = (current?: number): void => {
    request.observe?.({
      planned: summary.planned,
      ...(current !== undefined ? { current } : {}),
      completed: summary.completed.length,
      failed: summary.failed.length,
      cost: { ...cost },
    });
  };
  observe();
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
      const checked = recheck(request.governanceRoot, since, candidate.sessionId);
      if (checked === undefined) {
        continue;
      }
      attempted += 1;
      observe(attempted);
      const result = await backfillOne(request, candidate, checked.upTo);
      if (result.reviewSessionId !== undefined) {
        mergeCostTally(
          cost,
          sessionCostTally(sessionsDirOf(request.governanceRoot), result.reviewSessionId)
        );
      }
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
    observe();
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
