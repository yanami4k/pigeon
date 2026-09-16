// 手动补审（M6 S4，决策 064）：pigeon review <sessionId> [--run <runId>] 的命令层。
// 对冷会话补审——worker、headless 与 Eval 实验会话不自动审，需要时由人手动补；与自动审阅同一派发器，
// 派出与收尾记进被审会话文件，完成后照常落盘候选。Reviewer 自身会话永不被审。
// 父策略取被审 Run 的 run.started（审阅工具豁免子集约束，父策略只用来继承 deny 与审批模式）。
import { existsSync } from "node:fs";
import path from "node:path";
import { JsonlEventLog, listSessionIds, materializeSession } from "../persistence/event-log.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { ReviewBudget } from "../review/scheduler.ts";
import { asRunId, asSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { createReviewDispatcher } from "./review-runtime.ts";

export interface ManualReviewInput {
  governanceRoot: string;
  sessionId: string;
  // 缺省审该会话最后一个 Run
  runId?: string;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  homeDir?: string;
  persistThinking?: boolean;
  budget?: Partial<ReviewBudget>;
}

export interface ManualReviewSummary {
  sessionId: SessionId;
  runId: RunId;
  reviewSessionId: SessionId;
  status: string;
  candidatesWritten: number;
  duplicates: number;
  unparsable?: string;
  error?: string;
}

export async function runManualReview(input: ManualReviewInput): Promise<ManualReviewSummary> {
  const sessionsDir = path.join(input.governanceRoot, ".pigeon", "sessions");
  const sessionId = asSessionId(input.sessionId);
  if (!existsSync(JsonlEventLog.filePathFor(sessionsDir, sessionId))) {
    const available = listSessionIds(sessionsDir);
    throw new Error(
      `会话不存在：${input.sessionId}` +
        (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
    );
  }
  const session = materializeSession(sessionsDir, sessionId, { content: false });
  if (session.sessionHeader?.worker.role === "reviewer") {
    throw new Error(`会话 ${sessionId} 是审阅会话：Reviewer 自身会话永不被审`);
  }
  const runId =
    input.runId !== undefined
      ? asRunId(input.runId)
      : (session.runStarteds.at(-1)?.runId ?? session.runtimeEvents.at(-1)?.runId);
  if (runId === undefined) {
    throw new Error(`会话 ${sessionId} 没有任何 Run，无可审阅内容`);
  }
  if (!session.records.some((record) => record.runId === runId)) {
    throw new Error(`会话 ${sessionId} 里没有 Run ${runId}`);
  }
  const policy = session.runStarteds.findLast((record) => record.runId === runId)?.payload
    .policy ?? { allow: [], deny: [], approvalMode: "prompt" as const };
  const log = new JsonlEventLog(sessionsDir, sessionId);
  try {
    const dispatcher = createReviewDispatcher({
      governanceRoot: input.governanceRoot,
      sessionId,
      parentPolicy: policy,
      parentLog: log,
      streamFn: input.streamFn,
      provider: input.provider,
      modelId: input.modelId,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(input.persistThinking !== undefined ? { persistThinking: input.persistThinking } : {}),
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
    });
    const { reviewSessionId, done } = dispatcher.dispatch({ sessionId, runId });
    const { outcome, persisted } = await done;
    return {
      sessionId,
      runId,
      reviewSessionId,
      status: outcome.status,
      candidatesWritten: persisted?.written.length ?? 0,
      duplicates: persisted?.duplicates ?? 0,
      ...(persisted?.unparsable !== undefined ? { unparsable: persisted.unparsable } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  } finally {
    log.close();
  }
}
