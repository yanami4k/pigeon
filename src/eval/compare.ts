// 编辑模式对照报告（决策 061）：两个 Eval 输出目录（基线与候选）按同一条件筛出结果行，按编辑模式汇总成功率、误报、
// 编辑调用与报错、报错分类、轮次、输出 token、撞输出上限次数与耗时，并逐任务对比。旧结果行没有 editMode 的按
// hashline 读，没有 process 的用会话账本复算（与 runner 写结果行同一个汇总函数）。"已知局限"段自动写出：
// 两组 harness 版本、运行时间先后、模型、样本量。报告只写目录名，不写本地绝对路径。
import { existsSync } from "node:fs";
import path from "node:path";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { asRunId, asSessionId } from "../state/ids.ts";
import { type EditMode, LEGACY_RESULT_EDIT_MODE } from "../tools/edit-mode.ts";
import {
  EDIT_ERROR_CATEGORIES,
  EDIT_ERROR_LABELS,
  EDIT_TOOL_NAME,
  type ProcessMetrics,
  summarizeProcess,
} from "./process.ts";
import {
  type EvalResultLine,
  effectiveResultLines,
  type HarnessRef,
  readResultLines,
} from "./results.ts";
import type { EvalCondition } from "./task.ts";

const DASH = "—";

export interface EditModeComparisonInput {
  baselineDir: string;
  candidateDir: string;
  condition?: EvalCondition;
}

interface CompareLine {
  line: EvalResultLine;
  editMode: EditMode;
  process?: ProcessMetrics;
  startedAt?: number;
  model?: string;
}

interface Group {
  name: string;
  dir: string;
  lines: CompareLine[];
}

function loadGroup(name: string, dir: string, condition: EvalCondition): Group {
  const sessionsDir = path.join(dir, ".pigeon", "sessions");
  // 读侧口径与报告一致：同键取最后一条非错误行
  const lines = effectiveResultLines(readResultLines(path.join(dir, "results.jsonl")))
    .filter((line) => line.condition === condition)
    .map((line): CompareLine => {
      const editMode = line.editMode ?? LEGACY_RESULT_EDIT_MODE;
      const entry: CompareLine = { line, editMode };
      if (line.process !== undefined) {
        entry.process = line.process;
      }
      const sessionId = asSessionId(line.sessionId);
      if (!existsSync(JsonlEventLog.filePathFor(sessionsDir, sessionId))) {
        return entry;
      }
      const runId = line.runId !== null ? asRunId(line.runId) : undefined;
      if (entry.process === undefined) {
        entry.process = summarizeProcess({
          sessionsDir,
          sessionId,
          editMode,
          ...(runId !== undefined ? { runId } : {}),
        });
      }
      const started = materializeSession(sessionsDir, sessionId, { content: false }).runStarteds[0];
      if (started !== undefined) {
        entry.startedAt = started.timestamp;
        entry.model = `${started.payload.model.provider}/${started.payload.model.id}`;
      }
      return entry;
    });
  return { name, dir, lines };
}

function modeLabel(group: Group): string {
  const modes = [...new Set(group.lines.map((entry) => entry.editMode))];
  return modes.length === 0 ? DASH : modes.join("/");
}

function successCell(lines: readonly CompareLine[], withPct: boolean): string {
  if (lines.length === 0) {
    return DASH;
  }
  const pass = lines.filter((entry) => entry.line.verdict === "pass").length;
  return withPct
    ? `${pass}/${lines.length}（${Math.round((pass / lines.length) * 100)}%）`
    : `${pass}/${lines.length}`;
}

function sumEdit(lines: readonly CompareLine[], key: "calls" | "errors"): number {
  return lines.reduce((sum, entry) => sum + (entry.process?.tools[EDIT_TOOL_NAME]?.[key] ?? 0), 0);
}

function average(lines: readonly CompareLine[], pick: (entry: CompareLine) => number): string {
  if (lines.length === 0) {
    return DASH;
  }
  return (lines.reduce((sum, entry) => sum + pick(entry), 0) / lines.length).toFixed(1);
}

function errorCategories(group: Group): string {
  const totals = new Map<string, number>();
  for (const entry of group.lines) {
    for (const [category, count] of Object.entries(entry.process?.editErrors ?? {})) {
      totals.set(category, (totals.get(category) ?? 0) + count);
    }
  }
  const modes = [...new Set(group.lines.map((entry) => entry.editMode))];
  const order = [
    ...new Set([...modes.flatMap((mode) => EDIT_ERROR_CATEGORIES[mode]), ...totals.keys()]),
  ];
  const parts = order
    .filter((category) => (totals.get(category) ?? 0) > 0)
    .map((category) => `${EDIT_ERROR_LABELS[category] ?? category} ${totals.get(category)}`);
  return parts.length > 0 ? parts.join("、") : "无";
}

function formatRef(ref: HarnessRef | undefined): string {
  return ref === undefined ? "未记录" : `${ref.commit}${ref.dirty ? "（有未提交改动）" : ""}`;
}

function refs(group: Group): string[] {
  return [...new Set(group.lines.map((entry) => formatRef(entry.line.harnessRef)))];
}

function timeRange(group: Group): { text: string; min?: number; max?: number } {
  const stamps = group.lines.flatMap((entry) =>
    entry.startedAt !== undefined ? [entry.startedAt] : []
  );
  if (stamps.length === 0) {
    return { text: "未能从会话账本读到运行时间" };
  }
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const iso = (value: number) => `${new Date(value).toISOString().slice(0, 16).replace("T", " ")}`;
  return { text: `${iso(min)} 至 ${iso(max)}（UTC）`, min, max };
}

