import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCases, judgeStep } from "./stream-classes.ts";
import type { TestCaseResult } from "./stream-measure.ts";
import { compareRuns } from "./stream-runner.ts";

const run = (outcomes: Record<string, TestCaseResult["outcome"]>): TestCaseResult[] =>
  Object.entries(outcomes).map(([id, outcome]) => ({
    id,
    file: id.split("::")[0] ?? null,
    outcome,
  }));

test("两类用例（214）：之前两遍都没过、之后两遍都过为要做到的；四遍都过为不许挂的；同一侧两遍不一的排除并计数；人弄坏的与收集失败的伪用例都不进", () => {
  // 之后（人的代码）两遍
  const commit = compareRuns([
    run({
      "t.py::new": "passed",
      "t.py::old": "passed",
      "t.py::parentFlaky": "passed",
      "t.py::commitFlaky": "passed",
      "t.py::broken": "failed",
      "t.py::skippedBefore": "passed",
      "n.py::uncollectedBefore": "passed",
      "t.py::oneMissingBefore": "passed",
      "c.py::<collection>": "passed",
    }),
    run({
      "t.py::new": "passed",
      "t.py::old": "passed",
      "t.py::parentFlaky": "passed",
      "t.py::commitFlaky": "failed",
      "t.py::broken": "failed",
      "t.py::skippedBefore": "passed",
      "n.py::uncollectedBefore": "passed",
      "t.py::oneMissingBefore": "passed",
      "c.py::<collection>": "passed",
    }),
  ]);
  // 之前（叠放到 parent 上）两遍：n.py 在 parent 上收集失败，只剩伪用例
  const parent = compareRuns([
    run({
      "t.py::new": "failed",
      "t.py::old": "passed",
      "t.py::parentFlaky": "passed",
      "t.py::commitFlaky": "passed",
      "t.py::broken": "passed",
      "t.py::skippedBefore": "skipped",
      "n.py::<collection>": "failed",
      "t.py::oneMissingBefore": "failed",
    }),
    run({
      "t.py::new": "failed",
      "t.py::old": "passed",
      "t.py::parentFlaky": "failed",
      "t.py::commitFlaky": "passed",
      "t.py::broken": "passed",
      "t.py::skippedBefore": "skipped",
      "n.py::<collection>": "failed",
    }),
  ]);
  // t.py、n.py 都是人在该步新写或改过的测试文件
  assert.deepEqual(classifyCases(commit, parent, new Set(["t.py", "n.py"])), {
    failToPass: ["n.py::uncollectedBefore", "t.py::new", "t.py::skippedBefore"],
    passToPass: ["t.py::old"],
    excludedFlaky: ["t.py::commitFlaky", "t.py::oneMissingBefore", "t.py::parentFlaky"],
  });
});

test("两类用例（274）：人在该步没改的测试文件在 parent 侧整文件收集失败，其中的用例不进要做到的；人改过的文件收集失败照旧计入；人没改的文件里单条失败的照旧计入", () => {
  const twice = (outcomes: Record<string, TestCaseResult["outcome"]>) =>
    compareRuns([run(outcomes), run(outcomes)]);
  // 之后：三个文件的用例都通过
  const commit = twice({
    "changed.py::a": "passed",
    "unchanged.py::b": "passed",
    "unchanged.py::c": "passed",
    "other.py::d": "passed",
    "other.py::e": "passed",
  });
  // 之前：changed.py 与 unchanged.py 整文件收集失败（例如叠上的 conftest 导入该步才有的模块）；other.py 正常收集、一条失败
  const parent = twice({
    "changed.py::<collection>": "failed",
    "unchanged.py::<collection>": "failed",
    "other.py::d": "failed",
    "other.py::e": "passed",
  });
  assert.deepEqual(classifyCases(commit, parent, new Set(["changed.py"])), {
    failToPass: ["changed.py::a", "other.py::d"],
    passToPass: ["other.py::e"],
    excludedFlaky: [],
  });
});

test("每步计分（196、201）：得分为要做到的通过比例；做成要求要做到的全过且不许挂的无一失败；缺席的用例算没过；失败编号截断", () => {
  const classes = {
    failToPass: ["a::1", "a::2", "a::3", "a::4"],
    passToPass: ["b::1", "b::2"],
    excludedFlaky: ["c::1"],
  };
  const agent = run({
    "a::1": "passed",
    "a::2": "passed",
    "a::3": "failed",
    "b::1": "passed",
    "b::2": "passed",
  });
  assert.deepEqual(judgeStep(classes, agent), {
    failToPass: { passed: 2, total: 4 },
    score: 0.5,
    passToPass: { failed: 0, total: 2 },
    solved: false,
    failedCases: { failToPass: ["a::3", "a::4"], passToPass: [], truncated: false },
    excludedFlaky: 1,
  });
  const allF2p = run({
    "a::1": "passed",
    "a::2": "passed",
    "a::3": "passed",
    "a::4": "passed",
    "b::1": "passed",
  });
  const j = judgeStep(classes, allF2p, 1);
  assert.equal(j.score, 1);
  assert.equal(j.solved, false, "不许挂的有一条没过即不算做成");
  assert.deepEqual(j.passToPass, { failed: 1, total: 2 });
  const full = judgeStep(classes, [...allF2p, ...run({ "b::2": "passed" })]);
  assert.equal(full.solved, true);
  const capped = judgeStep(classes, [], 1);
  assert.deepEqual(capped.failedCases, {
    failToPass: ["a::1"],
    passToPass: ["b::1"],
    truncated: true,
  });
});

test("要做到的为零的步：得分与做成都为空（不进主判据分母），不许挂的照常统计", () => {
  const j = judgeStep({ failToPass: [], passToPass: ["b::1"], excludedFlaky: [] }, run({}));
  assert.equal(j.score, null);
  assert.equal(j.solved, null);
  assert.deepEqual(j.failToPass, { passed: 0, total: 0 });
  assert.deepEqual(j.passToPass, { failed: 1, total: 1 });
});
