// 延续式跑批器（决策 126 修订、140、142、143、145、147、148；第三、四、六节）：agent 按历史顺序一步一步地做，
// 每一步都在它自己上一步留下的代码上接着做。每条流乘以每个条件（乘以第几遍）为一个独立作业，共用工作队列并行（缺省 4 路）。
// 每一步：回到本步起点 → 程序写入该步人的测试、测试辅助与环境文件 → 按条件运行 agent → 恢复 agent 动过的测试 →
// 判定（题：判题测试；维护步：验证门）→ 落地提交或撤回（撤回后该步留空，后续照常往下做）→ 在另一份副本上做全量测量 →
// 失败归因 → 导出流历史 → 写结果行。被打断的一步整题作废、回到本步起点、不留结果行（144）；崩溃后从结果行与导出的
// 流历史续跑。agent 怎么跑（Pigeon 在进程内、最简 agent 在宿主上）与模型怎么接入都在 StepAgent 之后，跑批器不感知。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import type { TurnUsage } from "../state/runtime-events.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import { type GatewayMeter, meterDelta } from "./model-gateway.ts";
import type { LimitController } from "./model-limits.ts";
import type { HarnessRef } from "./results.ts";
import {
  attributeFailure,
  type CreatedRefs,
  createdByDiff,
  extractMissing,
} from "./stream-attribution.ts";
import type { HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { type StreamManifest, type StreamStep, stepsOf } from "./stream-manifest.ts";
import { countPassRate, type TestCaseResult, taskPassRate } from "./stream-measure.ts";
import {
  allPassed,
  countQuality,
  type StreamRepoRuntime,
  verifyConfigFile,
  verifyScript,
} from "./stream-profiles.ts";
import { renderStreamReport } from "./stream-report.ts";
import {
  lastCompletedStep,
  MEMORY_WARN_RATIO,
  readStreamResults,
  type StreamCondition,
  type StreamJobId,
  type StreamResultLine,
  streamJobKey,
  ZERO_USAGE,
} from "./stream-results.ts";
import { dockerStreamShell, StreamWorkspace } from "./stream-workspace.ts";
import { runWorkQueue } from "./work-queue.ts";

// 四个条件（126 修订、140）：记忆尚未建，完整 Pigeon 的记忆开关暂时等同于关闭
export interface ConditionSpec {
  name: StreamCondition;
  agent: "pigeon" | "minimal";
  // 回炉轮数上限（143）；0 为不开回炉
  repairRounds: number;
  // 回炉到上限仍不通过即撤回（142）
  revert: boolean;
  memory: boolean;
}

export const CONDITION_SPECS: Record<StreamCondition, ConditionSpec> = {
  full: { name: "full", agent: "pigeon", repairRounds: 3, revert: true, memory: true },
  "no-memory": { name: "no-memory", agent: "pigeon", repairRounds: 3, revert: true, memory: false },
  "no-gate": { name: "no-gate", agent: "pigeon", repairRounds: 0, revert: false, memory: false },
  minimal: { name: "minimal", agent: "minimal", repairRounds: 0, revert: false, memory: false },
};

// 每步总预算（147）：各条件同一个，包括轮数与墙钟，回炉的消耗计入其中；先按 150 轮、30 分钟，试跑后定死
export interface StepBudget {
  maxTurns: number;
  wallClockMs: number;
}

export const DEFAULT_STEP_BUDGET: StepBudget = { maxTurns: 150, wallClockMs: 30 * 60_000 };

// agent 的命令在哪里执行
export interface AgentTarget {
  container: string;
  root: string;
}

export interface StepAgentInput {
  job: StreamJobId;
  step: StreamStep;
  prompt: string;
  condition: ConditionSpec;
  target: AgentTarget;
  budget: StepBudget;
  // 开回炉的条件按它验证：由这条流的分步验证派生的一行命令（交 sh -c，在工作区根执行）与超时
  verify: { command: string; timeoutMs: number };
  // 宿主上给这个作业用的目录（会话账本等）
  workDir: string;
  // 经网关时，这个作业的模型接入地址（决策 155）
  modelBaseUrl?: string;
}

// 网关对跑批器露出的两样：作业的接入地址、作业的计量
export interface StreamModelGateway {
  jobBaseUrl(job: string): string;
  meter(job: string): GatewayMeter;
}

export interface StepAgentResult {
  status: string;
  turns: number;
  usage: TurnUsage;
  wallMs: number;
  // 开回炉的条件：用了几轮、最后一次验证结论（无法判定为 null）、是否撤回、撤回是否因预算先于轮数用尽、
  // 撤回时工作区没恢复成的原因；未开回炉为 null
  repair: {
    rounds: number;
    finalVerdict: "pass" | "fail" | null;
    reverted?: boolean;
    budgetExhausted?: boolean;
    restoreError?: string;
  } | null;
  // 这一步被打断（模型服务故障、限额）：整题作废、不留行
  interrupted?: string;
}

export interface StepAgent {
  run(input: StepAgentInput): Promise<StepAgentResult>;
}

export interface StreamEnvironment {
  ws: StreamWorkspace;
  target: AgentTarget;
  // 测量副本放在哪里（容器内路径）
  measureRoot: string;
  dispose(): Promise<void>;
}

export interface StreamEnvFactory {
  // 新开：从流起点建；续跑：从导出的流历史恢复到断点
  open(
    job: StreamJobId,
    init: { startCommit: string; resume?: { head: string; bundle: Buffer } }
  ): Promise<StreamEnvironment>;
}

// 人的代码在某提交上跑给定测试的用例结果（全量测量的基准）
export interface HumanBaseline {
  // 各遍收集出的用例的并集（A 口径的分母）
  cases: TestCaseResult[];
  // 每一遍都通过的用例
  passing: string[];
  // 各遍结果不一致（时过时不过）的用例
  flaky: string[];
  // 每一遍的内存峰值与墙钟（容器内按 cgroup 采样；取不到为 null）
  runs: BaselineRun[];
  // 各遍里耗时最长的用例
  slowest: { id: string; seconds: number } | null;
}

export interface BaselineRun {
  // 这一遍期间容器内存占用的峰值（不含可回收的页缓存），字节
  peakBytes: number | null;
  // 容器内存上限，字节；未设上限为 null
  limitBytes: number | null;
  wallMs: number;
}

// 在容器里每秒采样一次 cgroup 的内存占用（memory.current 减去页缓存 file），直到停止文件出现；
// 先采样后检查，至少采一次。不在 cgroup v2 容器里（读不到文件）即不输出
const MEMORY_SAMPLER = [
  's="$1"; g="$2"; m="";',
  "while :; do",
  'c=$(cat "$g/memory.current" 2>/dev/null) || break;',
  'f=$(awk \'$1=="file"{print $2}\' "$g/memory.stat" 2>/dev/null);',
  '[ -z "$f" ] && f=0; u=$((c - f)); if [ -z "$m" ] || [ "$u" -gt "$m" ]; then m=$u; fi;',
  '[ -f "$s" ] && break; sleep 1;',
  "done;",
  '[ -n "$m" ] && echo "peak $m" && echo "max $(cat "$g/memory.max" 2>/dev/null)"; true',
].join(" ");

export interface HumanReferenceCases {
  casesAt(commit: string, tests: readonly string[]): Promise<HumanBaseline>;
}

export class StepInterruptedError extends Error {
  override name = "StepInterruptedError";
}

export interface RunStreamsOptions {
  manifest: StreamManifest;
  runtime: StreamRepoRuntime;
  human: HumanRepo;
  envs: StreamEnvFactory;
  agents: Partial<Record<ConditionSpec["agent"], StepAgent>>;
  reference: HumanReferenceCases;
  outDir: string;
  conditions: readonly StreamCondition[];
  // 每个条件跑几遍（146 补跑时为 3）
  attempts?: number;
  // 只跑这些流；缺省为清单里全部
  streams?: readonly string[];
  // 并行作业数（缺省 4）
  concurrency?: number;
  // 试跑：每条流只跑前 K 步（143、147 校准用）
  maxSteps?: number;
  budget?: StepBudget;
  judgeTimeoutMs?: number;
  measureTimeoutMs?: number;
  harnessRef: HarnessRef;
  log?: (line: string) => void;
  // 限额统一处理（第 17 条）：每步前等放行、agent 运行时占一路；这一步撞上限额即作废、恢复后重做
  limits?: LimitController;
  // 经网关时：轮数与 token 一律取网关的按作业计量，四个条件同一口径
  gateway?: StreamModelGateway;
}

export interface StreamJobSummary {
  key: string;
  completedTo: number | null;
  stopped?: string;
}

export interface RunStreamsSummary {
  resultsFile: string;
  reportFile: string;
  jobs: StreamJobSummary[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jobDirName(job: StreamJobId): string {
  return `${job.stream}-${job.condition}-${job.attempt}`;
}

function writeAtomic(file: string, content: Buffer | string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export async function runStreams(options: RunStreamsOptions): Promise<RunStreamsSummary> {
  mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, "results.jsonl");
  const reportFile = path.join(options.outDir, "report.md");
  const streamIds = options.streams ?? options.manifest.streams.map((s) => s.id);
  for (const id of streamIds) {
    if (!options.manifest.streams.some((s) => s.id === id)) throw new Error(`清单里没有流 ${id}`);
  }
  const attempts = options.attempts ?? 1;
  const jobs: StreamJobId[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const stream of streamIds) {
      for (const condition of options.conditions) jobs.push({ stream, condition, attempt });
    }
  }
  const summaries: StreamJobSummary[] = [];
  await runWorkQueue(jobs, options.concurrency ?? 4, async (job) => {
    const summary: StreamJobSummary = { key: streamJobKey(job), completedTo: null };
    try {
      summary.completedTo = await runStreamJob(options, job, resultsFile);
    } catch (error) {
      summary.stopped = message(error);
      summary.completedTo = lastCompletedStep(readStreamResults(resultsFile), job)?.seq ?? null;
      options.log?.(`[${summary.key}] 停止：${summary.stopped}`);
    }
    summaries.push(summary);
  });
  const reportStreams = streamIds.map((id) => {
    const steps = limitSteps(stepsOf(options.manifest, id), options.maxSteps);
    return { id, lastSeq: steps.at(-1)?.seq ?? 0 };
  });
  writeFileSync(
    reportFile,
    renderStreamReport(readStreamResults(resultsFile), {
      title: `${options.manifest.repo}${options.maxSteps !== undefined ? `（试跑：每条流前 ${options.maxSteps} 步）` : ""}`,
      streams: reportStreams,
    })
  );
  return { resultsFile, reportFile, jobs: summaries };
}

function limitSteps(steps: StreamStep[], maxSteps: number | undefined): StreamStep[] {
  return maxSteps === undefined ? steps : steps.slice(0, maxSteps);
}

// 人的某步本应新建的：新增的源代码文件与源代码新增行里的顶层定义
function createdFor(options: RunStreamsOptions, step: StreamStep): CreatedRefs {
  const profile = options.runtime.profile;
  const source = options.human
    .changes(step.parent, step.commit)
    .filter((f) => profile.classifyFile(f.path) === "source");
  return createdByDiff({
    addedFiles: source.filter((f) => f.status === "A").map((f) => f.path),
    addedLines: options.human.addedLines(
      step.parent,
      step.commit,
      source.filter((f) => f.status !== "D").map((f) => f.path)
    ),
  });
}

interface JobState {
  head: string;
  previous: StreamResultLine | undefined;
  // 上一次测量时 agent 代码上通过的用例
  agentPassing: Set<string>;
  revertedCreated: CreatedRefs[];
  maintenanceCreated: CreatedRefs[];
}

async function runStreamJob(
  options: RunStreamsOptions,
  job: StreamJobId,
  resultsFile: string
): Promise<number | null> {
  const spec = CONDITION_SPECS[job.condition];
  const agent = options.agents[spec.agent];
  if (agent === undefined)
    throw new Error(`条件 ${job.condition} 需要的 agent（${spec.agent}）没有接入`);
  const segment = options.manifest.streams.find((s) => s.id === job.stream);
  if (segment === undefined) throw new Error(`清单里没有流 ${job.stream}`);
  const steps = limitSteps(stepsOf(options.manifest, job.stream), options.maxSteps);
  const jobDir = path.join(options.outDir, "streams", jobDirName(job));
  mkdirSync(jobDir, { recursive: true });
  // 分步验证配置写进这个作业的治理根（Pigeon 在宿主进程内运行，项目配置从治理根读；不写进容器工作区，
  // 免得被当成 agent 的改动落地提交）
  mkdirSync(path.join(jobDir, ".pigeon"), { recursive: true });
  writeAtomic(
    path.join(jobDir, ".pigeon", "verify.json"),
    `${JSON.stringify(verifyConfigFile(options.runtime.verifySteps, options.judgeTimeoutMs ?? 1_800_000), null, 2)}\n`
  );
  const bundleFile = path.join(jobDir, "history.bundle");
  const passingFile = (seq: number) => path.join(jobDir, `passing-${seq}.json`);
  const lines = readStreamResults(resultsFile);
  const last = lastCompletedStep(lines, job);
  const remaining = steps.filter((s) => last === undefined || s.seq > last.seq);
  if (remaining.length === 0) return last?.seq ?? null;
  const log = (text: string) => options.log?.(`[${streamJobKey(job)}] ${text}`);
  if (last !== undefined && !existsSync(bundleFile)) {
    throw new Error(`续跑缺流历史：${bundleFile} 不存在（断点在第 ${last.seq} 步）`);
  }
  const env = await options.envs.open(job, {
    startCommit: segment.startCommit,
    ...(last !== undefined
      ? { resume: { head: last.head, bundle: readFileSync(bundleFile) } }
      : {}),
  });
  try {
    const jobRows = lines.filter((l) => streamJobKey(l) === streamJobKey(job));
    const bySeq = new Map(steps.map((s) => [s.seq, s]));
    const state: JobState = {
      head: await env.ws.head(),
      previous: last,
      agentPassing:
        last !== undefined && existsSync(passingFile(last.seq))
          ? new Set(JSON.parse(readFileSync(passingFile(last.seq), "utf8")) as string[])
          : new Set(),
      revertedCreated: jobRows
        .filter((r) => r.reverted && r.kind === "task")
        .flatMap((r) => {
          const s = bySeq.get(r.seq);
          return s === undefined ? [] : [createdFor(options, s)];
        }),
      maintenanceCreated: steps
        .filter((s) => s.kind === "maintenance" && last !== undefined && s.seq <= last.seq)
        .map((s) => createdFor(options, s)),
    };
    if (last !== undefined && state.head !== last.head) {
      throw new Error(`续跑核对不符：工作区 HEAD 为 ${state.head}，断点行记的是 ${last.head}`);
    }
    const limits = options.limits;
    for (const step of remaining) {
      log(`第 ${step.seq} 步（${step.kind}）${step.subject.slice(0, 60)}`);
      const epochAtStart = limits?.epoch ?? 0;
      let row: StreamResultLine;
      for (;;) {
        await limits?.ready();
        const signals = limits?.signals ?? 0;
        try {
          row = await runStep(options, job, spec, agent, env, steps, step, state, jobDir);
          break;
        } catch (error) {
          // 这一步撞上了限额（暂停或降路）：已回到本步起点、不留行，等放行后重做同一步（144）
          if (
            error instanceof StepInterruptedError &&
            limits !== undefined &&
            limits.signals !== signals
          ) {
            log(`第 ${step.seq} 步撞上限额，作废，恢复后重做`);
            continue;
          }
          throw error;
        }
      }
      row.limitPauses = limits?.pausesSince(epochAtStart) ?? [];
      // 先存流历史与测量基线、后写结果行：两者之间崩溃时，断点行仍指向上一步，导出的历史里也有上一步的提交
      writeAtomic(bundleFile, await env.ws.exportBundle());
      writeAtomic(passingFile(step.seq), JSON.stringify([...state.agentPassing]));
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      state.previous = row;
      state.head = row.head;
    }
    return steps.at(-1)?.seq ?? null;
  } finally {
    await env.dispose();
  }
}

async function syncEnv(
  options: RunStreamsOptions,
  ws: StreamWorkspace,
  cwd?: string
): Promise<void> {
  const command = options.runtime.envSyncCommand;
  if (command === null) return;
  const r = await ws.run(command, 120_000, cwd);
  if (r.exitCode !== 0) throw new Error(`依赖切换失败：${r.output.slice(-500)}`);
}

// agent 不许改测试（第 6 条）：它动过的测试与测试辅助文件，本步由程序写入的恢复成人的版本，其余恢复成本步起点的版本；
// 它新建的测试文件保留（全量测量只跑人写的测试）
async function restoreTests(
  options: RunStreamsOptions,
  ws: StreamWorkspace,
  step: StreamStep
): Promise<void> {
  const profile = options.runtime.profile;
  const changed = (await ws.changedPaths()).filter((c) => {
    const kind = profile.classifyFile(c.path);
    return kind === "test" || kind === "testaux";
  });
  const human = new Set(
    step.humanFiles.filter((f) => f.kind === "test" || f.kind === "testaux").map((f) => f.path)
  );
  await ws.restoreFromHead(
    changed.filter((c) => !c.untracked && !human.has(c.path)).map((c) => c.path)
  );
  await ws.applyHumanFiles(
    step.humanFiles.filter((f) => human.has(f.path)),
    (p) => options.human.show(step.commit, p)
  );
}

// 某提交上人写的全部测试文件：全量测量与提前单独算的人的基准用同一份，两边的用例集一致
export function humanTestsAt(
  human: HumanRepo,
  runtime: StreamRepoRuntime,
  commit: string
): string[] {
  return human
    .tree(commit)
    .filter((e) => runtime.profile.classifyFile(e.path) === "test")
    .map((e) => e.path);
}

interface Measurement {
  fullPassRate: NonNullable<StreamResultLine["fullPassRate"]>;
  regressions: number;
  quality: NonNullable<StreamResultLine["quality"]>;
}

// 全量测量（145、148）：在从 HEAD 克隆的副本上补齐人截至该步的全部测试与测试辅助文件（被撤回题的测试也在内），
// 跑人写的全部测试；结果不进 agent 的会话
async function measure(
  options: RunStreamsOptions,
  env: StreamEnvironment,
  steps: readonly StreamStep[],
  step: StreamStep,
  state: JobState
): Promise<Measurement> {
  const { ws } = env;
  const runtime = options.runtime;
  const copy = await ws.prepareMeasureCopy(env.measureRoot, runtime.depsLinks);
  const tree = options.human
    .tree(step.commit)
    .map((e) => ({ ...e, kind: runtime.profile.classifyFile(e.path) }))
    .filter((e) => e.kind === "test" || e.kind === "testaux");
  await ws.syncHumanFilesAt(copy, tree, (p) => options.human.show(step.commit, p));
  await syncEnv(options, ws, copy);
  const tests = humanTestsAt(options.human, runtime, step.commit);
  // 一个卡死或导入失败的用例不让其余用例的结果丢失（见 runCases）；拿不到结果的用例在分母里、计为未通过
  const run = await runtime.runCases(ws, tests, {
    timeoutMs: options.measureTimeoutMs ?? 1_800_000,
    cwd: copy,
    scratch: `${copy}/.git`,
  });
  const agentCases = run.cases;
  // 分母固定在人这一侧（不在 agent 的代码上现收）：B 为人的代码上每遍都通过的用例，A 为人的代码上收集出的全部用例；
  // 时过时不过的单独计数（不进 B）
  const human = await options.reference.casesAt(step.commit, tests);
  const humanPassing = new Set(human.passing);
  const humanCollected = new Set(human.cases.map((c) => c.id));
  const humanCasesB = human.cases.map((c) =>
    humanPassing.has(c.id)
      ? c
      : { ...c, outcome: c.outcome === "passed" ? ("failed" as const) : c.outcome }
  );
  const nowPassing = new Set(agentCases.filter((c) => c.outcome === "passed").map((c) => c.id));
  let regressions = 0;
  for (const id of state.agentPassing) {
    if (humanPassing.has(id) && !nowPassing.has(id)) regressions++;
  }
  state.agentPassing = nowPassing;
  const tasks = steps.filter((s) => s.kind === "task" && s.seq <= step.seq);
  const byTask = taskPassRate(tasks, humanCasesB, agentCases);
  const quality = async (check: StreamRepoRuntime["quality"]["type"]) => {
    if (check === null) return null;
    const r = await ws.run(check.command, 900_000, copy);
    return countQuality(check, r.output, r.exitCode);
  };
  return {
    fullPassRate: {
      byCount: countPassRate(humanPassing, agentCases),
      byCountCollected: countPassRate(humanCollected, agentCases),
      byTask: { passed: byTask.passed, total: byTask.total, rate: byTask.rate },
      humanFlaky: human.flaky.length,
      humanRuns: human.runs,
      humanSlowest: human.slowest,
    },
    regressions,
    quality: {
      typeErrors: await quality(runtime.quality.type),
      formatErrors: await quality(runtime.quality.format),
      layerViolations: await quality(runtime.quality.layer),
    },
  };
}

async function runStep(
  options: RunStreamsOptions,
  job: StreamJobId,
  spec: ConditionSpec,
  agent: StepAgent,
  env: StreamEnvironment,
  steps: readonly StreamStep[],
  step: StreamStep,
  state: JobState,
  jobDir: string
): Promise<StreamResultLine> {
  const started = Date.now();
  const { ws } = env;
  const base = {
    repo: options.manifest.repo,
    stream: job.stream,
    condition: job.condition,
    attempt: job.attempt,
    seq: step.seq,
    kind: step.kind,
    commit: step.commit,
    harnessRef: options.harnessRef,
    limitPauses: [],
  };
  // 回到本步起点：上一步结束时的 HEAD
  await ws.rollback(state.head);
  if (step.kind === "skip" || step.kind === "reset") {
    return {
      ...base,
      outcome: "skipped",
      head: state.head,
      judged: false,
      repairRounds: null,
      reverted: false,
      finalVerdict: null,
      repairBudgetExhausted: null,
      fullPassRate: state.previous?.fullPassRate ?? null,
      regressions: 0,
      quality: state.previous?.quality ?? null,
      status: null,
      turns: 0,
      usage: ZERO_USAGE,
      agentWallMs: 0,
      wallMs: Date.now() - started,
      attribution: null,
    };
  }
  await ws.applyHumanFiles(step.humanFiles, (p) => options.human.show(step.commit, p));
  await syncEnv(options, ws);
  let result: StepAgentResult | null = null;
  let judged = false;
  let passed = false;
  let judgeOutput = "";
  let reverted = false;
  let head: string;
  if (step.kind === "apply") {
    head = await ws.land(step.message);
  } else {
    const key = streamJobKey(job);
    const before = options.gateway?.meter(key);
    const release = await options.limits?.acquire();
    try {
      result = await agent.run({
        job,
        step,
        prompt: step.prompt ?? step.message,
        condition: spec,
        target: env.target,
        budget: options.budget ?? DEFAULT_STEP_BUDGET,
        verify: {
          command: verifyScript(options.runtime.verifySteps),
          timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        },
        workDir: jobDir,
        ...(options.gateway !== undefined ? { modelBaseUrl: options.gateway.jobBaseUrl(key) } : {}),
      });
    } finally {
      release?.();
    }
    if (options.gateway !== undefined && before !== undefined) {
      // 四个条件同一口径：轮数即成功转发的模型请求数，token 取网关读到的用量
      const d = meterDelta(options.gateway.meter(key), before);
      result = {
        ...result,
        turns: d.requests,
        usage: {
          ...ZERO_USAGE,
          input: d.input,
          output: d.output,
          cacheRead: d.cacheRead,
          cacheWrite: d.cacheWrite,
          totalTokens: d.input + d.output + d.cacheRead + d.cacheWrite,
        },
      };
    }
    if (result.interrupted !== undefined) {
      await ws.rollback(state.head);
      throw new StepInterruptedError(`第 ${step.seq} 步被打断，整题作废：${result.interrupted}`);
    }
    await ws.normalizeTo(state.head);
    await restoreTests(options, ws, step);
    await syncEnv(options, ws);
    // 题：判题测试的逐用例结果（不看退出码）；维护步：验证门
    if (step.kind === "task") {
      const run = await options.runtime.runCases(ws, step.judgeTests, {
        timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        scratch: `${ws.root}/.git`,
      });
      passed = allPassed(run);
      judgeOutput = run.output;
    } else {
      const judgement = await ws.run(
        [...options.manifest.gateCommand],
        options.judgeTimeoutMs ?? 1_800_000
      );
      passed = judgement.exitCode === 0 && !judgement.timedOut;
      judgeOutput = judgement.output;
    }
    judged = true;
    // 154：回炉开启且最后一次验证失败即已撤回
    reverted = spec.revert && result.repair?.finalVerdict === "fail";
    if (reverted) {
      await ws.rollback(state.head);
      head = state.head;
    } else {
      head = await ws.land(step.message);
    }
  }
  const measured = await measure(options, env, steps, step, state);
  const attribution = judged
    ? attributeFailure({
        passed: passed && !reverted,
        missing: extractMissing(judgeOutput, ws.root),
        revertedCreated: state.revertedCreated,
        maintenanceCreated: state.maintenanceCreated,
        regressions: measured.regressions,
      })
    : null;
  if (reverted && step.kind === "task") state.revertedCreated.push(createdFor(options, step));
  if (step.kind === "maintenance") state.maintenanceCreated.push(createdFor(options, step));
  return {
    ...base,
    outcome: step.kind === "apply" ? "applied" : passed && !reverted ? "passed" : "failed",
    head,
    judged,
    repairRounds: result?.repair?.rounds ?? null,
    reverted,
    finalVerdict: result?.repair?.finalVerdict ?? null,
    repairBudgetExhausted:
      result?.repair === null || result?.repair === undefined
        ? null
        : (result.repair.budgetExhausted ?? false),
    ...(result?.repair?.restoreError !== undefined
      ? { error: `回炉撤回时工作区未恢复（跑批器已按本步起点复原）：${result.repair.restoreError}` }
      : {}),
    fullPassRate: measured.fullPassRate,
    regressions: measured.regressions,
    quality: measured.quality,
    status: result?.status ?? null,
    turns: result?.turns ?? 0,
    usage: result?.usage ?? ZERO_USAGE,
    agentWallMs: result?.wallMs ?? 0,
    wallMs: Date.now() - started,
    attribution,
  };
}

// ---------- 容器实现 ----------

export const STREAM_CONTAINER_ROOT = "/testbed";
export const STREAM_MEASURE_ROOT = "/measure";

// 每个作业一个断网容器；续跑时不复用残留容器，一律由镜像加导出的流历史重建
export function dockerStreamEnvs(input: {
  image: string;
  human: HumanRepo;
  // 容器名前缀（区分输出目录）
  prefix: string;
  docker?: readonly string[];
  runArgs?: readonly string[];
}): StreamEnvFactory {
  const docker = input.docker ?? ["docker"];
  return {
    async open(job, init) {
      const container = `${input.prefix}-${jobDirName(job)}`;
      await removeWorkspaceContainer(container, docker);
      await startWorkspaceContainer({
        image: input.image,
        name: container,
        docker,
        runArgs: [
          ...WORKSPACE_NETWORK_ARGS,
          "--label",
          `pigeon.stream=${input.prefix}`,
          ...(input.runArgs ?? []),
        ],
      });
      const ws = new StreamWorkspace(
        dockerStreamShell({ container, root: STREAM_CONTAINER_ROOT, docker })
      );
      try {
        if (init.resume !== undefined)
          await ws.restoreFromBundle(init.resume.bundle, init.resume.head);
        else await ws.initFromBundle(input.human.bundle(init.startCommit), init.startCommit);
      } catch (error) {
        await removeWorkspaceContainer(container, docker).catch(() => {});
        throw error;
      }
      return {
        ws,
        target: { container, root: STREAM_CONTAINER_ROOT },
        measureRoot: STREAM_MEASURE_ROOT,
        dispose: () => removeWorkspaceContainer(container, docker),
      };
    },
  };
}

// 人的基准：在装有人的完整历史的参考工作区里检出该提交、跑同一批测试，跑 repeat 遍（缺省 2）逐条比对——每遍都通过的
// 进 B 口径的分母，各遍结果不一致的标为时过时不过；第一遍收集出的全部用例即 A 口径的分母。结果按提交缓存到磁盘，各条件共用
export class ReferenceCases implements HumanReferenceCases {
  private readonly reference: ReferenceWorkspace;
  private readonly runtime: StreamRepoRuntime;
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private readonly repeat: number;
  private readonly cgroupDir: string;
  private readonly warn: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    reference: ReferenceWorkspace;
    runtime: StreamRepoRuntime;
    cacheDir: string;
    timeoutMs?: number;
    repeat?: number;
    // 容器内 cgroup v2 的目录（测试时指向假的目录）；告警出口缺省为标准错误
    cgroupDir?: string;
    warn?: (message: string) => void;
  }) {
    this.reference = input.reference;
    this.runtime = input.runtime;
    this.cacheDir = input.cacheDir;
    this.timeoutMs = input.timeoutMs ?? 1_800_000;
    this.repeat = Math.max(1, input.repeat ?? 2);
    this.cgroupDir = input.cgroupDir ?? "/sys/fs/cgroup";
    this.warn = input.warn ?? ((m) => console.error(m));
    mkdirSync(this.cacheDir, { recursive: true });
  }

  // 这个提交的基准是否已落盘（提前单独算过的直接读）
  has(commit: string): boolean {
    return existsSync(path.join(this.cacheDir, `${commit}.json`));
  }

  casesAt(commit: string, tests: readonly string[]): Promise<HumanBaseline> {
    // 参考工作区只有一份：各作业的请求排队依次做
    const run = this.queue.then(() => this.compute(commit, tests));
    this.queue = run.catch(() => {});
    return run;
  }

  private async compute(commit: string, tests: readonly string[]): Promise<HumanBaseline> {
    const file = path.join(this.cacheDir, `${commit}.json`);
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as HumanBaseline;
      return { ...saved, runs: saved.runs ?? [], slowest: saved.slowest ?? null };
    }
    const ws = this.reference.ws;
    await this.reference.checkout(commit);
    if (this.runtime.envSyncCommand !== null) {
      const sync = await ws.run(this.runtime.envSyncCommand, 120_000);
      if (sync.exitCode !== 0) throw new Error(`参考工作区依赖切换失败（${commit}）`);
    }
    const runs: TestCaseResult[][] = [];
    const meta: BaselineRun[] = [];
    for (let k = 0; k < this.repeat; k++) {
      const started = Date.now();
      const {
        result: run,
        peakBytes,
        limitBytes,
      } = await this.sampleMemory(() =>
        this.runtime.runCases(ws, tests, {
          timeoutMs: this.timeoutMs,
          scratch: `${ws.root}/.git`,
        })
      );
      meta.push({ peakBytes, limitBytes, wallMs: Date.now() - started });
      if (peakBytes !== null && limitBytes !== null && peakBytes > limitBytes * MEMORY_WARN_RATIO) {
        const mib = (b: number) => Math.round(b / 1048576);
        this.warn(
          `【内存告警】人的基准 ${commit} 第 ${k + 1} 遍：容器内存峰值 ${mib(peakBytes)} MiB，` +
            `超过上限 ${mib(limitBytes)} MiB 的 ${MEMORY_WARN_RATIO * 100}%，作业容器的内存上限可能不够`
        );
      }
      // 人这一侧拿不全就没有可信的分母：报错停下，不以缺了用例的基准静默缩小分母
      if (!run.complete) {
        throw new Error(
          `人的基准没拿到全部用例的结果（${commit}，第 ${k + 1} 遍）：${run.output.slice(-500)}`
        );
      }
      runs.push(run.cases);
    }
    const baseline = { ...compareRuns(runs), runs: meta };
    writeAtomic(file, JSON.stringify(baseline));
    return baseline;
  }

  // 做 work 的同时在参考容器里采样内存，返回期间的峰值与上限
  private async sampleMemory<T>(
    work: () => Promise<T>
  ): Promise<{ result: T; peakBytes: number | null; limitBytes: number | null }> {
    const ws = this.reference.ws;
    const stop = `${ws.root}/.git/pigeon-memory-stop`;
    await ws.run(["rm", "-f", stop], 30_000);
    const sampler = ws.run(
      ["sh", "-c", MEMORY_SAMPLER, "sh", stop, this.cgroupDir],
      this.timeoutMs * 2 + 600_000
    );
    let result: T;
    try {
      result = await work();
    } finally {
      await ws.run(["touch", stop], 30_000);
    }
    const out = (await sampler).output;
    const peak = /^peak (\d+)$/m.exec(out)?.[1];
    const max = /^max (\d+)$/m.exec(out)?.[1];
    return {
      result,
      peakBytes: peak !== undefined ? Number(peak) : null,
      limitBytes: max !== undefined ? Number(max) : null,
    };
  }
}

