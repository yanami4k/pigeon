// 后台作业的应用层接法（决策 365）。作业表本身在 tools/background-jobs.ts，这里接通知、会话记录、收尾与善后：
// - 结束通知：作业结束经运行面的通知队列告诉模型（与 worker 通知同一条队列）；还没递出时又有作业结束的，撤回重发、合并成
//   一条；结束状态已经由 job_output / job_kill 交回的，不再通知（还没递出的撤回）。终端界面里模型空闲时经 wake 叫醒它。
// - 会话记录：作业启动与结束各写一条（pigeon.background-job）。
// - 无人值守收尾（headless 与 worker 的运行面）：一次运行结束后还有作业在跑的，先交一条"仍在跑"的通知让模型处理一轮
//   （要结果就用 job_output 等，不要的用 job_kill 停掉），再等剩下的作业、把结束通知交给模型跑一轮，直到没有在跑的作业；
//   收尾总时限（设置可改）从收尾开始起算，计入运行的墙钟预算（墙钟到了照常中止）；总时限到了即停掉余下的作业、把通知
//   交给模型跑一轮，此后拒绝新开作业。收尾的每一轮照常计入运行的轮数与 token 上限。
// - 善后：会话或运行结束时停掉全部作业（disposeRuntime）；崩溃后下次启动按记录清理（每个进程每个治理目录一次）；
//   续跑时提示上一进程的作业已丢失。

