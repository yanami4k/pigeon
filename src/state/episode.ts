// EpisodeBuilder（M7 S2，决策 070；ROADMAP §M7）：从账本切出一次尝试并构造尝试引用。纯函数，无 IO——
// 读哪些会话文件由调用方决定（并行同任务派发按派出的会话传入）。
// 一次尝试 = 尝试会话的首个 Run（恢复后追加的 Run 已掺入人的后续干预，不计入）。
// 为提炼服务的选对、分叉成组与 Run 内局部对已随第一版学习闭环退役（决策 137）。
import type { AttemptRef, OutcomeLabel } from "./attempt-ref.ts";
import type { RunId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import { attemptOutcomeFacts, labelAttempt } from "./outcome-label.ts";
import { lastStepRunOf, stepRunsOf } from "./repair-step.ts";

export interface Attempt extends AttemptRef {
  // 本尝试的模型轮次数（回炉时按整步计）
  turns: number;
  // run.ended 的时间戳；缺运行结束记录时缺省
  endedAt?: number;
}

export interface TaskAttemptInput {
  governanceRoot: string;
  session: MaterializedSession;
  // 缺省取首个 Run
  runId?: RunId;
  // 条目范围起点；缺省 1
  fromRunSeq?: number;
  // 其他可能承载验证记录的会话（worker 尝试的验证落在父会话里）
  verificationSources?: readonly MaterializedSession[];
}

// 会话的首个 Run：优先 run.started，其次首条带 Run 的记录
export function firstRunOf(session: MaterializedSession): RunId | undefined {
  return (
    session.runStarteds[0]?.runId ??
    session.records.find(
      (record) =>
        record.runId !== undefined &&
        (record.kind === "entry" ||
          record.kind === "turn.started" ||
          record.kind === "turn.completed" ||
          record.kind === "run.ended")
    )?.runId
  );
}

// 一个 Run 的最末条目号：条目里最大的 runSeq；run.ended 记的消息数更大时以它为准
export function lastRunSeqOf(session: MaterializedSession, runId: RunId): number {
  let lastSeq = 0;
  for (const entry of session.entries) {
    if (entry.runId === runId && entry.runSeq > lastSeq) {
      lastSeq = entry.runSeq;
    }
  }
  for (const event of session.runtimeEvents) {
    if (event.runId === runId && event.kind === "run.ended") {
      lastSeq = Math.max(lastSeq, event.payload.messageCount);
    }
  }
  return lastSeq;
}

export function buildTaskAttempt(input: TaskAttemptInput): Attempt {
  const { session } = input;
  const runId = input.runId ?? firstRunOf(session);
  if (runId === undefined) {
    throw new Error(`会话 ${session.sessionId} 没有任何 Run，不能作为一次尝试`);
  }
  const sources = input.verificationSources ?? [];
  const lastSeq = lastRunSeqOf(session, runId);
  // 回炉（决策 142 / 143）：一步跨若干个 Run，轮次按整步计、收尾取整步最后一个 Run；标签由 attemptOutcomeFacts 按整步现算。
  // 尝试引用（runId 与条目范围）仍指向首个 Run：一次尝试的引用只容得下一个 Run
  const stepRuns = new Set(stepRunsOf(session, runId));
  let turns = 0;
  let endedAt: number | undefined;
  for (const event of session.runtimeEvents) {
    if (event.runId === undefined || !stepRuns.has(event.runId)) {
      continue;
    }
    if (event.kind === "turn.completed") {
      turns += 1;
    } else if (event.kind === "run.ended") {
      endedAt = event.timestamp;
    }
  }
  const from = input.fromRunSeq ?? 1;
  const label: OutcomeLabel = labelAttempt(
    attemptOutcomeFacts(session, runId, { verificationSources: sources })
  );
  const verification = latestVerification(session, runId, sources);
  return {
    governanceRoot: input.governanceRoot,
    sessionId: session.sessionId,
    runId,
    entryRange: { from, to: Math.max(from, lastSeq) },
    label,
    turns,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(verification !== undefined ? { verification } : {}),
  };
}

// 验证记录引用：在哪个会话文件、哪条记录（取时间最晚的一条，与标签现算同口径；回炉时验证门记录只认
// 整步最后一个 Run 的，判据的 eval.verified 按整步收）
function latestVerification(
  session: MaterializedSession,
  runId: RunId,
  sources: readonly MaterializedSession[]
): AttemptRef["verification"] {
  let best: { at: number; ref: NonNullable<AttemptRef["verification"]> } | undefined;
  const stepRuns = new Set(stepRunsOf(session, runId));
  const lastRun = lastStepRunOf(session, runId);
  for (const source of [session, ...sources]) {
    for (const record of source.attemptVerifieds) {
      if (
        record.target.sessionId === session.sessionId &&
        record.target.runId === lastRun &&
        (best === undefined || record.timestamp >= best.at)
      ) {
        best = { at: record.timestamp, ref: { sessionId: source.sessionId, recordId: record.id } };
      }
    }
  }
  for (const record of session.evalVerifieds) {
    if (stepRuns.has(record.runId) && (best === undefined || record.timestamp >= best.at)) {
      best = { at: record.timestamp, ref: { sessionId: session.sessionId, recordId: record.id } };
    }
  }
  return best?.ref;
}
