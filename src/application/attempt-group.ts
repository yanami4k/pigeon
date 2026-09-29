// 并行同任务派发（M7 S4，决策 069 / 071）：一次派出同一任务的多个 worker，生成共享任务标识写入派出记录；
// 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令（未配置则不跑，标签为未知），结果落宿主会话的通用验证记录；
// 全部收尾后从会话存储现算各尝试的标签交回（决策 180）。
// 失败自动分叉重试不叠加在并行同任务派发上（决策 079）。
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WorkerOrchestrator, WorkerOrigin, WorkerOutcome } from "../orchestration/workers.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionEntrySink } from "../state/session-entries.ts";
import {
  type StoreAttempt,
  type StoreSessionView,
  storeFirstRun,
  storeTaskAttempt,
} from "../state/session-judge.ts";
import type { WorkerLimits } from "../state/session-payloads.ts";
import { verifyAttempt } from "./attempt-verify.ts";

export interface AttemptGroupHost {
  // 宿主会话号：验证记录落在这里，现算标签时读它作为额外来源
  readonly sessionId: SessionId;
}

export interface AttemptGroupInput {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost;
  // 宿主会话的会话存储写入面（验证记录写在这里）；现算标签前经 flush 让验证记录落盘
  hostStore: HostStore;
  role: string;
  task: string;
  count: number;
  limits?: Partial<WorkerLimits>;
  verify?: VerifyConfig;
  // 缺省生成
  taskKey?: string;
  // 决策 294、297：各份共用的标签与派出来源；派出方是 worker 时为它的会话号（299）
  label?: string;
  origin?: WorkerOrigin;
  from?: SessionId;
  // 派出后（收尾前）回报派出的会话，供 Actor 回显
  onSpawned?: (sessionIds: readonly string[]) => void;
}

export interface AttemptGroupResult {
  taskKey: string;
  outcomes: WorkerOutcome[];
  attempts: StoreAttempt[];
  // 派发过程里的内部故障：与主会话挂载同口径，不吞掉
  errors: unknown[];
}

export type HostStore = SessionEntrySink & { flush?(): Promise<void> };

export function newTaskKey(): string {
  return `task_${randomUUID()}`;
}

export async function runAttemptGroup(input: AttemptGroupInput): Promise<AttemptGroupResult> {
  if (!Number.isInteger(input.count) || input.count < 2) {
    throw new Error("并行同任务派发至少需要 2 个尝试");
  }
  const taskKey = input.taskKey ?? newTaskKey();
  const sessionsDir = path.join(input.governanceRoot, ".pigeon", "sessions");
  const ids = Array.from({ length: input.count }, () =>
    input.orchestrator.spawn({
      role: input.role,
      task: input.task,
      taskKey,
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
    })
  );
  input.onSpawned?.(ids);
  const errors: unknown[] = [];
  // 各尝试收尾即验证（在各自工作树里），不等别的尝试
  const settled = await Promise.all(
    ids.map(async (id) => {
      const outcome = await input.orchestrator.awaitResult(id);
      const verify = input.verify;
      if (verify !== undefined && outcome.workspace.kind === "git-worktree") {
        const runId = firstRunIdOf(sessionsDir, id);
        if (runId !== undefined) {
          try {
            await verifyAttempt({
              config: verify,
              workspace: outcome.workspace.path,
              target: { sessionId: id, runId },
              store: input.hostStore,
            });
          } catch (error) {
            // 验证自身故障不被吞：口径同 attempt-verify.ts 的主会话挂载（进错误清单，不改变尝试结果）
            errors.push(error);
          }
        }
      }
      return outcome;
    })
  );
  // 验证记录落在宿主会话里：现算标签时作为额外来源
  await input.hostStore.flush?.();
  const host = loadStoreSession(sessionsDir, input.hostLog.sessionId)?.view;
  const attempts = storeAttempts(input.governanceRoot, sessionsDir, settled, host);
  return { taskKey, outcomes: settled, attempts, errors };
}

// 尝试会话的首个 Run
function firstRunIdOf(sessionsDir: string, sessionId: SessionId) {
  const loaded = loadStoreSession(sessionsDir, sessionId);
  return loaded !== undefined ? storeFirstRun(loaded.view) : undefined;
}

function storeAttempts(
  governanceRoot: string,
  sessionsDir: string,
  outcomes: readonly WorkerOutcome[],
  host: StoreSessionView | undefined
): StoreAttempt[] {
  const attempts: StoreAttempt[] = [];
  for (const outcome of outcomes) {
    const view = loadStoreSession(sessionsDir, outcome.sessionId)?.view;
    if (view === undefined || storeFirstRun(view) === undefined) {
      continue;
    }
    attempts.push(
      storeTaskAttempt({
        governanceRoot,
        view,
        verificationSources: host !== undefined ? [host] : [],
      })
    );
  }
  return attempts;
}

export interface SessionAttemptRunnerDeps {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost;
  hostStore: HostStore;
  verify?: VerifyConfig;
}

// 按会话装配并行同任务派发（tui /spawn --attempts 的落点）
export function createSessionAttemptRunner(
  deps: SessionAttemptRunnerDeps
): (request: { role: string; task: string; count: number }) => Promise<AttemptGroupResult> {
  return (request) =>
    runAttemptGroup({
      orchestrator: deps.orchestrator,
      governanceRoot: deps.governanceRoot,
      hostLog: deps.hostLog,
      hostStore: deps.hostStore,
      role: request.role,
      task: request.task,
      count: request.count,
      ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
    });
}
