// worker 完成通知（决策 297）：模型派出的 worker 结束时，一条通知进派出方的下一轮——派出方在跑时留在它的运行面上、
// 下一轮带上；空闲时经 wake 叫醒它来处理。
// - 只给模型派出的（spawn_worker）发；人用 /spawn 派的收尾照旧显示在消息区，程序直接调用的由调用方自己收。
// - 同一结果不在对话里出现两遍：派出方正用 wait_workers 等着的 worker 结束时不另发通知；等待工具交回结果时，还没递出的
//   通知撤回；已经递出的，等待工具只交回一句"结果见此前的通知"。
// - 多份尝试（attempts）不逐个发，全部结束并验证后由派发方发一条带各份标签的通知。
// 另有 drainWorkers：一次性命令（pigeon run）与能再派的 worker 在自己的运行结束后，等派出的 worker 全部结束、
// 把通知处理完才算结束。
import type {
  WorkerLifecycleEvent,
  WorkerOrchestrator,
  WorkerOutcome,
} from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import { escapeStatusText } from "./status-block.ts";

// 派出方运行面上接收通知的一面（PiRuntimeAdapter 满足）
export interface NoticeTarget {
  notify(text: string): string;
  withdrawNotice(key: string): boolean;
  noticeDelivered(key: string): boolean;
  pendingNotices(): number;
}

export const WORKER_NOTICE_PREFIX = "[worker 通知] ";

export interface WorkerNoticesOptions {
  orchestrator: Pick<WorkerOrchestrator, "subscribe">;
  // 派出方会话：只处理它派出的 worker
  parentSessionId: SessionId;
  target: NoticeTarget;
  // 一个 worker 结束时交给模型的文字（不含前缀）
  text: (outcome: WorkerOutcome) => string;
  // 派出方空闲时叫醒它（终端界面开一轮只带通知的运行；pigeon run 与嵌套 worker 由 drainWorkers 处理，不给）
  wake?: () => void;
  // 每条通知递出时的回调（终端界面据此在消息区显示）
  onNotice?: (text: string) => void;
}

// 等待工具交回结果时对某个 worker 的判定：fresh = 交回完整结果；notified = 已经递出过通知，只交回一句
export type NoticeClaim = "fresh" | "notified";

export class WorkerNotices {
  readonly #options: WorkerNoticesOptions;
  readonly #unsubscribe: () => void;
  // worker → 递出的通知键
  readonly #keys = new Map<SessionId, string>();
  // 正被等待工具等着的 worker（计数：可能同时被几次等待等着）
  readonly #awaited = new Map<SessionId, number>();
  // 多份尝试的 worker：不逐个发
  readonly #grouped = new Set<SessionId>();
  // 多份尝试里已由等待工具交回完整结果的：汇总通知里只写一句
  readonly #groupClaimed = new Set<SessionId>();
  readonly #groupPosted = new Set<SessionId>();
  #pendingGroups = 0;
  readonly #listeners = new Set<() => void>();

  constructor(options: WorkerNoticesOptions) {
    this.#options = options;
    this.#unsubscribe = options.orchestrator.subscribe((event) => this.#onEvent(event));
  }

  dispose(): void {
    this.#unsubscribe();
  }

  // 多份尝试：这些 worker 由派发方汇总发一条（汇总发出之前算作还有未交回的结果）
  group(ids: readonly SessionId[]): void {
    for (const id of ids) {
      this.#grouped.add(id);
    }
    this.#pendingGroups += 1;
  }

  // 还有多份尝试的汇总没发出
  pendingGroups(): number {
    return this.#pendingGroups;
  }

  // 直接递一段通知（收尾异常等）
  post(text: string): void {
    this.#deliver(text);
  }

  // 为某个 worker 递一段通知并记下键（续接时补递之前的运行没递出的完成通知）：等待工具交回它的结果时照常撤回或只交回一句
  postFor(id: SessionId, text: string): void {
    this.#keys.set(id, this.#deliver(text));
  }

  // 决策 309–313：程序在后台做、结束时发一条的（脚本编排）——开始时登记，发出前算作还有未交回的结果（drainWorkers 等它）；
  // 返回发出的函数，文字原样递出（前缀由调用方给），只发一次
  hold(): (text: string) => void {
    this.#pendingGroups += 1;
    let posted = false;
    return (text) => {
      if (posted) return;
      posted = true;
      this.#pendingGroups = Math.max(0, this.#pendingGroups - 1);
      this.#deliver(text, "");
    };
  }

  // 多份尝试的汇总通知（收尾异常时同样经这里发出）
  postGroup(ids: readonly SessionId[], text: string): void {
    for (const id of ids) {
      this.#groupPosted.add(id);
    }
    this.#pendingGroups = Math.max(0, this.#pendingGroups - 1);
    this.#deliver(text);
  }