// 多遍结果逐条比对：每遍都通过的为 passing；在某一遍缺席或结果与别遍不同的为 flaky；cases 取各遍收集出的并集；
// slowest 为各遍里耗时最长的用例
export function compareRuns(
  runs: readonly (readonly TestCaseResult[])[]
): Omit<HumanBaseline, "runs"> {
  const all = new Map<string, TestCaseResult>();
  for (const r of runs) for (const c of r) if (!all.has(c.id)) all.set(c.id, c);
  const outcomes = runs.map((r) => new Map(r.map((c) => [c.id, c.outcome])));
  const ids = new Set(runs.flatMap((r) => r.map((c) => c.id)));
  const passing: string[] = [];
  const flaky: string[] = [];
  for (const id of ids) {
    const seen = outcomes.map((m) => m.get(id));
    if (seen.every((o) => o === "passed")) passing.push(id);
    else if (new Set(seen).size > 1) flaky.push(id);
  }
  let slowest: HumanBaseline["slowest"] = null;
  for (const r of runs) {
    for (const c of r) {
      if (c.seconds !== undefined && (slowest === null || c.seconds > slowest.seconds)) {
        slowest = { id: c.id, seconds: c.seconds };
      }
    }
  }
  return { cases: [...all.values()], passing, flaky, slowest };
}
