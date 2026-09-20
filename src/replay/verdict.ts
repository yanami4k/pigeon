// 回放判定（M8 S4，决策 084）：把四组重执行的结果算成三值结论。
//
// 为什么不用置信区间当判据：N=5 时 Wilson 区间宽到只有极端分布才不重叠，以"区间不重叠"为判据，
// 实质门槛就是大效应，却披着统计的外观。这里直接把门槛写成大效应（缺省 0.4，即五次里差两次），
// 区间照算并写进回执，只作事后阅读，不参与判定。
//
// 三值口径（与 Eval 基线触顶时的结论口径一致）：
//   - 回归：成功侧带经验的通过率比不带经验低达门槛，或失败侧带经验反而比不带经验低达门槛。先判回归。
//   - 通过：失败侧提升达门槛，且成功侧没有达门槛的下降。
//   - 未测出：其余一切。"未测出"不是"无效"——它只说明这组回放没测出差别。
//
// 四组固定 N 全跑、不中途停：提前停会让"停在哪一次"成为结论的一部分，事后不可复算。
// 少跑一次即拒绝出结论（响亮失败，不按缺失值降级）。
import type { EvalVerdict } from "../state/runtime-events.ts";

// 四组之一；与账本 RerunArmSchema 同一组字面量（state 是叶子层，这里不反向依赖其 schema 对象）
export type RerunArm =
  | "failed-baseline"
  | "failed-with"
  | "successful-baseline"
  | "successful-with";

export const RERUN_ARMS: readonly RerunArm[] = [
  "failed-baseline",
  "failed-with",
  "successful-baseline",
  "successful-with",
];

// 每组跑几次：缺省 5，可配；低于 3 直接拒绝（三次以下连"差两次"都表达不出来）
export const DEFAULT_RERUN_N = 5;
export const MIN_RERUN_N = 3;

// 大效应门槛：缺省 0.4——N=5 时即"五次里差两次"
export const DEFAULT_EFFECT_THRESHOLD = 0.4;

export class RerunCountError extends Error {}

export interface RerunOutcome {
  arm: RerunArm;
  index: number;
  verdict: EvalVerdict;
}

export interface WilsonInterval {
  low: number;
  high: number;
}

export interface RerunArmStats {
  arm: RerunArm;
  runs: number;
  passes: number;
  passRate: number;
  // 下标 k-1 对应 k = 1..runs
  passAtK: number[];
  passPowK: number[];
  wilson: WilsonInterval;
}

export type VerificationConclusion = "passed" | "inconclusive" | "regressed";

export interface JudgeRerunsInput {
  runs: readonly RerunOutcome[];
  n: number;
  effectThreshold?: number;
}

export interface RerunJudgement {
  conclusion: VerificationConclusion;
  n: number;
  effectThreshold: number;
  positiveDelta: number;
  negativeDelta: number;
  arms: RerunArmStats[];
}

// 组合数 C(n, k)：n 最大只有几十，逐项相乘即可，不用阶乘避免溢出
function choose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// pass@k：从 n 次里随机抽 k 次，至少有一次通过的概率（1 减去全抽到失败的概率）
export function passAtK(n: number, passes: number, k: number): number {
  if (k <= 0 || k > n) {
    return 0;
  }
  return 1 - choose(n - passes, k) / choose(n, k);
}

// pass^k：从 n 次里随机抽 k 次，k 次全通过的概率
export function passPowK(n: number, passes: number, k: number): number {
  if (k <= 0 || k > n) {
    return 0;
  }
  return choose(passes, k) / choose(n, k);
}

// Wilson 区间（95%）：只进回执，不参与判定
export function wilsonInterval(n: number, passes: number, z = 1.96): WilsonInterval {
  if (n === 0) {
    return { low: 0, high: 0 };
  }
  const p = passes / n;
  const denominator = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (center - spread) / denominator),
    high: Math.min(1, (center + spread) / denominator),
  };
}

// 一组的统计：只有判决为 pass 的算通过——未定（运行没跑起来、验证命令自身故障）不算通过，
// 也不把该组算成少跑（它确实跑了一次，只是没测出成败）
export function armStats(
  arm: RerunArm,
  outcomes: readonly { verdict: EvalVerdict }[]
): RerunArmStats {
  const runs = outcomes.length;
  const passes = outcomes.filter((outcome) => outcome.verdict === "pass").length;
  return {
    arm,
    runs,
    passes,
    passRate: runs === 0 ? 0 : passes / runs,
    passAtK: Array.from({ length: runs }, (_, index) => passAtK(runs, passes, index + 1)),
    passPowK: Array.from({ length: runs }, (_, index) => passPowK(runs, passes, index + 1)),
    wilson: wilsonInterval(runs, passes),
  };
}

// 每组次数的下限守卫（M8 收口补遗）：判定阶段当然要再判一次，但调用方必须在跑任何一次回放之前
// 先调它——一次验证是四组各 N 次真执行，跑完几十分钟才报"次数太少"，既烧了预算又不落回执
export function assertRerunCount(n: number): void {
  if (!Number.isInteger(n) || n < MIN_RERUN_N) {
    throw new RerunCountError(
      `每组回放次数需要不小于 ${MIN_RERUN_N} 的整数（当前 ${n}）：次数再少连大效应都表达不出来，不降级出结论`
    );
  }
}

export function judgeReruns(input: JudgeRerunsInput): RerunJudgement {
  const { n } = input;
  assertRerunCount(n);
  const arms = RERUN_ARMS.map((arm) => {
    const outcomes = input.runs.filter((run) => run.arm === arm);
    if (outcomes.length !== n) {
      throw new RerunCountError(
        `回放组 ${arm} 跑了 ${outcomes.length} 次，应为 ${n} 次：四组固定 N 全跑不中途停，少跑就不出结论`
      );
    }
    return armStats(arm, outcomes);
  });
  const rateOf = (arm: RerunArm): number => arms.find((stats) => stats.arm === arm)?.passRate ?? 0;
  const positiveDelta = rateOf("failed-with") - rateOf("failed-baseline");
  const negativeDelta = rateOf("successful-with") - rateOf("successful-baseline");
  const effectThreshold = input.effectThreshold ?? DEFAULT_EFFECT_THRESHOLD;
  const conclusion: VerificationConclusion =
    negativeDelta <= -effectThreshold || positiveDelta <= -effectThreshold
      ? "regressed"
      : positiveDelta >= effectThreshold
        ? "passed"
        : "inconclusive";
  return { conclusion, n, effectThreshold, positiveDelta, negativeDelta, arms };
}
