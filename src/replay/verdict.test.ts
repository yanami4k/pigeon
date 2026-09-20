// 回放判定（M8 S4，决策 084）：四组固定 N 全跑不中途停；三值结论加大效应门槛；
// pass@k 与 pass^k 分开算；Wilson 区间算出来进回执但不参与判定。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  armStats,
  DEFAULT_EFFECT_THRESHOLD,
  DEFAULT_RERUN_N,
  judgeReruns,
  MIN_RERUN_N,
  passAtK,
  passPowK,
  RerunCountError,
  wilsonInterval,
} from "./verdict.ts";

const pass = { verdict: "pass" as const };
const fail = { verdict: "fail" as const };

// 四组各 N 次：按每组通过次数造运行清单
function runsOf(counts: {
  failedBaseline: number;
  failedWith: number;
  successfulBaseline: number;
  successfulWith: number;
  n?: number;
}): Parameters<typeof judgeReruns>[0]["runs"] {
  const n = counts.n ?? DEFAULT_RERUN_N;
  const arms = [
    ["failed-baseline", counts.failedBaseline],
    ["failed-with", counts.failedWith],
    ["successful-baseline", counts.successfulBaseline],
    ["successful-with", counts.successfulWith],
  ] as const;
  return arms.flatMap(([arm, passes]) =>
    Array.from({ length: n }, (_, index) => ({
      arm,
      index: index + 1,
      ...(index < passes ? pass : fail),
    }))
  );
}

test("pass@k 与 pass^k 分开算：k=1 都等于通过率，k=n 时一个问至少一次、一个问全中", () => {
  // 5 次里 3 次通过
  assert.equal(passAtK(5, 3, 1), 0.6);
  assert.equal(passPowK(5, 3, 1), 0.6);
  assert.equal(passAtK(5, 3, 5), 1, "抽满 5 次必然抽到通过的那几次");
  assert.equal(passPowK(5, 3, 5), 0, "有失败就不可能全中");
  assert.equal(passAtK(5, 0, 2), 0);
  assert.equal(passPowK(5, 5, 5), 1);
  // pass@2 = 1 - C(2,2)/C(5,2) = 1 - 1/10
  assert.ok(Math.abs(passAtK(5, 3, 2) - 0.9) < 1e-9);
  // pass^2 = C(3,2)/C(5,2) = 3/10
  assert.ok(Math.abs(passPowK(5, 3, 2) - 0.3) < 1e-9);
});

test("Wilson 区间：算出来只进回执，区间含通过率且落在 [0,1]", () => {
  const interval = wilsonInterval(5, 3);
  assert.ok(interval.low <= 0.6 && interval.high >= 0.6);
  assert.ok(interval.low >= 0 && interval.high <= 1);
  const none = wilsonInterval(5, 0);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0 && none.high < 1);
});

test("组统计：通过率、pass@k 与 pass^k 按 k 逐项列出，长度等于该组跑的次数", () => {
  const stats = armStats("failed-with", [pass, fail, pass, pass, fail]);
  assert.equal(stats.runs, 5);
  assert.equal(stats.passes, 3);
  assert.equal(stats.passRate, 0.6);
  assert.equal(stats.passAtK.length, 5);
  assert.equal(stats.passPowK.length, 5);
});

test("判定：失败侧提升达到大效应门槛且成功侧不回归即通过", () => {
  const judged = judgeReruns({
    runs: runsOf({ failedBaseline: 0, failedWith: 3, successfulBaseline: 5, successfulWith: 5 }),
    n: DEFAULT_RERUN_N,
  });
  assert.equal(judged.conclusion, "passed");
  assert.ok(Math.abs(judged.positiveDelta - 0.6) < 1e-9);
  assert.equal(judged.negativeDelta, 0);
  assert.equal(judged.effectThreshold, DEFAULT_EFFECT_THRESHOLD);
});

test("判定：提升不到门槛就是未测出，不是无效", () => {
  const judged = judgeReruns({
    runs: runsOf({ failedBaseline: 1, failedWith: 2, successfulBaseline: 5, successfulWith: 5 }),
    n: DEFAULT_RERUN_N,
  });
  assert.equal(judged.conclusion, "inconclusive", "0.2 的提升达不到大效应门槛");
});

test("判定：成功侧下降达到门槛即回归，即使失败侧同时大幅变好", () => {
  const judged = judgeReruns({
    runs: runsOf({ failedBaseline: 0, failedWith: 5, successfulBaseline: 5, successfulWith: 2 }),
    n: DEFAULT_RERUN_N,
  });
  assert.equal(judged.conclusion, "regressed", "负回放先判：经验让成功的那侧变差");
  assert.ok(judged.negativeDelta <= -DEFAULT_EFFECT_THRESHOLD);
});

test("判定：失败侧自身大幅变差同样是回归", () => {
  const judged = judgeReruns({
    runs: runsOf({ failedBaseline: 5, failedWith: 0, successfulBaseline: 5, successfulWith: 5 }),
    n: DEFAULT_RERUN_N,
  });
  assert.equal(judged.conclusion, "regressed");
});

test("判定：四组都必须跑满 N 次——少跑一次就拒绝出结论", () => {
  const short = runsOf({
    failedBaseline: 0,
    failedWith: 3,
    successfulBaseline: 5,
    successfulWith: 5,
  }).slice(0, -1);
  assert.throws(() => judgeReruns({ runs: short, n: DEFAULT_RERUN_N }), RerunCountError);
});

test("判定：N 低于下限直接拒绝，不降级也不凑合", () => {
  assert.equal(MIN_RERUN_N, 3);
  assert.throws(
    () =>
      judgeReruns({
        runs: runsOf({
          failedBaseline: 0,
          failedWith: 2,
          successfulBaseline: 2,
          successfulWith: 2,
          n: 2,
        }),
        n: 2,
      }),
    RerunCountError
  );
});

test("判定：判决为未定（运行没跑起来）的一次不算通过，也不把该组算少跑", () => {
  const runs = runsOf({
    failedBaseline: 0,
    failedWith: 5,
    successfulBaseline: 5,
    successfulWith: 5,
  }).map((run, index) => (index === 5 ? { ...run, verdict: "undetermined" as const } : run));
  const judged = judgeReruns({ runs, n: DEFAULT_RERUN_N });
  const withArm = judged.arms.find((arm) => arm.arm === "failed-with");
  assert.equal(withArm?.runs, 5);
  assert.equal(withArm?.passes, 4, "未定不计入通过");
});
