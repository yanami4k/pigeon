// 提交流跑批器（决策 193、212、215、216；144、145、147 等沿用）：固定起点——每一步都从人在该步之前的代码（step.parent）
// 新开一个干净容器开工，跨步只保留作业目录（治理根）里的会话与记忆，被 git 忽略的文件、/tmp 与家目录都随容器丢弃。
// 步为清单里的题按时间接成的一条流（维护步、套用步与跳过步都不跑，重置点不再切分）。每个条件（乘以第几遍）为一个独立作业，
// 共用工作队列并行（缺省 4 路）。每一步：取或恢复记忆快照、记下开工时的记忆大小 → 取这一步的两类用例（214）→ 取容器到
// 起点（上一步进行时已预先开好的直接用）并为下一步预先开容器 → 程序写入该步人的环境文件（人的测试与测试辅助文件判题时
// 才放入，198）→ 按条件运行 agent → 存下 agent 的改动（diff）→ 恢复 agent 动过的测试、写入人在该步的测试 → 判题前清理
// （195）→ 放入人在该步的全部测试跑一次全量、按两类用例计分（196、201）→ 写结果行 → 丢弃容器。可按题号只跑选出的题
// （202、219 校准）。被打断的一步整题作废、不留行（144），重做时另开容器；崩溃后从结果行续跑。agent 怎么跑与模型怎么
// 接入都在 StepAgent 之后，跑批器不感知。
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type { TurnUsage } from "../state/runtime-events.ts";
import { WORKSPACE_NETWORK_ARGS } from "./container-workspace.ts";
import { type GatewayMeter, meterDelta } from "./model-gateway.ts";
import { type LimitController, QUEUE_VOID_MS } from "./model-limits.ts";
import {
  type CaseClasses,
  classifyCases,
  judgeStep,
  type SideRuns,
  type StepJudging,
} from "./stream-classes.ts";
import type { HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import type { HarnessRef } from "./stream-harness.ts";
import {
  chainedTasks,
  DEFAULT_TASK_PROMPT_FORMAT,
  type StreamManifest,
  type StreamStep,
  TASK_CHAIN_ID,
  type TaskPromptFormat,
  taskPromptOf,
} from "./stream-manifest.ts";
import type { TestCaseResult } from "./stream-measure.ts";
import { memoryFactsOf, snapshotOrRestoreMemory } from "./stream-memory-snapshot.ts";
import {
  type CaseRun,
  countQuality,
  failedStepsOf,
  pinTestConfigFromTree,
  STRANDS_CASE_TIMEOUT_SEC,
  type StreamRepoRuntime,
} from "./stream-profiles.ts";
import { type ReportIdentity, renderStreamReport } from "./stream-report.ts";
import {
  type BuiltinStreamCondition,
  type ExternalStreamCondition,
  lastCompletedStep,
  MEMORY_WARN_RATIO,
  type MemoryFacts,
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

// 条件表（193、194、217）：记忆的 2 × 2——能否检索历史会话（sessionSearch）× 有无推送记忆（pushedMemory），四格都是
// 完整 Pigeon；最简 agent 另走启动器，作外部参照。外部 agent 条件（ext-<名字>，实验设施）不在表里，由调用方按配置文件
// 给出条件说明（RunStreamsOptions.conditionSpecs）：agent 键即条件名，作业容器接只通网关的网络，提取改动时排除配置里的路径。
// 决策 327：验证门与回炉随 322 删除，四格暂不带检查；下次实验接检查的方式随出题规则另行设计
export interface ConditionSpec {
  name: StreamCondition;
  // 用哪个 agent：内置条件为 pigeon 或 minimal；外部 agent 条件为条件名本身（ext-<名字>）
  agent: "pigeon" | "minimal" | ExternalStreamCondition;
  // 能否检索历史会话：关掉时 Pigeon 不注册两件会话检索工具，系统提示不提它们
  sessionSearch: boolean;
  // 有无推送记忆：透传给 headless（推送记忆另行施工，打开时 headless 暂时报错）
  pushedMemory: boolean;
  // 作业容器的网络档：缺省断网（--network none）；gateway-only 为只通模型网关的跑批内部网络（只给外部 agent 条件）
  network?: "gateway-only";
  // 提取改动时起止两次都排除的工作区路径（外部 agent 自己的状态目录等）；缺省不排除
  excludePaths?: readonly string[];
  // 网关上这个条件的请求体逐字转发（外部 agent 条件）：登记作业地址时声明，不去除工具定义里的 "type": "custom"
  verbatimRequestBody?: boolean;
}

export const CONDITION_SPECS: Record<BuiltinStreamCondition, ConditionSpec> = {
  "search-push": {
    name: "search-push",
    agent: "pigeon",
    sessionSearch: true,
    pushedMemory: true,
  },
  "search-only": {
    name: "search-only",
    agent: "pigeon",
    sessionSearch: true,
    pushedMemory: false,
  },
  "push-only": {
    name: "push-only",
    agent: "pigeon",
    sessionSearch: false,
    pushedMemory: true,
  },
  neither: {
    name: "neither",
    agent: "pigeon",
    sessionSearch: false,
    pushedMemory: false,
  },
  minimal: {
    name: "minimal",
    agent: "minimal",
    sessionSearch: false,
    pushedMemory: false,
  },
};

// 条件说明：内置条件查表，外部 agent 条件取调用方给的说明；都没有即报错
export function conditionSpecOf(
  options: Pick<RunStreamsOptions, "conditionSpecs">,
  condition: StreamCondition
): ConditionSpec {
  const spec =
    (CONDITION_SPECS as Record<string, ConditionSpec | undefined>)[condition] ??
    options.conditionSpecs?.[condition];
  if (spec === undefined)
    throw new Error(`条件 ${condition} 没有说明（外部 agent 条件须给配置文件）`);
  return spec;
}

// 每步总预算（147）：各条件同一个，包括轮数与墙钟，回炉的消耗计入其中；先按 150 轮、30 分钟，试跑后定死
export interface StepBudget {
  maxTurns: number;
  wallClockMs: number;
}

// 每步预算（147 校准）：在正式实验的服务器上以完整 Pigeon 试跑 10 步，轮数与墙钟各取第 90 百分位（78 轮、约 14.3 分钟）
// 乘 1.5，且分别不低于 150 轮、30 分钟，两项都由下限起作用，得 150 轮、30 分钟；各条件同额，回炉的消耗计入其中
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
  // 宿主上给这个作业用的目录（会话账本等）
  workDir: string;
  // 跑批器按步中止（本作业在网关排队超时等）：agent 与限额信号同一条路径停下（中止 agent、清掉容器里的进程），
  // 报被打断
  abortSignal?: AbortSignal;
  // 经网关时，这个作业的模型接入地址（决策 155）
  modelBaseUrl?: string;
}

// 网关对跑批器露出的：作业的接入地址（外部 agent 条件取跑批内部网络上的地址，并登记为请求体逐字转发）、作业的计量、
// 每步开始时重记在途峰值、排队看守
export interface StreamModelGateway {
  jobBaseUrl(
    job: string,
    options?: { on?: "loopback" | "internal"; verbatimBody?: boolean }
  ): string;
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
  const after =
    options.gateway !== undefined && before !== undefined ? options.gateway.meter(key) : undefined;
  const delta = after !== undefined && before !== undefined ? meterDelta(after, before) : undefined;
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
  // 这一步被打断（模型服务故障、限额）：整题作废、不留行
  interrupted?: string;
  // 外部 agent 的启动器写在结果文件里的 report（任意 JSON 对象）：原样记进结果行的 agentReport
  report?: Record<string, unknown>;
}

export interface StepAgent {
  run(input: StepAgentInput): Promise<StepAgentResult>;
}

export interface StreamEnvironment {
  ws: StreamWorkspace;
  target: AgentTarget;
  dispose(): Promise<void>;
}

export interface StreamEnvFactory {
  // 为一步新开一个干净的工作区，检出人在该步之前的代码（固定起点，212）。slot 为这一步在作业里用的槽位（0 或 1）：
  // 预先开下一步时同一作业同时有两个环境，按槽位区分（容器名带槽位）
  open(job: StreamJobId, init: { startCommit: string; slot?: number }): Promise<StreamEnvironment>;
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
  // 这一步的两类用例（214）：人在该步的全部测试在 commit 上与叠放到 parent 上各跑两遍比出
  classesAt(step: StreamStep): Promise<StepClasses>;
}

// 一步的两类用例：commit 与 parent 为人在该步与之前的代码；failToPassOutsideJudgeFiles 为要做到的里不在本题测试文件
// （人在该步新写或改过的测试文件）中的条数；unbuildable 为无法建立基线的原因（此时两类都为空），能建立即 null
export interface StepClasses extends CaseClasses {
  commit: string;
  parent: string;
  failToPassOutsideJudgeFiles: number;
  unbuildable: string | null;
}

// 人的代码或叠放运行拿不全用例的结果
export class IncompleteRunError extends Error {
  override name = "IncompleteRunError";
}

function unbuildableClasses(step: StreamStep, reason: string): StepClasses {
  return {
    commit: step.commit,
    parent: step.parent,
    failToPass: [],
    passToPass: [],
    excludedFlaky: [],
    failToPassOutsideJudgeFiles: 0,
    unbuildable: reason,
  };
}

// 要做到的用例里落在本题测试文件（人在该步新写或改过的测试文件）之外的那些（用例编号，保持原顺序）
export function outsideJudgeCases(step: StreamStep, failToPass: readonly string[]): string[] {
  const judgeFiles = new Set(step.judgeTests);
  return failToPass.filter((id) => !judgeFiles.has(caseFile(id)));
}

// 用例编号里的测试文件路径（"文件::…"的前一段）
export function caseFile(id: string): string {
  const cut = id.indexOf("::");
  return cut < 0 ? id : id.slice(0, cut);
}

// agent 自报被打断、期间却没有任何限额信号或上游故障：最多重做这么多次
export const MAX_BARE_INTERRUPTIONS = 3;
// 同一步因限额信号、上游故障或排队超时被作废：累计到前一个数先向标准错误告警，到后一个数停下作业，免得无止境重做
export const SIGNALLED_VOID_WARN = 5;
export const SIGNALLED_VOID_STOP = 10;
// 同一步只因排队超时被作废（额度环境造成，不是这一步本身的故障）：单独计数，累计到前一个数告警一次，到后一个数停下作业
export const QUEUE_VOID_WARN = 10;
export const QUEUE_VOID_STOP = 30;

// 治理根里的会话文件（决策 210 的布局：会话根下按工作目录编码的子目录、文件名为创建时间加会话号，另有同目录的锁文件），
// 以相对会话根的路径（分隔符一律为 /）标识，逐个文件区分：同一工作目录下前后几次尝试的会话落在同一个子目录里
function sessionFilesOf(jobDir: string): string[] {
  const dir = sessionsDirOf(jobDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
    )
    .sort();
}

// 清掉一次作废的尝试留在治理根里的痕迹：不在 keep 里的会话文件连同所在子目录的相对路径移到输出目录下、治理根之外的
// 隔离目录（保留备查），移空的子目录一并删去；重做时会话检索看不到作废的尝试，与从零开始的最简 agent 对等
function quarantineSessions(
  outDir: string,
  job: StreamJobId,
  jobDir: string,
  keep: ReadonlySet<string>,
  label: string
): number {
  const dir = sessionsDirOf(jobDir);
  const stray = sessionFilesOf(jobDir).filter((f) => !keep.has(f));
  if (stray.length > 0) {
    const target = path.join(outDir, "voided", jobDirName(job), label);
    for (const file of stray) {
      const to = path.join(target, ...file.split("/"));
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(dir, ...file.split("/")), to);
    }
    for (const sub of new Set(stray.map((f) => path.dirname(path.join(dir, ...f.split("/")))))) {
      if (sub !== dir && readdirSync(sub).length === 0) rmdirSync(sub);
    }
  }
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
  // 外部 agent 条件的说明（按条件名）；内置条件取 CONDITION_SPECS
  conditionSpecs?: Readonly<Record<string, ConditionSpec>>;
  reference: HumanReferenceCases;
  outDir: string;
  conditions: readonly StreamCondition[];
  // 每个条件跑几遍（146 补跑时为 3）
  attempts?: number;
  // 并行作业数（缺省 4）
  concurrency?: number;
  // 按题号选步（202、219 校准）：题号为清单里的题按时间接成的流中的序号（从 1 起）；给了即只跑这些题、按时间顺序
  tasks?: readonly number[];
  // 试跑：只跑（选出的题里的）前 K 道题
  maxSteps?: number;
  budget?: StepBudget;
  // 判题（放入人的测试后跑一次全量）的墙钟上限，也是交给回炉验证的超时
  judgeTimeoutMs?: number;
  // 题面格式（198、213）：缺省给测试文件路径；给用例名时名单为这一步要做到的用例（214）
  promptFormat?: TaskPromptFormat;
  // 预先开好下一步的容器（缺省开）：当前步的 agent 开始之前即为下一步新开容器，下一步开工时直接取用
  prefetchEnvs?: boolean;
  harnessRef: HarnessRef;
  log?: (line: string) => void;
  // 告警（缺省写标准错误输出）
  warn?: (line: string) => void;
  // 限额统一处理（决策 144、155）：每步前等放行、agent 运行时占一路；这一步撞上限额即作废、恢复后重做
  limits?: LimitController;
  // 经网关时：轮数与 token 一律取网关的按作业计量，各条件同一口径
  gateway?: StreamModelGateway;
  // 身份头的摘要与各 agent 的参数：原样记进每条结果行（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）
  runIdentity?: string;
  agentSettings?: Partial<Record<ConditionSpec["agent"], Record<string, unknown>>>;
  // 输出目录的身份头（调用方写入或比对之后读出）：报告的设置一节据此写开跑时的代码与显式放行的代码更换（269）；
  // 缺省即不写这一节
  reportIdentity?: ReportIdentity;
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

// 这次跑哪些步：清单里的题按时间接成一条流（215、216）；给了题号即只取这些题（按时间顺序，题号从 1 起、不得重复或越界），
// 再按 maxSteps 只取前 K 道
export function selectSteps(
  manifest: StreamManifest,
  selection: { tasks?: readonly number[] | undefined; maxSteps?: number | undefined }
): StreamStep[] {
  const all = chainedTasks(manifest);
  let steps = all;
  if (selection.tasks !== undefined) {
    const seen = new Set<number>();
    for (const n of selection.tasks) {
      if (!Number.isInteger(n) || n < 1 || n > all.length) {
        throw new Error(`题号 ${n} 越界（共 ${all.length} 道题，题号从 1 起）`);
      }
      if (seen.has(n)) throw new Error(`题号 ${n} 重复`);
      seen.add(n);
    }
    steps = [...seen].sort((a, b) => a - b).map((n) => all[n - 1] as StreamStep);
  }
  return selection.maxSteps === undefined ? steps : steps.slice(0, selection.maxSteps);
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
  // 题号不对即在开任何作业之前拒绝
  const steps = selectSteps(options.manifest, options);
  mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, "results.jsonl");
  sealTornTail(resultsFile);
  const reportFile = path.join(options.outDir, "report.md");
  const attempts = options.attempts ?? 1;
  const jobs: StreamJobId[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const condition of options.conditions) {
      jobs.push({ stream: TASK_CHAIN_ID, condition, attempt });
    }
  }
  const summaries: StreamJobSummary[] = [];
  await runWorkQueue(jobs, options.concurrency ?? 4, async (job) => {
    const summary: StreamJobSummary = { key: streamJobKey(job), completedTo: null };
    try {
      summary.completedTo = await runStreamJob(options, job, steps, resultsFile);
    } catch (error) {
      summary.stopped = message(error);
      summary.completedTo = lastCompletedStep(readStreamResults(resultsFile), job)?.seq ?? null;
      options.log?.(`[${summary.key}] 停止：${summary.stopped}`);
    }
    summaries.push(summary);
  });
  const scope = [
    options.tasks !== undefined ? `按题号选 ${steps.length} 道题` : undefined,
    options.maxSteps !== undefined ? `试跑：只跑前 ${options.maxSteps} 道题` : undefined,
  ].filter((x) => x !== undefined);
  writeFileSync(
    reportFile,
    renderStreamReport(readStreamResults(resultsFile), {
      ...(options.reportIdentity !== undefined ? { identity: options.reportIdentity } : {}),
      title: `${options.manifest.repo}${scope.length > 0 ? `（${scope.join("；")}）` : ""}`,
      // 分段：清单里按重置点切出的各段（固定起点下只用于分段报告，不影响怎么跑）
      segments: options.manifest.streams.map((s) => ({
        id: s.id,
        firstSeq: s.firstSeq,
        lastSeq: s.lastSeq,
      })),
    })
  );
  return { resultsFile, reportFile, jobs: summaries };
}

