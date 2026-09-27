// 延续式实验的结果行（决策 145、142、143、144）：每条流、每个条件、每一步一行，逐行追加到 results.jsonl，
// 与外部基准跑批同一种落盘与续跑做法（写完即追加；撕裂的末行读时丢弃；按键取断点）。
// 被限额打断的一步整题作废、不留行（144），因此这里没有错误行：有行即该步已完成。
import { existsSync, readFileSync } from "node:fs";
import type { TurnUsage } from "../state/runtime-events.ts";
import type { FailureAttribution } from "./stream-attribution.ts";
import type { HarnessRef } from "./stream-identity.ts";
import type { StreamStepKind } from "./stream-manifest.ts";
import type { CountPassRate } from "./stream-measure.ts";

export type StreamCondition = "full" | "no-memory" | "no-gate" | "minimal";

export const STREAM_CONDITIONS: readonly StreamCondition[] = [
  "full",
  "no-memory",
  "no-gate",
  "minimal",
];

// 结果：题与维护步按判定记 passed / failed；套用步记 applied；跳过步记 skipped
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
  // 本步结束后工作区的 HEAD（落地后的新提交，跳过时为本步起点）；续跑时据此核对容器
  head: string;
  // 本步是否做了判定（题与维护步为 true）
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
  // 全量测试通过率（跳过步沿用上一步，没有测量时为 null）。主指标 byCount 的分母为人的代码上每遍都通过的用例（B，
  // 145 修订）；byCountCollected 的分母为人的代码上收集出的全部用例（A，对照）；humanFlaky 为人的代码上时过时不过的用例数；
  // humanRuns 为人的基准每一遍的内存峰值与墙钟，humanSlowest 为其中耗时最长的用例
  fullPassRate: {
    byCount: CountPassRate;
    byCountCollected: CountPassRate;
    byTask: CountPassRate;
    humanFlaky: number;
    humanRuns: BaselineRunFacts[];
    humanSlowest: { id: string; seconds: number } | null;
  } | null;
  regressions: number | null;
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
  attribution: FailureAttribution | null;
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
  "head",
  "judged",
  "repairRounds",
  "finalVerdict",
  "humanTestRestores",
  "agentChangedDeps",
  "humanFailsGate",
  "runIdentity",
  "agentSettings",
  "fullPassRate",
  "regressions",
  "quality",
  "status",
  "turns",
  "usage",
  "agentWallMs",
  "wallMs",
  "attribution",
  "limitPauses",
  "gateway",
  "admissionWaitMs",
  "harnessRef",
] as const;

// 旧结果行才带、新行不再写的字段（决策 173）：读取与报告照常接受
export const LEGACY_STREAM_RESULT_FIELDS = ["reverted", "repairBudgetExhausted"] as const;

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
