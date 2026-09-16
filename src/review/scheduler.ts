// 后台审阅调度（M6 S2，决策 064 子裁决 ①②④）：纯调度逻辑，不做装配——派出审阅的动作由 application 注入。
// - 触发：主会话每 everyTurns 轮一次（缺省 8），Run 结束固定补一次；everyTurns 为 0 表示只在 Run 结束审，
//   enabled 为 false 表示关闭。两个值在会话开始时冻结（写进注入快照并随 run.started 落盘，由装配方负责）。
// - 并发：全局同时只跑 1 个审阅（闸由进程共享）。按轮次触发遇忙则跳过并交给 recordSkip 记录；
//   Run 结束补审遇忙则排队（064 修订：每个会话最多一个，新的覆盖旧的），闸释放后立即执行。
//   会话退出或释放时 shutdown：不再触发，排队中或进行中的审阅以原因为退出的跳过记录留痕。
// - 隔离：派出抛错或审阅收尾失败一律吞掉并交给 reportError，调度器从不向主 Run 抛异常。
// - 增量：每次审阅只喂上次审阅覆盖到的条目号之后的内容（快照另带少量前情）。
import type { RunId, SessionId } from "../state/ids.ts";

export const DEFAULT_REVIEW_EVERY_TURNS = 8;

// Reviewer 专设预算（子裁决 ④）：超限按中止处理、不产出候选、主 Run 不受影响；四项均可配
export interface ReviewBudget {
  maxTurns: number;
  wallClockMs: number;
  maxTokens: number;
}

export const DEFAULT_REVIEW_BUDGET: ReviewBudget = {
  maxTurns: 12,
  wallClockMs: 3 * 60_000,
  maxTokens: 40_000,
};

export type ReviewTrigger = "turns" | "run-end";

export interface ReviewSpawnRequest {
  sessionId: SessionId;
  runId: RunId;
  reason: ReviewTrigger;
  // 上次审阅覆盖到的条目号；首次审阅缺省
  sinceRunSeq?: number;
}

export interface ReviewSpawnHandle {
  // 本次审阅覆盖到的条目号（下一次审阅的起点）
  throughRunSeq: number;
  // 审阅收尾（成功、中止或失败都 resolve / reject 一次）
  done: Promise<unknown>;
}

export interface ReviewSkip {
  sessionId: SessionId;
  runId: RunId;
  reason: ReviewTrigger;
  // 跳过原因：busy = 按轮次触发时上一次审阅未收尾；exit = 会话退出或释放时取消了排队中或进行中的审阅
  cause: "busy" | "exit";
  at: number;
}

// 全局闸：进程内同一时刻最多一个审阅在跑；释放时通知订阅方（排队的结束补审据此立即执行）
export interface ReviewGate {
  busy(): boolean;
  tryAcquire(): boolean;
  release(): void;
  onRelease(listener: () => void): () => void;
}

export function createReviewGate(limit = 1): ReviewGate {
  let running = 0;
  const listeners = new Set<() => void>();
  return {
    busy: () => running >= limit,
    tryAcquire: () => {
      if (running >= limit) {
        return false;
      }
      running += 1;
      return true;
    },
    release: () => {
      running = Math.max(0, running - 1);
      for (const listener of [...listeners]) {
        listener();
      }
    },
    onRelease: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// 进程共享的缺省闸（tui /resume 换绑后的新会话与旧会话共用同一个）
export const sharedReviewGate: ReviewGate = createReviewGate();

export interface ReviewSchedulerOptions {
  sessionId: SessionId;
  everyTurns: number;
  enabled: boolean;
  gate: ReviewGate;
  spawn: (request: ReviewSpawnRequest) => ReviewSpawnHandle;
  recordSkip: (skip: ReviewSkip) => void;
  reportError: (error: unknown) => void;
  now?: () => number;
}

export class ReviewScheduler {
  readonly #options: ReviewSchedulerOptions;
  readonly #turns = new Map<RunId, number>();
  readonly #reviewedThrough = new Map<RunId, number>();
  // 064 修订：排队中的结束补审（每个会话最多一个，新的覆盖旧的）
  #queuedRunId: RunId | undefined;
  // 本会话进行中的审阅（退出时据此落跳过记录）
  #inFlight: { runId: RunId; reason: ReviewTrigger; count: number } | undefined;
  #closed = false;
  readonly #unsubscribeGate: () => void;

  constructor(options: ReviewSchedulerOptions) {
    this.#options = options;
    this.#unsubscribeGate = options.gate.onRelease(() => this.#drainQueue());
  }

  onTurnCompleted(runId: RunId): void {
    const turns = (this.#turns.get(runId) ?? 0) + 1;
    this.#turns.set(runId, turns);
    const { everyTurns } = this.#options;
    if (everyTurns > 0 && turns % everyTurns === 0) {
      this.#trigger(runId, "turns");
    }
  }

  onRunEnded(runId: RunId): void {
    this.#trigger(runId, "run-end");
    this.#turns.delete(runId);
  }

  // 会话退出或释放：不再触发；排队中或进行中的审阅由调用方取消，这里落一条原因为退出的跳过记录
  shutdown(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribeGate();
    const queued = this.#queuedRunId;
    this.#queuedRunId = undefined;
    const target =
      queued !== undefined
        ? { runId: queued, reason: "run-end" as const }
        : this.#inFlight !== undefined && this.#inFlight.count > 0
          ? this.#inFlight
          : undefined;
    if (target !== undefined) {
      this.#recordSkip(target.runId, target.reason, "exit");
    }
  }

  // 闸释放：排队的结束补审立即执行（若又被别的会话抢先占闸，则继续排队）
  #drainQueue(): void {
    const runId = this.#queuedRunId;
    if (this.#closed || runId === undefined || this.#options.gate.busy()) {
      return;
    }
    this.#queuedRunId = undefined;
    this.#trigger(runId, "run-end");
  }

  #recordSkip(runId: RunId, reason: ReviewTrigger, cause: ReviewSkip["cause"]): void {
    const options = this.#options;
    try {
      options.recordSkip({
        sessionId: options.sessionId,
        runId,
        reason,
        cause,
        at: (options.now ?? Date.now)(),
      });
    } catch (error) {
      options.reportError(error);
    }
  }

  #trigger(runId: RunId, reason: ReviewTrigger): void {
    const options = this.#options;
    if (!options.enabled || this.#closed) {
      return;
    }
    if (!options.gate.tryAcquire()) {
      if (reason === "run-end") {
        // 064 修订：结束那段往往是教训最集中的收尾阶段——遇忙排队，不跳过；新的覆盖旧的
        this.#queuedRunId = runId;
      } else {
        this.#recordSkip(runId, reason, "busy");
      }
      return;
    }
    const since = this.#reviewedThrough.get(runId);
    let handle: ReviewSpawnHandle;
    try {
      handle = options.spawn({
        sessionId: options.sessionId,
        runId,
        reason,
        ...(since !== undefined ? { sinceRunSeq: since } : {}),
      });
    } catch (error) {
      options.gate.release();
      options.reportError(error);
      return;
    }
    this.#reviewedThrough.set(runId, handle.throughRunSeq);
    this.#inFlight = { runId, reason, count: (this.#inFlight?.count ?? 0) + 1 };
    const settle = (): void => {
      if (this.#inFlight !== undefined) {
        this.#inFlight.count -= 1;
      }
      options.gate.release();
    };
    handle.done.then(settle, (error: unknown) => {
      settle();
      options.reportError(error);
    });
  }
}
