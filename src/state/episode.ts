// EpisodeBuilder（M7 S2，决策 070 / 073；ROADMAP §M7）：从账本切出可对比的尝试。纯函数，无 IO——
// 读哪些会话文件由调用方决定（提炼入口按任务标识、Eval 结果目录或分叉记录找齐会话后传入）。
// - 同任务比对：一次尝试 = 尝试会话的首个 Run（恢复后追加的 Run 已掺入人的后续干预，不计入）；
// - 分叉：共享前缀（来源 Run 的第 1 条到分叉点）单独产出、只算一次；来源侧取分叉点之后到该 Run 结尾，分支侧取分支会话首个 Run；
// - 选对（未裁细节的保守缺省）：只有成功与失败进对比，每侧只取一个——成功侧取总轮数最少，失败侧取最早收尾，
//   其余尝试只记在 others 里；全成功、全失败或凑不齐两侧时给出跳过原因；
// - Run 内局部对：只取理由来源为人写的拒绝，与域错误后紧跟的同工具成功重试（只产出教训候选）。
import type { AttemptRef, OutcomeLabel } from "./attempt-ref.ts";
import type { ForkPoint } from "./event-log.ts";
import type { RunId, SessionId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import { attemptOutcomeFacts, labelAttempt } from "./outcome-label.ts";
import { lastStepRunOf, stepRunsOf } from "./repair-step.ts";

export interface Attempt extends AttemptRef {
  // 本尝试的模型轮次数（选成功侧用）
  turns: number;
  // run.ended 的时间戳（选失败侧用）；缺运行结束记录时缺省
  endedAt?: number;
}

export interface TaskAttemptInput {
  governanceRoot: string;
  session: MaterializedSession;
  // 缺省取首个 Run
  runId?: RunId;
  // 条目范围起点（分叉来源侧从分叉点之后起算）；缺省 1
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

export type ContrastSkipReason = "all-passed" | "all-failed" | "no-contrast";

export interface ContrastSelection {
  successful?: Attempt;
  failed?: Attempt;
  // 未进对比的其余尝试（含放弃、基础设施错误、未知）
  others: Attempt[];
  skip?: ContrastSkipReason;
}

export function selectContrast(attempts: readonly Attempt[]): ContrastSelection {
  const passed = attempts.filter((attempt) => attempt.label === "Passed");
  const failed = attempts.filter((attempt) => attempt.label === "Failed");
  if (passed.length === 0 || failed.length === 0) {
    return {
      others: [...attempts],
      skip: passed.length > 0 ? "all-passed" : failed.length > 0 ? "all-failed" : "no-contrast",
    };
  }
  const ended = (attempt: Attempt): number => attempt.endedAt ?? Number.POSITIVE_INFINITY;
  const successful = passed.reduce((best, attempt) =>
    attempt.turns < best.turns || (attempt.turns === best.turns && ended(attempt) < ended(best))
      ? attempt
      : best
  );
  const earliestFailed = failed.reduce((best, attempt) =>
    ended(attempt) < ended(best) ? attempt : best
  );
  return {
    successful,
    failed: earliestFailed,
    others: attempts.filter((attempt) => attempt !== successful && attempt !== earliestFailed),
  };
}

export interface ForkGroupInput {
  governanceRoot: string;
  source: MaterializedSession;
  // 从 source 分叉出来的分支会话（各自带分支会话头）
  branches: readonly MaterializedSession[];
}

export interface ForkGroup {
  forkPoint: ForkPoint;
  // 共享前缀：来源 Run 的第 1 条到分叉点，只产出一次
  sharedPrefix: { sessionId: SessionId; runId: RunId; from: number; to: number };
  // 来源侧在前，分支按传入顺序；分叉点是该 Run 最后一条时来源侧没有独有条目，不进组
  attempts: Attempt[];
}

export function buildForkGroup(input: ForkGroupInput): ForkGroup {
  const { source, branches } = input;
  if (branches.length === 0) {
    throw new Error("分叉成组至少需要一个分支会话");
  }
  let forkPoint: ForkPoint | undefined;
  for (const branch of branches) {
    const header = branch.branchHeader;
    if (header === undefined || header.sourceSessionId !== source.sessionId) {
      throw new Error(`会话 ${branch.sessionId} 不是 ${source.sessionId} 的分支`);
    }
    if (forkPoint === undefined) {
      forkPoint = header.forkPoint;
    } else if (
      forkPoint.runId !== header.forkPoint.runId ||
      forkPoint.runSeq !== header.forkPoint.runSeq
    ) {
      throw new Error("分支来自不同的分叉点，共享前缀不唯一，不能成组对比");
    }
  }
  const point = forkPoint as ForkPoint;
  return {
    forkPoint: point,
    sharedPrefix: {
      sessionId: source.sessionId,
      runId: point.runId,
      from: 1,
      to: point.runSeq,
    },
    attempts: [
      // 分叉点是该 Run 最后一条时，来源侧在分叉点之后没有独有条目：它只贡献共享前缀，
      // 不作为一次可对比的尝试（否则条目范围会退化成"从 n+1 到 n+1"的假区间）
      ...(lastRunSeqOf(source, point.runId) > point.runSeq
        ? [
            buildTaskAttempt({
              governanceRoot: input.governanceRoot,
              session: source,
              runId: point.runId,
              fromRunSeq: point.runSeq + 1,
            }),
          ]
        : []),
      ...branches.map((branch) =>
        buildTaskAttempt({ governanceRoot: input.governanceRoot, session: branch })
      ),
    ],
  };
}

export type LocalPair =
  | {
      kind: "human-rejection";
      toolCallId: string;
      toolName: string;
      reason: string;
      runSeq?: number;
    }
  | {
      kind: "domain-error-retry";
      // 成功重试的那次调用
      toolCallId: string;
      failedToolCallId: string;
      toolName: string;
      failedRunSeq?: number;
      runSeq?: number;
    };

// Run 内局部对（决策 073）。toolResultSeqs：工具调用号 → 其结果消息在本 Run 的条目号（取自内容文件）
export function collectLocalPairs(
  session: MaterializedSession,
  runId: RunId,
  toolResultSeqs: ReadonlyMap<string, number>
): LocalPair[] {
  const pairs: LocalPair[] = [];
  for (const record of session.decisions) {
    const { decision } = record;
    if (
      record.runId === runId &&
      decision.outcome === "rejected" &&
      decision.approvedBy === "human" &&
      decision.reasonSource === "human" &&
      decision.reason !== undefined &&
      decision.reason.trim() !== ""
    ) {
      const runSeq = toolResultSeqs.get(record.toolCallId);
      pairs.push({
        kind: "human-rejection",
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        reason: decision.reason,
        ...(runSeq !== undefined ? { runSeq } : {}),
      });
    }
  }
  const settleds = session.runtimeEvents.flatMap((event) =>
    event.kind === "tool.settled" && event.runId === runId ? [event.payload] : []
  );
  for (const [index, failed] of settleds.entries()) {
    const retry = settleds[index + 1];
    if (
      failed.isError &&
      failed.errorKind === "domain" &&
      retry !== undefined &&
      retry.toolName === failed.toolName &&
      !retry.isError
    ) {
      const failedRunSeq = toolResultSeqs.get(failed.toolCallId);
      const runSeq = toolResultSeqs.get(retry.toolCallId);
      pairs.push({
        kind: "domain-error-retry",
        toolCallId: retry.toolCallId,
        failedToolCallId: failed.toolCallId,
        toolName: failed.toolName,
        ...(failedRunSeq !== undefined ? { failedRunSeq } : {}),
        ...(runSeq !== undefined ? { runSeq } : {}),
      });
    }
  }
  return pairs;
}
