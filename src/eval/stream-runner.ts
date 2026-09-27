// 延续式跑批器（决策 126 修订、140、142、143、145、147、148；第三、四、六节）：agent 按历史顺序一步一步地做，
// 每一步都在它自己上一步留下的代码上接着做。每条流乘以每个条件（乘以第几遍）为一个独立作业，共用工作队列并行（缺省 4 路）。
// 每一步：回到本步起点 → 程序写入该步人的测试、测试辅助与环境文件 → 按条件运行 agent → 恢复 agent 动过的测试 →
// 判定（题：判题测试；维护步：验证门）→ 落地提交（没做好也照样落地，后续在它之上接着做）→ 在另一份副本上做全量测量 →
// 失败归因 → 导出流历史 → 写结果行。被打断的一步整题作废、回到本步起点、不留结果行（144）；崩溃后从结果行与导出的
// 流历史续跑。agent 怎么跑（Pigeon 在进程内、最简 agent 在宿主上）与模型怎么接入都在 StepAgent 之后，跑批器不感知。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import type { TurnUsage } from "../state/runtime-events.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import { type GatewayMeter, meterDelta } from "./model-gateway.ts";
import { type LimitController, QUEUE_VOID_MS } from "./model-limits.ts";
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
  failedStepsOf,
  gateFromSteps,
  pinTestConfigFromTree,
  STRANDS_CASE_TIMEOUT_SEC,
  type StreamRepoRuntime,
  type StreamVerifyStep,
  verifyConfigFile,
  verifyScript,
} from "./stream-profiles.ts";
import { renderStreamReport } from "./stream-report.ts";
import {
  lastCompletedStep,
  MEMORY_WARN_RATIO,
  readStreamResults,
  type StreamCondition,
  type StreamGatewayFacts,
  type StreamJobId,
  type StreamResultLine,
  streamJobKey,
  ZERO_USAGE,
} from "./stream-results.ts";
import {
  type CommandOutcome,
  dockerStreamShell,
  removeCoveringHelpers,
  StreamWorkspace,
  StreamWorkspaceAccessError,
} from "./stream-workspace.ts";
import { runWorkQueue } from "./work-queue.ts";

// 四个条件（126 修订、140）：完整 Pigeon 开回炉与结构化记忆；去掉记忆只关结构化记忆；去掉验证门即不开回炉；
// 最简 agent 另走启动器
export interface ConditionSpec {
  name: StreamCondition;
  agent: "pigeon" | "minimal";
  // 回炉轮数上限（143）；0 为不开回炉。回炉到上限仍不通过即以失败收尾、代码照样落地（172 / 173）
  repairRounds: number;
  memory: boolean;
}

export const CONDITION_SPECS: Record<StreamCondition, ConditionSpec> = {
  full: { name: "full", agent: "pigeon", repairRounds: 3, memory: true },
  "no-memory": { name: "no-memory", agent: "pigeon", repairRounds: 3, memory: false },
  "no-gate": { name: "no-gate", agent: "pigeon", repairRounds: 0, memory: false },
  minimal: { name: "minimal", agent: "minimal", repairRounds: 0, memory: false },
};

// 每步总预算（147）：各条件同一个，包括轮数与墙钟，回炉的消耗计入其中；先按 150 轮、30 分钟，试跑后定死
export interface StepBudget {
  maxTurns: number;
  wallClockMs: number;
}

// 每步预算（147 校准）：在正式实验的服务器上以完整 Pigeon 试跑 10 步，轮数与墙钟各取第 90 百分位（78 轮、约 14.3 分钟）
// 乘 1.5，且分别不低于 150 轮、30 分钟，两项都由下限起作用，得 150 轮、30 分钟；四个条件同额，回炉的消耗计入其中
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
  // 开回炉的条件按它验证：这条流的分步验证（各步名称、命令与执行目录，Pigeon 原样交给 headless，逐步出结论）、
  // 由它派生的一行命令（交 sh -c、在工作区根执行，给只认一条命令的 agent）与超时
  verify: { steps: readonly StreamVerifyStep[]; command: string; timeoutMs: number };
  // 宿主上给这个作业用的目录（会话账本等）
  workDir: string;
  // 跑批器按步中止（本作业在网关排队超时等）：agent 与限额信号同一条路径停下（中止 agent、清掉容器里的进程），
  // 报被打断
  abortSignal?: AbortSignal;
  // 经网关时，这个作业的模型接入地址（决策 155）
  modelBaseUrl?: string;
  // 人在这一步的树里的测试与测试辅助文件：回炉验证前只还原（并计数）这些，agent 早先步骤落地的自己的测试不算
  humanTestFiles?: ReadonlySet<string>;
  // 测试框架自动加载的辅助文件名（strands 为 conftest.py）、人在这一步的测试文件与人在这一步的树里的全部路径：回炉
  // 验证前按与判题前同一规则删掉 agent 放的、覆盖人写测试的这类文件（人树里有的一律不删，例如仓库根的 conftest.py）
  autoloadedTestHelper?: string;
  humanTests?: readonly string[];
  humanTree?: readonly string[];
  // 定点对照的单步重跑（决策 157）：结构化记忆开启、挑选固定为这几条（空即一条不给），走正常推送路径；流中不给
  structuredMemoryFixed?: { opening: readonly string[]; repair: readonly string[] };
}

// 网关对跑批器露出的：作业的接入地址、作业的计量、每步开始时重记在途峰值、排队看守
export interface StreamModelGateway {
  jobBaseUrl(job: string): string;
  meter(job: string): GatewayMeter;
  resetPeak(job: string): void;
  watchQueue?(job: string, thresholdMs: number, listener: () => void): () => void;
}

// 一步的 agent 在放行机制下运行（决策 144、160、163；正式跑批与预算试跑共用）：
//   先等放行（同时在跑的 agent 数小于网关的可用容量且不超过配置路数；等待发生在 agent 开始之前，不计入这一步的
//   墙钟预算，不作废、不耗额度，时长交回记入结果行）；放行后记下限额信号数与本作业的计量，跑 agent；
//   本作业在网关累计等空闲账号超过 QUEUE_VOID_MS 即经按步中止立即停下 agent（不等它跑完）；
//   结束后比较：期间有限额信号、本作业有上游故障、排队超时或 agent 自报被打断，即作废（不看是哪种 agent，
//   也不看 agent 自己报没报被打断）
export interface AdmittedAgentRun {
  result: StepAgentResult;
  delta: GatewayMeter | undefined;
  admissionWaitMs: number;
  // 作废的原因；空即不作废
  voidReasons: string[];
  // 作废源于限额信号、上游故障或排队超时
  limitRelated: boolean;
  // 作废只因排队超时（期间没有限额信号与上游故障）：单独计数，不计入限额信号类作废的上限
  queueOnly: boolean;
}

