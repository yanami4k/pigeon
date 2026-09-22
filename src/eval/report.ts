// Eval 报告（M6.5 S4，决策 060；113 修订：只维持一套模板，条件数参数化）：report.md 只由 results.jsonl 的行决定，
// 可复算。条件取自在场的行（按 none / candidate / approved 的固定次序），单条件时不出条件对照一节；标题写明题源与条件数。M6.5 只做 per-task 三元结果
// 与 pairwise delta，按 M9 统计规范不报裸胜率——成功率表逐任务列出；Wilson 区间与 McNemar exact 在 M9 补。
// holdout 任务单列：写 Skill 时没看过它们，holdout 上的变化才说明经验会迁移而非背题。
import { LEGACY_RESULT_EDIT_MODE } from "../tools/edit-mode.ts";
import { DETERMINISTIC_ERROR_LABELS, type EvalResultLine } from "./results.ts";
import { EVAL_CONDITIONS, type EvalCondition } from "./task.ts";

const DASH = "—";

function ofTask(lines: readonly EvalResultLine[], taskIds: readonly string[]): EvalResultLine[] {
  return lines.filter((line) => taskIds.includes(line.taskId));
}

function ofCondition(lines: readonly EvalResultLine[], condition: EvalCondition): EvalResultLine[] {
  return lines.filter((line) => line.condition === condition);
}

function count(lines: readonly EvalResultLine[], verdict: EvalResultLine["verdict"]): number {
  return lines.filter((line) => line.verdict === verdict).length;
}

function successCell(lines: readonly EvalResultLine[]): string {
  if (lines.length === 0) {
    return DASH;
  }
  const pass = count(lines, "pass");
  const undetermined = count(lines, "undetermined");
  const pct = Math.round((pass / lines.length) * 100);
  return `${pass}/${lines.length}（${pct}%${undetermined > 0 ? `，未判定 ${undetermined}` : ""}）`;
}

function passRate(lines: readonly EvalResultLine[]): number | undefined {
  return lines.length === 0 ? undefined : count(lines, "pass") / lines.length;
}

