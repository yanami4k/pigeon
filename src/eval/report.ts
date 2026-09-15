// Eval 报告（M6.5 S4，决策 060）：report.md 只由 results.jsonl 的行决定，可复算，入库。M6.5 只做 per-task 三元结果
// 与 pairwise delta，按 M9 统计规范不报裸胜率——成功率表逐任务列出；Wilson 区间与 McNemar exact 在 M9 补。
// holdout 任务单列：写 Skill 时没看过它们，holdout 上的变化才说明经验会迁移而非背题。
import { LEGACY_RESULT_EDIT_MODE } from "../tools/edit-mode.ts";
import type { EvalResultLine } from "./results.ts";
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

export function renderEvalReport(lines: readonly EvalResultLine[]): string {
  const taskIds = [...new Set(lines.map((line) => line.taskId))].sort();
  const holdoutIds = taskIds.filter((id) =>
    lines.some((line) => line.taskId === id && line.holdout)
  );
  const visibleIds = taskIds.filter((id) => !holdoutIds.includes(id));
  const maxAttempt = lines.reduce((max, line) => Math.max(max, line.attempt), 0);
  const label = (id: string): string => (holdoutIds.includes(id) ? `${id}（holdout）` : id);
  const out: string[] = [
    "# Eval 冒烟报告",
    "",
    `- 运行：${lines.length} 次；任务 ${taskIds.length} 个（其中 holdout ${holdoutIds.length} 个）；每任务每条件最多 ${maxAttempt} 次`,
    "- 条件：none = 无 Skill，candidate = 候选 Skill，approved = 已批准 Skill；三者只有 skillRoots 不同，memoryRoots 一律为空",
    `- 编辑模式：${[...new Set(lines.map((line) => line.editMode ?? LEGACY_RESULT_EDIT_MODE))].join(" / ") || "—"}`,
    "- 判决：确定性验证器的退出码三值（通过 / 失败 / 未判定）；误报 = agent 自报完成但验证失败",
    "- 统计口径：per-task 三元结果与 pairwise delta；Wilson 区间与 McNemar exact 在 M9 补",
    "",
  ];

  const successTable = (heading: string, ids: readonly string[]): void => {
    out.push(heading, "");
    if (ids.length === 0) {
      out.push("（无）", "");
      return;
    }
    out.push(
      `| 任务 | ${EVAL_CONDITIONS.join(" | ")} |`,
      `|---|${EVAL_CONDITIONS.map(() => "---").join("|")}|`
    );
    for (const id of ids) {
      const taskLines = ofTask(lines, [id]);
      out.push(
        `| ${id} | ${EVAL_CONDITIONS.map((condition) => successCell(ofCondition(taskLines, condition))).join(" | ")} |`
      );
    }
    const pooled = ofTask(lines, ids);
    out.push(
      `| 合计 | ${EVAL_CONDITIONS.map((condition) => successCell(ofCondition(pooled, condition))).join(" | ")} |`,
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
    for (const condition of EVAL_CONDITIONS) {
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

  out.push(
    "## pairwise delta（成功率百分点）",
    "",
    "| 任务 | candidate − none | approved − none | approved − candidate |",
    "|---|---|---|---|"
  );
  const deltaRow = (name: string, ids: readonly string[]): string => {
    const scoped = ofTask(lines, ids);
    const none = ofCondition(scoped, "none");
    const candidate = ofCondition(scoped, "candidate");
    const approved = ofCondition(scoped, "approved");
    return `| ${name} | ${deltaCell(candidate, none)} | ${deltaCell(approved, none)} | ${deltaCell(approved, candidate)} |`;
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

  out.push(
    "## 成本与过程（按条件汇总，含 holdout）",
    "",
    "| 条件 | 运行 | 误报 | 平均轮次 | 平均工具调用 | 平均需审批 | 总 token | 总成本 | 平均耗时（秒） |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const condition of EVAL_CONDITIONS) {
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
  const errored = lines.filter((line) => line.error !== undefined);
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
