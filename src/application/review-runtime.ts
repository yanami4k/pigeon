// 后台审阅（M6 S2 / S4，决策 064 / 065）：审阅派发器与主会话的调度挂载。
// - 派发器：复用 worker 编排，专用编排器只派 reviewer（无工作区、预算专设），派出与收尾落在被审会话文件的
//   child.* 两族；审阅以"完成"收尾才从结构化结果落盘候选，超限、中止、失败一律不产出。自动审阅与
//   pigeon review 手动补审共用这一份。它不向 Actor 暴露（不是 /spawn 那个编排器），cli 因此仍不装通用
//   worker 编排器（067）。
// - 调度挂载：订阅 cli / tui 主会话的 turn.completed 与 run.ended，交给纯调度器判断；按轮次触发遇忙则落
//   review.skipped，Run 结束补审遇忙则排队（064 修订），释放时关停调度并以原因为退出的跳过记录留痕。
//   派出、运行与收尾的任何失败都只进内部错误清单，不向主 Run 抛异常（§M6 完成证据第 3 条）。
// - Reviewer 会话由 worker 工厂装配，不经本模块挂调度，因此永远不会被再审。
import path from "node:path";
import {
  type ChildFamilySink,
  WorkerOrchestrator,
  type WorkerOutcome,
} from "../orchestration/workers.ts";
import {
  materializeSession,
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import {
  type CandidateSink,
  type PersistCandidatesResult,
  persistReviewerCandidates,
} from "../review/candidates.ts";
import { reviewerTask } from "../review/prompt.ts";
import {
  DEFAULT_REVIEW_BUDGET,
  type ReviewBudget,
  type ReviewGate,
  ReviewScheduler,
  sharedReviewGate,
} from "../review/scheduler.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { ReviewConfig, ReviewTarget } from "../state/review.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

export interface ReviewDispatcherOptions {
  governanceRoot: string;
  // 被审会话：审阅派出与收尾、候选两族都写进它的会话文件
  sessionId: SessionId;
  parentPolicy: ToolPolicyLike;
  parentLog: ChildFamilySink & CandidateSink;
  // Reviewer 的模型接入：缺省继承主会话（角色表覆盖列在 worker 工厂里生效）
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  homeDir?: string;
  persistThinking?: boolean;
  budget?: Partial<ReviewBudget>;
}

export interface ReviewDispatchResult {
  outcome: WorkerOutcome;
  // 审阅完成时的候选落盘结果；未完成时缺省
  persisted?: PersistCandidatesResult;
}

export interface ReviewDispatcher {
  dispatch(target: ReviewTarget): {
    reviewSessionId: SessionId;
    done: Promise<ReviewDispatchResult>;
  };
  // 取消在跑的审阅
  cancelAll(): Promise<void>;
  errors(): unknown[];
}

export function createReviewDispatcher(options: ReviewDispatcherOptions): ReviewDispatcher {
  const { governanceRoot, sessionId } = options;
  const sessionsDir = path.join(governanceRoot, ".pigeon", "sessions");
  const budget: ReviewBudget = { ...DEFAULT_REVIEW_BUDGET, ...options.budget };
  const errors: unknown[] = [];
  // 派出记录回指被审的那一次 Run（trace 据此把 Reviewer 挂在对应 Run 下）；每次派出前设定
  let targetRunId: RunId | undefined;
  const orchestrator = new WorkerOrchestrator({
    governanceRoot,
    session: { sessionId },
    parentPolicy: options.parentPolicy,
    parentLog: options.parentLog,
    activeRunId: () => targetRunId,
    // Reviewer 只有 read 档工具，自动放行；任何意外的审批请求一律拒绝（后台没有审批通道）
    approvals: async () => ({ approved: false, reason: "后台审阅没有审批通道" }),
    createRuntime: createWorkerRuntimeFactory({
      streamFnFor: () => options.streamFn,
      provider: options.provider,
      modelId: options.modelId,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.persistThinking !== undefined
        ? { persistThinking: options.persistThinking }
        : {}),
    }),
    defaultLimits: budget,
  });

  // 候选落盘（决策 065）：模型身份取 Reviewer 会话的 run.started，用量取轮次与 turn.completed 的 token 合计
  const persistCandidatesFrom = (outcome: WorkerOutcome, runId: RunId): PersistCandidatesResult => {
    const reviewer = materializeSession(sessionsDir, outcome.sessionId, { content: false });
    const model = reviewer.runStarteds[0]?.payload.model ?? {
      provider: options.provider,
      id: options.modelId,
    };
    const totalTokens = reviewer.runtimeEvents.reduce(
      (sum, record) =>
        record.kind === "turn.completed" ? sum + (record.payload.usage?.totalTokens ?? 0) : sum,
      0
    );
    return persistReviewerCandidates({
      governanceRoot,
      sessionsDir,
      sink: options.parentLog,
      structured: outcome.result?.structured,
      source: { sessionId, runId, reviewSessionId: outcome.sessionId },
      model: { provider: model.provider, id: model.id },
      usage: { turns: outcome.turns, totalTokens },
    });
  };

  return {
    dispatch: (target) => {
      targetRunId = target.runId;
      const reviewSessionId = orchestrator.spawn({
        role: "reviewer",
        task: reviewerTask(target),
        limits: budget,
        review: target,
      });
      const done = orchestrator.awaitResult(reviewSessionId).then((outcome) =>
        // M6（决策 064 子裁决 ④ / 065）：只有完成收尾的审阅才落盘候选；超限、中止、失败一律不产出
        outcome.status === "completed"
          ? { outcome, persisted: persistCandidatesFrom(outcome, target.runId) }
          : { outcome }
      );
      return { reviewSessionId, done };
    },
    cancelAll: async () => {
      for (const worker of orchestrator.status()) {
        if (worker.state === "running") {
          await orchestrator.cancel(worker.sessionId).catch((error: unknown) => errors.push(error));
        }
      }
    },
    errors: () => [...errors, ...orchestrator.errors()],
  };
}

