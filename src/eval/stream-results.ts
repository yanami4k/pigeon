// 提交流实验的结果行（决策 145、142、143、144、193）：每个条件、每一步一行，逐行追加到 results.jsonl，
// 与外部基准跑批同一种落盘与续跑做法（写完即追加；撕裂的末行读时丢弃；按键取断点）。
// 被限额打断的一步整题作废、不留行（144），因此这里没有错误行：有行即该步已完成。
import { existsSync, readFileSync } from "node:fs";
import type { TurnUsage } from "../state/runtime-events.ts";
import type { StepJudging } from "./stream-classes.ts";
import type { HarnessRef } from "./stream-harness.ts";
import type { StreamStepKind } from "./stream-manifest.ts";
import type { CountPassRate } from "./stream-measure.ts";

// 条件（193、194、217）：记忆的 2 × 2——能否检索历史会话 × 有无推送记忆，四格都开验证门与回炉；另加最简 agent 作外部参照
export type StreamCondition = "search-push" | "search-only" | "push-only" | "neither" | "minimal";

export const STREAM_CONDITIONS: readonly StreamCondition[] = [
  "search-push",
  "search-only",
  "push-only",
  "neither",
  "minimal",
];

// 结果：题按判定记 passed / failed；依赖环境选不出而作废的步记 skipped。固定起点（215）下维护步、套用步与跳过步
// 都不跑，applied 与维护步的判定只出现在旧结果行里
export type StreamStepOutcome = "passed" | "failed" | "applied" | "skipped";

export interface LimitPauseRecord {
  // 5h / weekly / monthly / concurrency
  kind: string;
  startedAt: string;
  endedAt: string | null;
}

export interface StreamResultLine {
  repo: string;
  stream: string;
  condition: StreamCondition;
  attempt: number;
  seq: number;
  kind: StreamStepKind;
  commit: string;
  outcome: StreamStepOutcome;
  // 本步的起点：人在该步之前的代码（step.parent，193、212 固定起点）
  start: string;
  // agent 在这一步的改动（相对起点的 git diff，含新建文件）存在哪里：输出目录下的相对路径；没跑 agent 为 null
  diff: string | null;
  // 为这一步新开干净容器（建容器、送入起点、清历史自验）的毫秒；没开容器为 null
  envOpenMs: number | null;
  // 延续式（193 之前）的旧结果行才有：本步结束后的 HEAD、回归数与失败归因。新行不写，只读兼容
  head?: string;
  regressions?: number | null;
  attribution?: string | null;
  // 本步是否做了判定（题为 true）
  judged: boolean;
  // 回炉：未开回炉的条件为 null
  repairRounds: number | null;
  finalVerdict: "pass" | "fail" | null;
  // 撤回拆除（决策 173）之前写下的旧结果行才有：是否撤回、撤回是否因预算先于轮数用尽。新行不写，只读兼容
  reverted?: boolean;
  repairBudgetExhausted?: boolean | null;
  // 验证之前发现 agent 改过人写测试并还原的次数（每次验证至多计 1）；未开回炉为 null
  humanTestRestores: number | null;
  // agent 是否改了依赖声明文件（与人在该步的版本不同）：切环境一律按人的声明，这里只记下；没有依赖声明或没跑 agent 为 null
  agentChangedDeps: boolean | null;
  // 人的代码在这一步没过验证门（清单里的标记，见开跑前置检查）
  humanFailsGate: boolean;
  // 这次跑批的身份摘要（输出目录 identity.json 的 core）；没给为 null
  runIdentity: string | null;
  // 本条件所用 agent 的参数（Pigeon：温度、输出上限、推理档位；最简 agent：它自己配置里的 model_kwargs）；没给为 null
  agentSettings: Record<string, unknown> | null;
  // 判题（196、201、214）：放入人在该步的全部测试后跑一次全量，按两类用例统计——要做到的通过数与总数、每步得分（要做到的
  // 为零时为 null，不进主判据分母）、不许挂的失败数与总数、做成与否（要做到的为零时为 null）、没通过的用例编号（截断）、
  // 因时过时不过排除的用例数。没判的步为 null
  judging: StepJudging | null;
  // 193 固定起点之前的旧结果行才有的全量测试通过率（按条数、按题等）。新行不写，只读兼容
  fullPassRate?: {
    byCount: CountPassRate;
    byCountCollected: CountPassRate;
    byTask: CountPassRate;
    humanFlaky: number;
    humanRuns: BaselineRunFacts[];
    humanSlowest: { id: string; seconds: number } | null;
  } | null;
  // 这一步开工时（记忆快照取定或恢复之后、agent 开始之前）作业治理根里 .pigeon/learned/MEMORY.md 的字节数、条目数与条目
  // 部分的字符数（文件头不计，223 的上限按它算）；文件不在记 0
  memoryAtStart: MemoryFacts | null;
  // 这一步 agent 运行与收尾复盘都结束之后（判题之前）的记忆大小，口径同上；最后一步的即一遍结束时的记忆。复盘接入之前
  // 照样在 agent 结束后记。依赖环境选不出而没跑 agent 的步为 null
  memoryAtEnd: MemoryFacts | null;
  // 这一步是否撞了宽上限（171）：agent 以撞轮数或墙钟上限收尾（终态 turn-limit / wall-clock-limit），或轮数、墙钟
  // （含验证门与回炉）达到上限。没跑 agent 为 null
  hitStepBudget: boolean | null;
  // 这一步的收尾复盘是否撞了复盘上限；复盘接入之前恒为 null
  hitReviewBudget: boolean | null;
  // 这一步的收尾复盘：轮数与墙钟（推送记忆的复盘接入之前恒为 null）；花费在 gateway.reviewCostCny
  review: { turns: number; wallMs: number } | null;
  // 这一步的容器是否在上一步进行时预先开好（envOpenMs 为等它就绪的时间）
  envPrefetched: boolean;
  quality: {
    typeErrors: number | null;
    formatErrors: number | null;
    layerViolations: number | null;
  } | null;
  // agent 的终态（没跑 agent 的步为 null）
  status: string | null;
  turns: number;
  usage: TurnUsage;
  // agent 用时；整步用时
  agentWallMs: number;
  wallMs: number;
  limitPauses: LimitPauseRecord[];
  // 经网关时本步的模型请求：等空闲账号的累计毫秒、各账号成功转发的次数（下标 0 为账号 1，不记 key）、
  // 同时在途的请求数峰值；没跑 agent 或不经网关为 null
  gateway: StreamGatewayFacts | null;
  // 这一步的 agent 开始之前等放行的毫秒（决策 163：同时在跑的 agent 数达到可用容量或配置路数时在步与步之间等；
  // 含整批暂停）；没跑 agent 为 null
  admissionWaitMs: number | null;
  harnessRef: HarnessRef;
  error?: string;
}

