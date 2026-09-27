// 回炉的一步（决策 142 / 143 / 147）：验证不过就把失败反馈发回同一会话、开一个新 Run 接着修，所以一步由同一会话里的
// 若干个 Run 组成——首个 Run 加上各轮回炉的 Run。回炉开启与否由 run.started 里冻结的回炉轮数判定。
// 这一步的成败以最后一次验证为准，中间轮次的失败不算这一步失败；读成败标签的地方一律经这里取整步。
// 修满或预算耗尽仍失败时这一步以失败收尾、工作区保留 agent 的改动，不做回退（决策 172 / 173），账本不另记。
// 最后一个 Run 没有验证记录即这一步未收尾（例如某轮回炉 Run 结束之后、其验证落盘之前进程崩溃），没有结论，
// 续跑时整步重做；不能拿上一轮的失败验证当这一步的结论。纯函数，无 IO。
import type { RunId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import type { EvalVerdict } from "./runtime-events.ts";

// 会话冻结的回炉轮数；0 即未开启
export function repairRoundsOf(session: Pick<MaterializedSession, "runStarteds">): number {
  return session.runStarteds[0]?.payload.repairRounds ?? 0;
}

// 一步由哪些 Run 组成（按开始顺序）：回炉开启的会话里全部 Run 即一步；否则这个 Run 自成一步
export function stepRunsOf(
  session: Pick<MaterializedSession, "runStarteds">,
  runId: RunId
): RunId[] {
  if (repairRoundsOf(session) === 0) {
    return [runId];
  }
  const runs = session.runStarteds.map((record) => record.runId);
  return runs.includes(runId) ? runs : [runId];
}

// 这一步的最后一个 Run：验证门的结论只认它的验证记录（回炉关闭时就是这个 Run 本身）
export function lastStepRunOf(
  session: Pick<MaterializedSession, "runStarteds">,
  runId: RunId
): RunId {
  return stepRunsOf(session, runId).at(-1) ?? runId;
}

// 某个 Run 上时间最晚的一条验证门记录（只看本会话）
export function lastGateVerificationOf(
  session: Pick<MaterializedSession, "sessionId" | "attemptVerifieds">,
  runId: RunId
): MaterializedSession["attemptVerifieds"][number] | undefined {
  let best: MaterializedSession["attemptVerifieds"][number] | undefined;
  for (const record of session.attemptVerifieds) {
    if (
      record.target.sessionId === session.sessionId &&
      record.target.runId === runId &&
      (best === undefined || record.timestamp >= best.timestamp)
    ) {
      best = record;
    }
  }
  return best;
}

export interface RepairStepOutcome {
  // 用了几轮回炉（首个 Run 不算）
  rounds: number;
  // 这一步最后一个 Run 的验证结论；最后一个 Run 没有验证记录（这一步未收尾）时缺省
  verdict?: EvalVerdict;
}

// 回炉一步的结果（由账本推出）；回炉未开启返回 undefined
export function repairStepOutcome(
  session: Pick<MaterializedSession, "sessionId" | "runStarteds" | "attemptVerifieds">
): RepairStepOutcome | undefined {
  if (repairRoundsOf(session) === 0) {
    return undefined;
  }
  const runs = session.runStarteds.map((record) => record.runId);
  const lastRun = runs.at(-1);
  const last = lastRun !== undefined ? lastGateVerificationOf(session, lastRun) : undefined;
  return {
    rounds: Math.max(0, runs.length - 1),
    ...(last !== undefined ? { verdict: last.verdict } : {}),
  };
}
