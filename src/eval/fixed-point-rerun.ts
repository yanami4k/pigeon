// 定点对照的单步重跑（决策 139、156、157、158）：每个事件、每组各若干遍（缺省 5），每遍从该步起点恢复该流的断网容器工作区
// （上一步落地的提交加该步的人写测试，与流中该步开工时一致），治理根里放第 1 到 k−1 步的会话副本，按完整条件跑完整的一步：
// agent、分步验证门、回炉（3 轮），预算与原尝试相同；模型请求经本地网关、计量与限额处理与流中一致。
// 三组的差别只在结构化记忆的固定挑选（157），推送路径与正式使用同一条。
// 一致性核对（156）：从原尝试的 run.started 解出预算、模型、推理档位、工具名单与工作方式指令，重跑照搬（预算与流中相同，
// 不接受调用方另给）；每遍跑完再按重跑自己的 run.started 核对一次，任何一项不同即拒绝、不写结果行。
// 各遍互不可见：每遍一个独立的治理根副本；被打断的一遍整遍作废（会话移出、从起点重来），与流中的作废规则相同。
// 结果写结果行（158：不新增账本记录），按"事件 × 组 × 遍次"断点续跑。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { hostWorkspaceAccess, taskReferencedFiles } from "../memory/structured-workspace.ts";
import {
  materializeSession,
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import {
  AttemptFidelityError,
  assertThinkingLevelReproducible,
  intersectAttemptTools,
  type ReproducedRuntime,
  reproducedRuntime,
  samplingOf,
} from "../replay/fidelity.ts";
import { type AttemptPlan, resolveAttemptPlan } from "../replay/plan.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { type ContentBlock, sha256Hex } from "../state/message-content.ts";
import { repairRoundsOf, repairStepOutcome } from "../state/repair-step.ts";
import {
  type FileChangeEvent,
  ledgerFileChanges,
  reportedPathOf,
} from "../state/structured-memory.ts";
import { describeFingerprint, parseStepOutput } from "../state/verify-fingerprint.ts";
import { recordStepsOf, type VerifyStepResult } from "../state/verify-steps.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  FIXED_POINT_GROUPS,
  type FixedPointEvent,
  type FixedPointEventList,
  type FixedPointGroup,
  type FixedSelection,
  openNoMemoryJob,
  prepareStepStart,
  resultsDigestOf,
  seedGovernanceRoot,
  sessionIdsOf,
  sliceHistory,
} from "./fixed-point-events.ts";
import { renderFixedPointReport } from "./fixed-point-report.ts";
import {
  appendFixedPointRow,
  type FirstVerify,
  type FixedPointRow,
  fixedPointKey,
  type OffTaskVerdict,
  type RepairVerify,
  readFixedPointRows,
} from "./fixed-point-results.ts";
import type { LimitController } from "./model-limits.ts";
import type { HarnessRef } from "./results.ts";
import { STREAM_WORK_DIRECTIVE } from "./stream-agents.ts";
import type { HumanRepo } from "./stream-facts.ts";
import { identityDigest, identityFile, type StreamRunIdentity } from "./stream-identity.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import {
  allPassed,
  gateFromSteps,
  type StreamRepoRuntime,
  verifyScript,
} from "./stream-profiles.ts";
import { type StreamGatewayFacts, type StreamJobId, ZERO_USAGE } from "./stream-results.ts";
import {
  CONDITION_SPECS,
  humanTestsAt,
  lockOutDir,
  MAX_BARE_INTERRUPTIONS,
  QUEUE_VOID_STOP,
  QUEUE_VOID_WARN,
  restoreTests,
  runAdmittedAgent,
  SIGNALLED_VOID_STOP,
  SIGNALLED_VOID_WARN,
  type StepAgent,
  type StepBudget,
  StepInterruptedError,
  type StreamEnvFactory,
  type StreamModelGateway,
  syncEnv,
} from "./stream-runner.ts";
import { StreamWorkspaceAccessError } from "./stream-workspace.ts";
import { runWorkQueue } from "./work-queue.ts";

// 每组缺省几遍（139）
export const DEFAULT_FIXED_POINT_PASSES = 5;
// 缺省几路并行（strands 的整流跑完后可开到 6）
export const DEFAULT_FIXED_POINT_CONCURRENCY = 2;

// 重跑与原尝试不一致（预算、工具、模型、推理档位、温度、输出上限、工作方式指令、题面）：拒绝，不写结果行
export class FidelityRejectedError extends Error {
  override name = "FidelityRejectedError";
}

// ---------- 一致性核对 ----------

// 重跑实际用的预算：与原尝试完全相同（预算与流中相同）；原尝试的预算不是跑批器的形态即拒绝
export function rerunBudget(original: AttemptPlan): StepBudget {
  const { maxTurns, wallClockMs, maxTokens } = original.budget;
  if (maxTurns === undefined || wallClockMs === undefined || maxTokens !== undefined) {
    throw new AttemptFidelityError(
      "原尝试的预算不是跑批器的形态（轮数与墙钟上限、不设 token 上限）：重跑无法照搬，故拒绝"
    );
  }
  return { maxTurns, wallClockMs };
}