// 百分点差，保留一位小数，带符号
function deltaCell(
  minuend: readonly EvalResultLine[],
  subtrahend: readonly EvalResultLine[]
): string {
  const a = passRate(minuend);
  const b = passRate(subtrahend);
  if (a === undefined || b === undefined) {
    return DASH;
  }
  const rounded = Math.round((a - b) * 1000) / 10;
  if (rounded === 0) {
    return "0.0";
  }
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

function average(lines: readonly EvalResultLine[], pick: (line: EvalResultLine) => number): string {
  if (lines.length === 0) {
    return DASH;
  }
  return (lines.reduce((sum, line) => sum + pick(line), 0) / lines.length).toFixed(1);
}

// 各条件的含义（只讲在场的条件）
const CONDITION_NOTES: Readonly<Record<EvalCondition, string>> = {
  none: "none = 无经验",
  candidate: "candidate = 候选经验",
  approved: "approved = 已批准经验",
};

// 条件对照：按固定次序两两相减（后者减前者）
const DELTA_PAIRS: ReadonlyArray<readonly [EvalCondition, EvalCondition]> = [
  ["candidate", "none"],
  ["approved", "none"],
  ["approved", "candidate"],
];

export interface EvalReportOptions {
  // 题源名（任务源的 name）；缺省写"未注明题源"
  source?: string;
}

export function renderEvalReport(
  allLines: readonly EvalResultLine[],
  options: EvalReportOptions = {}
): string {
  // 内容审核拒答不计入成败统计：成功率、三元结果与 delta 都不含它；任务仍列出，单列在"标注"一节
  const refusedLines = allLines.filter((line) => line.status === "refused");
  const lines = allLines.filter((line) => line.status !== "refused");
  const taskIds = [...new Set(allLines.map((line) => line.taskId))].sort();
  const holdoutIds = taskIds.filter((id) =>
    allLines.some((line) => line.taskId === id && line.holdout)
  );
  const visibleIds = taskIds.filter((id) => !holdoutIds.includes(id));
  const maxAttempt = lines.reduce((max, line) => Math.max(max, line.attempt), 0);
  const label = (id: string): string => (holdoutIds.includes(id) ? `${id}（holdout）` : id);
  const present = EVAL_CONDITIONS.filter((condition) =>
    allLines.some((line) => line.condition === condition)
  );
  const conditions: readonly EvalCondition[] = present.length > 0 ? present : ["none"];
  const shape =
    conditions.length === 1
      ? `单条件 ${conditions[0]}`
      : `${conditions.length} 条件对照：${conditions.join(" / ")}`;
  const pairs = DELTA_PAIRS.filter(
    ([after, before]) => conditions.includes(after) && conditions.includes(before)
  );
  const out: string[] = [
    `# Eval 报告：${options.source ?? "未注明题源"}（${shape}）`,
    "",
    `- 运行：${lines.length} 次；任务 ${taskIds.length} 个（其中 holdout ${holdoutIds.length} 个）；每任务每条件最多 ${maxAttempt} 次`,
    `- 条件：${conditions.map((condition) => CONDITION_NOTES[condition]).join("，")}${conditions.length > 1 ? "；各条件只有经验装载不同" : ""}`,
    `- 编辑模式：${[...new Set(lines.map((line) => line.editMode ?? LEGACY_RESULT_EDIT_MODE))].join(" / ") || "—"}`,
    "- 判决：确定性验证器的退出码三值（通过 / 失败 / 未判定）；误报 = agent 自报完成但验证失败",
    conditions.length > 1
      ? "- 统计口径：per-task 三元结果与 pairwise delta；Wilson 区间与 McNemar exact 在 M9 补"
      : "- 统计口径：per-task 三元结果",
    "",
  ];

  const successTable = (heading: string, ids: readonly string[]): void => {
    out.push(heading, "");
    if (ids.length === 0) {
      out.push("（无）", "");
      return;
    }
    out.push(
      `| 任务 | ${conditions.join(" | ")} |`,
      `|---|${conditions.map(() => "---").join("|")}|`
    );
    for (const id of ids) {
      const taskLines = ofTask(lines, [id]);
      out.push(
        `| ${id} | ${conditions.map((condition) => successCell(ofCondition(taskLines, condition))).join(" | ")} |`
      );
    }
    const pooled = ofTask(lines, ids);
    out.push(
      `| 合计 | ${conditions.map((condition) => successCell(ofCondition(pooled, condition))).join(" | ")} |`,
      ""
    );
  };
  successTable("## 成功率（非 holdout）", visibleIds);
  successTable("## 成功率（holdout）", holdoutIds);

  out.push(
    "## per-task 三元结果",
    "",
    "| 任务 | 条件 | 通过 | 失败 | 未判定 | 误报 |",
    "|---|---|---|---|---|---|"
  );
  for (const id of [...visibleIds, ...holdoutIds]) {
    const taskLines = ofTask(lines, [id]);
    for (const condition of conditions) {
      const cell = ofCondition(taskLines, condition);
      if (cell.length === 0) {
        continue;
      }
      out.push(
        `| ${label(id)} | ${condition} | ${count(cell, "pass")} | ${count(cell, "fail")} | ` +
          `${count(cell, "undetermined")} | ${cell.filter((line) => line.falsePositive).length} |`
      );
    }
  }
  out.push("");

  // 条件对照只在两个以上条件在场时才有意义
  if (pairs.length > 0) {
    out.push(
      "## pairwise delta（成功率百分点）",
      "",
      `| 任务 | ${pairs.map(([after, before]) => `${after} − ${before}`).join(" | ")} |`,
      `|---|${pairs.map(() => "---").join("|")}|`
    );
    const deltaRow = (name: string, ids: readonly string[]): string => {
      const scoped = ofTask(lines, ids);
      return `| ${name} | ${pairs
        .map(([after, before]) =>
          deltaCell(ofCondition(scoped, after), ofCondition(scoped, before))
        )
        .join(" | ")} |`;
    };
    for (const id of [...visibleIds, ...holdoutIds]) {
      out.push(deltaRow(label(id), [id]));
    }
    if (visibleIds.length > 0) {
      out.push(deltaRow("合计（非 holdout）", visibleIds));
    }
    if (holdoutIds.length > 0) {
      out.push(deltaRow("合计（holdout）", holdoutIds));
    }
    out.push("");
  }

  out.push(
    "## 成本与过程（按条件汇总，含 holdout）",
    "",
    "| 条件 | 运行 | 误报 | 平均轮次 | 平均工具调用 | 平均需审批 | 总 token | 总成本 | 平均耗时（秒） |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const condition of conditions) {
    const cell = ofCondition(lines, condition);
    if (cell.length === 0) {
      continue;
    }
    const tokens = cell.reduce((sum, line) => sum + line.usage.totalTokens, 0);
    const cost = cell.reduce((sum, line) => sum + line.usage.cost.total, 0);
    out.push(
      `| ${condition} | ${cell.length} | ${cell.filter((line) => line.falsePositive).length} | ` +
        `${average(cell, (line) => line.turns)} | ${average(cell, (line) => line.toolCalls)} | ` +
        `${average(cell, (line) => line.approvalsNeeded)} | ${tokens} | ${cost.toFixed(4)} | ` +
        `${average(cell, (line) => line.durationMs / 1000)} |`
    );
  }
  const emptyPatches = lines.filter((line) => line.emptyPatch === true);
  const limitHits = lines.filter((line) => line.limitHit !== undefined);
  const deterministicLines = lines.filter((line) => line.deterministicError !== undefined);
  const verdictLabel = { pass: "通过", fail: "失败", undetermined: "未判定" } as const;
  if (
    refusedLines.length + emptyPatches.length + limitHits.length + deterministicLines.length >
    0
  ) {
    out.push("", "## 标注", "");
    if (refusedLines.length > 0) {
      out.push(
        `- 内容审核拒答：${refusedLines.length} 次（不补跑、不计入成败统计）：${refusedLines.map((line) => label(line.taskId)).join("、")}`
      );
    }
    if (emptyPatches.length > 0) {
      out.push(
        `- 空补丁（判失败，根本没改）：${emptyPatches.length} 次：${emptyPatches.map((line) => label(line.taskId)).join("、")}`
      );
    }
    if (limitHits.length > 0) {
      out.push(
        `- 撞上限：${limitHits.length} 次，其中判分通过 ${count(limitHits, "pass")} 次：` +
          limitHits
            .map(
              (line) => `${label(line.taskId)}（${line.limitHit}，${verdictLabel[line.verdict]}）`
            )
            .join("、")
      );
    }
    if (deterministicLines.length > 0) {
      out.push(
        `- 确定性错误（重跑必复现，不补跑）：${deterministicLines.length} 次，其中判分通过 ${count(deterministicLines, "pass")} 次：` +
          deterministicLines
            .map(
              (line) =>
                `${label(line.taskId)}（${line.deterministicError !== undefined ? DETERMINISTIC_ERROR_LABELS[line.deterministicError] : ""}，${verdictLabel[line.verdict]}）`
            )
            .join("、")
      );
    }
  }
  const failedWithProgress = lines.filter(
    (line) => line.verdict === "fail" && line.testProgress !== undefined
  );
  if (failedWithProgress.length > 0) {
    const cell = (count: { passed: number; total: number } | undefined): string =>
      count === undefined ? DASH : `${count.passed}/${count.total}`;
    out.push(
      "",
      "## 失败运行的连续指标",
      "",
      "| 任务 | 条件 | 目标用例通过 | 回归用例通过 |",
      "|---|---|---|---|"
    );
    for (const line of failedWithProgress) {
      out.push(
        `| ${label(line.taskId)} | ${line.condition} | ${cell(line.testProgress?.target)} | ${cell(line.testProgress?.regression)} |`
      );
    }
  }
  const errored = allLines.filter((line) => line.error !== undefined);
  if (errored.length > 0) {
    out.push("", "## 运行异常", "");
    for (const line of errored) {
      out.push(
        `- ${label(line.taskId)} / ${line.condition} / 第 ${line.attempt} 次：${line.error}`
      );
    }
  }
  out.push("");
  return out.join("\n");
}
