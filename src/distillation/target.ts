// 提炼目标组装（M7 S4，决策 070 / 074 / 075）：把选好的对比对（或强制提炼时的单侧）组装成提炼器的作用域。
// 纯函数；选对规则在 state/episode.ts。强制提炼（pigeon distill --force，未裁细节的保守缺省）：
// 全失败取最早收尾的一次、只产出教训；全成功取总轮数最少的一次。
import type { AttemptRef } from "../state/attempt-ref.ts";
import type { DistillAttemptScope, DistillTarget } from "../state/distill.ts";
import type { Attempt, ContrastSelection } from "../state/episode.ts";

export function attemptRef(attempt: Attempt): AttemptRef {
  return {
    governanceRoot: attempt.governanceRoot,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    entryRange: { ...attempt.entryRange },
    label: attempt.label,
    ...(attempt.verification !== undefined ? { verification: { ...attempt.verification } } : {}),
  };
}

function scopeOf(attempt: Attempt): DistillAttemptScope {
  return {
    governanceRoot: attempt.governanceRoot,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    from: attempt.entryRange.from,
    to: attempt.entryRange.to,
    label: attempt.label,
    ...(attempt.verification !== undefined ? { verification: { ...attempt.verification } } : {}),
  };
}

export interface ContrastTargetInput {
  kind: DistillTarget["kind"];
  taskKey?: string;
  selection: Pick<ContrastSelection, "successful" | "failed" | "others">;
  sharedPrefix?: DistillTarget["sharedPrefix"];
  // 任务描述所在；缺省取成功侧，其次失败侧
  task?: DistillTarget["task"];
}

export function contrastTarget(input: ContrastTargetInput): DistillTarget {
  const { successful, failed, others } = input.selection;
  const primary = successful ?? failed;
  const task =
    input.task ??
    (primary !== undefined
      ? {
          governanceRoot: primary.governanceRoot,
          sessionId: primary.sessionId,
          runId: primary.runId,
        }
      : undefined);
  if (task === undefined) {
    throw new Error("提炼目标至少需要一侧尝试");
  }
  return {
    kind: input.kind,
    ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
    task,
    ...(input.sharedPrefix !== undefined ? { sharedPrefix: input.sharedPrefix } : {}),
    ...(successful !== undefined ? { successful: scopeOf(successful) } : {}),
    ...(failed !== undefined ? { failed: scopeOf(failed) } : {}),
    others: others.map(attemptRef),
  };
}

// 强制提炼：全失败或全成功的组只取一侧；凑不出任何可比尝试时返回 undefined
export function forcedSelection(
  attempts: readonly Attempt[]
): Pick<ContrastSelection, "successful" | "failed" | "others"> | undefined {
  const ended = (attempt: Attempt) => attempt.endedAt ?? Number.POSITIVE_INFINITY;
  const failed = attempts.filter((attempt) => attempt.label === "Failed");
  const passed = attempts.filter((attempt) => attempt.label === "Passed");
  if (failed.length > 0 && passed.length === 0) {
    const earliest = failed.reduce((best, attempt) =>
      ended(attempt) < ended(best) ? attempt : best
    );
    return { failed: earliest, others: attempts.filter((attempt) => attempt !== earliest) };
  }
  if (passed.length > 0 && failed.length === 0) {
    const fewest = passed.reduce((best, attempt) => (attempt.turns < best.turns ? attempt : best));
    return { successful: fewest, others: attempts.filter((attempt) => attempt !== fewest) };
  }
  return undefined;
}
