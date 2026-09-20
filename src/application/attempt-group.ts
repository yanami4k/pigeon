// 并行同任务派发（M7 S4，决策 069 / 071 / 074）：一次派出同一任务的多个 worker，生成共享任务标识写入派出记录；
// 每个尝试收尾后由程序在该尝试的工作树里独立执行验证命令（未配置则不跑，标签为未知），结果落宿主会话的通用验证记录；
// 全部收尾后按账本现算标签选对（每侧只取一个），凑成成败两侧即自动派提炼器，否则留一条带原因的提炼跳过记录。
// 失败自动分叉重试不叠加在并行同任务派发上（决策 079）。
import { randomUUID } from "node:crypto";
import path from "node:path";
import { contrastTarget } from "../distillation/target.ts";
import type {
  ChildFamilySink,
  WorkerOrchestrator,
  WorkerOutcome,
  WorkerRuntimeFactory,
} from "../orchestration/workers.ts";
import { materializeSession } from "../persistence/session-read.ts";
import type { CandidateSink } from "../review/candidates.ts";
import type { ReviewGate } from "../review/scheduler.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import {
  type Attempt,
  buildTaskAttempt,
  type ContrastSelection,
  type ContrastSkipReason,
  firstRunOf,
  selectContrast,
} from "../state/episode.ts";
import type {
  CandidateVerifiedRecord,
  DistillSkippedInput,
  WorkerLimits,
} from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { type AttemptVerificationSink, verifyAttempt } from "./attempt-verify.ts";
import { type AutoVerifyWiring, autoVerifyCandidates } from "./auto-verify.ts";
import {
  createDistillDispatcher,
  type DistillDispatcher,
  type DistillOutcome,
} from "./distill-runtime.ts";

export interface AttemptGroupHost extends AttemptVerificationSink {
  // 宿主会话号：验证记录落在这里，现算标签时读它作为额外来源
  readonly sessionId: SessionId;
  appendDistillSkipped(input: DistillSkippedInput): unknown;
}

export interface AttemptGroupInput {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost;
  role: string;
  task: string;
  count: number;
  limits?: Partial<WorkerLimits>;
  verify?: VerifyConfig;
  // 缺省不自动提炼（只验证与记账）
  distill?: DistillDispatcher;
  // M8（决策 086）：提炼落库后自动验证新候选；缺省关（开关由 Actor 显式拨）
  autoVerify?: AutoVerifyWiring;
  // 缺省生成
  taskKey?: string;
  // 派出后（收尾前）回报派出的会话，供 Actor 回显
  onSpawned?: (sessionIds: readonly string[]) => void;
}

export interface AttemptGroupResult {
  taskKey: string;
  outcomes: WorkerOutcome[];
  attempts: Attempt[];
  selection: ContrastSelection;
  skip?: ContrastSkipReason;
  distill?: DistillOutcome;
  // M8（决策 086）：自动验证落下的回执（开关关着时为空）
  verified?: CandidateVerifiedRecord[];
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
  const selection = selectContrast(attempts);
  if (selection.skip !== undefined || input.distill === undefined) {
    if (selection.skip !== undefined) {
      input.hostLog.appendDistillSkipped({
        taskKey,
        reason: selection.skip,
        attempts: attempts.map((attempt) => ({
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          label: attempt.label,
        })),
      });
    }
    return {
      taskKey,
      outcomes: settled,
      attempts,
      selection,
      ...(selection.skip !== undefined ? { skip: selection.skip } : {}),
      errors,
    };
  }
  const distill = await input.distill.distill(contrastTarget({ kind: "task", taskKey, selection }));
  // M8（决策 086）：无人值守时把刚落库的候选自动验一遍；缺省关
  const auto = await autoVerifyCandidates(input.autoVerify, distill.persisted);
  errors.push(...auto.errors);
  return {
    taskKey,
    outcomes: settled,
    attempts,
    selection,
    distill,
    ...(auto.records.length > 0 ? { verified: auto.records } : {}),
    errors,
  };
}

export interface SessionAttemptRunnerDeps {
  orchestrator: Pick<WorkerOrchestrator, "spawn" | "awaitResult">;
  governanceRoot: string;
  hostLog: AttemptGroupHost & ChildFamilySink & CandidateSink;
  parentPolicy: ToolPolicyLike;
  createRuntime: WorkerRuntimeFactory;
  verify?: VerifyConfig;
  gate?: ReviewGate;
  // M8（决策 086）：无人值守自动验证；缺省关
  autoVerify?: AutoVerifyWiring;
}

// 按会话装配并行同任务派发（tui /spawn --attempts 的落点）：同一编排器派尝试，专用派发器派提炼器
export function createSessionAttemptRunner(
  deps: SessionAttemptRunnerDeps
): (request: { role: string; task: string; count: number }) => Promise<AttemptGroupResult> {
  const distill = createDistillDispatcher({
    governanceRoot: deps.governanceRoot,
    hostSessionId: deps.hostLog.sessionId,
    hostLog: deps.hostLog,
    parentPolicy: deps.parentPolicy,
    createRuntime: deps.createRuntime,
    ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
  });
  return (request) =>
    runAttemptGroup({
      orchestrator: deps.orchestrator,
      governanceRoot: deps.governanceRoot,
      hostLog: deps.hostLog,
      role: request.role,
      task: request.task,
      count: request.count,
      ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
      ...(deps.autoVerify !== undefined ? { autoVerify: deps.autoVerify } : {}),
      distill,
    });
}
