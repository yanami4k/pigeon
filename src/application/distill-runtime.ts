// 提炼派发器（M7 S4，决策 074）：复用 worker 编排，专用编排器只派 distiller（无工作区、预算专设），
// 派出与收尾落在宿主会话文件的 child.* 两族；提炼以"完成"收尾才从结构化结果落盘候选（v3，带对比来源块），
// 超限、中止、失败一律不产出。与 Reviewer 共用全局并发闸：闸忙时等上一个收尾再派（排队，不跳过）。
// 自动触发（并行同任务全部收尾后、分叉叶子验证完成后）与 pigeon distill 手动提炼共用这一份。
// 内部故障（候选落盘失败、编排器故障）除了进错误清单，另向标准错误输出告警，同一类只说一次。
import path from "node:path";
import {
  type PersistDistillerResult,
  persistDistillerCandidates,
} from "../distillation/candidates.ts";
import { distillerTask } from "../distillation/prompt.ts";
import { buildDistillSnapshot, renderDistillSnapshot } from "../distillation/snapshot.ts";
import {
  type ChildFamilySink,
  WorkerOrchestrator,
  type WorkerOutcome,
  type WorkerRuntimeFactory,
} from "../orchestration/workers.ts";
import { materializeSession } from "../persistence/session-read.ts";
import type { CandidateSink } from "../review/candidates.ts";
import { type ReviewGate, sharedReviewGate } from "../review/scheduler.ts";
import type { DistillTarget } from "../state/distill.ts";
import type { WorkerLimits } from "../state/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { dedupedWarner, failureDetail } from "./warnings.ts";

// 提炼器预算（决策 074；120、121 修订）：40 轮、12.5 分钟（按 40/16 同比放宽），不设 token 上限；超限按中止处理、
// 不产出候选；各项可配。提炼器每轮都把整段上下文重送一遍，按累计 token 设限在长尝试（SWE-bench 规模）上几轮就用完；
// 16 轮在这类尝试上常常读不完两侧材料
export const DEFAULT_DISTILL_BUDGET: WorkerLimits = {
  maxTurns: 40,
  wallClockMs: 12.5 * 60_000,
};

export interface DistillDispatcherOptions {
  // 暂存目录与提炼器会话文件所在的治理根
  governanceRoot: string;
  // 宿主会话：提炼的派出与收尾、候选两族与跳过记录都写进它的会话文件
  hostSessionId: SessionId;
  hostLog: ChildFamilySink & CandidateSink;
  parentPolicy: ToolPolicyLike;
  // 提炼器运行面工厂（角色表的模型接入覆盖列在工厂里生效）
  createRuntime: WorkerRuntimeFactory;
  budget?: Partial<WorkerLimits>;
  gate?: ReviewGate;
}

export interface DistillOutcome {
  distillSessionId: SessionId;
  status: WorkerOutcome["status"];
  error?: string;
  // 完成收尾时的候选落盘结果
  persisted?: PersistDistillerResult;
}

export interface DistillDispatcher {
  distill(target: DistillTarget): Promise<DistillOutcome>;
  errors(): unknown[];
}

// 等全局闸空出来再占用（排队）；返回释放函数
export async function acquireGate(gate: ReviewGate): Promise<() => void> {
  while (!gate.tryAcquire()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = gate.onRelease(() => {
        unsubscribe();
        resolve();
      });
    });
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      gate.release();
    }
  };
}

// 宿主记录的信封 Run：取主证据一侧的 Run（与 M6 以被审 Run 为信封同口径；引用型记录不在宿主会话造 Run）
export function hostRunIdOf(target: DistillTarget): RunId {
  return target.failed?.runId ?? target.successful?.runId ?? target.task.runId;
}

export function createDistillDispatcher(options: DistillDispatcherOptions): DistillDispatcher {
  const budget: WorkerLimits = { ...DEFAULT_DISTILL_BUDGET, ...options.budget };
  const gate = options.gate ?? sharedReviewGate;
  const sessionsDir = path.join(options.governanceRoot, ".pigeon", "sessions");
  const errors: unknown[] = [];
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: options.governanceRoot,
    session: { sessionId: options.hostSessionId },
    parentPolicy: options.parentPolicy,
    parentLog: options.hostLog,
    // 派出记录不回指 Run：被提炼的尝试不在宿主会话里（回指外部 Run 会在宿主会话造出不存在的 Run）
    // 提炼器只有 read 档工具，自动放行；任何意外的审批请求一律拒绝（后台没有审批通道）
    approvals: async () => ({ approved: false, reason: "后台提炼没有审批通道" }),
    createRuntime: options.createRuntime,
    defaultLimits: budget,
  });

  const persistFrom = (outcome: WorkerOutcome, target: DistillTarget, runId: RunId) => {
    const distilled = materializeSession(sessionsDir, outcome.sessionId, { content: false });
    const model = distilled.runStarteds[0]?.payload.model ?? { provider: "custom", id: "custom" };
    const totalTokens = distilled.runtimeEvents.reduce(
      (sum, record) =>
        record.kind === "turn.completed" ? sum + (record.payload.usage?.totalTokens ?? 0) : sum,
      0
    );
    return persistDistillerCandidates({
      governanceRoot: options.governanceRoot,
      sink: options.hostLog,
      hostRunId: runId,
      target,
      distillSessionId: outcome.sessionId,
      structured: outcome.result?.structured,
      model: { provider: model.provider, id: model.id },
      usage: { turns: outcome.turns, totalTokens },
    });
  };

  // 内部故障不静默：每次提炼收尾时把新出现的故障（本派发器的落盘失败、编排器的内部故障）各告警一次
  const warn = dedupedWarner();
  let warnedLocal = 0;
  let warnedOrchestrator = 0;
  const drainWarnings = (): void => {
    const fromOrchestrator = orchestrator.errors();
    for (const error of errors.slice(warnedLocal)) {
      warn(error, `经验提炼告警：${failureDetail(error)}（这次提炼的候选没有落库，不影响运行）`);
    }
    for (const error of fromOrchestrator.slice(warnedOrchestrator)) {
      warn(error, `经验提炼告警：${failureDetail(error)}（提炼器本次运行没有产出，不影响运行）`);
    }
    warnedLocal = errors.length;
    warnedOrchestrator = fromOrchestrator.length;
  };

  return {
    distill: async (target) => {
      const release = await acquireGate(gate);
      try {
        const runId = hostRunIdOf(target);
        const distillSessionId = orchestrator.spawn({
          role: "distiller",
          // 121：冻结对比快照直接放进首轮输入
          task: distillerTask(target, renderDistillSnapshot(buildDistillSnapshot(target))),
          limits: budget,
          distill: target,
        });
        const outcome = await orchestrator.awaitResult(distillSessionId);
        let persisted: PersistDistillerResult | undefined;
        if (outcome.status === "completed") {
          try {
            persisted = persistFrom(outcome, target, runId);
          } catch (error) {
            errors.push(error);
          }
        }
        return {
          distillSessionId,
          status: outcome.status,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(persisted !== undefined ? { persisted } : {}),
        };
      } finally {
        drainWarnings();
        release();
      }
    },
    errors: () => [...errors, ...orchestrator.errors()],
  };
}
