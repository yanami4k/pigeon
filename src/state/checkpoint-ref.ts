// 分叉点之前最近的工作区快照（M7 S6，决策 078；M8 S3 起由回放共用）：纯函数，只读物化结果。
// 同一 Run 内不晚于该条目的最后一个快照；没有则取更早 Run 的最后一个；仍没有则说明该点早于首次改动——
// 取首个快照的改前基线；整个会话都没改过文件时返回 undefined（由调用方决定取现状快照还是响亮失败）。
// 放在 state 叶子层：分叉（application/fork.ts）要用它，且它不碰文件系统。
import type { ForkPoint } from "./event-log.ts";
import type { RunId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";

export function resolveCheckpointBefore(
  session: MaterializedSession,
  point: ForkPoint
): { commit: string; ref?: string } | undefined {
  const runOrder: RunId[] = [];
  for (const record of session.records) {
    if (record.kind === "entry" && !runOrder.includes(record.runId)) {
      runOrder.push(record.runId);
    }
  }
  const pointRunIndex = runOrder.indexOf(point.runId);
  let best: { commit: string; ref: string } | undefined;
  for (const record of session.checkpoints) {
    const runIndex = runOrder.indexOf(record.runId);
    const before =
      runIndex < pointRunIndex ||
      (record.runId === point.runId && record.payload.afterRunSeq <= point.runSeq);
    if (runIndex >= 0 && before) {
      best = { commit: record.payload.commit, ref: record.payload.ref };
    }
  }
  if (best !== undefined) {
    return best;
  }
  const base = session.checkpoints.find((record) => record.payload.baseCommit !== undefined);
  return base?.payload.baseCommit !== undefined ? { commit: base.payload.baseCommit } : undefined;
}
