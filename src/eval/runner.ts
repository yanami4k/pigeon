// Eval runner（M6.5 S4，决策 046 / 059 / 060 含修订）：自建薄 runner，只做四件事——读任务目录、准备仓库快照、
// 经 headless 入口跑 Pigeon、调验证器并出 JSONL 结果。每任务每条件跑 N 次（轮次按"第几次 → 任务 → 条件"交错，
// 减少模型服务随时间漂移对条件对比的影响）；三个条件只由 skillRoots 决定：none 为空、candidate 只含候选目录、
// approved 只含已批准目录，memoryRoots 三个条件一律为空。每次一个新会话，治理根为输出目录（其下 .pigeon/ 不入库、
// 不进日常会话列表）；工作区是从任务 ref 开出的工作树，收工后回填验证资产并跑验证器，跑完删除工作树与分支。
// 每次运行结束立即追加一行 results.jsonl；重跑同一输出目录时已有的（任务、条件、第几次）跳过，全部结束后重写 report.md。
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadless } from "../application/headless.ts";
import { describeHead } from "../orchestration/worktree.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { FailureClass } from "../state/classification.ts";
import { asRunId, newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { DEFAULT_EDIT_MODE, type EditMode, LEGACY_RESULT_EDIT_MODE } from "../tools/edit-mode.ts";
import { emptyProcessMetrics, type ProcessMetrics, summarizeProcess } from "./process.ts";
import { renderEvalReport } from "./report.ts";
import { type EvalResultLine, type HarnessRef, readResultLines } from "./results.ts";
import { prepareTaskWorkspace, releaseStaleWorkspaces } from "./snapshot.ts";
import { EVAL_CONDITIONS, type EvalCondition, type LoadedEvalTask } from "./task.ts";
import { verifyTaskRun } from "./verify.ts";

export { EVAL_RESULT_FIELDS, type EvalResultLine } from "./results.ts";

export interface EvalSkillRoots {
  candidate: SkillRoot;
  approved: SkillRoot;
}

export interface RunEvalOptions {
  tasks: readonly LoadedEvalTask[];
  skill: EvalSkillRoots;
  // results.jsonl、report.md 与实验治理根 .pigeon/ 的落点
  outDir: string;
  runs: number;
  streamFn: StreamFn;
  yolo: boolean;
  thinking?: ThinkingLevel;
  provider?: string;
  modelId?: string;
  homeDir?: string;
  conditions?: readonly EvalCondition[];
  // 决策 061：编辑模式（单值，缺省 hashline）；运行键为（任务、条件、编辑模式、第几次）
  editMode?: EditMode;
  // harness 版本：缺省取本源码所在仓库的 HEAD 短号与是否有未提交改动（测试注入）
  harnessRef?: HarnessRef;
  // 每次运行写完结果行后回调（进度输出）
  onResult?: (line: EvalResultLine) => void;
}

// 本源码所在仓库（Pigeon）的版本；读不到时如实记 unknown
function currentHarnessRef(): HarnessRef {
  try {
    return describeHead(fileURLToPath(new URL(".", import.meta.url)));
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

export interface RunEvalSummary {
  // results.jsonl 的全部行（含此前运行留下的）
  lines: EvalResultLine[];
  ran: number;
  skipped: number;
  resultsFile: string;
  reportFile: string;
}

// 条件 → skillRoots（059 修订：直接指向入库的 eval/skills/<name>/{candidate,approved}/）
export function skillRootsFor(
  condition: EvalCondition,
  skill: EvalSkillRoots
): readonly SkillRoot[] {
  switch (condition) {
    case "none":
      return [];
    case "candidate":
      return [skill.candidate];
    case "approved":
      return [skill.approved];
  }
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalSummary> {
  mkdirSync(options.outDir, { recursive: true });
  // 工具路径围栏以 realpath 为准：工作树开在输出目录下
  const outDir = realpathSync.native(path.resolve(options.outDir));
  const resultsFile = path.join(outDir, "results.jsonl");
  const reportFile = path.join(outDir, "report.md");
  const done = new Set(readResultLines(resultsFile).map(lineKey));
  // 续跑前清理上次进程死于中途留下的工作树与分支（同名 worker 会撞分支）
  for (const repoRoot of new Set(options.tasks.map((task) => task.repoRoot))) {
    releaseStaleWorkspaces({ governanceRoot: outDir, repoRoot });
  }
  const conditions = options.conditions ?? EVAL_CONDITIONS;
  const editMode = options.editMode ?? DEFAULT_EDIT_MODE;
  const harnessRef = options.harnessRef ?? currentHarnessRef();
  let ran = 0;
  let skipped = 0;
  for (let attempt = 1; attempt <= options.runs; attempt += 1) {
    for (const task of options.tasks) {
      for (const condition of conditions) {
        if (done.has(lineKey({ taskId: task.spec.id, condition, editMode, attempt }))) {
          skipped += 1;
          continue;
        }
        const line = await runOnce(
          options,
          { outDir, editMode, harnessRef },
          task,
          condition,
          attempt
        );
        appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
        ran += 1;
        options.onResult?.(line);
      }
    }
  }
  const lines = readResultLines(resultsFile);
  writeFileSync(reportFile, renderEvalReport(lines));
  return { lines, ran, skipped, resultsFile, reportFile };
}

function lineKey(
  line: Pick<EvalResultLine, "taskId" | "condition" | "editMode" | "attempt">
): string {
  return `${line.taskId}\n${line.condition}\n${line.editMode ?? LEGACY_RESULT_EDIT_MODE}\n${line.attempt}`;
}

interface RunContext {
  outDir: string;
  editMode: EditMode;
  harnessRef: HarnessRef;
}

function failureClassLabel(failure: FailureClass | null): string | null {
  if (failure === null) {
    return null;
  }
  return failure.category === "cancelled" && failure.breaker
    ? "cancelled:breaker"
    : failure.category;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOnce(
  options: RunEvalOptions,
  context: RunContext,
  task: LoadedEvalTask,
  condition: EvalCondition,
  attempt: number
): Promise<EvalResultLine> {
  const { outDir, editMode, harnessRef } = context;
  const sessionId = newSessionId();
  const base: ErrorLineBase = {
    taskId: task.spec.id,
    condition,
    editMode,
    attempt,
    holdout: task.spec.holdout,
    sessionId,
    harnessRef,
  };
  let prepared: ReturnType<typeof prepareTaskWorkspace>;
  try {
    prepared = prepareTaskWorkspace({
      task,
      governanceRoot: outDir,
      sessionId,
      condition,
      attempt,
    });
  } catch (error) {
    return errorLine(base, `准备快照失败：${message(error)}`);
  }
  let line: EvalResultLine;
  try {
    const workspaceRoot = prepared.workspace.path;
    const run = await runHeadless({
      task: task.instructions,
      governanceRoot: outDir,
      workspaceRoot,
      streamFn: options.streamFn,
      yolo: options.yolo,
      sessionId,
      maxTurns: task.spec.budget.maxTurns,
      wallClockMs: task.spec.budget.wallClockMs,
      ...(task.spec.budget.maxTokens !== undefined
        ? { maxTokens: task.spec.budget.maxTokens }
        : {}),
      skillRoots: skillRootsFor(condition, options.skill),
      memoryRoots: [],
      editMode,
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
    const verified = await verifyTaskRun({
      task,
      workspaceRoot,
      governanceRoot: outDir,
      sessionId,
      ...(run.runId !== undefined ? { runId: run.runId } : {}),
    });
    const errors = [
      run.errorMessage,
      verified.error,
      verified.recordError !== undefined
        ? `eval.verified 未落盘：${verified.recordError}`
        : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    // 过程指标：与复算既有运行同一个汇总函数；账本读不出时如实记空并写进 error
    let process: ProcessMetrics;
    try {
      process = summarizeProcess({
        sessionsDir: path.join(outDir, ".pigeon", "sessions"),
        sessionId,
        editMode,
        ...(run.runId !== undefined ? { runId: asRunId(run.runId) } : {}),
      });
    } catch (error) {
      process = emptyProcessMetrics(editMode);
      errors.push(`过程指标汇总失败：${message(error)}`);
    }
    line = {
      ...base,
      process,
      runId: run.runId ?? null,
      status: run.status,
      verdict: verified.verdict,
      falsePositive: verified.falsePositive,
      turns: run.turns,
      toolCalls: run.toolCalls,
      approvalsNeeded: run.approvalsNeeded,
      usage: run.usage,
      durationMs: run.durationMs,
      failureClass: failureClassLabel(run.failure),
      ...(errors.length > 0 ? { error: errors.join("；") } : {}),
    };
  } catch (error) {
    line = errorLine(base, `运行失败：${message(error)}`);
  }
  try {
    prepared.release();
  } catch (error) {
    line = {
      ...line,
      error: [line.error, `清理工作树失败：${message(error)}`].filter(Boolean).join("；"),
    };
  }
  return line;
}

type ErrorLineBase = Pick<
  EvalResultLine,
  "taskId" | "condition" | "attempt" | "holdout" | "sessionId"
> & { editMode: EditMode; harnessRef: HarnessRef };

function errorLine(base: ErrorLineBase, error: string): EvalResultLine {
  return {
    ...base,
    process: emptyProcessMetrics(base.editMode),
    runId: null,
    status: "error",
    verdict: "undetermined",
    falsePositive: false,
    turns: 0,
    toolCalls: 0,
    approvalsNeeded: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    durationMs: 0,
    failureClass: "unknown",
    error,
  };
}
