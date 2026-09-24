// 定点对照的单步重跑（决策 139、156、157、158）：每个事件、每组各若干遍（缺省 5），每遍从该步起点恢复该流的断网容器工作区
// （上一步落地的提交加该步的人写测试，与流中该步开工时一致），治理根里放第 1 到 k−1 步的会话副本，按完整条件跑完整的一步：
// agent、分步验证门、回炉（3 轮）、撤回，预算与原尝试相同；模型请求经本地网关、计量与限额处理与流中一致。
// 三组的差别只在结构化记忆的固定挑选（157），推送路径与正式使用同一条。
// 一致性核对（156）：从原尝试的 run.started 解出预算、模型、推理档位、工具名单与工作方式指令，重跑照搬；
// 调用方要的预算比原尝试宽即拒绝；每遍跑完再按重跑自己的 run.started 核对一次，任何一项放宽或不同即拒绝、不写结果行。
// 各遍互不可见：每遍一个独立的治理根副本；被打断的一遍整遍作废（会话移出、从起点重来），与流中的作废规则相同。
// 结果写结果行（158：不新增账本记录），按"事件 × 组 × 遍次"断点续跑。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { hostWorkspaceAccess, taskReferencedFiles } from "../memory/structured-workspace.ts";
import { materializeSession } from "../persistence/session-read.ts";
import {
  AttemptFidelityError,
  assertThinkingLevelReproducible,
  effectiveLimits,
  intersectAttemptTools,
  type ReproducedRuntime,
  reproducedRuntime,
  samplingOf,
} from "../replay/fidelity.ts";
import { type AttemptPlan, resolveAttemptPlan } from "../replay/plan.ts";
import type { SessionId } from "../state/ids.ts";
import { ledgerFileChanges, reportedPathOf } from "../state/structured-memory.ts";
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
  type FirstVerify,
  type FixedPointRow,
  fixedPointKey,
  readFixedPointRows,
} from "./fixed-point-results.ts";
import { type GatewayMeter, meterDelta } from "./model-gateway.ts";
import type { LimitController } from "./model-limits.ts";
import type { HarnessRef } from "./results.ts";
import { STREAM_WORK_DIRECTIVE } from "./stream-agents.ts";
import type { HumanRepo } from "./stream-facts.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import {
  allPassed,
  gateFromSteps,
  type StreamRepoRuntime,
  verifyScript,
} from "./stream-profiles.ts";
import { type StreamGatewayFacts, ZERO_USAGE } from "./stream-results.ts";
import {
  CONDITION_SPECS,
  DEFAULT_STEP_BUDGET,
  MAX_BARE_INTERRUPTIONS,
  restoreTests,
  SIGNALLED_VOID_STOP,
  type StepAgent,
  type StepAgentResult,
  type StepBudget,
  StepInterruptedError,
  type StreamEnvFactory,
  type StreamModelGateway,
  syncEnv,
} from "./stream-runner.ts";
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

// 重跑实际用的预算：照搬原尝试；调用方要了预算即逐项核对，比原尝试宽即拒绝
export function rerunBudget(original: AttemptPlan, requested?: StepBudget): StepBudget {
  const limits = effectiveLimits(
    original.budget,
    DEFAULT_STEP_BUDGET,
    requested !== undefined
      ? { maxTurns: requested.maxTurns, wallClockMs: requested.wallClockMs }
      : undefined
  );
  return { maxTurns: limits.maxTurns, wallClockMs: limits.wallClockMs };
}

// 重跑的运行面照搬原尝试（推理档位认不出即拒绝）；工作方式指令须与跑批器的一致
export function rerunRuntime(original: AttemptPlan): ReproducedRuntime {
  const runtime = reproducedRuntime(samplingOf(original));
  if ((runtime.taskDirective ?? null) !== STREAM_WORK_DIRECTIVE) {
    throw new AttemptFidelityError("原尝试的工作方式指令与跑批器的不同：重跑无法照搬，故拒绝");
  }
  return runtime;
}