export async function runAdmittedAgent(
  options: { limits?: LimitController; gateway?: StreamModelGateway },
  key: string,
  run: (abortSignal: AbortSignal) => Promise<StepAgentResult>
): Promise<AdmittedAgentRun> {
  const admission = await options.limits?.acquire();
  // 放行之后任何一条语句抛错都要交还放行名额：紧接着进 try
  let signalsBefore = 0;
  let before: GatewayMeter | undefined;
  let queueExceeded = false;
  let stopQueueWatch: (() => void) | undefined;
  let result: StepAgentResult;
  try {
    signalsBefore = options.limits?.signals ?? 0;
    before = options.gateway?.meter(key);
    options.gateway?.resetPeak(key);
    const stepAbort = new AbortController();
    stopQueueWatch = options.gateway?.watchQueue?.(key, QUEUE_VOID_MS, () => {
      queueExceeded = true;
      stepAbort.abort();
    });
    result = await run(stepAbort.signal);
  } finally {
    stopQueueWatch?.();
    admission?.();
  }
  const delta =
    options.gateway !== undefined && before !== undefined
      ? meterDelta(options.gateway.meter(key), before)
      : undefined;
  const signalled = (options.limits?.signals ?? 0) !== signalsBefore;
  const upstreamFailed = (delta?.upstreamFailures ?? 0) > 0;
  const queued = queueExceeded || (delta?.queueMs ?? 0) > QUEUE_VOID_MS;
  const voidReasons = [
    signalled ? "期间出现限额信号" : undefined,
    upstreamFailed ? `本作业的上游故障 ${delta?.upstreamFailures} 次` : undefined,
    queued
      ? `等空闲账号累计 ${Math.round((delta?.queueMs ?? 0) / 1000)} 秒（超过 ${QUEUE_VOID_MS / 1000} 秒）`
      : undefined,
    result.interrupted !== undefined ? `agent 报被打断：${result.interrupted}` : undefined,
  ].filter((x) => x !== undefined);
  return {
    result,
    delta,
    admissionWaitMs: admission?.waitedMs ?? 0,
    voidReasons,
    limitRelated: signalled || upstreamFailed || queued,
    queueOnly: queued && !signalled && !upstreamFailed,
  };
}

