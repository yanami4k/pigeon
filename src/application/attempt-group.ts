// 并行同任务派发（M7 S4，决策 069 / 071）：一次派出同一任务的多个 worker，生成共享任务标识写入派出记录；
// 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令（未配置则不跑，标签为未知），结果落宿主会话的通用验证记录；
// 全部收尾后按账本现算各尝试的标签交回。
// 失败自动分叉重试不叠加在并行同任务派发上（决策 079）。
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WorkerOrchestrator, WorkerOutcome } from "../orchestration/workers.ts";
import { materializeSession } from "../persistence/session-read.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import { type Attempt, buildTaskAttempt, firstRunOf } from "../state/episode.ts";
import type { WorkerLimits } from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionEntrySink } from "../state/session-entries.ts";
import { type AttemptVerificationSink, verifyAttempt } from "./attempt-verify.ts";

export interface AttemptGroupHost extends AttemptVerificationSink {
  // 宿主会话号：验证记录落在这里，现算标签时读它作为额外来源
  readonly sessionId: SessionId;
}

export interface AttemptGroupInput {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost;
  // 决策 206：宿主会话的新存储写入面（验证记录双写）；缺省不写
  hostStore?: SessionEntrySink;
  role: string;
  task: string;
  count: number;
  limits?: Partial<WorkerLimits>;
  verify?: VerifyConfig;
  // 缺省生成
  taskKey?: string;
  // 派出后（收尾前）回报派出的会话，供 Actor 回显
  onSpawned?: (sessionIds: readonly string[]) => void;
}

export interface AttemptGroupResult {
  taskKey: string;
  outcomes: WorkerOutcome[];
  attempts: Attempt[];
  // 派发过程里的内部故障（验证记录落盘失败等）：与主会话挂载同口径，不吞掉
  errors: unknown[];
}

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
        const runId = firstRunOf(materializeSession(sessionsDir, id, { content: false }));
        if (runId !== undefined) {
          const result = await verifyAttempt({
            config: verify,
            workspace: outcome.workspace.path,
            target: { sessionId: id, runId },
            sink: input.hostLog,
            ...(input.hostStore !== undefined ? { store: input.hostStore } : {}),
          });
          // 账本写失败不被吞：口径同 attempt-verify.ts 的主会话挂载（进错误清单，不改变尝试结果）
          if (result.recordError !== undefined) {
            errors.push(result.recordError);
          }
        }
      }
      return outcome;
    })
  );
  // 验证记录落在宿主会话里：现算标签时作为额外来源
  const hostSessions = [
    materializeSession(sessionsDir, input.hostLog.sessionId, { content: false }),
  ];
  const attempts: Attempt[] = [];
  for (const outcome of settled) {
    const session = materializeSession(sessionsDir, outcome.sessionId, { content: false });
    if (firstRunOf(session) === undefined) {
      continue;
    }
    attempts.push(
      buildTaskAttempt({
        governanceRoot: input.governanceRoot,
        session,
        verificationSources: hostSessions,
      })
    );
  }
  return { taskKey, outcomes: settled, attempts, errors };
}

export interface SessionAttemptRunnerDeps {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost;
  hostStore?: SessionEntrySink;
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
      ...(deps.hostStore !== undefined ? { hostStore: deps.hostStore } : {}),
      role: request.role,
      task: request.task,
      count: request.count,
      ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
    });
}
