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
  const report = renderEvalReport(lines, { source: "local" });
  // 标题按实际内容：题源与条件数（113 修订：一套模板，条件数参数化）
  assert.match(report, /^# Eval 报告：local（3 条件对照：none \/ candidate \/ approved）$/m);
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

// 报告里"成功率"一节（到下一节标题为止）：断言只看这一段，免得匹配到别的表里形状相同的行
function successSection(report: string): string {
  const start = report.indexOf("## 成功率（非 holdout）");
  const end = report.indexOf("## 成功率（holdout）");
  assert.ok(start !== -1 && end > start, "报告里没有成功率一节");
  return report.slice(start, end);
}

test("Eval 报告的标注：内容审核拒答不进成败统计的分母并单列；空补丁与撞上限（含其中判分通过数）单列；没有这些标注时不出该节", () => {
  const lines = [
    line("a", "none", 1, "pass", { status: "turn-limit", limitHit: "turn-limit" }),
    line("b", "none", 1, "fail", { status: "wall-clock-limit", limitHit: "wall-clock-limit" }),
    line("c", "none", 1, "fail", { emptyPatch: true }),
    line("d", "none", 1, "undetermined", { status: "refused", error: "内容审核拒答：refused" }),
    line("e", "none", 1, "pass"),
  ];
  const success = successSection(renderEvalReport(lines));
  const report = renderEvalReport(lines);
  // 拒答的那一行不进分母：合计 2/4 而不是 2/5；它自己的格子为空（若计入会是 0/1（0%，未判定 1））
  assert.match(success, /^\| 合计 \| 2\/4（50%） \|$/m);
  assert.match(success, /^\| d \| — \|$/m);
  // 撞上限但判分通过的计为通过
  assert.match(success, /^\| a \| 1\/1（100%） \|$/m);
  assert.match(report, /## 标注/);
  assert.match(report, /- 内容审核拒答：1 次（不补跑、不计入成败统计）：d/);
  assert.match(report, /- 空补丁（判失败，根本没改）：1 次：c/);
  assert.match(
    report,
    /- 撞上限：2 次，其中判分通过 1 次：a（turn-limit，通过）、b（wall-clock-limit，失败）/
  );
  assert.doesNotMatch(renderEvalReport([line("e", "none", 1, "pass")]), /## 标注/);
});

test("单条件报告：标题写明单条件，表只列这一个条件，不出条件对照（pairwise delta）一节，条件说明只讲在场的条件", () => {
  const report = renderEvalReport([line("a", "none", 1, "pass"), line("b", "none", 1, "fail")], {
    source: "swebench-verified",
  });
  assert.match(report, /^# Eval 报告：swebench-verified（单条件 none）$/m);
  assert.match(successSection(report), /^\| 任务 \| none \|$/m);
  assert.doesNotMatch(report, /candidate|approved/);
  assert.doesNotMatch(report, /pairwise delta/);
  assert.match(report, /^\| none \| 2 \|/m);
});

test("Eval 报告：某任务缺某条件的运行时格子标破折号，delta 不计算", () => {
  const report = renderEvalReport([
    line("a", "none", 1, "pass"),
    line("a", "candidate", 1, "fail"),
    line("b", "none", 1, "pass"),
  ]);
  // 两个条件在场：只列这两列；b 缺 candidate 的格子标破折号
  assert.match(successSection(report), /^\| b \| 1\/1（100%） \| — \|$/m);
  const delta = report.slice(report.indexOf("## pairwise delta"));
  assert.match(delta, /^\| 任务 \| candidate − none \|$/m);
  assert.match(delta, /^\| a \| -100\.0 \|$/m);
  assert.match(delta, /^\| b \| — \|$/m);
});