export function renderEditModeComparison(input: EditModeComparisonInput): string {
  const condition = input.condition ?? "none";
  const baseline = loadGroup("基线", input.baselineDir, condition);
  const candidate = loadGroup("候选", input.candidateDir, condition);
  const groups = [baseline, candidate];
  const header = groups.map((group) => `${modeLabel(group)}（${group.name}）`);
  const out: string[] = [
    "# 编辑模式对照",
    "",
    `- 基线：${path.basename(path.resolve(input.baselineDir))}（编辑模式 ${modeLabel(baseline)}）`,
    `- 候选：${path.basename(path.resolve(input.candidateDir))}（编辑模式 ${modeLabel(candidate)}）`,
    `- 条件：${condition}`,
    "- 过程指标来自会话账本；编辑报错按报错文案的稳定前缀分类",
    "",
    "## 汇总",
    "",
    `| 指标 | ${header.join(" | ")} |`,
    "|---|---|---|",
  ];
  const row = (label: string, cell: (group: Group) => string) =>
    out.push(`| ${label} | ${groups.map(cell).join(" | ")} |`);
  row("运行数", (group) => String(group.lines.length));
  row("成功率", (group) => successCell(group.lines, true));
  row("误报", (group) => String(group.lines.filter((entry) => entry.line.falsePositive).length));
  row("编辑调用数", (group) => String(sumEdit(group.lines, "calls")));
  row("编辑报错数", (group) => String(sumEdit(group.lines, "errors")));
  row("编辑报错率", (group) => {
    const calls = sumEdit(group.lines, "calls");
    return calls === 0 ? DASH : `${((sumEdit(group.lines, "errors") / calls) * 100).toFixed(1)}%`;
  });
  row("报错分类", errorCategories);
  row("平均轮次", (group) => average(group.lines, (entry) => entry.line.turns));
  row("平均输出 token", (group) => average(group.lines, (entry) => entry.line.usage.output));
  row("撞输出上限次数", (group) =>
    String(group.lines.reduce((sum, entry) => sum + (entry.process?.outputLimitTurns ?? 0), 0))
  );
  row("平均耗时（秒）", (group) => average(group.lines, (entry) => entry.line.durationMs / 1000));

  const taskIds = [
    ...new Set(groups.flatMap((group) => group.lines.map((entry) => entry.line.taskId))),
  ].sort();
  out.push(
    "",
    "## 逐任务对比",
    "",
    "| 任务 | 成功（基线） | 成功（候选） | 编辑调用/报错（基线） | 编辑调用/报错（候选） | 平均轮次（基线） | 平均轮次（候选） | 平均输出 token（基线） | 平均输出 token（候选） |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const taskId of taskIds) {
    const scoped = groups.map((group) =>
      group.lines.filter((entry) => entry.line.taskId === taskId)
    );
    const edits = scoped.map((lines) =>
      lines.length === 0 ? DASH : `${sumEdit(lines, "calls")}/${sumEdit(lines, "errors")}`
    );
    out.push(
      `| ${taskId} | ${scoped.map((lines) => successCell(lines, false)).join(" | ")} | ${edits.join(" | ")} | ` +
        `${scoped.map((lines) => average(lines, (entry) => entry.line.turns)).join(" | ")} | ` +
        `${scoped.map((lines) => average(lines, (entry) => entry.line.usage.output)).join(" | ")} |`
    );
  }

  const baseRefs = refs(baseline);
  const candRefs = refs(candidate);
  const sameRef = baseRefs.length === 1 && candRefs.length === 1 && baseRefs[0] === candRefs[0];
  const baseTime = timeRange(baseline);
  const candTime = timeRange(candidate);
  const ordered =
    baseTime.max !== undefined && candTime.min !== undefined && baseTime.max < candTime.min
      ? "；两组先后运行、没有交错，模型服务随时间的变化会混入对比"
      : baseTime.min !== undefined && candTime.min !== undefined
        ? "；两组运行时间有重叠或候选早于基线"
        : "";
  const models = [
    ...new Set(
      groups.flatMap((group) =>
        group.lines.flatMap((entry) => (entry.model !== undefined ? [entry.model] : []))
      )
    ),
  ];
  const attempts = Math.max(
    0,
    ...groups.flatMap((group) => group.lines.map((entry) => entry.line.attempt))
  );
  const missingProcess = groups.map(
    (group) => group.lines.filter((entry) => entry.process === undefined).length
  );
  out.push(
    "",
    "## 已知局限",
    "",
    `- harness 版本：基线 ${baseRefs.join("、") || DASH}；候选 ${candRefs.join("、") || DASH}——${sameRef ? "两组 harness 版本相同" : "两组 harness 版本不同，版本差会混入对比"}`,
    `- 时间先后：基线 ${baseTime.text}；候选 ${candTime.text}${ordered}`,
    `- 模型：${models.length > 0 ? models.join("、") : "未能从会话账本读到"}；${models.length <= 1 ? "单一模型，结论不外推到其他模型" : "两组模型不一致"}`,
    `- 样本量：基线 ${baseline.lines.length} 次、候选 ${candidate.lines.length} 次运行（每任务每组最多 ${attempts} 次）；样本小，不做显著性结论，成功率触顶时只写未测出差异`
  );
  if (missingProcess.some((count) => count > 0)) {
    out.push(
      `- 过程指标缺失：基线 ${missingProcess[0]} 行、候选 ${missingProcess[1]} 行既无 process 字段也找不到会话账本，编辑计数按 0 计`
    );
  }
  out.push("");
  return out.join("\n");
}