export interface StreamGatewayFacts {
  queueMs: number;
  accountRequests: number[];
  peakInFlight: number;
  // 本步 agent 的模型花费（人民币元）：读网关计量的 costCny 按步做差；网关计量还没有这一项时为 null
  costCny?: number | null;
  // 本步复盘的模型花费（人民币元），单列；复盘接入之前恒为 null
  reviewCostCny?: number | null;
  // 本步单次请求送进模型的输入 token 最大值（上下文峰值，218）：读网关计量的 peakInputTokens（每步开始时重置）；
  // 网关计量还没有这一项时为 null
  peakInputTokens?: number | null;
}

export interface MemoryFacts {
  bytes: number;
  entries: number;
  entryChars: number;
}

// 人的基准内存峰值超过容器上限的这一比例即告警：说明作业容器的上限可能不够
export const MEMORY_WARN_RATIO = 0.75;

export interface BaselineRunFacts {
  peakBytes: number | null;
  limitBytes: number | null;
  wallMs: number;
}

export const STREAM_RESULT_FIELDS = [
  "repo",
  "stream",
  "condition",
  "attempt",
  "seq",
  "kind",
  "commit",
  "outcome",
  "start",
  "diff",
  "envOpenMs",
  "judged",
  "repairRounds",
  "finalVerdict",
  "humanTestRestores",
  "agentChangedDeps",
  "humanFailsGate",
  "runIdentity",
  "agentSettings",
  "judging",
  "memoryAtStart",
  "memoryAtEnd",
  "hitStepBudget",
  "hitReviewBudget",
  "review",
  "envPrefetched",
  "quality",
  "status",
  "turns",
  "usage",
  "agentWallMs",
  "wallMs",
  "limitPauses",
  "gateway",
  "admissionWaitMs",
  "harnessRef",
] as const;

// 旧结果行才带、新行不再写的字段（决策 173 的撤回字段；193 固定起点之前的 HEAD、回归数与失败归因；196、201 两类用例
// 计分之前的全量测试通过率）：读取照常接受
export const LEGACY_STREAM_RESULT_FIELDS = [
  "reverted",
  "repairBudgetExhausted",
  "head",
  "regressions",
  "attribution",
  "fullPassRate",
] as const;

export interface StreamJobId {
  stream: string;
  condition: StreamCondition;
  attempt: number;
}

export function streamJobKey(job: StreamJobId): string {
  return `${job.stream}|${job.condition}|${job.attempt}`;
}

// 读结果行：撕裂的末行（进程死于写到一半）与空行丢弃
export function readStreamResults(file: string): StreamResultLine[] {
  if (!existsSync(file)) return [];
  const out: StreamResultLine[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      out.push(JSON.parse(raw) as StreamResultLine);
    } catch {
      // 撕裂的行
    }
  }
  return out;
}

export function lastCompletedStep(
  lines: readonly StreamResultLine[],
  job: StreamJobId
): StreamResultLine | undefined {
  const key = streamJobKey(job);
  let last: StreamResultLine | undefined;
  for (const line of lines) {
    if (streamJobKey(line) !== key) continue;
    if (last === undefined || line.seq > last.seq) last = line;
  }
  return last;
}

export const ZERO_USAGE: TurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