// 重跑的运行面照搬原尝试（推理档位认不出即拒绝）；工作方式指令须与跑批器的一致
export function rerunRuntime(original: AttemptPlan): ReproducedRuntime {
  const runtime = reproducedRuntime(samplingOf(original));
  if ((runtime.taskDirective ?? null) !== STREAM_WORK_DIRECTIVE) {
    throw new AttemptFidelityError("原尝试的工作方式指令与跑批器的不同：重跑无法照搬，故拒绝");
  }
  return runtime;
}

// 跑完后按重跑自己的 run.started 核对：预算与原尝试相同，工具不多于原尝试，模型、推理档位、温度、输出上限、
// 工作方式指令与放权方式逐项相同（题面另按内容块语义核对，见 assertSessionTask：计划里的题面取自账本存储，长题面是截断的）
export function assertRerunFidelity(original: AttemptPlan, rerun: AttemptPlan): void {
  const problems: string[] = [];
  const ob = original.budget;
  const rb = rerun.budget;
  if (
    ob.maxTurns !== rb.maxTurns ||
    ob.wallClockMs !== rb.wallClockMs ||
    ob.maxTokens !== rb.maxTokens
  ) {
    problems.push(
      `预算与原尝试不同：轮数 ${rb.maxTurns}、墙钟 ${rb.wallClockMs}、token ${rb.maxTokens}，` +
        `原尝试 ${ob.maxTurns}、${ob.wallClockMs}、${ob.maxTokens}`
    );
  }
  const extra = rerun.tools.filter(
    (t) => !intersectAttemptTools(rerun.tools, original.tools).includes(t)
  );
  if (extra.length > 0) problems.push(`多出原尝试没有的工具：${extra.join("、")}`);
  const o = original.model;
  const r = rerun.model;
  if (o.provider !== r.provider || o.id !== r.id) {
    problems.push(`模型不同：${r.provider}/${r.id}，原尝试 ${o.provider}/${o.id}`);
  }
  try {
    if (assertThinkingLevelReproducible(r) !== assertThinkingLevelReproducible(o)) {
      problems.push(`推理档位不同：${r.thinkingLevel}，原尝试 ${o.thinkingLevel}`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (o.temperature !== r.temperature)
    problems.push(`采样温度不同：${r.temperature}，原尝试 ${o.temperature}`);
  if (o.maxOutputTokens !== r.maxOutputTokens) {
    problems.push(`单轮输出上限不同：${r.maxOutputTokens}，原尝试 ${o.maxOutputTokens}`);
  }
  if (original.taskDirective !== rerun.taskDirective) problems.push("工作方式指令不同");
  if (original.approvalMode !== rerun.approvalMode) {
    problems.push(`放权方式不同：${rerun.approvalMode}，原尝试 ${original.approvalMode}`);
  }
  if (problems.length > 0) {
    throw new FidelityRejectedError(`重跑与原尝试不一致，拒绝：${problems.join("；")}`);
  }
}

// 题面核对（按内容块语义）：账本存消息正文时按单块 64 KiB 截断存储（块上标 truncated，并带未截断全文的 sha256 fullHash），
// agent 当时拿到的是全文。首条用户消息的文本块有截断的，就以题面（跑批器交给 agent 的原字符串，不去首尾空白）的 sha256
// 与该块的 fullHash 比较；都未截断的，文本块相接后与题面逐字比较（两边都去首尾空白，同回放计划的取法）。截断的存储文本
// 不参与逐字比较
export function taskBlocksMatch(
  blocks: readonly ContentBlock[],
  expected: string
): { ok: true } | { ok: false; reason: string } {
  const texts = blocks.filter(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text"
  );
  if (texts.length === 0) return { ok: false, reason: "首条用户消息里没有文本" };
  if (texts.some((b) => b.truncated)) {
    const [only] = texts;
    if (texts.length !== 1 || only === undefined) {
      return { ok: false, reason: "题面分成多块且有截断，无从核对全文" };
    }
    return only.fullHash === sha256Hex(expected)
      ? { ok: true }
      : { ok: false, reason: "题面全文的哈希不同（存储截断）" };
  }
  return texts
    .map((b) => b.text)
    .join("\n")
    .trim() === expected.trim()
    ? { ok: true }
    : { ok: false, reason: "题面不同" };
}

// 某个会话里某个 Run 的首条用户消息须与题面相同（taskBlocksMatch），不同即以给定的错误拒绝
export function assertSessionTask(
  sessionsDir: string,
  sessionId: SessionId,
  runId: RunId,
  expected: string,
  what: string,
  ErrorType: new (message: string) => Error
): void {
  const first = readMessageContentFileDetailed(sessionContentFilePath(sessionsDir, sessionId))
    .records.filter((r) => r.runId === runId && r.role === "user")
    .sort((a, b) => a.runSeq - b.runSeq)[0];
  const verdict =
    first === undefined
      ? { ok: false as const, reason: "账本里没有首条用户消息" }
      : taskBlocksMatch(first.blocks, expected);
  if (!verdict.ok) {
    throw new ErrorType(`${what}的题面与清单不同，拒绝重跑：${verdict.reason}`);
  }
}

// 验证分步（run.started 冻结的 verify.steps：名字、命令与执行目录）须与原尝试相同，不同即拒绝
export function assertSameVerifySteps(
  what: string,
  expected: readonly { name: string; command: string; cwd?: string }[] | undefined,
  actual: readonly { name: string; command: string; cwd?: string }[] | undefined
): void {
  const shape = (steps: typeof expected) =>
    JSON.stringify((steps ?? []).map((s) => [s.name, s.command, s.cwd ?? null]));
  if (expected === undefined || actual === undefined || shape(expected) !== shape(actual)) {
    throw new FidelityRejectedError(
      `重跑与原尝试不一致，拒绝：${what}的验证分步不同（${shape(actual)}，原尝试 ${shape(expected)}）`
    );
  }
}

// 镜像：无记忆整流输出目录的身份头里记下的镜像 ID 须与这次重跑所用的相同；身份头须与结果行记下的摘要对得上
export function assertSameImage(
  noMemoryDir: string,
  rows: readonly { runIdentity: string | null }[],
  imageId: string
): void {
  const file = identityFile(noMemoryDir);
  if (!existsSync(file)) {
    throw new FidelityRejectedError(
      "无记忆整流的输出目录里没有身份头（identity.json）：无从核对镜像，拒绝"
    );
  }
  const identity = JSON.parse(readFileSync(file, "utf8")) as StreamRunIdentity;
  const digest = identityDigest(identity.core);
  if (rows.some((r) => r.runIdentity !== digest)) {
    throw new FidelityRejectedError(
      "无记忆整流的结果行记下的身份摘要与身份头对不上：无从核对镜像，拒绝"
    );
  }
  if (identity.core.image !== imageId) {
    throw new FidelityRejectedError(
      `重跑与原尝试不一致，拒绝：镜像 ${imageId}，无记忆整流所用 ${identity.core.image}`
    );
  }
}

// 回炉上限（run.started 冻结的值）须与原尝试相同，不同即拒绝
export function assertSameRepairRounds(original: number, rerun: number): void {
  if (original !== rerun) {
    throw new FidelityRejectedError(
      `重跑与原尝试不一致，拒绝：回炉上限 ${rerun}，原尝试 ${original}`
    );
  }
}

// ---------- 首轮验证 ----------

// 某次验证是否在题面以外的检查上变红（131 口径）：taskTestFiles 为题面测试文件（本步改动的文件、开工时已在工作区的
// 文件、题面直接指到的文件三者的并集）；认定不全时为 undefined，测试步一律判不清
export function offTaskRedOf(input: {
  steps: readonly VerifyStepResult[];
  commands: ReadonlyMap<string, string>;
  workspace: string;
  taskTestFiles: ReadonlySet<string> | undefined;
}): OffTaskVerdict {
  const failures: string[] = [];
  const undetermined: string[] = [];
  for (const step of input.steps) {
    if (step.verdict === "pass") continue;
    if (step.verdict !== "fail") {
      undetermined.push(step.name);
      continue;
    }
    const command = input.commands.get(step.name);
    const parsed = parseStepOutput({
      name: step.name,
      ...(command !== undefined ? { command } : {}),
      output: step.output,
    });
    if (parsed.kind !== "test") {
      // 格式、类型、分层、代码检查失败一律算；类型未知且输出无法解析的判不清
      if (!parsed.recognized && parsed.kind === "unknown") {
        undetermined.push(step.name);
        continue;
      }
      failures.push(`${step.name}：${parsed.fingerprints.map(describeFingerprint).join("、")}`);
      continue;
    }
    if (!parsed.recognized || input.taskTestFiles === undefined) {
      undetermined.push(step.name);
      continue;
    }
    const offTask = parsed.fingerprints.filter((f) => {
      if (f.file === undefined) return true;
      const file = reportedPathOf(f.file, input.workspace, step.cwd);
      return !input.taskTestFiles?.has(file);
    });
    if (offTask.length > 0) {
      failures.push(`${step.name}：${offTask.map(describeFingerprint).join("、")}`);
    } else if (step.truncated || parsed.incomplete) {
      // 列出来的都属题面，但清单不全：看不到的部分可能有题面以外的失败
      undetermined.push(step.name);
    }
  }
  return {
    offTaskRed: failures.length > 0 ? true : undetermined.length > 0 ? null : false,
    offTaskFailures: failures,
    undetermined,
  };
}

// 某次验证的题面测试文件（131 修订①，只用这次验证之前的事实）：本步到这次验证为止改动的文件（验证前会被还原的
// 人写受保护测试不算）、开工时已在工作区的文件、题面直接指到的文件三者的并集
export function taskTestFilesAt(input: {
  changes: readonly FileChangeEvent[];
  at: number;
  protectedFiles: ReadonlySet<string>;
  dirtyAtStart: readonly string[];
  mentioned: readonly string[];
}): Set<string> {
  return new Set([
    ...input.changes
      .filter((e) => e.at <= input.at)
      .flatMap((e) => e.files)
      .filter((f) => !input.protectedFiles.has(f)),
    ...input.dirtyAtStart,
    ...input.mentioned,
  ]);
}

// ---------- 重跑 ----------

export interface FixedPointOptions {
  events: FixedPointEventList;
  manifest: StreamManifest;
  runtime: StreamRepoRuntime;
  human: HumanRepo;
  noMemoryDir: string;
  envs: StreamEnvFactory;
  hostFor(target: { container: string; root: string }): WorkspaceHost;
  // 按原尝试照搬的运行面造 Pigeon agent
  agentFor(runtime: ReproducedRuntime): StepAgent;
  outDir: string;
  groups?: readonly FixedPointGroup[];
  passes?: number;
  concurrency?: number;
  judgeTimeoutMs?: number;
  limits?: LimitController;
  gateway?: StreamModelGateway;
  harnessRef: HarnessRef;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  // 调用方已对输出目录取了锁
  outDirLocked?: boolean;
  // 丢掉某个作业的残留环境（容器实现：删掉同名容器）；每遍开环境之前调用
  discardEnv?: (job: StreamJobId) => Promise<void>;
  // 这次重跑所用镜像的 ID：给了即与无记忆整流身份头里的核对
  imageId?: string;
  // harness 代码的核对：给了即以无记忆整流结果行记下的各个 harness 版本调用它，不符即抛错拒绝
  checkHarness?: (recorded: readonly HarnessRef[]) => void;
}

export interface FixedPointSummary {
  resultsFile: string;
  reportFile: string;
  // 本次写了几行、此前已有几行
  written: number;
  existing: number;
  stopped: { key: string; error: string }[];
  // 缺失的组（无关记忆找不到候选）：不重跑
  missing: string[];
}

interface Prepared {
  event: FixedPointEvent;
  step: StreamStep;
  original: AttemptPlan;
  // 原尝试 run.started 冻结的回炉上限与验证分步
  originalRepairRounds: number;
  originalVerifySteps: readonly { name: string; command: string; cwd?: string }[] | undefined;
  budget: StepBudget;
  agent: StepAgent;
  segmentStart: string;
  sessionsDir: string;
  sliced?: Buffer;
  bundle: () => Buffer;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runFixedPoint(options: FixedPointOptions): Promise<FixedPointSummary> {
  // 同一输出目录同一时刻只许一个进程写（结果行、各遍治理根）：与跑批器同一把输出目录锁，撞锁即拒绝并报出占用者；
  // 调用方已取锁（装配在开跑前探测账号之前就取）即不再取
  const release = options.outDirLocked === true ? () => {} : lockOutDir(options.outDir);
  try {
    return await runLocked(options);
  } finally {
    release();
  }
}

async function runLocked(options: FixedPointOptions): Promise<FixedPointSummary> {
  const resultsFile = path.join(options.outDir, "results.jsonl");
  const reportFile = path.join(options.outDir, "report.md");
  const groups = options.groups ?? FIXED_POINT_GROUPS;
  const passes = options.passes ?? DEFAULT_FIXED_POINT_PASSES;
  const bySeq = new Map(options.manifest.steps.map((s) => [s.seq, s]));
  // 开跑之前全部核对：事件清单出自这份整流输出，每个事件的原尝试可照搬、预算与原尝试相同——任一不符即一遍都不跑
  const attempt = options.events.noMemory.attempt;
  for (const s of options.events.noMemory.streams) {
    const digest = resultsDigestOf(openNoMemoryJob(options.noMemoryDir, s.id, attempt));
    if (digest !== s.resultsDigest) {
      throw new Error(`事件清单不是出自这份无记忆整流输出（流 ${s.id} 的结果行摘要不符）`);
    }
  }
  // 镜像与 harness 代码须与无记忆整流时相同（决策 156）
  const noMemoryRows = options.events.noMemory.streams.flatMap(
    (s) => openNoMemoryJob(options.noMemoryDir, s.id, attempt).rows
  );
  if (options.imageId !== undefined)
    assertSameImage(options.noMemoryDir, noMemoryRows, options.imageId);
  const harnessRefs = new Map(
    noMemoryRows.map((r) => [`${r.harnessRef.commit}|${r.harnessRef.dirty}`, r.harnessRef])
  );
  // 至多两个（中途换上登记过的运行时兼容提交，见 fixed-point-harness.ts）；两个以上、或两个而没有核对，一律拒绝
  if (harnessRefs.size > 2 || (harnessRefs.size === 2 && options.checkHarness === undefined)) {
    throw new FidelityRejectedError(
      `无记忆整流的结果行记下了 ${harnessRefs.size} 个不同的 harness 版本：无从核对，拒绝`
    );
  }
  options.checkHarness?.([...harnessRefs.values()]);
  const prepared = new Map<string, Prepared>();
  for (const event of options.events.events) {
    const step = bySeq.get(event.seq);
    if (step === undefined || step.commit !== event.commit) {
      throw new Error(`事件 ${event.id} 与清单对不上（第 ${event.seq} 步）`);
    }
    const segment = options.manifest.streams.find((s) => s.id === event.stream);
    if (segment === undefined) throw new Error(`清单里没有流 ${event.stream}`);
    const job = openNoMemoryJob(options.noMemoryDir, event.stream, attempt);
    const original = resolveAttemptPlan({
      sessionsDir: job.sessionsDir,
      sessionId: event.stepSession as SessionId,
      runId: event.firstRunId as AttemptPlan["runId"],
      startCommit: event.startHead,
    });
    // 原尝试交给 agent 的题面须与清单题面相同（按内容块语义：存储截断的比全文哈希）
    assertSessionTask(
      job.sessionsDir,
      event.stepSession as SessionId,
      event.firstRunId as RunId,
      step.prompt ?? step.message,
      `事件 ${event.id} 的原尝试`,
      AttemptFidelityError
    );
    const budget = rerunBudget(original);
    const originalSession = materializeSession(job.sessionsDir, event.stepSession as SessionId, {
      content: false,
    });
    assertSameVerifySteps(
      `事件 ${event.id} 这次运行方式`,
      originalSession.runStarteds[0]?.payload.verify?.steps,
      options.runtime.verifySteps
    );
    const runtime = rerunRuntime(original);
    prepared.set(event.id, {
      event,
      step,
      original,
      originalRepairRounds: repairRoundsOf(originalSession),
      originalVerifySteps: originalSession.runStarteds[0]?.payload.verify?.steps,
      budget,
      agent: options.agentFor(runtime),
      segmentStart: segment.startCommit,
      sessionsDir: job.sessionsDir,
      bundle: () => job.bundle(),
    });
  }
  const done = new Set(readFixedPointRows(resultsFile).map(fixedPointKey));
  const existing = done.size;
  const missing: string[] = [];
  const preps = [...prepared.values()];
  for (const prep of preps) {
    for (const group of groups) {
      if (prep.event.fixed[group] === null) missing.push(`${prep.event.id}|${group}`);
    }
  }
  const jobs = scheduleJobs(preps.length, groups, passes)
    .map(({ event, group, pass }) => {
      const prep = preps[event] as Prepared;
      return { prep, group, pass, fixed: prep.event.fixed[group] };
    })
    .filter(
      (j): j is { prep: Prepared; group: FixedPointGroup; pass: number; fixed: FixedSelection } =>
        j.fixed !== null &&
        !done.has(fixedPointKey({ eventId: j.prep.event.id, group: j.group, pass: j.pass }))
    );
  let written = 0;
  const stopped: FixedPointSummary["stopped"] = [];
  await runWorkQueue(jobs, options.concurrency ?? DEFAULT_FIXED_POINT_CONCURRENCY, async (job) => {
    const key = fixedPointKey({ eventId: job.prep.event.id, group: job.group, pass: job.pass });
    try {
      const row = await runPassWithVoids(options, job.prep, job.group, job.pass, job.fixed);
      appendFixedPointRow(resultsFile, row);
      written += 1;
      options.log?.(
        `[${key}] 首轮题面以外变红 ${String(row.firstVerify.offTaskRed)}，回炉 ${row.repairRounds ?? "—"} 轮，${row.outcome}`
      );
    } catch (error) {
      stopped.push({ key, error: message(error) });
      options.log?.(`[${key}] 停止：${message(error)}`);
    }
  });
  writeFileSync(
    reportFile,
    renderFixedPointReport(options.events, readFixedPointRows(resultsFile), { passes })
  );
  return { resultsFile, reportFile, written, existing, stopped, missing };
}

// 作业顺序：遍次在外、事件居中、组在内，组的先后按（事件序号 + 遍次）轮转——同一事件同一遍次的各组相邻出队，
// 哪组先跑在遍次间轮换，负载、接口延迟与限额窗口随时段的变化不会系统性地偏向某一组（配对差按事件算）。
// 确定性；续跑按"事件 × 组 × 遍次"成键，与顺序无关
export function scheduleJobs(
  eventCount: number,
  groups: readonly FixedPointGroup[],
  passes: number
): { event: number; group: FixedPointGroup; pass: number }[] {
  const out: { event: number; group: FixedPointGroup; pass: number }[] = [];
  for (let pass = 1; pass <= passes; pass++) {
    for (let event = 0; event < eventCount; event++) {
      const shift = (event + pass) % Math.max(1, groups.length);
      for (let i = 0; i < groups.length; i++) {
        out.push({ event, group: groups[(i + shift) % groups.length] as FixedPointGroup, pass });
      }
    }
  }
  return out;
}

// 一遍的治理根：每遍独立（各遍互不可见）
function passDirOf(outDir: string, eventId: string, group: FixedPointGroup, pass: number): string {
  return path.join(outDir, "passes", eventId, `${group}-${pass}`);
}

// 从起点重来之前：上一次（被打断、或进程死在中途）留下的治理根整体移到隔离目录，再放入第 1 到 k−1 步的会话副本
function resetGovernanceRoot(
  options: FixedPointOptions,
  prep: Prepared,
  dir: string,
  label: string
): void {
  if (existsSync(dir)) {
    const target = path.join(
      options.outDir,
      "voided",
      path.relative(path.join(options.outDir, "passes"), dir),
      label
    );
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(dir, target);
  }
  mkdirSync(dir, { recursive: true });
  seedGovernanceRoot(dir, prep.sessionsDir, prep.event.priorSessionFiles);
}

async function runPassWithVoids(
  options: FixedPointOptions,
  prep: Prepared,
  group: FixedPointGroup,
  pass: number,
  fixed: FixedSelection
): Promise<FixedPointRow> {
  const dir = passDirOf(options.outDir, prep.event.id, group, pass);
  let bare = 0;
  let signalled = 0;
  let queued = 0;
  const warn = options.warn ?? ((line: string) => process.stderr.write(`[定点对照] ${line}\n`));
  for (let attempt = 1; ; attempt++) {
    await options.limits?.ready();
    const epoch = options.limits?.epoch ?? 0;
    resetGovernanceRoot(options, prep, dir, `attempt-${attempt}-${Date.now()}`);
    try {
      const row = await runPass(options, prep, group, pass, fixed, dir);
      // 这一遍开始之后收到过停止信号（停服、关机）：不论判定进行到哪，这一遍作废、不写行，取下一遍时停下
      if (options.limits?.shutdownReason !== undefined) {
        throw new StepInterruptedError(`作废：${options.limits.shutdownReason}`, true);
      }
      row.limitPauses = options.limits?.pausesSince(epoch) ?? [];
      return row;
    } catch (caught) {
      // 工作区访问出错（agent 改坏了属主或权限、放了删不掉的链接）：与跑批器同一口径，作废重做、计入被打断上限
      const error =
        caught instanceof StreamWorkspaceAccessError
          ? new StepInterruptedError(`作废：${caught.message}`, false)
          : caught;
      if (!(error instanceof StepInterruptedError)) throw error;
      // 只因排队超时作废（额度环境造成）：与跑批器同一口径单独计数，10 次告警、30 次停下，不计入限额信号类的上限
      if (error.queued) {
        queued += 1;
        bare = 0;
        if (queued >= QUEUE_VOID_STOP) {
          throw new Error(`因排队超时累计作废 ${queued} 次：停下（${error.message}）`);
        }
        if (queued === QUEUE_VOID_WARN) {
          warn(
            `[${prep.event.id}|${group}|${pass}] 因排队超时已累计作废 ${queued} 次，仍在重做；累计 ${QUEUE_VOID_STOP} 次即停下这一遍`
          );
        }
        options.log?.(
          `[${prep.event.id}|${group}|${pass}] 第 ${queued} 次排队作废，从起点重来：${error.message}`
        );
        continue;
      }
      if (error.signalled) {
        signalled += 1;
        bare = 0;
        if (signalled >= SIGNALLED_VOID_STOP) {
          throw new Error(`因限额信号或上游故障累计作废 ${signalled} 次：停下（${error.message}）`);
        }
        if (signalled === SIGNALLED_VOID_WARN) {
          warn(
            `[${prep.event.id}|${group}|${pass}] 因限额信号或上游故障已累计作废 ${signalled} 次，仍在重做；累计 ${SIGNALLED_VOID_STOP} 次即停下这一遍`
          );
        }
      } else {
        bare += 1;
        if (bare > MAX_BARE_INTERRUPTIONS) {
          throw new Error(
            `连续 ${bare} 次被打断、期间没有限额信号或上游故障：停下（${error.message}）`
          );
        }
      }
      options.log?.(`[${prep.event.id}|${group}|${pass}] 作废，从起点重来：${error.message}`);
    }
  }
}

async function runPass(
  options: FixedPointOptions,
  prep: Prepared,
  group: FixedPointGroup,
  pass: number,
  fixed: FixedSelection,
  dir: string
): Promise<FixedPointRow> {
  const started = Date.now();
  const { event, step } = prep;
  prep.sliced ??= sliceHistory({
    bundle: prep.bundle(),
    head: event.startHead,
    keep: event.priorStepStarts,
    scratch: path.join(options.outDir, "scratch"),
  });
  const job = { stream: `${event.id}-${group}`, condition: "full" as const, attempt: pass };
  // 每遍都从新环境、干净起点开始：先丢掉同名的残留环境（上次被杀留下的容器），免得工厂接管它、看到上次的被忽略文件与 /tmp
  await options.discardEnv?.(job);
  const env = await options.envs.open(job, {
    startCommit: prep.segmentStart,
    resume: { head: event.startHead, seq: event.startSeq, bundle: prep.sliced },
  });
  try {
    await prepareStepStart(options, env, step, {
      startHead: event.startHead,
      keep: event.priorStepStarts,
    });
    const priorIds = new Set(sessionIdsOf(path.join(dir, ".pigeon", "sessions")));
    const { ws } = env;
    const meterKey = `fixed-point|${event.id}|${group}|${pass}`;
    // 人在这一步的测试与测试辅助文件：验证前被还原的受保护文件
    const humanTests = new Set(
      options.human
        .tree(step.commit)
        .map((e) => e.path)
        .filter((p) => {
          const kind = options.runtime.profile.classifyFile(p);
          return kind === "test" || kind === "testaux";
        })
    );
    // 放行与作废判定与跑批器共用（决策 144、160、163）：等放行后跑 agent，本作业在网关排队超过阈值即中止；期间有限额信号、
    // 上游故障、排队超时或 agent 报被打断即整遍作废
    const admitted = await runAdmittedAgent(options, meterKey, (abortSignal) =>
      prep.agent.run({
        job: { stream: event.stream, condition: "full", attempt: pass },
        step,
        prompt: step.prompt ?? step.message,
        condition: CONDITION_SPECS.full,
        target: env.target,
        budget: prep.budget,
        verify: {
          steps: options.runtime.verifySteps,
          command: verifyScript(options.runtime.verifySteps),
          timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        },
        workDir: dir,
        humanTestFiles: humanTests,
        ...(options.runtime.autoloadedTestHelper !== undefined
          ? {
              autoloadedTestHelper: options.runtime.autoloadedTestHelper,
              humanTests: humanTestsAt(options.human, options.runtime, step.commit),
              humanTree: options.human.tree(step.commit).map((e) => e.path),
            }
          : {}),
        structuredMemoryFixed: fixed,
        ...(options.gateway !== undefined
          ? { modelBaseUrl: options.gateway.jobBaseUrl(meterKey) }
          : {}),
        abortSignal,
      })
    );
    const result = admitted.result;
    const delta = admitted.delta;
    if (admitted.voidReasons.length > 0) {
      throw new StepInterruptedError(
        `作废：${admitted.voidReasons.join("；")}`,
        admitted.limitRelated,
        admitted.queueOnly
      );
    }
    let turns = result.turns;
    let usage = result.usage;
    let gateway: StreamGatewayFacts | null = null;
    if (delta !== undefined) {
      turns = delta.requests;
      usage = {
        ...ZERO_USAGE,
        input: delta.input,
        output: delta.output,
        cacheRead: delta.cacheRead,
        cacheWrite: delta.cacheWrite,
        totalTokens: delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
      };
      gateway = {
        queueMs: delta.queueMs,
        accountRequests: delta.accountRequests,
        peakInFlight: delta.peakInFlight,
      };
    }
    // 重跑的会话：治理根里新出现的那一个
    const sessionsDir = path.join(dir, ".pigeon", "sessions");
    const fresh = sessionIdsOf(sessionsDir).filter((id) => !priorIds.has(id));
    if (fresh.length !== 1) throw new Error(`这一遍应恰有一个新会话，实际 ${fresh.length} 个`);
    const sessionId = fresh[0] as SessionId;
    const session = materializeSession(sessionsDir, sessionId, { content: false });
    const firstRun = session.runStarteds[0];
    if (firstRun === undefined) throw new Error("重跑的会话里没有 Run");
    assertRerunFidelity(
      prep.original,
      resolveAttemptPlan({
        sessionsDir,
        sessionId,
        runId: firstRun.runId,
        startCommit: event.startHead,
      })
    );
    assertSessionTask(
      sessionsDir,
      sessionId,
      firstRun.runId,
      step.prompt ?? step.message,
      "这一遍",
      FidelityRejectedError
    );
    assertSameRepairRounds(prep.originalRepairRounds, repairRoundsOf(session));
    assertSameVerifySteps(
      "这一遍",
      prep.originalVerifySteps,
      session.runStarteds[0]?.payload.verify?.steps
    );
    const host = options.hostFor(env.target);
    const verdicts = verdictsOf(session, sessionId, host, step, humanTests);
    const used = memoryUsedOf(session, sessionId, event);
    const given = givenOf(session);
    // 判定与流中同一口径：恢复 agent 动过的测试后，题跑判题测试、维护步跑验证门
    await ws.normalizeTo(event.startHead);
    await restoreTests(options, ws, step);
    await syncEnv(options, ws, step.commit);
    let passed: boolean;
    if (step.kind === "task") {
      const run = await options.runtime.runCases(ws, step.judgeTests, {
        timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        scratch: `${ws.root}/.git`,
      });
      passed = allPassed(run);
    } else {
      const judgement = await ws.run(
        gateFromSteps(options.runtime.verifySteps),
        options.judgeTimeoutMs ?? 1_800_000
      );
      passed = judgement.exitCode === 0 && !judgement.timedOut;
    }
    return {
      eventId: event.id,
      stream: event.stream,
      seq: event.seq,
      group,
      pass,
      sessionId,
      given,
      givenMatch: givenMatches(given, fixed),
      firstVerify: verdicts.first,
      repairVerify: verdicts.repair,
      repairRounds: result.repair?.rounds ?? null,
      finalVerdict: result.repair?.finalVerdict ?? null,
      // 与流中同一口径：成败只看判题，回炉的最终结论另记在 finalVerdict（172 / 173）
      outcome: passed ? "passed" : "failed",
      memoryUsed: used.used,
      memoryUsedFiles: used.files,
      status: result.status,
      turns,
      usage,
      agentWallMs: result.wallMs,
      wallMs: Date.now() - started,
      gateway,
      admissionWaitMs: admitted.admissionWaitMs,
      limitPauses: [],
      harnessRef: options.harnessRef,
    };
  } finally {
    await env.dispose();
  }
}

type Session = ReturnType<typeof materializeSession>;

// 实际给出的条目：首个 Run 的开局那几条，与各回炉轮 Run 的回炉那几条（回炉未开启即没有回炉轮）
function givenOf(session: Session): FixedPointRow["given"] {
  const first = session.runStarteds[0]?.payload.structuredMemory;
  return {
    selection: first?.selection ?? null,
    opening: [...(first?.opening ?? [])],
    repair:
      repairRoundsOf(session) === 0
        ? []
        : session.runStarteds
            .slice(1)
            .map((r) => [
              ...((r.payload.structuredMemory as { repair?: string[] } | undefined)?.repair ?? []),
            ]),
  };
}

// 实际给出的与指定的是否一致，按开局与每一轮回炉分开：开局逐条相同；每一轮回炉与指定的回炉条目逐条相同
// （用前核验没过而被拦下即不一致）；不是固定挑选一律不一致
export function givenMatches(
  given: FixedPointRow["given"],
  fixed: FixedSelection
): FixedPointRow["givenMatch"] {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const fixedSelection = given.selection === "fixed";
  return {
    opening: fixedSelection && same(given.opening, fixed.opening),
    repair: given.repair.map((round) => fixedSelection && same(round, fixed.repair)),
  };
}

function gatesOf(session: Session, sessionId: string) {
  return session.attemptVerifieds
    .filter((g) => g.target.sessionId === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// 首轮验证（开局事件的判据）与回炉后的下一次验证（回炉事件的判据，决策 164）。题面测试文件与派生同一口径，
// 但只用这次验证之前的事实：本步到这次验证为止改动的文件（账本；验证前会被还原的人写受保护测试不算，agent 改过它们
// 也不因此成为题面文件）、开工时已在工作区的文件（开工时的树相对起点提交的差异）、题面直接指到的文件（mentionedUntracked）
function verdictsOf(
  session: Session,
  sessionId: string,
  host: WorkspaceHost,
  step: StreamStep,
  protectedFiles: ReadonlySet<string>
): { first: FirstVerify; repair: RepairVerify } {
  const gates = gatesOf(session, sessionId);
  const first = gates[0];
  const notEntered: RepairVerify = {
    entered: false,
    offTaskRed: null,
    offTaskFailures: [],
    undetermined: [],
  };
  if (first === undefined) {
    return {
      first: {
        failed: null,
        offTaskRed: null,
        offTaskFailures: [],
        undetermined: ["（没有验证记录）"],
      },
      repair: notEntered,
    };
  }
  const access = hostWorkspaceAccess(host);
  const base = session.runStarteds.find((r) => r.payload.stepStart?.baseCommit !== undefined)
    ?.payload.stepStart?.baseCommit;
  const dirty =
    base === undefined
      ? undefined
      : access.git([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "--relative",
          "-r",
          "--root",
          base,
        ]);
  const mentioned = taskReferencedFiles(step.prompt ?? step.message, access.probe(), {
    mentionedUntracked: true,
  });
  const changes = ledgerFileChanges(session, first.workspace);
  const commands = new Map<string, string>();
  for (const s of session.runStarteds[0]?.payload.verify?.steps ?? [])
    commands.set(s.name, s.command);
  const judge = (gate: (typeof gates)[number]): OffTaskVerdict => {
    const taskTestFiles =
      dirty === undefined
        ? undefined
        : taskTestFilesAt({
            changes,
            at: gate.timestamp,
            protectedFiles,
            dirtyAtStart: dirty.split(/\r?\n/).filter((l) => l.trim() !== ""),
            mentioned,
          });
    return offTaskRedOf({
      steps: recordStepsOf(gate),
      commands,
      workspace: gate.workspace,
      taskTestFiles,
    });
  };
  const rounds = repairStepOutcome(session)?.rounds ?? 0;
  const entered = first.verdict === "fail" && rounds >= 1;
  const second = gates[1];
  return {
    first: {
      failed: first.verdict === "fail" ? true : first.verdict === "pass" ? false : null,
      ...judge(first),
    },
    repair: !entered
      ? notEntered
      : second === undefined
        ? {
            entered: true,
            offTaskRed: null,
            offTaskFailures: [],
            undetermined: ["（没有第 2 次验证）"],
          }
        : { entered: true, ...judge(second) },
  };
}

// 记忆是否被用上（139）：三组同一口径——按带记忆组指定的红转绿条目（开局的与回炉的），在带记忆组本会给出它们的时间
// 窗口里看 agent 是否改了条目的补改文件：开局条目看首轮验证之前，回炉条目看每一轮回炉（第 r 次验证之后、下一次验证
// 之前或会话结束）。不带组与无关组的这一指标即基线
function memoryUsedOf(
  session: Session,
  sessionId: string,
  event: FixedPointEvent
): { used: boolean | null; files: string[] } {
  const memory = event.fixed.memory;
  if (memory === null) return { used: null, files: [] };
  const items = new Map(event.relevant.map((i) => [i.id, i]));
  const gates = gatesOf(session, sessionId);
  const changes = ledgerFileChanges(session, gates[0]?.workspace);
  const rounds = repairRoundsOf(session) === 0 ? 0 : (repairStepOutcome(session)?.rounds ?? 0);
  const windows: { ids: string[]; after: number; upTo: number }[] = [
    {
      ids: memory.opening,
      after: Number.NEGATIVE_INFINITY,
      upTo: gates[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    },
    ...Array.from({ length: rounds }, (_, i) => ({
      ids: memory.repair,
      after: gates[i]?.timestamp ?? Number.POSITIVE_INFINITY,
      upTo: gates[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY,
    })),
  ];
  let applicable = false;
  const files = new Set<string>();
  for (const w of windows) {
    for (const id of w.ids) {
      const item = items.get(id);
      if (item === undefined || item.repairFiles === null) continue;
      applicable = true;
      const want = new Set(item.repairFiles);
      for (const change of changes) {
        if (change.at > w.after && change.at <= w.upTo) {
          for (const f of change.files) if (want.has(f)) files.add(f);
        }
      }
    }
  }
  return { used: applicable ? files.size > 0 : null, files: [...files].sort() };
}

// 结果行目录里的全部遍次治理根（供测试与排查看）
export function passDirsOf(outDir: string): string[] {
  const root = path.join(outDir, "passes");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((event) =>
    readdirSync(path.join(root, event)).map((p) => path.join(root, event, p))
  );
}
