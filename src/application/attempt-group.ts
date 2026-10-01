// 并行同任务派发（M7 S4，决策 069）：一次派出同一任务的多个 worker，生成共享任务标识写入派出记录；
// 全部收尾后交回各份的 WorkerOutcome（决策 322：不再执行验证命令、不再贴标签，各份的改动与摘要由主 agent 或人比较）。
import { randomUUID } from "node:crypto";
import type { WorkerOrchestrator, WorkerOrigin, WorkerOutcome } from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import type { WorkerLimits } from "../state/session-payloads.ts";

export interface AttemptGroupInput {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  role: string;
  task: string;
  count: number;
  limits?: Partial<WorkerLimits>;
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
}

export function newTaskKey(): string {
  return `task_${randomUUID()}`;
}

export async function runAttemptGroup(input: AttemptGroupInput): Promise<AttemptGroupResult> {
  if (!Number.isInteger(input.count) || input.count < 2) {
    throw new Error("并行同任务派发至少需要 2 个尝试");
  }
  const taskKey = input.taskKey ?? newTaskKey();
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
  const outcomes = await Promise.all(ids.map((id) => input.orchestrator.awaitResult(id)));
  return { taskKey, outcomes };
}

export interface SessionAttemptRunnerDeps {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
}

// 按会话装配并行同任务派发（tui /spawn --attempts 的落点）
export function createSessionAttemptRunner(
  deps: SessionAttemptRunnerDeps
): (request: { role: string; task: string; count: number }) => Promise<AttemptGroupResult> {
  return (request) =>
    runAttemptGroup({
      orchestrator: deps.orchestrator,
      role: request.role,
      task: request.task,
      count: request.count,
    });
}