async function runStreamJob(
  options: RunStreamsOptions,
  job: StreamJobId,
  steps: readonly StreamStep[],
  resultsFile: string
): Promise<number | null> {
  const spec = conditionSpecOf(options, job.condition);
  const agent = options.agents[spec.agent];
  if (agent === undefined)
    throw new Error(`条件 ${job.condition} 需要的 agent（${spec.agent}）没有接入`);
  const stepAgent: StepAgent = agent;
  // 作业目录即 agent 的治理根：条件 × 遍次各一个。会话与记忆只在同一作业里沿步累积，不跨条件或遍次串用；
  // 目录名必须同时含这两者
  const jobDir = path.join(options.outDir, "streams", jobDirName(job));
  mkdirSync(jobDir, { recursive: true });
  // 每步完成时治理根里的会话文件清单（相对会话根的路径，含工作目录编码子目录）：续跑时不在上一个完成步清单里的会话（进程死在一步中途留下的）一律移出
  const sessionsFile = (seq: number) => path.join(jobDir, `sessions-${seq}.json`);
  const lines = readStreamResults(resultsFile);
  const last = lastCompletedStep(lines, job);
  const remaining = steps.filter((s) => last === undefined || s.seq > last.seq);
  if (remaining.length === 0) return last?.seq ?? null;
  const log = (text: string) => options.log?.(`[${streamJobKey(job)}] ${text}`);
  const warn = options.warn ?? ((line: string) => process.stderr.write(`[跑批] ${line}\n`));
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
  const limits = options.limits;
  // 预先开下一步的容器（流水线只做到这一步，判分与下一步开工不重叠）：当前步的 agent 开始之前即为下一步开好容器。
  // 同一作业同时至多两个容器，按步在本作业题单里的位置轮流用两个槽位命名，互不冲突
  const prefetched = new Map<number, Promise<StreamEnvironment>>();
  const openFor = (step: StreamStep) =>
    options.envs.open(job, { startCommit: step.parent, slot: steps.indexOf(step) % 2 });
  const envs: JobEnvs = {
    async take(step) {
      const pending = prefetched.get(step.seq);
      if (pending !== undefined) {
        prefetched.delete(step.seq);
        try {
          return { env: await pending, prefetched: true };
        } catch (error) {
          log(`第 ${step.seq} 步预先开的容器不可用，重开：${message(error)}`);
        }
      }
      return { env: await openFor(step), prefetched: false };
    },
    prefetchAfter(step) {
      if (options.prefetchEnvs === false || limits?.shutdownReason !== undefined) return;
      const next = remaining[remaining.indexOf(step) + 1];
      if (next === undefined || prefetched.has(next.seq)) return;
      const pending = openFor(next);
      pending.catch(() => {});
      prefetched.set(next.seq, pending);
    },
  };
  try {
    await runRemainingSteps();
  } finally {
    // 作业结束或停下：预先开好却没用上的容器一律丢弃
    for (const pending of prefetched.values()) {
      try {
        await (await pending).dispose();
      } catch {
        // 没开成的不必丢弃
      }
    }
  }
  return steps.at(-1)?.seq ?? null;

  async function runRemainingSteps(): Promise<void> {
    for (const step of remaining) {
      log(`第 ${step.seq} 步 ${step.subject.slice(0, 60)}`);
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
        // 记忆（191）：还没有这一步的快照即取一份；已有（作废重做、崩溃后续跑）即把记忆恢复成它
        snapshotOrRestoreMemory(jobDir, step.seq);
        const memoryAtStart = memoryFactsOf(jobDir);
        const sessionsBefore = new Set(sessionFilesOf(jobDir));
        try {
          row = await runStep(
            options,
            job,
            spec,
            stepAgent,
            envs,
            step,
            jobDir,
            memoryAtStart,
            log
          );
          // 这一步开始之后收到过停止信号：不论判题、测量进行到哪（停止信号可能打断了它们），这一步作废、不写行，
          // 作业在取下一步时停下
          if (limits?.shutdownReason !== undefined) {
            throw new StepInterruptedError(`第 ${step.seq} 步作废：${limits.shutdownReason}`, true);
          }
          break;
        } catch (error) {
          // 这一步作废（决策 144、160）：容器已丢弃、不留行，等放行后另开容器重做同一步
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
      // 先存会话清单、后写结果行：两者之间崩溃时，断点行仍指向上一步，续跑重做这一步
      writeAtomic(sessionsFile(step.seq), JSON.stringify(sessionFilesOf(jobDir)));
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
    }
  }
}

// 一个作业取步环境的方式：take 取这一步的容器（预先开好的直接用，否则现开）；prefetchAfter 为下一步预先开容器
interface JobEnvs {
  take(step: StreamStep): Promise<{ env: StreamEnvironment; prefetched: boolean }>;
  prefetchAfter(step: StreamStep): void;
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

// agent 不许改测试（决策 148）：它动过的测试与测试辅助文件，人在该步写入的换成人的版本，其余恢复成起点的版本；人在该步
// 新写或改过的测试与测试辅助文件此时才写入（198：判题时才放入）。它新建的测试文件保留（全量测量只跑人写的测试）。
// 把测试或测试辅助文件改了名的（暂存的改名）：改名后的路径删掉，原路径另作一项、恢复成起点的版本
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
  // 子树里有人在该步的测试文件的，判题之前删掉；只作用于 agent 自己测试目录的保留。其余测试辅助（helper 模块、数据
  // 文件、__init__.py 等）是 agent 自己测试的依赖，不动。候选逐个文件列出（被忽略的也算：agent 可以改 .gitignore 藏它）
  const helper = options.runtime.autoloadedTestHelper;
  if (helper !== undefined) {
    const tree = options.human.tree(step.commit).map((e) => e.path);
    const inTree = new Set(tree);
    const humanTests = tree.filter((p) => profile.classifyFile(p) === "test");
    await removeCoveringHelpers(ws, helper, (p) => inTree.has(p), humanTests);
  }
}

// 判题与测量之前的清理（195 的补口）：agent 放下的、解释器启动时会被自动加载的文件（不在人在该步树里的）删掉；静态检查
// 工具的配置写回人的版本、人树里没有的删掉；家目录下同类的用户级文件与目录删掉。运行方式没给这类清理的不做
export async function cleanForJudging(
  options: Pick<RunStreamsOptions, "runtime" | "human">,
  ws: StreamWorkspace,
  step: StreamStep
): Promise<void> {
  const hygiene = options.runtime.judgeHygiene;
  if (hygiene === undefined) return;
  const tree = options.human.tree(step.commit).map((e) => e.path);
  const inTree = new Set(tree);
  const inOrAboveTree = (p: string) => inTree.has(p) || tree.some((t) => t.startsWith(`${p}/`));
  const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  await ws.grantOwnerAccess();
  const named = async (patterns: readonly string[]) => {
    const found: string[] = [];
    for (const pattern of patterns) found.push(...(await ws.pathsNamed(pattern)));
    return [...new Set(found)];
  };
  await ws.removeTrees((await named(hygiene.startupHooks)).filter((p) => !inOrAboveTree(p)));
  await ws.removeTrees((await named(hygiene.lintConfigs)).filter((p) => !inTree.has(p)));
  await ws.applyHumanFiles(
    tree
      .filter((p) => hygiene.lintConfigs.includes(baseName(p)))
      .map((p) => ({
        path: p,
        op: "write" as const,
        kind: options.runtime.profile.classifyFile(p),
      })),
    (p) => options.human.show(step.commit, p)
  );
  await ws.clearHomePaths(hygiene.homePaths);
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

interface Judgement {
  judging: StepJudging;
  quality: NonNullable<StreamResultLine["quality"]>;
}

// 判题（196、201、214）：就地进行（容器随这一步丢弃）——工作区里的测试与测试辅助文件同步成人在该步的全部（agent 新建的
// 删掉），跑人在该步的全部测试一次，按两类用例计分；再跑静态检查计数。结果不进 agent 可见的任何地方
async function judgeFull(
  options: RunStreamsOptions,
  ws: StreamWorkspace,
  step: StreamStep,
  classes: CaseClasses
): Promise<Judgement> {
  const runtime = options.runtime;
  const run = await judgeCases(options, ws, step);
  const quality = async (check: StreamRepoRuntime["quality"]["type"]) => {
    if (check === null) return null;
    const r = await ws.run(check.command, 900_000);
    return countQuality(check, r.output, r.exitCode);
  };
  return {
    judging: judgeStep(classes, run.cases),
    quality: {
      typeErrors: await quality(runtime.quality.type),
      formatErrors: await quality(runtime.quality.format),
      layerViolations: await quality(runtime.quality.layer),
    },
  };
}

// 判题的用例运行部分（judgeFull 与按保存的改动重判共用）：同步人在该步的测试与测试辅助文件，跑人在该步的全部测试一次
export async function judgeCases(
  options: Pick<RunStreamsOptions, "runtime" | "human" | "judgeTimeoutMs">,
  ws: StreamWorkspace,
  step: StreamStep
): Promise<CaseRun> {
  const runtime = options.runtime;
  // agent 新建的文件先暂存：同步时才能按类删掉未跟踪的测试文件
  await ws.stageAll();
  const tree = options.human
    .tree(step.commit)
    .map((e) => ({ ...e, kind: runtime.profile.classifyFile(e.path) }))
    .filter((e) => e.kind === "test" || e.kind === "testaux");
  await ws.syncHumanFilesAt(
    ws.root,
    tree,
    (p) => options.human.show(step.commit, p),
    (p) => {
      const kind = runtime.profile.classifyFile(p);
      return kind === "test" || kind === "testaux" ? kind : null;
    }
  );
  const tests = humanTestsAt(options.human, runtime, step.commit);
  // 一个卡死或导入失败的用例不让其余用例的结果丢失（见 runCases）；拿不到结果的用例计为未通过
  return runtime.runCases(ws, tests, {
    timeoutMs: options.judgeTimeoutMs ?? 1_800_000,
    scratch: `${ws.root}/.git`,
  });
}

// 这一步的题面（198、213）：提交信息加应通过的测试名单——本题新写或改过的测试文件路径，或其中要做到的用例编号；
// 要做到的用例有落在这些文件之外的，另列第二段：它们所在的测试文件（去重、排序），或这些用例编号
function promptFor(options: RunStreamsOptions, step: StreamStep, classes: CaseClasses): string {
  const format = options.promptFormat ?? DEFAULT_TASK_PROMPT_FORMAT;
  const outside = outsideJudgeCases(step, classes.failToPass);
  const outsideSet = new Set(outside);
  if (format === "test-files") {
    return taskPromptOf(
      step.message,
      format,
      step.judgeTests,
      [...new Set(outside.map(caseFile))].sort()
    );
  }
  return taskPromptOf(
    step.message,
    format,
    classes.failToPass.filter((id) => !outsideSet.has(id)),
    outside
  );
}

// agent 设下、跑批器处理不了的访问障碍（列不出的目录、删不掉的链接）：这一步作废重做，不停作业
function voidOnAccessError(seq: number, error: unknown): never {
  if (error instanceof StreamWorkspaceAccessError) {
    throw new StepInterruptedError(`第 ${seq} 步作废：${error.message}`, false);
  }
  throw error;
}

async function runStep(
  options: RunStreamsOptions,
  job: StreamJobId,
  spec: ConditionSpec,
  agent: StepAgent,
  envs: JobEnvs,
  step: StreamStep,
  jobDir: string,
  memoryAtStart: MemoryFacts,
  log: (text: string) => void
): Promise<StreamResultLine> {
  const started = Date.now();
  // 两类用例（214）：题面给用例名时要用，判题时计分；已预计算的直接读，没有即在参考工作区现算
  const classes = await options.reference.classesAt(step);
  const base = {
    repo: options.manifest.repo,
    stream: job.stream,
    condition: job.condition,
    attempt: job.attempt,
    seq: step.seq,
    kind: step.kind,
    commit: step.commit,
    start: step.parent,
    harnessRef: options.harnessRef,
    limitPauses: [],
    gateway: null,
    admissionWaitMs: null,
    humanFailsGate: step.humanFailsGate === true,
    runIdentity: options.runIdentity ?? null,
    agentSettings: options.agentSettings?.[spec.agent] ?? null,
    memoryAtStart,
    // 复盘（191、192）：推送格在 agent 部分里填；不推送的条件恒为 null
    review: null,
    hitReviewBudget: null,
  };
  let envPrefetched = false;
  // agent（与收尾复盘）跑完才有：步末的记忆大小、是否撞了宽上限
  let memoryAtEnd: MemoryFacts | null = null;
  let hitStepBudget: boolean | null = null;
  // 不判的一行：依赖环境选不出来而作废的步（记下原因，不计 agent 的用量）
  const notRun = (envOpenMs: number, error: EnvSelectionError): StreamResultLine => ({
    ...base,
    outcome: "skipped",
    diff: null,
    envOpenMs,
    envPrefetched,
    judged: false,
    agentChangedDeps: null,
    judging: null,
    baselineUnavailable: classes.unbuildable,
    memoryAtEnd,
    hitStepBudget,
    quality: null,
    status: null,
    turns: 0,
    usage: ZERO_USAGE,
    agentWallMs: 0,
    wallMs: Date.now() - started,
    error: `${error.message}（这一步作废）`,
  });
  const prompt = promptFor(options, step, classes);
  // 固定起点（193、212）：为这一步新开干净容器，检出人在该步之前的代码（上一步进行时已预先开好的直接取用）
  const openedAt = Date.now();
  const taken = await envs.take(step);
  const env = taken.env;
  envPrefetched = taken.prefetched;
  const envOpenMs = Date.now() - openedAt;
  log(
    `第 ${step.seq} 步${envPrefetched ? "取预先开好的容器" : "开容器"} ${(envOpenMs / 1000).toFixed(1)} 秒`
  );
  try {
    // 这一步的 agent 开始之前为下一步预先开容器
    envs.prefetchAfter(step);
    const { ws } = env;
    // 开工只写人在该步的环境文件；测试与测试辅助文件判题时才放入（198）
    await ws.applyHumanFiles(
      step.humanFiles.filter((f) => f.kind === "env"),
      (p) => options.human.show(step.commit, p)
    );
    try {
      await syncEnv(options, ws, step.commit);
    } catch (error) {
      if (error instanceof EnvSelectionError) return notRun(envOpenMs, error);
      voidOnAccessError(step.seq, error);
    }
    const startTree = await ws.worktreeTree(spec.excludePaths);
    const key = streamJobKey(job);
    const admitted = await runAdmittedAgent(options, key, (abortSignal) =>
      agent.run({
        job,
        step,
        prompt,
        condition: spec,
        target: env.target,
        budget: options.budget ?? DEFAULT_STEP_BUDGET,
        workDir: jobDir,
        ...(options.gateway !== undefined
          ? {
              modelBaseUrl:
                spec.network === "gateway-only" || spec.verbatimRequestBody === true
                  ? options.gateway.jobBaseUrl(key, {
                      ...(spec.network === "gateway-only" ? { on: "internal" as const } : {}),
                      ...(spec.verbatimRequestBody === true ? { verbatimBody: true } : {}),
                    })
                  : options.gateway.jobBaseUrl(key),
            }
          : {}),
        abortSignal,
      })
    );
    let result = admitted.result;
    if (admitted.voidReasons.length > 0) {
      throw new StepInterruptedError(
        `第 ${step.seq} 步作废：${admitted.voidReasons.join("；")}`,
        admitted.limitRelated,
        admitted.queueOnly
      );
    }
    let gatewayFacts: StreamGatewayFacts | null = null;
    const delta = admitted.delta;
    if (delta !== undefined) {
      // 各条件同一口径：轮数即成功转发的模型请求数，token 取网关读到的用量
      // 花费与上下文峰值从网关计量读：花费按步做差，峰值取收尾时的值（每步开始时已重记）。
      // 复盘随决策 331 删除，复盘花费恒为 null（字段留在结果行里，旧行照常可读）
      const agentDelta = delta;
      gatewayFacts = {
        queueMs: delta.queueMs,
        accountRequests: delta.accountRequests,
        peakInFlight: delta.peakInFlight,
        costCny: agentDelta.costCny,
        reviewCostCny: null,
        peakInputTokens: delta.peakInputTokens,
        ...((delta.rejectedRequests ?? 0) > 0 ? { rejectedRequests: delta.rejectedRequests } : {}),
      };
      result = {
        ...result,
        turns: agentDelta.requests,
        usage: {
          ...ZERO_USAGE,
          input: agentDelta.input,
          output: agentDelta.output,
          cacheRead: agentDelta.cacheRead,
          cacheWrite: agentDelta.cacheWrite,
          totalTokens:
            agentDelta.input + agentDelta.output + agentDelta.cacheRead + agentDelta.cacheWrite,
        },
      };
    }
    const budget = options.budget ?? DEFAULT_STEP_BUDGET;
    hitStepBudget =
      result.status === "turn-limit" ||
      result.status === "wall-clock-limit" ||
      result.turns >= budget.maxTurns ||
      result.wallMs >= budget.wallClockMs;
    memoryAtEnd = memoryFactsOf(jobDir);
    const agentChangedDeps = await agentChangedDeclaration(options, ws, step.commit);
    // agent 自己提交、切分支或让 HEAD 游离过的，先挪回起点；再存下它相对开工时的改动（代替延续式的流历史）
    await ws.normalizeTo(step.parent);
    await ws.grantOwnerAccess();
    const diffName = `step-${step.seq}.diff`;
    mkdirSync(path.join(jobDir, "diffs"), { recursive: true });
    writeAtomic(
      path.join(jobDir, "diffs", diffName),
      await ws.diffTrees(startTree, await ws.worktreeTree(spec.excludePaths))
    );
    const agentPart = {
      diff: path.posix.join("streams", jobDirName(job), "diffs", diffName),
      envOpenMs,
      envPrefetched,
      agentChangedDeps,
      memoryAtEnd,
      hitStepBudget,
      // 复盘随决策 331 删除：两项恒为 null（字段留在结果行里，旧行照常可读）
      review: null,
      hitReviewBudget: null,
      status: result.status,
      turns: result.turns,
      usage: result.usage,
      agentWallMs: result.wallMs,
      gateway: gatewayFacts,
      admissionWaitMs: admitted.admissionWaitMs,
      ...(result.report !== undefined ? { agentReport: result.report } : {}),
    };
    // 这道题无法建立基线（⑤）：agent 照跑（记忆照常积累），不判分，结果行记原因，不进主判据
    if (classes.unbuildable !== null) {
      return {
        ...base,
        ...agentPart,
        outcome: "skipped",
        judged: false,
        judging: null,
        baselineUnavailable: classes.unbuildable,
        quality: null,
        wallMs: Date.now() - started,
      };
    }
    try {
      await restoreTests(options, ws, step);
      await cleanForJudging(options, ws, step);
    } catch (error) {
      voidOnAccessError(step.seq, error);
    }
    try {
      await syncEnv(options, ws, step.commit);
    } catch (error) {
      if (error instanceof EnvSelectionError) return notRun(envOpenMs, error);
      voidOnAccessError(step.seq, error);
    }
    // 判题：放入人在该步的全部测试后跑一次全量，按两类用例计分（不看退出码）
    let judged: Judgement;
    try {
      judged = await judgeFull(options, ws, step, classes);
    } catch (error) {
      voidOnAccessError(step.seq, error);
    }
    const j = judged.judging;
    return {
      ...base,
      ...agentPart,
      // 结果：要做到的全过（为零时即成立）且不许挂的无一失败记 passed，否则 failed；主判据看 judging
      outcome:
        j.failToPass.passed === j.failToPass.total && j.passToPass.failed === 0
          ? "passed"
          : "failed",
      judged: true,
      judging: j,
      baselineUnavailable: null,
      quality: judged.quality,
      wallMs: Date.now() - started,
    };
  } finally {
    // 这一步的容器用完即弃：被忽略的文件、/tmp 与家目录都不跨步（212）
    await env.dispose();
  }
}

// ---------- 容器实现 ----------

export const STREAM_CONTAINER_ROOT = "/testbed";

// 每一步一个新开的断网容器（决策 212）：同名的旧容器（上一步的、作废尝试的，或进程被杀时留下的）先删掉，由镜像新起，
// 经 bundle 送入人在该步之前的代码并清历史自验。容器随这一步结束丢弃，被 git 忽略的文件、/tmp 与家目录都不跨步
export function dockerStreamEnvs(input: {
  image: string;
  human: HumanRepo;
  // 容器名前缀（区分输出目录）
  prefix: string;
  docker?: readonly string[];
  runArgs?: readonly string[];
  // 容器内的工作区根（缺省 /testbed；本机测试指到临时目录）
  root?: string;
  log?: (line: string) => void;
  // 闸门不成立时的告警（缺省写标准错误，只报一次）
  warn?: (line: string) => void;
  // 按条件替换网络参数（外部 agent 条件：接只通网关的跑批内部网络、只读挂载工具目录）；返回 undefined 的条件照旧断网
  conditionArgs?: (condition: StreamCondition) => readonly string[] | undefined;
}): StreamEnvFactory {
  const docker = input.docker ?? ["docker"];
  const root = input.root ?? STREAM_CONTAINER_ROOT;
  // 开好容器后探一次闸门：不成立（Podman、rootless 等没有 /.dockerenv，或缺少环境变量）即告警一次，说明后果
  let gateWarned = false;
  const warn = input.warn ?? ((line: string) => process.stderr.write(`[跑批] ${line}\n`));
  const probeGate = async (container: string, ws: StreamWorkspace) => {
    if (gateWarned || (await ws.inStreamContainer())) return;
    gateWarned = true;
    warn(
      `作业容器 ${container} 里闸门不成立（缺 PIGEON_STREAM_CONTAINER=1 或 /.dockerenv）：判题前不清家目录下的用户级文件，清 agent 进程退回只按本步标记清，不带标记的后台进程清不到`
    );
  };
  return {
    async open(job, init) {
      const container = `${input.prefix}-${jobDirName(job)}-${init.slot ?? 0}`;
      await removeWorkspaceContainer(container, docker);
      await startWorkspaceContainer({
        image: input.image,
        name: container,
        docker,
        runArgs: [
          ...(input.conditionArgs?.(job.condition) ?? WORKSPACE_NETWORK_ARGS),
          // 标明这是跑批器起的作业容器：清 agent 进程时据此除 init 与主命令外全清（见 KILL_STEP_PROCESSES）
          "-e",
          "PIGEON_STREAM_CONTAINER=1",
          "--label",
          `pigeon.stream=${input.prefix}`,
          ...(input.runArgs ?? []),
        ],
      });
      const ws = new StreamWorkspace(dockerStreamShell({ container, root, docker }));
      try {
        await ws.initFromBundle(input.human.bundle(init.startCommit), init.startCommit);
      } catch (error) {
        await removeWorkspaceContainer(container, docker).catch(() => {});
        throw error;
      }
      await probeGate(container, ws);
      input.log?.(`[${container}] 新开到 ${init.startCommit.slice(0, 9)}`);
      return {
        ws,
        target: { container, root },
        dispose: () => removeWorkspaceContainer(container, docker),
      };
    },
  };
}

// 缓存结果的身份：镜像身份（内容层摘要，见 imageIdentityOf；不用本地镜像 ID 与可变的标签）与命令摘要（人的基准为跑用例的方式，开跑前检查为检查门命令）
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

// strands v6 镜像的内容层身份（14 层；经典存储与 containerd 镜像存储下相同）
export const STRANDS_V6_LAYERS =
  "layers:sha256:ebe5a5270ca0fcee26caf49d6695a56b090b81b027fed92ac7eac8c35b60c5fa";

// 镜像等价表（旧镜像身份, 新镜像身份），只用于人的用例基准：列入的镜像运行环境逐字相同、只差 lint 层，
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
  // 镜像身份改按内容层（RootFS 各层摘要的有序列表）之后：已落盘结果记的是经典存储下的 config 摘要。v6 的 config 摘要与
  // v6 的内容层身份是同一个镜像；v4 与 v6 运行环境逐字相同（见上一对），读回口径不变
  ["sha256:d23b0a512ca217bc2c7984bf33dc52c1006cbf0cd2a9642b7638efb0e3f99b42", STRANDS_V6_LAYERS],
  ["sha256:281bf24305dd0891440e1ecf3a07f09644688f8b28a4e770a5522a43b4d6d8d6", STRANDS_V6_LAYERS],
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
  private readonly human: HumanRepo | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    reference: ReferenceWorkspace;
    runtime: StreamRepoRuntime;
    // 人的仓库（宿主侧）：两类用例的叠放运行从这里取人在该步的测试、测试辅助、环境文件与测试配置；只算人的基准时可不给
    human?: HumanRepo;
    cacheDir: string;
    // 参考容器所用镜像的身份（内容层摘要）：缓存身份之一
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
    this.human = input.human;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private requireHuman(): HumanRepo {
    if (this.human === undefined)
      throw new Error("算两类用例需要人的仓库（ReferenceCases 的 human）");
    return this.human;
  }

  // 叠放运行的落盘结果：身份相符（或按等价读回）且记的起点就是这一步的 parent 才算
  private readOverlay(step: StreamStep): HumanBaseline | undefined {
    const saved = readIdentified<HumanBaseline & { stuck?: string[]; parent?: string }>(
      path.join(this.cacheDir, `${step.commit}.overlay.json`),
      this.casesIdentity(),
      this.equivalent,
      (s) => this.casesHangFree(s),
      this.equivalentImages
    );
    return saved?.parent === step.parent ? saved : undefined;
  }

  // 这一步的两类用例是否已能全从落盘结果读出（提前预计算过的）
  hasClasses(step: StreamStep): boolean {
    return this.cachedClasses(step) !== undefined;
  }

  // 这道题"无法建立基线"的落盘记录：身份相符（或按等价读回）且记的起点就是这一步的 parent 才算；返回原因
  private readUnbuildable(step: StreamStep): string | undefined {
    const saved = readIdentified<{ parent?: string; reason?: string }>(
      path.join(this.cacheDir, `${step.commit}.unbuildable.json`),
      this.casesIdentity(),
      this.equivalent,
      () => true,
      this.equivalentImages
    );
    return saved?.parent === step.parent ? (saved.reason ?? "") : undefined;
  }

  // 只从落盘结果读两类用例（不跑任何东西）；两侧有一侧没落盘即 undefined，记为无法建立基线的读回那条记录。选题（只在
  // 要做到的不为零的题中抽）用它
  cachedClasses(step: StreamStep): StepClasses | undefined {
    const unbuildable = this.readUnbuildable(step);
    if (unbuildable !== undefined) return unbuildableClasses(step, unbuildable);
    const after = this.readCases(step.commit);
    const before = this.readOverlay(step);
    return after === undefined || before === undefined
      ? undefined
      : this.stepClasses(step, after, before);
  }

  private stepClasses(step: StreamStep, after: SideRuns, before: SideRuns): StepClasses {
    const classes = classifyCases(after, before, new Set(step.judgeTests));
    return {
      commit: step.commit,
      parent: step.parent,
      ...classes,
      failToPassOutsideJudgeFiles: outsideJudgeCases(step, classes.failToPass).length,
      unbuildable: null,
    };
  }

  // 两类用例（214）：之后一侧即人的基准（commit 上跑人在该步的全部测试两遍，与全量测量同一份缓存）；之前一侧为叠放运行。
  // 比出的两类另存一份 <commit>.classes.json（由两份落盘结果现算，供事后分析读，不作缓存）。任一侧拿不全用例的结果
  // 即这道题无法建立基线：落盘原因（<commit>.unbuildable.json），之后读回、不再重算，两类都为空
  async classesAt(step: StreamStep): Promise<StepClasses> {
    const known = this.readUnbuildable(step);
    if (known !== undefined) return unbuildableClasses(step, known);
    const tests = humanTestsAt(this.requireHuman(), this.runtime, step.commit);
    let out: StepClasses;
    try {
      const after = await this.casesAt(step.commit, tests);
      const before = await this.overlayAt(step, tests);
      out = this.stepClasses(step, after, before);
    } catch (error) {
      if (!(error instanceof IncompleteRunError)) throw error;
      writeAtomic(
        path.join(this.cacheDir, `${step.commit}.unbuildable.json`),
        JSON.stringify({
          parent: step.parent,
          reason: error.message,
          identity: this.casesIdentity(),
        })
      );
      out = unbuildableClasses(step, error.message);
    }
    writeAtomic(
      path.join(this.cacheDir, `${step.commit}.classes.json`),
      JSON.stringify({ seq: step.seq, ...out })
    );
    return out;
  }

  // 叠放运行（214 的之前一侧）：检出人在该步之前的代码，叠上人在该步的测试、测试辅助与环境文件（红测试对取合并后的
  // 版本，即 step.commit 上的），依赖按叠上的人的声明切，pytest 配置显式取 step.commit 的版本（不读工作区里 parent 的），
  // 跑人在该步的全部测试 repeat 遍。拿不全用例的结果即报错：缺席会被当作没通过，整遍缺失会把不许挂的误判成要做到的
  overlayAt(step: StreamStep, tests: readonly string[]): Promise<HumanBaseline> {
    const run = this.queue.then(async (): Promise<HumanBaseline> => {
      const saved = this.readOverlay(step);
      if (saved !== undefined)
        return { ...saved, runs: saved.runs ?? [], slowest: saved.slowest ?? null };
      const human = this.requireHuman();
      const read = (p: string) => human.show(step.commit, p);
      const ws = this.reference.ws;
      await this.reference.checkout(step.parent);
      const overlay = step.humanFiles.filter(
        (f) => f.kind === "test" || f.kind === "testaux" || f.kind === "env"
      );
      await ws.applyHumanFiles(overlay, read);
      if (this.runtime.envSyncCommand !== null) {
        const sync = await ws.run(this.runtime.envSyncCommand, 120_000);
        if (sync.exitCode !== 0)
          throw new Error(`参考工作区依赖切换失败（${step.parent} 叠 ${step.commit}）`);
      }
      await this.runtime.pinTestConfig?.(ws, async (p) => {
        try {
          return read(p);
        } catch {
          return undefined;
        }
      });
      const baseline = await this.repeatRuns(`${step.commit}（叠放到 ${step.parent}）`, tests);
      writeAtomic(
        path.join(this.cacheDir, `${step.commit}.overlay.json`),
        JSON.stringify({
          ...baseline.result,
          stuck: baseline.stuck,
          parent: step.parent,
          overlay: overlay.map((f) => `${f.op} ${f.path}`),
          identity: this.casesIdentity(),
        })
      );
      return baseline.result;
    });
    this.queue = run.catch(() => {});
    return run;
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
    const { result: baseline, stuck } = await this.repeatRuns(commit, tests);
    writeAtomic(file, JSON.stringify({ ...baseline, stuck, identity }));
    return baseline;
  }

  // 在参考工作区现状上跑 tests repeat 遍、逐条比对；每遍采内存峰值，拿不全用例即报错
  private async repeatRuns(
    commit: string,
    tests: readonly string[]
  ): Promise<{ result: HumanBaseline; stuck: string[] }> {
    const ws = this.reference.ws;
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
      // 人这一侧拿不全就没有可信的分母：报错，不以缺了用例的基准静默缩小分母（两类用例据此记这道题无法建立基线）
      if (!run.complete) {
        throw new IncompleteRunError(
          `人的基准没拿到全部用例的结果（${commit}，第 ${k + 1} 遍）：${run.output.slice(-500)}`
        );
      }
      runs.push(run.cases);
      for (const id of run.stuck) stuck.add(id);
    }
    return { result: { ...compareRuns(runs), runs: meta }, stuck: [...stuck] };
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