  // 等待工具开始等这些 worker
  beginWait(ids: readonly SessionId[]): void {
    for (const id of ids) {
      this.#awaited.set(id, (this.#awaited.get(id) ?? 0) + 1);
    }
  }

  endWait(ids: readonly SessionId[]): void {
    for (const id of ids) {
      const count = (this.#awaited.get(id) ?? 1) - 1;
      if (count <= 0) this.#awaited.delete(id);
      else this.#awaited.set(id, count);
    }
  }

  // 等待工具要交回这个已结束 worker 的结果：还没递出的通知撤回（交回完整结果），已递出的只交回一句
  claim(id: SessionId): NoticeClaim {
    if (this.#grouped.has(id)) {
      // 汇总通知已发出（递出或待递）即只交回一句；还没发出的，汇总里这一份只写一句
      if (this.#groupPosted.has(id)) {
        return "notified";
      }
      this.#groupClaimed.add(id);
      return "fresh";
    }
    const key = this.#keys.get(id);
    if (key === undefined) {
      return "fresh";
    }
    this.#keys.delete(id);
    return this.#options.target.withdrawNotice(key) ? "fresh" : "notified";
  }

  claimedInGroup(id: SessionId): boolean {
    return this.#groupClaimed.has(id);
  }

  // 有通知递出时回调（drainWorkers 用来醒）
  onPosted(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onEvent(event: WorkerLifecycleEvent): void {
    if (event.kind !== "worker.settled") return;
    const { worker, outcome } = event;
    if (worker.origin !== "agent" || worker.parentSessionId !== this.#options.parentSessionId) {
      return;
    }
    // 正被等着的由等待工具交回完整结果，不另发
    if (this.#grouped.has(worker.sessionId) || this.#awaited.has(worker.sessionId)) {
      return;
    }
    const key = this.#deliver(this.#options.text(outcome));
    this.#keys.set(worker.sessionId, key);
  }

  // 决策 363：通知进用户消息的正文，里面的 worker 摘要等与开工状态块同一转义，伪造不出 pigeon 标签
  #deliver(text: string, prefix = WORKER_NOTICE_PREFIX): string {
    const full = `${prefix}${escapeStatusText(text)}`;
    const key = this.#options.target.notify(full);
    this.#options.onNotice?.(full);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // 回调故障不挡通知
      }
    }
    this.#options.wake?.();
    return key;
  }
}

// 运行面上"把待递的通知当一次运行跑"的一面（PiRuntimeAdapter 满足）
export interface DrainTarget<R> {
  pendingNotices(): number;
  runNotices(): Promise<R>;
}

// 派出方自己的运行结束后：还有它派出的 worker 在跑、多份尝试的汇总没发出、或有待递的通知时，等下一条通知到来（或全部结束）
// 再跑一轮只带通知的运行，直到都结束、通知都处理完。stopped 为真即不再等（撞上限、外部中止）。
// 返回最后一次运行的结果（没再跑即 undefined）与是否因 stopped 中途不等
export async function drainWorkers<R>(input: {
  orchestrator: Pick<WorkerOrchestrator, "status" | "subscribe">;
  parentSessionId: SessionId;
  notices: WorkerNotices;
  target: DrainTarget<R>;
  stopped: () => boolean;
}): Promise<{ last?: R; interrupted: boolean }> {
  let last: R | undefined;
  const live = () =>
    input.orchestrator
      .status()
      .some(
        (worker) =>
          worker.parentSessionId === input.parentSessionId &&
          (worker.state === "running" || worker.state === "queued")
      );
  const outstanding = () => live() || input.notices.pendingGroups() > 0;
  for (;;) {
    if (input.stopped()) {
      return {
        ...(last !== undefined ? { last } : {}),
        interrupted: outstanding() || input.target.pendingNotices() > 0,
      };
    }
    if (input.target.pendingNotices() > 0) {
      last = await input.target.runNotices();
      continue;
    }
    if (!outstanding()) {
      break;
    }
    // 等下一条通知或任一 worker 结束
    await new Promise<void>((resolve) => {
      const offNotice = input.notices.onPosted(() => done());
      const offSettle = input.orchestrator.subscribe((event) => {
        if (event.kind === "worker.settled") done();
      });
      const poll = setInterval(() => {
        if (input.stopped()) done();
      }, 200);
      function done(): void {
        offNotice();
        offSettle();
        clearInterval(poll);
        resolve();
      }
    });
  }
  return { ...(last !== undefined ? { last } : {}), interrupted: false };
}