// 跑完后按重跑自己的 run.started 核对：预算不宽于原尝试，工具不多于原尝试，模型、推理档位、温度、输出上限、
// 工作方式指令与题面逐项相同
export function assertRerunFidelity(original: AttemptPlan, rerun: AttemptPlan): void {
  const problems: string[] = [];
  try {
    effectiveLimits(original.budget, DEFAULT_STEP_BUDGET, {
      maxTurns: rerun.budget.maxTurns ?? Number.POSITIVE_INFINITY,
      wallClockMs: rerun.budget.wallClockMs ?? Number.POSITIVE_INFINITY,
      ...(rerun.budget.maxTokens !== undefined ? { maxTokens: rerun.budget.maxTokens } : {}),
    });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
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
  if (original.task !== rerun.task) problems.push("题面不同");
  if (original.approvalMode !== rerun.approvalMode) {
    problems.push(`放权方式不同：${rerun.approvalMode}，原尝试 ${original.approvalMode}`);
  }
  if (problems.length > 0) {
    throw new FidelityRejectedError(`重跑与原尝试不一致，拒绝：${problems.join("；")}`);
  }
}

// ---------- 首轮验证 ----------

// 首轮验证是否在题面以外的检查上变红（131 口径）：taskTestFiles 为题面测试文件（本步改动的文件、开工时已在工作区的
// 文件、题面直接指到的文件三者的并集）；认定不全时为 undefined，测试步一律判不清
export function offTaskRedOf(input: {
  steps: readonly VerifyStepResult[];
  commands: ReadonlyMap<string, string>;
  workspace: string;
  taskTestFiles: ReadonlySet<string> | undefined;
}): Pick<FirstVerify, "offTaskRed" | "offTaskFailures" | "undetermined"> {
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
  // 调用方要的预算（缺省照搬原尝试）；比原尝试宽即拒绝
  budget?: StepBudget;
  judgeTimeoutMs?: number;
  limits?: LimitController;
  gateway?: StreamModelGateway;
  harnessRef: HarnessRef;
  log?: (line: string) => void;
  warn?: (line: string) => void;
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
  mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, "results.jsonl");
  const reportFile = path.join(options.outDir, "report.md");
  const groups = options.groups ?? FIXED_POINT_GROUPS;
  const passes = options.passes ?? DEFAULT_FIXED_POINT_PASSES;
  const bySeq = new Map(options.manifest.steps.map((s) => [s.seq, s]));
  // 开跑之前全部核对：事件清单出自这份整流输出，每个事件的原尝试可照搬、预算不宽于原尝试——任一不符即一遍都不跑
  const attempt = options.events.noMemory.attempt;
  for (const s of options.events.noMemory.streams) {
    const digest = resultsDigestOf(openNoMemoryJob(options.noMemoryDir, s.id, attempt));
    if (digest !== s.resultsDigest) {
      throw new Error(`事件清单不是出自这份无记忆整流输出（流 ${s.id} 的结果行摘要不符）`);
    }
  }
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
    // 原尝试的题面按账本里首条用户消息取（去掉首尾空白），与清单题面同样去掉首尾空白再比
    if (original.task !== (step.prompt ?? step.message).trim()) {
      throw new AttemptFidelityError(`事件 ${event.id} 的原尝试题面与清单不同，拒绝重跑`);
    }
    const budget = rerunBudget(original, options.budget);
    const runtime = rerunRuntime(original);
    prepared.set(event.id, {
      event,
      step,
      original,
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
  const jobs: { prep: Prepared; group: FixedPointGroup; pass: number; fixed: FixedSelection }[] =
    [];
  for (const prep of prepared.values()) {
    for (const group of groups) {
      const fixed = prep.event.fixed[group];
      if (fixed === null) {
        missing.push(`${prep.event.id}|${group}`);
        continue;
      }
      for (let pass = 1; pass <= passes; pass++) {
        if (!done.has(fixedPointKey({ eventId: prep.event.id, group, pass }))) {
          jobs.push({ prep, group, pass, fixed });
        }
      }
    }
  }
  let written = 0;
  const stopped: FixedPointSummary["stopped"] = [];
  await runWorkQueue(jobs, options.concurrency ?? DEFAULT_FIXED_POINT_CONCURRENCY, async (job) => {
    const key = fixedPointKey({ eventId: job.prep.event.id, group: job.group, pass: job.pass });
    try {
      const row = await runPassWithVoids(options, job.prep, job.group, job.pass, job.fixed);
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
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
    renderFixedPointReport(options.events, readFixedPointRows(resultsFile), { groups, passes })
  );
  return { resultsFile, reportFile, written, existing, stopped, missing };
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
  for (let attempt = 1; ; attempt++) {
    await options.limits?.ready();
    const epoch = options.limits?.epoch ?? 0;
    resetGovernanceRoot(options, prep, dir, `attempt-${attempt}-${Date.now()}`);
    try {
      const row = await runPass(options, prep, group, pass, fixed, dir);
      row.limitPauses = options.limits?.pausesSince(epoch) ?? [];
      return row;
    } catch (error) {
      if (!(error instanceof StepInterruptedError)) throw error;
      if (error.signalled) {
        signalled += 1;
        bare = 0;
        if (signalled >= SIGNALLED_VOID_STOP) {
          throw new Error(`因限额信号或上游故障累计作废 ${signalled} 次：停下（${error.message}）`);
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
  const env = await options.envs.open(job, {
    startCommit: prep.segmentStart,
    resume: { head: event.startHead, bundle: prep.sliced },
  });
  try {
    await prepareStepStart(options, env, step, {
      startHead: event.startHead,
      keep: event.priorStepStarts,
    });
    const priorIds = new Set(sessionIdsOf(path.join(dir, ".pigeon", "sessions")));
    const { ws } = env;
    const meterKey = `fixed-point|${event.id}|${group}|${pass}`;
    const release = await options.limits?.acquire();
    const signalsBefore = options.limits?.signals ?? 0;
    const before: GatewayMeter | undefined = options.gateway?.meter(meterKey);
    options.gateway?.resetPeak(meterKey);
    let result: StepAgentResult;
    try {
      result = await prep.agent.run({
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
        humanTestFiles: new Set(
          options.human
            .tree(step.commit)
            .map((e) => e.path)
            .filter((p) => {
              const kind = options.runtime.profile.classifyFile(p);
              return kind === "test" || kind === "testaux";
            })
        ),
        structuredMemoryFixed: fixed,
        ...(options.gateway !== undefined
          ? { modelBaseUrl: options.gateway.jobBaseUrl(meterKey) }
          : {}),
      });
    } finally {
      release?.();
    }
    const delta =
      options.gateway !== undefined && before !== undefined
        ? meterDelta(options.gateway.meter(meterKey), before)
        : undefined;
    const signalled = (options.limits?.signals ?? 0) !== signalsBefore;
    const upstreamFailed = (delta?.upstreamFailures ?? 0) > 0;
    if (signalled || upstreamFailed || result.interrupted !== undefined) {
      const why = [
        signalled ? "期间出现限额信号" : undefined,
        upstreamFailed ? `上游故障 ${delta?.upstreamFailures} 次` : undefined,
        result.interrupted !== undefined ? `agent 报被打断：${result.interrupted}` : undefined,
      ].filter((x) => x !== undefined);
      throw new StepInterruptedError(`作废：${why.join("；")}`, signalled || upstreamFailed);
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
    const host = options.hostFor(env.target);
    const firstVerify = firstVerifyOf(session, sessionId, host, step);
    const used = memoryUsedOf(session, sessionId, event);
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
    const reverted = result.repair?.finalVerdict === "fail";
    return {
      eventId: event.id,
      stream: event.stream,
      seq: event.seq,
      group,
      pass,
      sessionId,
      given: givenOf(session),
      firstVerify,
      repairRounds: result.repair?.rounds ?? null,
      finalVerdict: result.repair?.finalVerdict ?? null,
      reverted,
      outcome: passed && !reverted ? "passed" : "failed",
      memoryUsed: used.used,
      memoryUsedFiles: used.files,
      status: result.status,
      turns,
      usage,
      agentWallMs: result.wallMs,
      wallMs: Date.now() - started,
      gateway,
      limitPauses: [],
      harnessRef: options.harnessRef,
    };
  } finally {
    await env.dispose();
  }
}

type Session = ReturnType<typeof materializeSession>;

// 实际给出的条目：首个 Run 的开局那几条，与各回炉轮 Run 的回炉那几条
function givenOf(session: Session): FixedPointRow["given"] {
  const first = session.runStarteds[0]?.payload.structuredMemory;
  return {
    selection: first?.selection ?? null,
    opening: [...(first?.opening ?? [])],
    repair: session.runStarteds
      .slice(1)
      .map((r) => [
        ...((r.payload.structuredMemory as { repair?: string[] } | undefined)?.repair ?? []),
      ]),
  };
}

function gatesOf(session: Session, sessionId: string) {
  return session.attemptVerifieds
    .filter((g) => g.target.sessionId === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// 首轮验证：整体是否不过，是否在题面以外的检查上变红。题面测试文件与派生同一口径：本步改动的文件（账本）、
// 开工时已在工作区的文件（开工时的树相对起点提交的差异）、题面直接指到的文件（mentionedUntracked）
function firstVerifyOf(
  session: Session,
  sessionId: string,
  host: WorkspaceHost,
  step: StreamStep
): FirstVerify {
  const gate = gatesOf(session, sessionId)[0];
  if (gate === undefined) {
    return {
      failed: null,
      offTaskRed: null,
      offTaskFailures: [],
      undetermined: ["（没有验证记录）"],
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
  const taskTestFiles =
    dirty === undefined
      ? undefined
      : new Set([
          ...ledgerFileChanges(session, gate.workspace).flatMap((e) => e.files),
          ...dirty.split(/\r?\n/).filter((l) => l.trim() !== ""),
          ...taskReferencedFiles(step.prompt ?? step.message, access.probe(), {
            mentionedUntracked: true,
          }),
        ]);
  const commands = new Map<string, string>();
  for (const s of session.runStarteds[0]?.payload.verify?.steps ?? [])
    commands.set(s.name, s.command);
  return {
    failed: gate.verdict === "fail" ? true : gate.verdict === "pass" ? false : null,
    ...offTaskRedOf({
      steps: recordStepsOf(gate),
      commands,
      workspace: gate.workspace,
      taskTestFiles,
    }),
  };
}

// 记忆是否被用上：开局给的红转绿条目，看首轮验证之前；第 r 轮回炉给的，看第 r 次验证之后、下一次验证之前（或会话结束）。
// 这一窗口里 agent 改了条目记下的补改文件之一即算用上
function memoryUsedOf(
  session: Session,
  sessionId: string,
  event: FixedPointEvent
): { used: boolean | null; files: string[] } {
  const items = new Map(
    [...event.relevant, ...(event.irrelevant ?? []).map((x) => x.item)].map((i) => [i.id, i])
  );
  const gates = gatesOf(session, sessionId);
  const workspace = gates[0]?.workspace;
  const changes = ledgerFileChanges(session, workspace);
  const given = givenOf(session);
  const windows: { ids: string[]; after: number; upTo: number }[] = [
    {
      ids: given.opening,
      after: Number.NEGATIVE_INFINITY,
      upTo: gates[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    },
    ...given.repair.map((ids, i) => ({
      ids,
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
