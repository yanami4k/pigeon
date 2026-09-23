// 尝试结果的五个标签（M7 S1，决策 072；ROADMAP §M7 OutcomeLabeler）：由账本现算，不落盘，口径同 065 的候选状态现算。
// 判定顺序：
//   1. 证据不完整（缺运行结束记录、有悬账）→ 未知：副作用是否发生都不确定时不下确定性结论，验证结论也不例外；
//   2. 有验证结论 → 通过即成功、失败即失败、未判定即未知（验证结论压过运行终态）；
//   3. 无验证：撞任一上限 → 失败；治理熔断 → 失败；人主动取消 → 放弃；基础设施错误单列；业务失败 → 失败；
//      正常完成与分类为未知的 → 未知（无验证而正常完成不等于做对）。
// 放弃与基础设施错误不进成败对比（由对比方过滤，本文件只贴标签）。纯函数，无 IO。
// 回炉（决策 142 / 143）：一步跨同一会话里的若干个 Run，事实按整步取——验证门结论只取整步最后一个 Run 的，
// 运行结束、失败分类与撞上限取整步最后一个 Run，悬账计整步；中间轮次的失败不算这一步失败。
// 最后一个 Run 没有验证门记录时这一步未收尾，现算为未知（决策 154 修订）。
import type { OutcomeLabel } from "./attempt-ref.ts";
import type { FailureClass } from "./classification.ts";
import type { RunId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import { lastGateVerificationOf, repairRoundsOf, stepRunsOf } from "./repair-step.ts";
import type { EvalVerdict } from "./runtime-events.ts";

export type { OutcomeLabel } from "./attempt-ref.ts";

export interface AttemptOutcomeFacts {
  hasRunEnded: boolean;
  // 本 Run 的悬账条数（intent 无 receipt 且未确证）
  pendingCount: number;
  // 失败四分类（null = 正常收尾）
  failure: FailureClass | null;
  limitHit: boolean;
  // 最后一条验证结论；缺省 = 无验证
  verdict?: EvalVerdict;
}

export function labelAttempt(facts: AttemptOutcomeFacts): OutcomeLabel {
  if (!facts.hasRunEnded || facts.pendingCount > 0) {
    return "Unknown";
  }
  if (facts.verdict !== undefined) {
    return facts.verdict === "pass" ? "Passed" : facts.verdict === "fail" ? "Failed" : "Unknown";
  }
  if (facts.limitHit) {
    return "Failed";
  }
  const failure = facts.failure;
  if (failure === null) {
    return "Unknown";
  }
  switch (failure.category) {
    case "cancelled":
      return failure.breaker ? "Failed" : "Abandoned";
    case "infrastructure":
      return "InfrastructureError";
    case "business":
      return "Failed";
    default:
      return "Unknown";
  }
}

export interface AttemptFactsOptions {
  // 其他可能承载本尝试验证记录的会话（worker 尝试的验证落在父会话文件里）
  verificationSources?: readonly Pick<MaterializedSession, "attemptVerifieds">[];
}

// 从账本现算一次尝试（会话里的某次 Run）的事实：验证结论取本会话与额外来源里指向该会话与 Run 的
// 通用验证记录，以及本 Run 的 eval.verified，按时间取最后一条
export function attemptOutcomeFacts(
  session: MaterializedSession,
  runId: RunId,
  options: AttemptFactsOptions = {}
): AttemptOutcomeFacts {
  // 整步：回炉开启时是同一会话里的全部 Run，否则就是这个 Run 本身
  const runs = stepRunsOf(session, runId);
  const inStep = new Set(runs);
  const lastRun = runs.at(-1) ?? runId;
  // 回炉开启时这一步以最后一个 Run 的验证收尾：最后一个 Run 没有验证记录即未收尾（崩溃在其验证落盘之前），
  // 与缺运行结束记录同样现算为未知——不能让上一轮的失败验证替这一步下结论（决策 154 修订）
  const stepClosed =
    repairRoundsOf(session) === 0 || lastGateVerificationOf(session, lastRun) !== undefined;
  const hasRunEnded =
    stepClosed &&
    session.runtimeEvents.some((event) => event.kind === "run.ended" && event.runId === lastRun);
  const pendingCount = session.reconcile.unknown.filter((entry) =>
    inStep.has(entry.intent.runId)
  ).length;
  const failure =
    session.classification.runs.find((entry) => entry.runId === lastRun)?.failure ?? null;
  const limitHit = session.limitHits.some((record) => record.runId === lastRun);
  // 验证门记录只认这一步最后一个 Run 的（中间轮的失败验证不决定整步）；判据的 eval.verified 在一步收尾后
  // 挂在这一步的身份（首个 Run）上，按整步收
  const verdicts: Array<{ at: number; verdict: EvalVerdict }> = [];
  for (const source of [session, ...(options.verificationSources ?? [])]) {
    for (const record of source.attemptVerifieds) {
      if (record.target.sessionId === session.sessionId && record.target.runId === lastRun) {
        verdicts.push({ at: record.timestamp, verdict: record.verdict });
      }
    }
  }
  for (const record of session.evalVerifieds) {
    if (inStep.has(record.runId)) {
      verdicts.push({ at: record.timestamp, verdict: record.payload.verdict });
    }
  }
  verdicts.sort((a, b) => a.at - b.at);
  const verdict = verdicts.at(-1)?.verdict;
  return {
    hasRunEnded,
    pendingCount,
    failure,
    limitHit,
    ...(verdict !== undefined ? { verdict } : {}),
  };
}
