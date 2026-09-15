// Eval 报告（M6.5 S4，决策 060）：任务乘条件的成功率表、holdout 单列、per-task 三元结果、pairwise delta、
// 误报与成本；Wilson 区间与 McNemar 留给 M9。报告只由 results 行决定（可复算）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEvalReport } from "./report.ts";
import type { EvalResultLine } from "./runner.ts";
import type { EvalCondition } from "./task.ts";

function line(
  taskId: string,
  condition: EvalCondition,
  attempt: number,
  verdict: EvalResultLine["verdict"],
  extra: Partial<EvalResultLine> = {}
): EvalResultLine {
  return {
    taskId,
    condition,
    attempt,
    holdout: false,
    sessionId: `sess-${taskId}-${condition}-${attempt}`,
    runId: `run-${taskId}-${condition}-${attempt}`,
    status: "completed",
    verdict,
    falsePositive: false,
    turns: 4,
    toolCalls: 3,
    approvalsNeeded: 1,
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    durationMs: 2000,
    failureClass: null,
    ...extra,
  };
}

test("Eval 报告：成功率表（非 holdout 与 holdout 分开）、per-task 三元结果、pairwise delta、误报与成本", () => {
  const lines = [
    line("a", "none", 1, "pass"),
    line("a", "none", 2, "fail", { falsePositive: true }),
    line("a", "candidate", 1, "pass"),
    line("a", "candidate", 2, "pass"),
    line("a", "approved", 1, "pass"),
    line("a", "approved", 2, "undetermined", { status: "wall-clock-limit" }),
    line("h", "none", 1, "fail", { holdout: true }),
    line("h", "candidate", 1, "pass", { holdout: true }),
    line("h", "approved", 1, "pass", { holdout: true }),
  ];
  const report = renderEvalReport(lines);
  assert.match(report, /^# Eval 冒烟报告/m);
  assert.match(report, /Wilson 区间与 McNemar exact 在 M9 补/);

  const [visible, holdout] = report.split("## 成功率（holdout）");
  assert.match(visible ?? "", /\| a \| 1\/2（50%） \| 2\/2（100%） \| 1\/2（50%，未判定 1） \|/);
  assert.doesNotMatch(visible?.split("## per-task")[0] ?? "", /\| h \|/);
  assert.match(holdout ?? "", /\| h \| 0\/1（0%） \| 1\/1（100%） \| 1\/1（100%） \|/);

  assert.match(report, /\| a \| approved \| 1 \| 0 \| 1 \| 0 \|/);
  assert.match(report, /\| a \| none \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(report, /\| a \| \+50\.0 \| 0\.0 \| -50\.0 \|/);
  assert.match(report, /\| h（holdout） \| \+100\.0 \| \+100\.0 \| 0\.0 \|/);

  // 成本与过程：按条件汇总（不含 holdout 的与含 holdout 的都列运行数）
  assert.match(report, /\| none \| 3 \| 1 \| 4\.0 \| 3\.0 \| 1\.0 \| 450 \| 0\.0090 \| 2\.0 \|/);
});

test("Eval 报告：某任务缺某条件的运行时格子标破折号，delta 不计算", () => {
  const report = renderEvalReport([line("b", "none", 1, "pass")]);
  assert.match(report, /\| b \| 1\/1（100%） \| — \| — \|/);
  assert.match(report, /\| b \| — \| — \| — \|/);
});