import { Value } from "typebox/value";
import { killMarkedInContainer } from "../execution/container-host.ts";
import type { RunId } from "../state/ids.ts";
import { jobsDirOf } from "../state/paths.ts";
import {
  BackgroundJobDataSchema,
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import {
  type BackgroundJob,
  type BackgroundJobEvent,
  cleanupOrphanedJobs,
  elapsedText,
  jobChangesText,
  jobOutputText,
  jobStateText,
  type OrphanReport,
  outputTail,
  type SessionJobs,
} from "../tools/background-jobs.ts";
import { escapeStatusText } from "./status-block.ts";
import type { DrainTarget, NoticeTarget } from "./worker-notices.ts";

export const JOB_NOTICE_PREFIX = "[后台作业通知] ";
// 通知里带的输出末尾
const NOTICE_TAIL_BYTES = 2048;

export function backgroundJobEntry(event: BackgroundJobEvent, runId?: RunId): SessionCustomEntry {
  const run = runId !== undefined ? { runId } : {};
  if (event.phase === "started") {
    const { phase: _phase, ...rest } = event;
    return {
      customType: SessionEntryType.BackgroundJob,
      data: { version: SESSION_ENTRY_VERSION, event: "started", ...run, ...rest },
    };
  }
  const { phase: _phase, ...rest } = event;
  return {
    customType: SessionEntryType.BackgroundJob,
    data: { version: SESSION_ENTRY_VERSION, event: "ended", ...run, ...rest },
  };
}

// 一个结束了的作业在通知里的一段
function noticeSection(job: BackgroundJob): string {
  const changes = jobChangesText(job);
  const tail = outputTail(job, NOTICE_TAIL_BYTES);
  return [
    `作业 ${job.id} ${jobStateText(job)}：$ ${job.command}`,
    jobOutputText(job),
    ...(changes !== undefined ? [changes] : []),
    ...(tail !== "" ? [`输出末尾：\n${tail}`] : []),
  ].join("\n");
}

export function jobNoticeText(jobs: readonly BackgroundJob[]): string {
  const sections = jobs.map(noticeSection);
  return jobs.length === 1
    ? (sections[0] as string)
    : [`${jobs.length} 个后台作业已结束：`, ...sections].join("\n\n");
}

export interface JobNoticesOptions {
  wake?: () => void;
  onNotice?: (text: string) => void;
}

// 一个运行面上的作业结束通知
export class JobNotices {
  readonly #target: NoticeTarget;
  #wake: (() => void) | undefined;
  #onNotice: ((text: string) => void) | undefined;
  #key: string | undefined;
  #inNotice: BackgroundJob[] = [];
  readonly #unsubscribe: Array<() => void>;

  constructor(jobs: SessionJobs, target: NoticeTarget, options: JobNoticesOptions = {}) {
    this.#target = target;
    this.#wake = options.wake;
    this.#onNotice = options.onNotice;
    this.#unsubscribe = [
      jobs.onSettled((job) => {
        if (!job.reported) this.#post([job], true);
      }),
      jobs.onReported((job) => this.#claim(job)),
    ];
  }

  // 终端界面晚绑定：空闲时叫醒模型、在消息区显示
  bind(options: JobNoticesOptions): void {
    this.#wake = options.wake;
    this.#onNotice = options.onNotice;
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  // 上一条通知已递出：其中的作业算交给模型了；还没递出：撤回，交回其中的作业（合并进下一条）
  #takeBack(): BackgroundJob[] {
    const key = this.#key;
    const previous = this.#inNotice;
    this.#key = undefined;
    this.#inNotice = [];
    if (key === undefined) return [];
    if (!this.#target.noticeDelivered(key) && this.#target.withdrawNotice(key)) {
      return previous;
    }
    for (const job of previous) job.reported = true;
    return [];
  }

  #post(added: readonly BackgroundJob[], wake: boolean): void {
    const jobs = [...this.#takeBack(), ...added].filter((job) => !job.reported);
    if (jobs.length === 0) return;
    const text = `${JOB_NOTICE_PREFIX}${escapeStatusText(jobNoticeText(jobs))}`;
    this.#inNotice = jobs;
    this.#key = this.#target.notify(text);
    this.#onNotice?.(text);
    if (wake) this.#wake?.();
  }

  // job_output / job_kill 交回了结束状态：还没递出的通知里去掉它（剩下的重发）
  #claim(job: BackgroundJob): void {
    if (!this.#inNotice.includes(job)) return;
    const key = this.#key;
    if (key !== undefined && this.#target.noticeDelivered(key)) return;
    this.#post([], false);
  }
}

// 收尾总时限的起点（同一会话多次进入收尾共用一个总时限）
const closeoutDeadlines = new WeakMap<SessionJobs, number>();

// 收尾开始时还有作业在跑：先交给模型的一条（只交一次）
export function stillRunningText(jobs: readonly BackgroundJob[], now = Date.now()): string {
  const list = jobs
    .map((job) => `${job.id}（${job.command}，已跑 ${elapsedText(now - job.startedAt)}）`)
    .join("、");
  return `本次运行即将收尾，${jobs.length} 个后台作业仍在跑：${list}；需要它们的结果就用 job_output 等，不需要的用 job_kill 停掉`;
}

export const CLOSEOUT_CLOSED_REASON = "无人值守收尾的总时限已到";

// 无人值守收尾：等在跑的作业、把通知交给模型跑一轮，直到没有在跑的作业或待递的通知；stopped 为真（墙钟、上限、外部中止）
// 即不再等。总时限到了停掉余下的作业，此后拒绝新开。返回最后一次运行的结果（没跑即 undefined）
export async function settleBackgroundJobs<R>(input: {
  jobs: SessionJobs;
  target: DrainTarget<R> & { notify(text: string): unknown };
  stopped: () => boolean;
  closeoutMs: number;
}): Promise<{ last?: R }> {
  const { jobs, target } = input;
  let last: R | undefined;
  for (;;) {
    if (input.stopped()) break;
    if (target.pendingNotices() > 0) {
      last = await target.runNotices();
      continue;
    }
    const running = jobs.running();
    if (running.length === 0) break;
    let deadline = closeoutDeadlines.get(jobs);
    if (deadline === undefined) {
      // 收尾开始：总时限起算，先让模型处理一轮"仍在跑"
      deadline = Date.now() + input.closeoutMs;
      closeoutDeadlines.set(jobs, deadline);
      target.notify(`${JOB_NOTICE_PREFIX}${escapeStatusText(stillRunningText(running))}`);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      jobs.close(CLOSEOUT_CLOSED_REASON);
      await jobs.killAll("closeout");
      continue;
    }
    const controller = new AbortController();
    const poll = setInterval(() => {
      if (input.stopped()) controller.abort();
    }, 200);
    try {
      await jobs.waitAny(remaining, controller.signal);
    } finally {
      clearInterval(poll);
    }
  }
  return last !== undefined ? { last } : {};
}

// 续跑：会话记录里只有启动、没有结束的作业（属于已退出的进程）与用过的最大作业号
export interface PreviousJobs {
  lost: Array<{ jobId: string; command: string }>;
  lastId: number;
}

export function previousJobsOf(
  entries: ReadonlyArray<{ type: string; customType?: unknown; data?: unknown }>
): PreviousJobs {
  const started = new Map<string, string>();
  let lastId = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SessionEntryType.BackgroundJob) continue;
    if (!Value.Check(BackgroundJobDataSchema, entry.data)) continue;
    const data = entry.data;
    const seq = /^j(\d+)$/.exec(data.jobId)?.[1];
    if (seq !== undefined) lastId = Math.max(lastId, Number(seq));
    if (data.event === "started") started.set(data.jobId, data.command);
    else started.delete(data.jobId);
  }
  return {
    lost: [...started].map(([jobId, command]) => ({ jobId, command })),
    lastId,
  };
}

