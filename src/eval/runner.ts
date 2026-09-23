// Eval runner（M6.5 S4，决策 046 / 059 / 060 含修订；M9 决策 098 / 102）：自建薄 runner，只做四件事——向任务源要实例、
// 让任务源准备运行环境、经 headless 入口跑 Pigeon、执行任务源给出的判据命令并出 JSONL 结果。runner 不感知题目来源：
// 实例清单、环境准备、判据命令与元数据都由任务源提供（自造冒烟题与外部基准各一个实现）；工作区在宿主还是在容器里
// 由任务源交回的执行端决定，runner 只把它递给运行面。
// 每任务每条件跑 N 次（轮次按"第几次 → 任务 → 条件"交错，减少模型服务随时间漂移对条件对比的影响）；三个条件只由
// skillRoots 决定：none 为空、candidate 只含候选目录、approved 只含已批准目录，memoryRoots 三个条件一律为空。
// 每次一个新会话，治理根为输出目录（其下 .pigeon/ 不入库、不进日常会话列表）。可并行：同时最多 concurrency 个运行。
// 每次运行结束立即追加一行 results.jsonl；重跑同一输出目录时已有非错误行的（任务、条件、编辑模式、第几次）跳过，
// 错误行（环境准备、模型服务或判据设施出错，不是任务的成败）不占键、自动补跑；全部结束后重写 report.md。
// 各路共用一个工作队列：哪一路空了就取下一题，不按批等待。可选的断供处理：按完成顺序连续若干次模型服务故障时，
// 全体暂停一段再取题；暂停次数用满仍连续故障就停止取新题（已完成的行保留，摘要写明原因），留给之后续跑。
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadless } from "../application/headless.ts";
import type { StructuredMemoryOptions } from "../application/structured-memory.ts";
import { describeHead } from "../orchestration/worktree.ts";
import { isContextOverflowError, type StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { FailureClass } from "../state/classification.ts";
import { asRunId, newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { DEFAULT_EDIT_MODE, type EditMode } from "../tools/edit-mode.ts";
import { emptyProcessMetrics, type ProcessMetrics, summarizeProcess } from "./process.ts";
import { renderEvalReport } from "./report.ts";
import {
  completedResultKeys,
  DETERMINISTIC_ERROR_LABELS,
  type DeterministicError,
  type EvalResultLine,
  effectiveResultLines,
  type HarnessRef,
  parseTestProgress,
  readResultLines,
  resultLineKey,
} from "./results.ts";
import { EVAL_CONDITIONS, type EvalCondition } from "./task.ts";
import type { EvalInstance, PreparedInstance, TaskSource } from "./task-source.ts";
import { verifyTaskRun } from "./verify.ts";

export { EVAL_RESULT_FIELDS, type EvalResultLine } from "./results.ts";

export interface EvalSkillRoots {
  candidate: SkillRoot;
  approved: SkillRoot;
}

export interface RunEvalOptions {
  // 决策 102：题从哪来由任务源决定
  source: TaskSource;
  // candidate / approved 条件所需的 Skill 根；只跑 none 条件时可缺省
  skill?: EvalSkillRoots;
  // results.jsonl、report.md 与实验治理根 .pigeon/ 的落点
  outDir: string;
  runs: number;
  streamFn: StreamFn;
  yolo: boolean;
  thinking?: ThinkingLevel;
  // 决策 063：单轮输出上限（缺省 16,384）
  maxOutputTokens?: number;
  // M9：采样温度（缺省不设）；评测固定采样时由调用方给出，冻结进每次运行的注入快照
  temperature?: number;
  // 决策 142 / 143：回炉——每次运行的验证命令与回炉轮数（缺省不给即关闭）。验证命令是这一步里的验证门，
  // 与任务源的判据不是一回事：回炉结束（含撤回）后判据照常判分。只支持本地 git 工作区（容器任务源启动即报错）
  verify?: VerifyConfig;
  repairRounds?: number;
  // 决策 134 / 157：结构化记忆（开关与固定挑选）——给了才接入。缺省不接入：本跑批的治理根是整批共用的输出目录，
  // 缺省接入会让后面的题拿到前面题的记忆、改变既有评测的条件
  structuredMemory?: StructuredMemoryOptions;
  provider?: string;
  modelId?: string;
  homeDir?: string;
  conditions?: readonly EvalCondition[];
  // 决策 061：编辑模式（单值，缺省 hashline）；运行键为（任务、条件、编辑模式、第几次）
  editMode?: EditMode;
  // 同时进行的运行数上限（缺省 1）；同一输出目录仍只支持一个 runner 进程
  concurrency?: number;
  // harness 版本：缺省取本源码所在仓库的 HEAD 短号与是否有未提交改动（测试注入）
  harnessRef?: HarnessRef;
  // 每次运行写完结果行后回调（进度输出）
  onResult?: (line: EvalResultLine) => void;
  // 断供处理；缺省不处理（跑完全部题，故障记错误行）
  outage?: OutageOptions;
}

// 外部基准跑批的缺省断供口径：连续 8 次模型服务故障暂停 10 分钟，最多 3 次（约半小时）仍如此就停止
export const DEFAULT_OUTAGE: Readonly<
  Pick<OutageOptions, "consecutiveFailures" | "pauseMs" | "maxPauses">
> = {
  consecutiveFailures: 8,
  pauseMs: 10 * 60_000,
  maxPauses: 3,
};

export interface OutageOptions {
  // 按完成顺序连续这么多次模型服务故障（中间没有别的结果）即判为断供
  consecutiveFailures: number;
  // 每次断供暂停多久再取题
  pauseMs: number;
  // 暂停次数上限：用满之后再判为断供就停止取新题；任何一次非故障结果把计数清零
  maxPauses: number;
  // 测试注入
  sleep?: (ms: number) => Promise<void>;
  // 告警（缺省写标准错误输出）
  warn?: (text: string) => void;
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
  // results.jsonl 的全部行（含此前运行留下的、含错误行）
  lines: EvalResultLine[];
  ran: number;
  skipped: number;
  resultsFile: string;
  reportFile: string;
  // 因断供停止取新题时的原因；跑完全部题时缺省
  stopped?: string;
}

// 条件 → skillRoots（059 修订：直接指向入库的 eval/skills/<name>/{candidate,approved}/）
export function skillRootsFor(
  condition: EvalCondition,
  skill: EvalSkillRoots | undefined
): readonly SkillRoot[] {
  if (condition === "none") {
    return [];
  }
  if (skill === undefined) {
    throw new Error(`条件 ${condition} 需要 Skill 根，但没有提供`);
  }
  return condition === "candidate" ? [skill.candidate] : [skill.approved];
}

// 内容审核类拒答：provider 以错误收尾，但原因是内容审核而非服务故障——重跑大概率重复，故不按错误行补跑
const CONTENT_REFUSAL_PATTERN =
  /refused to complete|stopped with: sensitive|content[_ -]?(filter|policy|moderation)|high risk|内容审核|敏感内容|违规/i;

export function isContentRefusal(errorMessage: string | undefined): boolean {
  return errorMessage !== undefined && CONTENT_REFUSAL_PATTERN.test(errorMessage);
}

// 确定性错误：同样的请求重发必然再错，补跑只会原样复现，故不按错误行处理。判据是"错误由请求内容本身决定、
// 与服务端当时的状态无关"；目前只认上下文超长（识别用上游按各 provider 报错文案的判定，限额类先排除）。
// 认证失败、泛化的 400、模型不存在等虽然也会复现，但原因在配置而不在这道题，是否同样处理留待裁决，暂按服务故障
export function deterministicErrorOf(
  errorMessage: string | undefined
): DeterministicError | undefined {
  if (errorMessage === undefined) {
    return undefined;
  }
  return isContextOverflowError(errorMessage) ? "context-overflow" : undefined;
}

const LIMIT_STATUSES = ["turn-limit", "wall-clock-limit", "token-limit"] as const;

// 错误行里模型服务故障的前缀（断供判定据此计数）
const PROVIDER_FAILURE_PREFIX = "基础设施错误（模型服务故障";

function isProviderFailureLine(line: EvalResultLine): boolean {
  return line.status === "error" && (line.error ?? "").startsWith(PROVIDER_FAILURE_PREFIX);
}

interface Job {
  instance: EvalInstance;
  condition: EvalCondition;
  attempt: number;
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalSummary> {
  mkdirSync(options.outDir, { recursive: true });
  // 工具路径围栏以 realpath 为准：工作树开在输出目录下
  const outDir = realpathSync.native(path.resolve(options.outDir));
  const resultsFile = path.join(outDir, "results.jsonl");
  const reportFile = path.join(outDir, "report.md");
  // 只有非错误行占键：抽风留下的错误行在重跑时自动补跑
  const done = completedResultKeys(readResultLines(resultsFile));
  await options.source.cleanupStale?.(outDir);
  const conditions = options.conditions ?? EVAL_CONDITIONS;
  const editMode = options.editMode ?? DEFAULT_EDIT_MODE;
  const harnessRef = options.harnessRef ?? currentHarnessRef();
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`并行数需要正整数：${concurrency}`);
  }
  const instances = options.source.instances();
  const jobs: Job[] = [];
  let skipped = 0;
  for (let attempt = 1; attempt <= options.runs; attempt += 1) {
    for (const instance of instances) {
      for (const condition of conditions) {
        if (done.has(resultLineKey({ taskId: instance.id, condition, editMode, attempt }))) {
          skipped += 1;
        } else {
          jobs.push({ instance, condition, attempt });
        }
      }
    }
  }
  let ran = 0;
  let next = 0;
  // 断供状态：连续故障计数、已暂停次数、进行中的暂停、停止原因
  const outage = options.outage;
  const sleep =
    outage?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = outage?.warn ?? ((line: string) => process.stderr.write(`[eval] ${line}\n`));
  let streak = 0;
  let pauses = 0;
  let pause: Promise<void> | undefined;
  let stopped: string | undefined;
  const noteOutage = (line: EvalResultLine): void => {
    if (outage === undefined) {
      return;
    }
    if (!isProviderFailureLine(line)) {
      streak = 0;
      pauses = 0;
      return;
    }
    streak += 1;
    if (streak < outage.consecutiveFailures || pause !== undefined || stopped !== undefined) {
      return;
    }
    if (pauses >= outage.maxPauses) {
      stopped = `模型服务持续不可用：连续 ${streak} 次模型服务故障，已暂停 ${pauses} 次仍未恢复`;
      warn(`${stopped}，停止取新题（已完成的行保留，之后在同一输出目录续跑）`);
      return;
    }
    pauses += 1;
    streak = 0;
    warn(
      `连续 ${outage.consecutiveFailures} 次模型服务故障，全体暂停 ${Math.round(outage.pauseMs / 60_000)} 分钟再取题` +
        `（第 ${pauses} 次，上限 ${outage.maxPauses} 次）`
    );
    pause = sleep(outage.pauseMs).finally(() => {
      pause = undefined;
    });
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      while (pause !== undefined) {
        await pause;
      }
      if (stopped !== undefined) {
        return;
      }
      const job = jobs[next];
      next += 1;
      if (job === undefined) {
        return;
      }
      const line = await runOnce(options, { outDir, editMode, harnessRef }, job);
      // 每次运行结束立即落盘：进程中途死掉，已完成的行不丢
      appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
      ran += 1;
      noteOutage(line);
      options.onResult?.(line);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  const lines = readResultLines(resultsFile);
  // 报告按读侧口径：同键取最后一条非错误行
  writeFileSync(
    reportFile,
    renderEvalReport(effectiveResultLines(lines), { source: options.source.name })
  );
  return {
    lines,
    ran,
    skipped,
    resultsFile,
    reportFile,
    ...(stopped !== undefined ? { stopped } : {}),
  };
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
  job: Job
): Promise<EvalResultLine> {
  const { outDir, editMode, harnessRef } = context;
  const { instance, condition, attempt } = job;
  const startedAt = Date.now();
  const sessionId = newSessionId();
  const base: ErrorLineBase = {
    taskId: instance.id,
    condition,
    editMode,
    attempt,
    holdout: instance.holdout,
    sessionId,
    harnessRef,
    ...(instance.difficulty !== undefined ? { difficulty: instance.difficulty } : {}),
  };
  let prepared: PreparedInstance;
  try {
    prepared = await options.source.prepare(instance, {
      governanceRoot: outDir,
      sessionId,
      condition,
      attempt,
    });
  } catch (error) {
    return {
      ...errorLine(base, `准备环境失败：${message(error)}`),
      wallMs: Date.now() - startedAt,
    };
  }
  let line: EvalResultLine;
  try {
    const run = await runHeadless({
      task: instance.instructions,
      governanceRoot: outDir,
      workspaceRoot: prepared.workspaceRoot,
      ...(prepared.host !== undefined ? { workspaceHost: prepared.host } : {}),
      streamFn: options.streamFn,
      yolo: options.yolo,
      sessionId,
      maxTurns: instance.budget.maxTurns,
      wallClockMs: instance.budget.wallClockMs,
      ...(instance.budget.maxTokens !== undefined ? { maxTokens: instance.budget.maxTokens } : {}),
      skillRoots: skillRootsFor(condition, options.skill),
      memoryRoots: [],
      editMode,
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(instance.systemDirective !== undefined
        ? { taskDirective: instance.systemDirective }
        : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.verify !== undefined ? { verify: options.verify } : {}),
      ...(options.repairRounds !== undefined && options.repairRounds > 0
        ? { repairRounds: options.repairRounds }
        : {}),
      ...(options.structuredMemory !== undefined
        ? { structuredMemory: options.structuredMemory }
        : {}),
    });
    // 模型服务故障的运行不判分：没有可用结果，重跑时整次补跑。两条路都算——请求层抛错（上游合成失败消息，
    // 失败分类为基础设施）与流内以错误收尾（连接中断、服务端报错：终态 failed，失败分类落在未知）
    // 内容审核类拒答先于服务故障判定：独立状态，不判分、不补跑、不计入成败统计
    const refused = run.status === "failed" && isContentRefusal(run.errorMessage);
    // 确定性错误（如上下文超长）：重跑必复现，照常判分——改到哪判到哪，与撞上限同理
    const deterministic =
      run.status === "failed" && !refused ? deterministicErrorOf(run.errorMessage) : undefined;
    const providerFailed =
      !refused &&
      deterministic === undefined &&
      (run.failure?.category === "infrastructure" || run.status === "failed");
    // 回炉撤回而工作区没恢复成：工作区既不是这一步起点、也不是 agent 的最后结果，判分没有意义——
    // 不判分，记错误行（不占续跑键，重跑时补跑）
    const restoreFailed = !refused && !providerFailed && run.repair?.restoreError !== undefined;
    const verified =
      providerFailed || refused || restoreFailed
        ? undefined
        : await verifyTaskRun({
            taskId: instance.id,
            judge: () => prepared.judge(),
            commandHint: prepared.judgeCommandHint,
            governanceRoot: outDir,
            sessionId,
            ...(run.runId !== undefined ? { runId: run.runId } : {}),
          });
    const errors = [
      run.errorMessage,
      verified?.error,
      verified?.recordError !== undefined
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
    // 错误行口径（决策 101 ①：未完成不计为模型失败）：模型服务故障（失败分类为基础设施）或判据设施自身出错
    // （备料失败、拉不起来、约定的出错退出码）或回炉撤回时工作区没恢复成时，这次运行没有产出可用结果——
    // 记 error，不占续跑键，重跑时补跑。
    // 验证器超时不在此列：可能正是任务改坏了代码，属于这次运行的真实结果
    const testProgress = parseTestProgress(verified?.details);
    const limitStatus = LIMIT_STATUSES.find((status) => status === run.status);
    const infrastructure = providerFailed
      ? "模型服务故障"
      : verified?.error !== undefined
        ? "判据设施出错"
        : restoreFailed
          ? "回炉撤回时工作区未恢复"
          : undefined;
    line = {
      ...base,
      process,
      runId: run.runId ?? null,
      status: infrastructure !== undefined ? "error" : refused ? "refused" : run.status,
      verdict:
        infrastructure !== undefined || verified === undefined ? "undetermined" : verified.verdict,
      falsePositive:
        infrastructure !== undefined || verified === undefined ? false : verified.falsePositive,
      turns: run.turns,
      toolCalls: run.toolCalls,
      approvalsNeeded: run.approvalsNeeded,
      usage: run.usage,
      durationMs: run.durationMs,
      failureClass: failureClassLabel(run.failure),
      // 判据命令尾行 JSON 的约定字段（见 task-source.ts）：连续指标与空补丁
      ...(infrastructure === undefined && testProgress !== undefined ? { testProgress } : {}),
      ...(infrastructure === undefined &&
      verified?.verdict === "fail" &&
      (verified.details as { emptyPatch?: unknown } | undefined)?.emptyPatch === true
        ? { emptyPatch: true as const }
        : {}),
      ...(infrastructure === undefined && limitStatus !== undefined
        ? { limitHit: limitStatus }
        : {}),
      ...(infrastructure === undefined && deterministic !== undefined
        ? { deterministicError: deterministic }
        : {}),
      // 决策 142 / 143：回炉开启时在场——用了几轮、最终验证结论、是否撤回（及是否因预算耗尽提前撤回）
      ...(run.repair !== undefined ? { repair: { ...run.repair } } : {}),
      // 决策 134：接入结构化记忆时在场——开局给了哪几条、每轮回炉给了哪几条
      ...(run.structuredMemory !== undefined
        ? {
            structuredMemory: {
              enabled: run.structuredMemory.enabled,
              opening: [...run.structuredMemory.opening],
              openingBlocked: [...run.structuredMemory.openingBlocked],
              repair: run.structuredMemory.repair.map((round) => [...round]),
              repairBlocked: run.structuredMemory.repairBlocked.map((round) => [...round]),
            },
          }
        : {}),
      ...(refused
        ? { error: [`内容审核拒答（不补跑、不计入成败统计）`, ...errors].join("；") }
        : infrastructure !== undefined
          ? {
              error: [`基础设施错误（${infrastructure}，终态 ${run.status}）`, ...errors].join(
                "；"
              ),
            }
          : deterministic !== undefined
            ? {
                error: [
                  `确定性错误（${DETERMINISTIC_ERROR_LABELS[deterministic]}，重跑必复现；照常判分、不补跑）`,
                  ...errors,
                ].join("；"),
              }
            : errors.length > 0
              ? { error: errors.join("；") }
              : {}),
    };
  } catch (error) {
    line = errorLine(base, `运行失败：${message(error)}`);
  }
  try {
    await prepared.release();
  } catch (error) {
    line = {
      ...line,
      error: [line.error, `清理运行环境失败：${message(error)}`].filter(Boolean).join("；"),
    };
  }
  return { ...line, wallMs: Date.now() - startedAt };
}

type ErrorLineBase = Pick<
  EvalResultLine,
  "taskId" | "condition" | "attempt" | "holdout" | "sessionId" | "difficulty"
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