export interface ReviewAttachOptions {
  bundle: RuntimeBundle;
  governanceRoot: string;
  config: ReviewConfig;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  homeDir?: string;
  persistThinking?: boolean;
  gate?: ReviewGate;
  budget?: Partial<ReviewBudget>;
  // 审阅收尾后的附加处理（候选落盘已在派发器里完成）；抛错只进错误清单
  onSettled?: (result: ReviewDispatchResult, runId: RunId) => void | Promise<void>;
}

export interface ReviewAttachment {
  // 等当前在跑的审阅全部收尾（测试与退出路径用）
  idle(): Promise<void>;
  // 退订并取消在跑的审阅，等其收尾
  stop(): Promise<void>;
  // 不改变主 Run 的内部故障（派出失败、收尾失败、跳过记录写盘失败）
  errors(): unknown[];
}

export function attachReviewScheduler(options: ReviewAttachOptions): ReviewAttachment {
  const { bundle, governanceRoot } = options;
  const sessionId = bundle.adapter.sessionId;
  const sessionsDir = path.join(governanceRoot, ".pigeon", "sessions");
  const errors: unknown[] = [];
  const pending = new Set<Promise<unknown>>();
  const dispatcher = createReviewDispatcher({
    governanceRoot,
    sessionId,
    parentPolicy: bundle.adapter.snapshot().tools.policy,
    parentLog: bundle.eventLog,
    streamFn: options.streamFn,
    provider: options.provider,
    modelId: options.modelId,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.persistThinking !== undefined ? { persistThinking: options.persistThinking } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  });

  // 本次审阅覆盖到的条目号：被审 Run 在内容文件里的最大条目号
  const lastRunSeq = (runId: RunId): number =>
    readMessageContentFileDetailed(sessionContentFilePath(sessionsDir, sessionId)).records.reduce(
      (max, record) => (record.runId === runId && record.runSeq > max ? record.runSeq : max),
      0
    );

  const scheduler = new ReviewScheduler({
    sessionId,
    everyTurns: options.config.everyTurns,
    enabled: options.config.enabled,
    gate: options.gate ?? sharedReviewGate,
    spawn: (request) => {
      const throughRunSeq = lastRunSeq(request.runId);
      const { done } = dispatcher.dispatch({
        sessionId: request.sessionId,
        runId: request.runId,
        ...(request.sinceRunSeq !== undefined ? { sinceRunSeq: request.sinceRunSeq } : {}),
      });
      const settled = done.then(async (result) => {
        await options.onSettled?.(result, request.runId);
      });
      pending.add(settled);
      settled.finally(() => pending.delete(settled)).catch(() => {});
      return { throughRunSeq, done: settled };
    },
    recordSkip: (skip) => {
      bundle.eventLog.appendObservation({
        kind: "review.skipped",
        runId: skip.runId,
        payload: { trigger: skip.reason, reason: skip.cause },
      });
    },
    reportError: (error) => {
      errors.push(error);
    },
  });

  const unsubscribe = bundle.adapter.subscribe((event) => {
    try {
      if (event.kind === "turn.completed") {
        scheduler.onTurnCompleted(event.runId);
      } else if (event.kind === "run.ended") {
        scheduler.onRunEnded(event.runId);
      }
    } catch (error) {
      errors.push(error);
    }
  });

  const idle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };

  return {
    idle,
    stop: async () => {
      unsubscribe();
      // 064 修订：先关停调度（清排队、落原因为退出的跳过记录），再取消进行中的审阅
      scheduler.shutdown();
      await dispatcher.cancelAll();
      await idle();
    },
    errors: () => [...errors, ...dispatcher.errors()],
  };
}