export interface StepAgentResult {
  status: string;
  turns: number;
  usage: TurnUsage;
  wallMs: number;
  // 开回炉的条件：用了几轮、最后一次验证结论（无法判定为 null）；未开回炉为 null
  repair: {
    rounds: number;
    finalVerdict: "pass" | "fail" | null;
    // 验证之前发现 agent 改过人写测试并还原的次数（容器模式的 Pigeon 给出；缺省按 0 记）
    humanTestRestores?: number;
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
    init: { startCommit: string; resume?: { head: string; seq: number; bundle: Buffer } }
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

// 人的代码在某提交上跑验证门的结果（开跑前置检查：人的代码过不了验证门的步要清零或逐个定夺）
export interface GateCheck {
  passed: boolean;
  // 没过的步（验证命令里"== 步名 未通过 =="的行）
  failedSteps: string[];
  wallMs: number;
  outputTail: string;
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

// agent 自报被打断、期间却没有任何限额信号或上游故障：最多重做这么多次
export const MAX_BARE_INTERRUPTIONS = 3;
// 同一步因限额信号、上游故障或排队超时被作废：累计到前一个数先向标准错误告警，到后一个数停下作业，免得无止境重做
export const SIGNALLED_VOID_WARN = 5;
export const SIGNALLED_VOID_STOP = 10;
// 同一步只因排队超时被作废（额度环境造成，不是这一步本身的故障）：单独计数，累计到前一个数告警一次，到后一个数停下作业
export const QUEUE_VOID_WARN = 10;
export const QUEUE_VOID_STOP = 30;

// 治理根里的会话文件（会话账本与旁置的正文文件）
function sessionFilesOf(jobDir: string): string[] {
  const dir = path.join(jobDir, ".pigeon", "sessions");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// 清掉一次作废的尝试留在治理根里的痕迹：不在 keep 里的会话文件移到输出目录下、治理根之外的隔离目录（保留备查），
// 结构化记忆缓存删掉、下次由其余会话重建——重做时会话检索与结构化记忆都看不到作废的尝试，与从零开始的最简 agent 对等
function quarantineSessions(
  outDir: string,
  job: StreamJobId,
  jobDir: string,
  keep: ReadonlySet<string>,
  label: string
): number {
  const dir = path.join(jobDir, ".pigeon", "sessions");
  const stray = sessionFilesOf(jobDir).filter((f) => !keep.has(f));
  if (stray.length > 0) {
    const target = path.join(outDir, "voided", jobDirName(job), label);
    mkdirSync(target, { recursive: true });
    for (const file of stray) renameSync(path.join(dir, file), path.join(target, file));
  }
  rmSync(path.join(jobDir, ".pigeon", "cache"), { recursive: true, force: true });
  return stray.length;
}

// 一步作废：signalled 为这一步期间出现过限额信号、本作业的上游故障或排队超时（无论 agent 怎么报），否则是 agent 自报被打断；
// queued 为作废只因排队超时（额度环境造成，单独计数）
export class StepInterruptedError extends Error {
  override name = "StepInterruptedError";
  readonly signalled: boolean;
  readonly queued: boolean;
  constructor(message: string, signalled: boolean, queued = false) {
    super(message);
    this.signalled = signalled;
    this.queued = queued;
  }
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
  // 告警（缺省写标准错误输出）
  warn?: (line: string) => void;
  // 限额统一处理（决策 144、155）：每步前等放行、agent 运行时占一路；这一步撞上限额即作废、恢复后重做
  limits?: LimitController;
  // 经网关时：轮数与 token 一律取网关的按作业计量，四个条件同一口径
  gateway?: StreamModelGateway;
  // 身份头的摘要与各 agent 的参数：原样记进每条结果行（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）
  runIdentity?: string;
  agentSettings?: Partial<Record<ConditionSpec["agent"], Record<string, unknown>>>;
  // 调用方已对输出目录取了锁（CLI 入口在写身份头、开跑前探测之前就取）：这里不再取
  outDirLocked?: boolean;
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

export function jobDirName(job: StreamJobId): string {
  return `${job.stream}-${job.condition}-${job.attempt}`;
}

// 结果行逐行追加：进程死于写到一半（例如停服超时被 SIGKILL）会留下没有换行的半行，之后追加的整行会接在它后面、
// 一起读不出来。开跑前补一个换行把它隔开（读时照常丢弃这半行）
export function sealTornTail(file: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file);
  if (content.length > 0 && content[content.length - 1] !== 0x0a) appendFileSync(file, "\n");
}

function writeAtomic(file: string, content: Buffer | string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// 输出目录的单实例锁：同一时刻只许一个跑批进程写同一个输出目录（锁文件记持有进程；持有者已死的残留锁由下一个进程接管，
// 与项目里其余跨进程锁同一口径）
export const RUN_LOCK = "run.lock";

export function lockOutDir(outDir: string): () => void {
  mkdirSync(outDir, { recursive: true });
  return acquireExclusiveLock(
    path.join(outDir, RUN_LOCK),
    `输出目录 ${outDir} 正被另一个跑批进程使用，拒绝同时写同一目录`
  );
}

export async function runStreams(options: RunStreamsOptions): Promise<RunStreamsSummary> {
  const release = options.outDirLocked === true ? () => {} : lockOutDir(options.outDir);
  try {
    return await runStreamsLocked(options);
  } finally {
    release();
  }
}

async function runStreamsLocked(options: RunStreamsOptions): Promise<RunStreamsSummary> {
  mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, "results.jsonl");
  sealTornTail(resultsFile);
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
  // 作业目录即 agent 的治理根：条件 × 流 × 遍次各一个。结构化记忆从治理根里的以往会话派生，
  // 所以只在同一条流里沿步累积，不跨条件、遍次或流串用；目录名必须同时含这三者
  const jobDir = path.join(options.outDir, "streams", jobDirName(job));
  mkdirSync(jobDir, { recursive: true });
  // 分步验证配置另存一份在作业的治理根，供事后查看这个作业验证的是什么（Pigeon 的验证不读它：跑批器每步把分步配置
  // 直接交给步 agent）；不写进容器工作区，免得被当成 agent 的改动落地提交
  mkdirSync(path.join(jobDir, ".pigeon"), { recursive: true });
  writeAtomic(
    path.join(jobDir, ".pigeon", "verify.json"),
    `${JSON.stringify(verifyConfigFile(options.runtime.verifySteps, options.judgeTimeoutMs ?? 1_800_000), null, 2)}\n`
  );
  const bundleFile = path.join(jobDir, "history.bundle");
  const passingFile = (seq: number) => path.join(jobDir, `passing-${seq}.json`);
  // 每步完成时治理根里的会话文件清单：续跑时不在上一个完成步清单里的会话（进程死在一步中途留下的）一律移出
  const sessionsFile = (seq: number) => path.join(jobDir, `sessions-${seq}.json`);
  const lines = readStreamResults(resultsFile);
  const last = lastCompletedStep(lines, job);
  const remaining = steps.filter((s) => last === undefined || s.seq > last.seq);
  if (remaining.length === 0) return last?.seq ?? null;
  const log = (text: string) => options.log?.(`[${streamJobKey(job)}] ${text}`);
  const warn = options.warn ?? ((line: string) => process.stderr.write(`[跑批] ${line}\n`));
  if (last !== undefined && !existsSync(bundleFile)) {
    throw new Error(`续跑缺流历史：${bundleFile} 不存在（断点在第 ${last.seq} 步）`);
  }
  // 开容器（接管或重建）之前先看控制器：已停下（收到停止信号、每月额度用完）的不再开，免得开了又删
  await options.limits?.ready();
  const env = await options.envs.open(job, {
    startCommit: segment.startCommit,
    ...(last !== undefined
      ? { resume: { head: last.head, seq: last.seq, bundle: readFileSync(bundleFile) } }
      : {}),
  });
  try {
    // 进程死在一步中途（被杀、整机重启）时，那次尝试的会话还在治理根里；续跑重做这一步之前同样移出
    const committed =
      last === undefined
        ? new Set<string>()
        : existsSync(sessionsFile(last.seq))
          ? new Set(JSON.parse(readFileSync(sessionsFile(last.seq), "utf8")) as string[])
          : undefined;
    if (committed !== undefined) {
      const moved = quarantineSessions(
        options.outDir,
        job,
        jobDir,
        committed,
        `resume-after-${last?.seq ?? 0}-${Date.now()}`
      );
      if (moved > 0) log(`续跑：上次中断的一步留下 ${moved} 个会话文件，已移出治理根`);
    }
    const state: JobState = {
      head: await env.ws.head(),
      previous: last,
      agentPassing:
        last !== undefined && existsSync(passingFile(last.seq))
          ? new Set(JSON.parse(readFileSync(passingFile(last.seq), "utf8")) as string[])
          : new Set(),
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
      // 连续被打断、期间却没有任何限额信号或上游故障的次数：超过上限即停下作业，不无限重做
      let bareInterruptions = 0;
      let signalledVoids = 0;
      let queueVoids = 0;
      let attempt = 0;
      for (;;) {
        await limits?.ready();
        attempt += 1;
        const sessionsBefore = new Set(sessionFilesOf(jobDir));
        try {
          row = await runStep(options, job, spec, agent, env, steps, step, state, jobDir);
          // 这一步开始之后收到过停止信号：不论判题、测量进行到哪（停止信号可能打断了它们），这一步作废、不写行，
          // 回到本步起点后作业在取下一步时停下
          if (limits?.shutdownReason !== undefined) {
            await env.ws.discardAttempt(state.head, step.seq - 1, env.measureRoot);
            throw new StepInterruptedError(`第 ${step.seq} 步作废：${limits.shutdownReason}`, true);
          }
          break;
        } catch (error) {
          // 这一步作废（决策 144、160）：已回到本步起点、不留行，等放行后重做同一步
          if (!(error instanceof StepInterruptedError)) throw error;
          quarantineSessions(
            options.outDir,
            job,
            jobDir,
            sessionsBefore,
            `step-${step.seq}-attempt-${attempt}`
          );
          if (error.queued) {
            bareInterruptions = 0;
            queueVoids += 1;
            if (queueVoids >= QUEUE_VOID_STOP) {
              throw new Error(
                `第 ${step.seq} 步因排队超时累计作废 ${queueVoids} 次：停下作业（最后一次：${error.message}）`
              );
            }
            if (queueVoids === QUEUE_VOID_WARN) {
              warn(
                `[${streamJobKey(job)}] 第 ${step.seq} 步因排队超时已累计作废 ${queueVoids} 次，仍在重做；累计 ${QUEUE_VOID_STOP} 次即停下这个作业`
              );
            }
            log(
              `第 ${step.seq} 步第 ${queueVoids} 次排队作废（不计入限额信号类的累计上限；累计 ${QUEUE_VOID_STOP} 次即停下）：${error.message}`
            );
            continue;
          }
          if (error.signalled) {
            bareInterruptions = 0;
            signalledVoids += 1;
            if (signalledVoids >= SIGNALLED_VOID_STOP) {
              throw new Error(
                `第 ${step.seq} 步因限额信号或上游故障累计作废 ${signalledVoids} 次：停下作业（最后一次：${error.message}）`
              );
            }
            if (signalledVoids === SIGNALLED_VOID_WARN) {
              warn(
                `[${streamJobKey(job)}] 第 ${step.seq} 步因限额信号或上游故障已累计作废 ${signalledVoids} 次，仍在重做；累计 ${SIGNALLED_VOID_STOP} 次即停下这个作业`
              );
            }
            log(
              `第 ${step.seq} 步撞上限额、上游故障或排队超时，作废，恢复后重做：${error.message}`
            );
            continue;
          }
          bareInterruptions += 1;
          if (bareInterruptions > MAX_BARE_INTERRUPTIONS) {
            throw new Error(
              `第 ${step.seq} 步连续 ${bareInterruptions} 次被打断，期间没有限额信号或上游故障：停下作业（${error.message}）`
            );
          }
          log(`第 ${step.seq} 步被打断，作废重做（第 ${bareInterruptions} 次）：${error.message}`);
        }
      }
      row.limitPauses = limits?.pausesSince(epochAtStart) ?? [];
      // 先存流历史与测量基线、后写结果行：两者之间崩溃时，断点行仍指向上一步，导出的历史里也有上一步的提交
      writeAtomic(bundleFile, await env.ws.exportBundle());
      writeAtomic(passingFile(step.seq), JSON.stringify([...state.agentPassing]));
      writeAtomic(sessionsFile(step.seq), JSON.stringify(sessionFilesOf(jobDir)));
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      state.previous = row;
      state.head = row.head;
    }
    return steps.at(-1)?.seq ?? null;
  } finally {
    // 因停止信号（停服、关机）停下的作业留着容器，重启后续跑接管它；其余情形照常删掉
    if (options.limits?.shutdownReason === undefined) await env.dispose();
  }
}

// 依赖环境选不出来（没有满足该步依赖声明的组合、lint 映射里没有该提交）：这一步作废，作业照常往下走
// select-env / select-lint 的"没有可用组合 / 映射里没有该提交"
export const ENV_UNAVAILABLE_EXIT = 3;

export class EnvSelectionError extends Error {
  override name = "EnvSelectionError";
}

// 切依赖（148 修订）：运行环境与 lint 环境都按该步人的提交选——运行方式给了依赖声明文件时，把人在该步的
// 这份声明写到工作区 .git 下的临时位置再交给切换命令，不看 agent 改过的；没给则按工作区里的声明（envSyncCommand）
export async function syncEnv(
  options: Pick<RunStreamsOptions, "runtime" | "human">,
  ws: StreamWorkspace,
  humanCommit: string,
  cwd?: string
): Promise<void> {
  const runtime = options.runtime;
  let command = runtime.envSyncCommand;
  if (runtime.envDeclarationFile !== undefined && runtime.envSyncFor !== undefined) {
    const declared = `${ws.root}/.git/pigeon-human-env-declaration`;
    await ws.writeFile(declared, options.human.show(humanCommit, runtime.envDeclarationFile));
    command = runtime.envSyncFor(declared);
  }
  // 只有切换脚本明说"没有可用组合 / 映射里没有该提交"（退出码 3）才作废这一步；其余失败（超时、命令不在、容器故障等）
  // 是跑批环境的问题，停下作业报错，不写成跳过步
  const check = (what: string, r: CommandOutcome) => {
    if (r.exitCode === 0 && !r.timedOut) return;
    if (r.exitCode === ENV_UNAVAILABLE_EXIT && !r.timedOut)
      throw new EnvSelectionError(`${what}选择失败（${humanCommit}）：${r.output.slice(-500)}`);
    throw new Error(
      `${what}切换出错（${humanCommit}，退出码 ${r.exitCode}${r.timedOut ? "，超时" : ""}）：${r.output.slice(-500)}`
    );
  };
  // 切换命令是跑批器自己的命令：以固定 PATH 执行，不经过 agent 能改指的依赖环境链接
  const lint = runtime.lintSyncCommand?.(humanCommit);
  const switchEnvs = async (withConfig: boolean) => {
    if (command !== null)
      check("依赖环境", await ws.run(command, 120_000, cwd, { systemPath: true }));
    // 测试配置同样按人在该步的版本（agent 改的 pytest 配置不起作用）
    if (withConfig) {
      await runtime.pinTestConfig?.(ws, async (p) => {
        try {
          return options.human.show(humanCommit, p);
        } catch {
          return undefined;
        }
      });
    }
    if (lint !== undefined)
      check("lint 环境", await ws.run(lint, 120_000, cwd, { systemPath: true }));
  };
  // 判题、测量、验证门以镜像的 PATH 用这些链接。agent 能把链接或切换脚本的中间链接（<链接>.next）换成真目录，切换脚本
  // 的替换随之失败（EISDIR）：以 root、固定 PATH 删掉两者再切
  const links = runtime.envLinks;
  const clearLinks = async () => {
    if (links === undefined) return;
    await ws.asRoot('rm -rf -- "$@"', "删掉被改过的依赖环境链接", {
      args: links.flatMap((l) => [l.link, `${l.link}.next`]),
    });
  };
  const retryAfterClearing = async (withConfig: boolean) => {
    await clearLinks();
    try {
      await switchEnvs(withConfig);
    } catch (error) {
      if (error instanceof EnvSelectionError) throw error;
      throw new StreamWorkspaceAccessError(
        `删掉依赖环境链接之后切换仍失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  // 第一次切换之前先核对：链接已被改过即先删掉
  if (links !== undefined && !(await ws.envLinksIntact(links))) await clearLinks();
  try {
    await switchEnvs(true);
  } catch (error) {
    // 切换以 3 以外的退出码失败（例如中间链接被换成了目录）：配置了链接即删掉重试一次，仍失败按访问错误作废
    if (links === undefined || error instanceof EnvSelectionError) throw error;
    await retryAfterClearing(true);
  }
  // 核对切换结果：仍被改指或不是链接即删掉重切一次，仍不对则这一步作废
  if (links !== undefined && !(await ws.envLinksIntact(links))) {
    await retryAfterClearing(false);
    if (!(await ws.envLinksIntact(links))) {
      throw new StreamWorkspaceAccessError(
        `依赖环境的链接被改过，重切之后仍不在 root 所有的目录下（${links.map((l) => l.link).join("、")}）`
      );
    }
  }
}

// agent 是否改了依赖声明文件（与人在该步的版本不同，含删掉）；运行方式没有依赖声明为 null
async function agentChangedDeclaration(
  options: RunStreamsOptions,
  ws: StreamWorkspace,
  humanCommit: string
): Promise<boolean | null> {
  const file = options.runtime.envDeclarationFile;
  if (file === undefined) return null;
  const human = options.human.show(humanCommit, file);
  try {
    return !(await ws.readFile(`${ws.root}/${file}`)).equals(human);
  } catch {
    return true;
  }
}

// agent 不许改测试（决策 148）：它动过的测试与测试辅助文件，本步由程序写入的恢复成人的版本，其余恢复成本步起点的版本；
// 它新建的测试文件保留（全量测量只跑人写的测试）。把测试或测试辅助文件改了名的（暂存的改名）：改名后的路径删掉，
// 原路径另作一项、恢复成本步起点的版本
export async function restoreTests(
  options: Pick<RunStreamsOptions, "runtime" | "human">,
  ws: StreamWorkspace,
  step: StreamStep
): Promise<void> {
  await ws.grantOwnerAccess();
  const profile = options.runtime.profile;
  const isTest = (p: string) => {
    const kind = profile.classifyFile(p);
    return kind === "test" || kind === "testaux";
  };
  // agent 设了 skip-worktree 或 assume-unchanged 的文件对 git status 隐身：先去掉标记再看改动
  await ws.unmarkIndex();
  const all = await ws.changedPaths();
  const changed = all.filter((c) => isTest(c.path));
  const human = new Set(
    step.humanFiles.filter((f) => f.kind === "test" || f.kind === "testaux").map((f) => f.path)
  );
  await ws.removePaths(
    all
      .filter((c) => c.renamedFrom !== undefined && isTest(c.renamedFrom) && !human.has(c.path))
      .map((c) => c.path)
  );
  await ws.restoreFromHead(
    changed.filter((c) => !c.untracked && !human.has(c.path)).map((c) => c.path)
  );
  await ws.applyHumanFiles(
    step.humanFiles.filter((f) => human.has(f.path)),
    (p) => options.human.show(step.commit, p)
  );
  // 会被测试框架自动加载、改变人写测试的收集与执行的文件（strands 的 conftest.py）：不在人在该步树里、且所在目录的
  // 子树里有人在该步的测试文件的，判题之前删掉，也就不会落地；只作用于 agent 自己测试目录的保留。其余测试辅助（helper
  // 模块、数据文件、__init__.py 等）是 agent 自己测试的依赖，不动。候选逐个文件列出（被忽略的也算：agent 可以改
  // .gitignore 藏它）。测量副本另按人的测试集合同步（见 measure）
  const helper = options.runtime.autoloadedTestHelper;
  if (helper !== undefined) {
    const tree = options.human.tree(step.commit).map((e) => e.path);
    const inTree = new Set(tree);
    const humanTests = tree.filter((p) => profile.classifyFile(p) === "test");
    await removeCoveringHelpers(ws, helper, (p) => inTree.has(p), humanTests);
  }
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

// 全量测量（145、148）：在从 HEAD 克隆的副本上补齐人截至该步的全部测试与测试辅助文件（没做出来的题的测试也在内），
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
  // 副本里的测试与测试辅助文件与人的这一集合完全一致：agent 新建的（含 conftest.py 一类）先删掉，再写人的
  await ws.syncHumanFilesAt(
    copy,
    tree,
    (p) => options.human.show(step.commit, p),
    (p) => {
      const kind = runtime.profile.classifyFile(p);
      return kind === "test" || kind === "testaux" ? kind : null;
    }
  );
  await syncEnv(options, ws, step.commit, copy);
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
    gateway: null,
    admissionWaitMs: null,
    humanFailsGate: step.humanFailsGate === true,
    runIdentity: options.runIdentity ?? null,
    agentSettings: options.agentSettings?.[spec.agent] ?? null,
  };
  // 不做、不判的一行：跳过步，或因依赖环境选不出来而作废的步（回到本步起点、记下原因、沿用上一步的测量）
  const notRun = (error?: string): StreamResultLine => ({
    ...base,
    outcome: "skipped",
    head: state.head,
    judged: false,
    repairRounds: null,
    finalVerdict: null,
    humanTestRestores: null,
    agentChangedDeps: null,
    fullPassRate: state.previous?.fullPassRate ?? null,
    regressions: 0,
    quality: state.previous?.quality ?? null,
    status: null,
    turns: 0,
    usage: ZERO_USAGE,
    agentWallMs: 0,
    wallMs: Date.now() - started,
    attribution: null,
    ...(error !== undefined ? { error } : {}),
  });
  const voided = async (error: EnvSelectionError) => {
    await ws.discardAttempt(state.head, step.seq - 1);
    return notRun(`${error.message}（这一步作废）`);
  };
  // 回到本步起点：上一步结束时的 HEAD
  await ws.rollback(state.head);
  if (step.kind === "skip" || step.kind === "reset") return notRun();
  await ws.applyHumanFiles(step.humanFiles, (p) => options.human.show(step.commit, p));
  try {
    await syncEnv(options, ws, step.commit);
  } catch (error) {
    if (error instanceof EnvSelectionError) return voided(error);
    if (error instanceof StreamWorkspaceAccessError) {
      await ws.discardAttempt(state.head, step.seq - 1);
      throw new StepInterruptedError(`第 ${step.seq} 步作废：${error.message}`, false);
    }
    throw error;
  }
  let agentChangedDeps: boolean | null = null;
  let result: StepAgentResult | null = null;
  let gatewayFacts: StreamGatewayFacts | null = null;
  let admissionWaitMs: number | null = null;
  let judged = false;
  let passed = false;
  let judgeOutput = "";
  let head: string;
  if (step.kind === "apply") {
    head = await ws.land(step.message, state.head);
  } else {
    const key = streamJobKey(job);
    const admitted = await runAdmittedAgent(options, key, (abortSignal) =>
      agent.run({
        job,
        step,
        prompt: step.prompt ?? step.message,
        condition: spec,
        target: env.target,
        budget: options.budget ?? DEFAULT_STEP_BUDGET,
        verify: {
          steps: options.runtime.verifySteps,
          command: verifyScript(options.runtime.verifySteps),
          timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        },
        workDir: jobDir,
        humanTestFiles: new Set(
          options.human
            .tree(step.commit)
            .map((e) => e.path)
            .filter((p) => {
              const kind = options.runtime.profile.classifyFile(p);
              return kind === "test" || kind === "testaux";
            })
        ),
        ...(options.runtime.autoloadedTestHelper !== undefined
          ? {
              autoloadedTestHelper: options.runtime.autoloadedTestHelper,
              humanTests: humanTestsAt(options.human, options.runtime, step.commit),
              humanTree: options.human.tree(step.commit).map((e) => e.path),
            }
          : {}),
        ...(options.gateway !== undefined ? { modelBaseUrl: options.gateway.jobBaseUrl(key) } : {}),
        abortSignal,
      })
    );
    result = admitted.result;
    admissionWaitMs = admitted.admissionWaitMs;
    const delta = admitted.delta;
    if (admitted.voidReasons.length > 0) {
      // 作废重做：连同这次尝试在库里留下的痕迹（agent 的提交所在的 reflog、ORIG_HEAD、本步的开工树引用）一并丢掉
      await ws.discardAttempt(state.head, step.seq - 1);
      throw new StepInterruptedError(
        `第 ${step.seq} 步作废：${admitted.voidReasons.join("；")}`,
        admitted.limitRelated,
        admitted.queueOnly
      );
    }
    if (delta !== undefined) {
      // 四个条件同一口径：轮数即成功转发的模型请求数，token 取网关读到的用量
      const d = delta;
      gatewayFacts = {
        queueMs: d.queueMs,
        accountRequests: d.accountRequests,
        peakInFlight: d.peakInFlight,
      };
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
    agentChangedDeps = await agentChangedDeclaration(options, ws, step.commit);
    await ws.normalizeTo(state.head);
    try {
      await restoreTests(options, ws, step);
    } catch (error) {
      // agent 设下、跑批器处理不了的访问障碍（列不出的目录、删不掉的链接）：这一步作废重做，不停作业
      if (!(error instanceof StreamWorkspaceAccessError)) throw error;
      await ws.discardAttempt(state.head, step.seq - 1);
      throw new StepInterruptedError(`第 ${step.seq} 步作废：${error.message}`, false);
    }
    try {
      await syncEnv(options, ws, step.commit);
    } catch (error) {
      if (error instanceof EnvSelectionError) return voided(error);
      if (error instanceof StreamWorkspaceAccessError) {
        await ws.discardAttempt(state.head, step.seq - 1);
        throw new StepInterruptedError(`第 ${step.seq} 步作废：${error.message}`, false);
      }
      throw error;
    }
    // 题：判题测试的逐用例结果（不看退出码）；维护步：验证门
    if (step.kind === "task") {
      const run = await options.runtime.runCases(ws, step.judgeTests, {
        timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
        scratch: `${ws.root}/.git`,
      });
      passed = allPassed(run);
      judgeOutput = run.output;
    } else {
      // 维护步：这条流的分步验证（与回炉的验证、开跑前检查同一套），不用清单里冻结的验证命令——
      // 两者一旦不一致，维护步的判定就与 agent 在回炉里被验证的不是同一件事
      const judgement = await ws.run(
        gateFromSteps(options.runtime.verifySteps),
        options.judgeTimeoutMs ?? 1_800_000
      );
      passed = judgement.exitCode === 0 && !judgement.timedOut;
      judgeOutput = judgement.output;
    }
    judged = true;
    // 回炉最终不通过也照样落地：这一步以失败收尾，下一步从 agent 的代码之上接着做（172 / 173）
    head = await ws.land(step.message, state.head);
  }
  let measured: Measurement;
  try {
    measured = await measure(options, env, steps, step, state);
  } catch (error) {
    // 测量时选不出依赖组合：与判题前同一口径作废——撤掉已落地的提交，回到本步起点
    if (error instanceof StreamWorkspaceAccessError) {
      await ws.discardAttempt(state.head, step.seq - 1, env.measureRoot);
      throw new StepInterruptedError(`第 ${step.seq} 步作废：${error.message}`, false);
    }
    if (!(error instanceof EnvSelectionError)) throw error;
    await ws.clearArtifacts(env.measureRoot);
    return voided(error);
  }
  // 测量与判题的产物（测量副本、判题与验证门的报告）用完即清，不留给下一步的 agent
  await ws.clearArtifacts(env.measureRoot);
  const attribution = judged
    ? attributeFailure({
        passed,
        missing: extractMissing(judgeOutput, ws.root),
        maintenanceCreated: state.maintenanceCreated,
        regressions: measured.regressions,
      })
    : null;
  if (step.kind === "maintenance") state.maintenanceCreated.push(createdFor(options, step));
  return {
    ...base,
    // 成败只看判题（题跑判题测试、维护步跑验证门），判的是落地的 agent 代码；回炉的最终结论另记在 finalVerdict
    outcome: step.kind === "apply" ? "applied" : passed ? "passed" : "failed",
    head,
    judged,
    repairRounds: result?.repair?.rounds ?? null,
    finalVerdict: result?.repair?.finalVerdict ?? null,
    humanTestRestores:
      result?.repair === null || result?.repair === undefined
        ? null
        : (result.repair.humanTestRestores ?? 0),
    agentChangedDeps,
    fullPassRate: measured.fullPassRate,
    regressions: measured.regressions,
    quality: measured.quality,
    status: result?.status ?? null,
    turns: result?.turns ?? 0,
    usage: result?.usage ?? ZERO_USAGE,
    agentWallMs: result?.wallMs ?? 0,
    wallMs: Date.now() - started,
    attribution,
    gateway: gatewayFacts,
    admissionWaitMs,
  };
}

// ---------- 容器实现 ----------

export const STREAM_CONTAINER_ROOT = "/testbed";
export const STREAM_MEASURE_ROOT = "/measure";

// 每个作业一个断网容器。续跑时（进程被杀、整机重启之后）先接管已存在的流容器：停止的启动、仍在运行的重启（清掉上次
// 留下的进程），核对它用的是当前镜像、库里有上一个完成步的提交，再把工作区回到那个提交（在途步的改动一律作废，
// 与作废重做同一口径；会话由续跑时的清理移出治理根）。这样续跑的作业与没中断的作业一样保留容器里的被忽略文件等状态。
// 没有残留容器、镜像不同或核对不上时，由镜像加导出的流历史重建
export function dockerStreamEnvs(input: {
  image: string;
  human: HumanRepo;
  // 容器名前缀（区分输出目录）
  prefix: string;
  docker?: readonly string[];
  runArgs?: readonly string[];
  // 容器内的工作区根与测量副本目录（缺省 /testbed 与 /measure；本机测试指到临时目录）
  root?: string;
  measureRoot?: string;
  // 容器里的临时目录：丢弃作废的尝试时清空（正式跑批传 /tmp）；不给即不清
  tmpDir?: string;
  log?: (line: string) => void;
  // 闸门不成立时的告警（缺省写标准错误，只报一次）
  warn?: (line: string) => void;
}): StreamEnvFactory {
  const docker = input.docker ?? ["docker"];
  const root = input.root ?? STREAM_CONTAINER_ROOT;
  const measureRoot = input.measureRoot ?? STREAM_MEASURE_ROOT;
  let imageId: string | undefined;
  // 开好容器后探一次闸门：不成立（Podman、rootless 等没有 /.dockerenv，或缺少环境变量）即告警一次，说明后果
  let gateWarned = false;
  const warn = input.warn ?? ((line: string) => process.stderr.write(`[跑批] ${line}\n`));
  const probeGate = async (container: string, ws: StreamWorkspace) => {
    if (gateWarned || (await ws.inStreamContainer())) return;
    gateWarned = true;
    warn(
      `作业容器 ${container} 里闸门不成立（缺 PIGEON_STREAM_CONTAINER=1 或 /.dockerenv）：丢弃作废尝试时不清空 /tmp，清 agent 进程退回只按本步标记清，不带标记的后台进程清不到`
    );
  };
  const envOf = (container: string, ws: StreamWorkspace): StreamEnvironment => ({
    ws,
    target: { container, root },
    measureRoot,
    dispose: () => removeWorkspaceContainer(container, docker),
  });
  return {
    async open(job, init) {
      const container = `${input.prefix}-${jobDirName(job)}`;
      if (init.resume !== undefined) {
        const found = await containerStatus(container, docker);
        imageId ??= await imageIdAsync(input.image, docker);
        // 只接管用当前镜像、由跑批器带标志起的容器；先前未带标志起的，闸门在里面不成立，改由流历史重建
        if (found !== null && found.image === imageId && found.marked) {
          try {
            await dockerCommand(docker, [
              found.status === "running" ? "restart" : "start",
              container,
            ]);
            const ws = new StreamWorkspace(
              dockerStreamShell({ container, root, docker }),
              input.tmpDir !== undefined ? { tmpDir: input.tmpDir } : {}
            );
            await ws.takeOver(init.resume.head, init.resume.seq, measureRoot);
            input.log?.(
              `[${container}] 接管已存在的容器（原为 ${found.status}），回到第 ${init.resume.head.slice(0, 9)} 提交`
            );
            await probeGate(container, ws);
            return envOf(container, ws);
          } catch (error) {
            input.log?.(
              `[${container}] 接管已存在的容器失败，改由流历史重建：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      await removeWorkspaceContainer(container, docker);
      await startWorkspaceContainer({
        image: input.image,
        name: container,
        docker,
        runArgs: [
          ...WORKSPACE_NETWORK_ARGS,
          // 标明这是跑批器起的作业容器：清 agent 进程时据此除 init 与主命令外全清（见 KILL_STEP_PROCESSES）
          "-e",
          "PIGEON_STREAM_CONTAINER=1",
          "--label",
          `pigeon.stream=${input.prefix}`,
          ...(input.runArgs ?? []),
        ],
      });
      const ws = new StreamWorkspace(
        dockerStreamShell({ container, root, docker }),
        input.tmpDir !== undefined ? { tmpDir: input.tmpDir } : {}
      );
      try {
        if (init.resume !== undefined) {
          await ws.restoreFromBundle(init.resume.bundle, init.resume.head);
          // 流历史里可能带着断点之后那一步落地的提交（导出流历史之后、写结果行之前被停）：同一口径丢掉
          await ws.discardAttempt(init.resume.head, init.resume.seq);
        } else await ws.initFromBundle(input.human.bundle(init.startCommit), init.startCommit);
      } catch (error) {
        await removeWorkspaceContainer(container, docker).catch(() => {});
        throw error;
      }
      await probeGate(container, ws);
      return envOf(container, ws);
    },
  };
}

function dockerCommand(docker: readonly string[], args: readonly string[]): Promise<string> {
  const [program = "docker", ...pre] = docker;
  return new Promise((resolve, reject) => {
    execFile(
      program,
      [...pre, ...args],
      { timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null)
          reject(new Error(`docker ${args[0]} 失败：${String(stderr).trim() || error.message}`));
        else resolve(String(stdout));
      }
    );
  });
}

// 容器的状态与所用镜像 ID；不存在为 null
async function containerStatus(
  container: string,
  docker: readonly string[]
): Promise<{ status: string; image: string; marked: boolean } | null> {
  try {
    const out = (
      await dockerCommand(docker, [
        "inspect",
        "--format",
        "{{.State.Status}}|{{.Image}}|{{range .Config.Env}}{{.}};{{end}}",
        container,
      ])
    ).trim();
    const [status = "", image = "", env = ""] = out.split("|");
    // 是否由跑批器以 -e PIGEON_STREAM_CONTAINER=1 起的（先前版本起的容器没有，闸门在里面不成立）
    const marked = env.split(";").includes("PIGEON_STREAM_CONTAINER=1");
    return status === "" ? null : { status, image, marked };
  } catch {
    return null;
  }
}

async function imageIdAsync(image: string, docker: readonly string[]): Promise<string> {
  return (await dockerCommand(docker, ["image", "inspect", "--format", "{{.Id}}", image])).trim();
}

// 缓存结果的身份：镜像标识（镜像 ID，不用可变的标签）与命令摘要（人的基准为跑用例的方式，开跑前检查为检查门命令）
export interface BaselineIdentity {
  image: string;
  command: string;
}

export function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

// 等价摘要表：（旧命令摘要, 新命令摘要）。身份里的摘要与当前摘要成对列在表里、且该结果没有任何挂起迹象（见 hangFree），
// 按等价读回；其余一律重算。现在的外壳再改，表里的新摘要即对不上，须重新审视。strands 跑用例的外壳两处变化：
//   1c1bd1a 起显式带 --timeout、--timeout-method signal 与 --rerun-except Timeout：只在用例挂起时起作用（仓库配置本就是
//     90 秒 signal 超时；不同处只在超时失败的用例不再重跑），没有卡住或超时用例的结果，逐用例结果不受影响；
//   其后 pytest 改以 -c 指定人在该步的配置（配置写在工作区之外，由 root 写入）、--rootdir 与 --confcutdir 都固定为
//     strands-py：人的代码上几种跑法用的是同一份人的配置，rootdir 与 conftest 的加载边界都是 strands-py，只是配置文件的
//     位置不同，逐用例结果不受影响。
// strands 的检查门结果随 lint 层重建（v6）一律重算，表里不再列检查门命令
export const EQUIVALENT_BASELINE_COMMANDS: EquivalencePairs = [
  // strands 跑用例的外壳：1c1bd1a 之前的
  ["da2746ca28858993", "7d0b7803e11a57b5"],
  // strands 跑用例的外壳：1c1bd1a 起、改用人的 pytest 配置之前的
  ["47c962cd27b0eefe", "7d0b7803e11a57b5"],
  // strands 跑用例的外壳：改用人的 pytest 配置、配置写在工作区 .git 下的
  ["70f10b887f6bfdc1", "7d0b7803e11a57b5"],
];

// 等价表：（旧, 新）对的列表；同一个旧值可以对多个新值
export type EquivalencePairs = Iterable<readonly [string, string]>;

function listedAsEquivalent(pairs: EquivalencePairs, from: string, to: string): boolean {
  for (const [a, b] of pairs) if (a === from && b === to) return true;
  return false;
}

// 镜像等价表（旧镜像 ID, 新镜像 ID），只用于人的用例基准：列入的镜像运行环境逐字相同、只差 lint 层，
// 跑用例用的是运行环境，逐用例结果不受影响；检查门结果要用 lint 环境，不按镜像等价
export const EQUIVALENT_CASE_IMAGES: EquivalencePairs = [
  // strands v4 → v5：v5 只在 v4 之上多一层按提交解析的 lint 环境（148 补记）
  [
    "sha256:281bf24305dd0891440e1ecf3a07f09644688f8b28a4e770a5522a43b4d6d8d6",
    "sha256:c543a4eaf23f465b494e56a1ef825673796611a52ac5f85f73daad1e02fb1148",
  ],
  // strands v4 → v6：v6 的 lint 层与 v5 解析结果逐字相同（95 个提交对到同样的 42 套），只是套装、映射表与切换脚本
  // 改归 root 且只读，/opt 与 /opt/lint 改为带粘滞位——只改了属主与权限，运行环境不动
  [
    "sha256:281bf24305dd0891440e1ecf3a07f09644688f8b28a4e770a5522a43b4d6d8d6",
    "sha256:d23b0a512ca217bc2c7984bf33dc52c1006cbf0cd2a9642b7638efb0e3f99b42",
  ],
];

function sameIdentity(saved: unknown, want: BaselineIdentity): boolean {
  const s = saved as Partial<BaselineIdentity> | undefined;
  return s !== undefined && s.image === want.image && s.command === want.command;
}

// 读落盘结果：身份相符即读回；镜像相同、命令摘要按等价表对得上、且结果没有挂起迹象的也读回；
// 文件不在、读不出、没有身份（旧文件）或身份不符都当作没有
function readIdentified<T>(
  file: string,
  want: BaselineIdentity,
  equivalent: EquivalencePairs,
  hangFree: (saved: T) => boolean,
  // 镜像等价表：只有运行环境逐字相同的镜像才列入，只用于人的用例基准
  equivalentImages: EquivalencePairs = []
): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as T & { identity?: unknown };
    if (sameIdentity(saved.identity, want)) return saved;
    const s = saved.identity as Partial<BaselineIdentity> | undefined;
    if (s === undefined || s.image === undefined || s.command === undefined) return undefined;
    const imageOk =
      s.image === want.image || listedAsEquivalent(equivalentImages, s.image, want.image);
    const commandOk =
      s.command === want.command ||
      (listedAsEquivalent(equivalent, s.command, want.command) && hangFree(saved));
    return imageOk && commandOk ? saved : undefined;
  } catch {
    return undefined;
  }
}

// 人的基准：在装有人的完整历史的参考工作区里检出该提交、跑同一批测试，跑 repeat 遍（缺省 2）逐条比对——每遍都通过的
// 进 B 口径的分母，各遍结果不一致的标为时过时不过；第一遍收集出的全部用例即 A 口径的分母。结果按提交缓存到磁盘，各条件共用；
// 缓存带身份（镜像与命令摘要），身份不符即重算
export class ReferenceCases implements HumanReferenceCases {
  private readonly reference: ReferenceWorkspace;
  private readonly runtime: StreamRepoRuntime;
  private readonly cacheDir: string;
  private readonly image: string;
  private readonly equivalent: EquivalencePairs;
  private readonly equivalentImages: EquivalencePairs;
  private readonly timeoutMs: number;
  private readonly repeat: number;
  private readonly cgroupDir: string;
  private readonly warn: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    reference: ReferenceWorkspace;
    runtime: StreamRepoRuntime;
    cacheDir: string;
    // 参考容器所用镜像的标识（镜像 ID）：缓存身份之一
    image: string;
    // 等价摘要表（缺省 EQUIVALENT_BASELINE_COMMANDS）与用例基准的镜像等价表（缺省 EQUIVALENT_CASE_IMAGES）
    equivalentCommands?: EquivalencePairs;
    equivalentImages?: EquivalencePairs;
    timeoutMs?: number;
    repeat?: number;
    // 容器内 cgroup v2 的目录（测试时指向假的目录）；告警出口缺省为标准错误
    cgroupDir?: string;
    warn?: (message: string) => void;
  }) {
    this.reference = input.reference;
    this.runtime = input.runtime;
    this.cacheDir = input.cacheDir;
    this.image = input.image;
    this.equivalent = input.equivalentCommands ?? EQUIVALENT_BASELINE_COMMANDS;
    this.equivalentImages = input.equivalentImages ?? EQUIVALENT_CASE_IMAGES;
    this.timeoutMs = input.timeoutMs ?? 1_800_000;
    this.repeat = Math.max(1, input.repeat ?? 2);
    this.cgroupDir = input.cgroupDir ?? "/sys/fs/cgroup";
    this.warn = input.warn ?? ((m) => console.error(m));
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private casesIdentity(): BaselineIdentity {
    return { image: this.image, command: commandDigest(this.runtime.casesCommand) };
  }

  private gateIdentity(command: readonly string[]): BaselineIdentity {
    return { image: this.image, command: commandDigest(JSON.stringify(command)) };
  }

  // 用例基准没有挂起迹象：记了卡住的用例即为空；没记的（旧文件）以最慢用例未达单条超时、每遍墙钟未达外层上限为证
  private casesHangFree(saved: HumanBaseline & { stuck?: string[] }): boolean {
    if (saved.stuck !== undefined && saved.stuck.length > 0) return false;
    if ((saved.slowest?.seconds ?? 0) >= STRANDS_CASE_TIMEOUT_SEC) return false;
    return (saved.runs ?? []).every((r) => r.wallMs < this.timeoutMs);
  }

  private readCases(commit: string): HumanBaseline | undefined {
    return readIdentified<HumanBaseline & { stuck?: string[] }>(
      path.join(this.cacheDir, `${commit}.json`),
      this.casesIdentity(),
      this.equivalent,
      (saved) => this.casesHangFree(saved),
      this.equivalentImages
    );
  }

  // 检查门结果按等价读回的前提：通过（没通过的可能正是超时或挂起所致）
  private readGate(commit: string, command: readonly string[]): GateCheck | undefined {
    return readIdentified<GateCheck>(
      path.join(this.cacheDir, `${commit}.gate.json`),
      this.gateIdentity(command),
      this.equivalent,
      (saved) => saved.passed
    );
  }

  // 这个提交的基准是否已落盘且身份相符（提前单独算过的直接读）
  has(commit: string): boolean {
    return this.readCases(commit) !== undefined;
  }

  casesAt(commit: string, tests: readonly string[]): Promise<HumanBaseline> {
    // 参考工作区只有一份：各作业的请求排队依次做
    const run = this.queue.then(() => this.compute(commit, tests));
    this.queue = run.catch(() => {});
    return run;
  }

  // 这个提交上人的代码是否已用这条检查门命令跑过（开跑前置检查），且身份相符
  hasGate(commit: string, command: readonly string[]): boolean {
    return this.readGate(commit, command) !== undefined;
  }

  // 开跑前置检查：人的代码在这个提交上跑验证门。结果按提交落盘，与基准同一排队
  gateAt(commit: string, command: readonly string[]): Promise<GateCheck> {
    const run = this.queue.then(async (): Promise<GateCheck> => {
      const file = path.join(this.cacheDir, `${commit}.gate.json`);
      const identity = this.gateIdentity(command);
      const saved = this.readGate(commit, command);
      if (saved !== undefined) return saved;
      const ws = this.reference.ws;
      await this.reference.checkout(commit);
      if (this.runtime.envSyncCommand !== null) {
        const sync = await ws.run(this.runtime.envSyncCommand, 120_000);
        if (sync.exitCode !== 0) throw new Error(`参考工作区依赖切换失败（${commit}）`);
      }
      // lint 环境按被检查的提交切换（与正式跑时"按该步人的提交"同一口径）
      const lint = this.runtime.lintSyncCommand?.(commit);
      if (lint !== undefined) {
        const sync = await ws.run(lint, 120_000);
        if (sync.exitCode !== 0) throw new Error(`参考工作区 lint 环境切换失败（${commit}）`);
      }
      await pinTestConfigFromTree(this.runtime, ws);
      const started = Date.now();
      const r = await ws.run(command, this.timeoutMs);
      const check: GateCheck = {
        passed: r.exitCode === 0 && !r.timedOut,
        failedSteps: failedStepsOf(r.output),
        wallMs: Date.now() - started,
        outputTail: r.output.slice(-4000),
      };
      writeAtomic(file, JSON.stringify({ ...check, identity }));
      return check;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async compute(commit: string, tests: readonly string[]): Promise<HumanBaseline> {
    const file = path.join(this.cacheDir, `${commit}.json`);
    const identity = this.casesIdentity();
    const saved = this.readCases(commit);
    if (saved !== undefined) {
      return { ...saved, runs: saved.runs ?? [], slowest: saved.slowest ?? null };
    }
    const ws = this.reference.ws;
    await this.reference.checkout(commit);
    if (this.runtime.envSyncCommand !== null) {
      const sync = await ws.run(this.runtime.envSyncCommand, 120_000);
      if (sync.exitCode !== 0) throw new Error(`参考工作区依赖切换失败（${commit}）`);
    }
    await pinTestConfigFromTree(this.runtime, ws);
    const runs: TestCaseResult[][] = [];
    const meta: BaselineRun[] = [];
    // 各遍里卡住、被记为失败的用例（并集）：落盘供日后判断这份基准有没有挂起迹象
    const stuck = new Set<string>();
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
      for (const id of run.stuck) stuck.add(id);
    }
    const baseline = { ...compareRuns(runs), runs: meta };
    writeAtomic(file, JSON.stringify({ ...baseline, stuck: [...stuck], identity }));
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