export function lostJobsText(lost: PreviousJobs["lost"]): string {
  return (
    `上一个进程启动的后台作业已随它结束而丢失（没有结束记录）：${lost.map((job) => `${job.jobId}（${job.command}）`).join("、")}。` +
    "残留的进程已按记录清理或会在下次启动时清理；需要的话重新启动"
  );
}

// 决策 365：沙箱交回时有作业在跑先提示（给人看的一行）。收尾交回之前作业随会话结束停掉，交回的是停下时的工作区；
// 会话中途 /export 时作业照跑，交回的可能是做到一半的样子。没有在跑的为 undefined
export function handbackJobsNotice(
  jobs: Pick<SessionJobs, "running"> | undefined,
  when: "close" | "export"
): string | undefined {
  const running = jobs?.running() ?? [];
  if (running.length === 0) return undefined;
  const list = running.map((job) => `${job.id}（${job.command}）`).join("、");
  return when === "close"
    ? `交回沙箱前停掉在跑的后台作业：${list}；交回的是它们停下时的工作区`
    : `交回时后台作业仍在跑：${list}；交回的改动可能是作业做到一半的样子`;
}

const cleanedDirs = new Set<string>();

const ORPHAN_RESULT_TEXT: Record<OrphanReport["result"], string> = {
  killed: "已停掉",
  gone: "进程已不在",
  reused: "进程号已被别的程序复用，没有动它",
  "container-unavailable": "容器已不可用",
};

// 崩溃后下次启动：清理上一进程留下的作业（每个进程每个治理目录一次，后台进行），给人报一行
export function cleanupOrphanedJobsOnce(
  governanceRoot: string,
  warn?: (line: string) => void
): Promise<OrphanReport[]> {
  const dir = jobsDirOf(governanceRoot);
  if (cleanedDirs.has(dir)) return Promise.resolve([]);
  cleanedDirs.add(dir);
  return cleanupOrphanedJobs(dir, {
    killContainer: (record) => killMarkedInContainer({ docker: ["docker"], ...record }),
  }).then(
    (reports) => {
      for (const report of reports) {
        warn?.(
          `上次异常退出时留下的后台作业 ${report.jobId}（${report.command}）：${ORPHAN_RESULT_TEXT[report.result]}`
        );
      }
      return reports;
    },
    () => []
  );
}
