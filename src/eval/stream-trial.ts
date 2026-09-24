// 预算校准的试跑（决策 147 修订）：从清单里挑若干步，每一步各自从人在该步父提交上的代码起跑（互不依赖、可并行），
// 按给定的条件与放宽的预算只跑 agent（开回炉的条件连同验证门与回炉），不判题、不做全量测量、不落地；每步一个独立的
// 治理根。结果行逐行追加，同一输出目录重跑只补跑还没完成的步。最后按判据算出建议预算：以"完整 Pigeon"条件（没跑它则
// 用全部条件）各步实际用掉的轮数与墙钟，各取第 90 百分位（最近秩法），乘以 1.5，且不低于 150 轮与 30 分钟
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { listSessionIds, materializeSession } from "../persistence/event-log.ts";
import { meterDelta } from "./model-gateway.ts";
import type { LimitController } from "./model-limits.ts";
import type { HumanRepo } from "./stream-facts.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import { type StreamRepoRuntime, verifyConfigFile, verifyScript } from "./stream-profiles.ts";
import type { StreamCondition, StreamGatewayFacts } from "./stream-results.ts";
import {
  CONDITION_SPECS,
  type StepAgent,
  type StepBudget,
  type StreamEnvFactory,
  type StreamModelGateway,
  syncEnv,
} from "./stream-runner.ts";

export const TRIAL_MIN_TURNS = 150;
export const TRIAL_MIN_WALL_CLOCK_MIN = 30;
export const TRIAL_MARGIN = 1.5;
// 同一步被打断（限额信号、上游故障、agent 自报）最多重做这么多次，仍不成即记出错
const MAX_TRIAL_ATTEMPTS = 3;

export interface TrialRow {
  stream: string;
  seq: number;
  kind: string;
  commit: string;
  condition: StreamCondition;
  status?: string;
  // 轮数：经网关时为成功转发的模型请求数，否则取 agent 报的
  turns?: number;
  agentTurns?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  agentWallMs?: number;
  stepWallMs?: number;
  // 每次验证的用时（Pigeon 回炉条件从会话账本取）
  verifyMs?: number[];
  repairRounds?: number | null;
  finalVerdict?: "pass" | "fail" | null;
  reverted?: boolean;
  budgetExhausted?: boolean | null;
  // 与正式结果行同形：等空闲账号的累计毫秒、各账号成功转发的次数、同时在途的请求数峰值；不经网关为 null
  gateway?: StreamGatewayFacts | null;
  memory?: {
    enabled: boolean | null;
    opening: string[];
    openingBlocked: string[];
    repair: string[][];
    repairBlocked: string[][];
  };
  error?: string;
}

export interface TrialRecommendation {
  condition: StreamCondition | "all";
  samples: number;
  p90Turns: number;
  p90WallMs: number;
  maxTurns: number;
  wallClockMin: number;
}

// 第 90 百分位（最近秩法）
function p90(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)] ?? 0;
}

export function recommendBudget(rows: readonly TrialRow[]): TrialRecommendation | null {
  const ok = rows.filter((r) => r.error === undefined && r.turns !== undefined);
  const full = ok.filter((r) => r.condition === "full");
  const used = full.length > 0 ? full : ok;
  if (used.length === 0) return null;
  const pTurns = p90(used.map((r) => r.turns ?? 0));
  const pWall = p90(used.map((r) => r.agentWallMs ?? 0));
  return {
    condition: full.length > 0 ? "full" : "all",
    samples: used.length,
    p90Turns: pTurns,
    p90WallMs: pWall,
    maxTurns: Math.max(TRIAL_MIN_TURNS, Math.ceil(pTurns * TRIAL_MARGIN)),
    wallClockMin: Math.max(TRIAL_MIN_WALL_CLOCK_MIN, Math.ceil((pWall * TRIAL_MARGIN) / 60_000)),
  };
}

export function readTrialRows(file: string): TrialRow[] {
  if (!existsSync(file)) return [];
  const out: TrialRow[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      out.push(JSON.parse(raw) as TrialRow);
    } catch {
      // 撕裂的末行
    }
  }
  return out;
}

// 会话账本里的验证用时与结构化记忆的挑选
function sessionFacts(workDir: string): {
  verifyMs: number[];
  memory: NonNullable<TrialRow["memory"]>;
} {
  const dir = path.join(workDir, ".pigeon", "sessions");
  const memory: NonNullable<TrialRow["memory"]> = {
    enabled: null,
    opening: [],
    openingBlocked: [],
    repair: [],
    repairBlocked: [],
  };
  const verifyMs: number[] = [];
  if (!existsSync(dir)) return { verifyMs, memory };
  for (const id of listSessionIds(dir)) {
    const s = materializeSession(dir, id, { content: false });
    for (const r of s.runStarteds) {
      const m = r.payload.structuredMemory;
      if (m === undefined) continue;
      memory.enabled = m.enabled;
      if (m.repair !== undefined) {
        memory.repair.push([...m.repair]);
        memory.repairBlocked.push([...(m.repairBlocked ?? [])]);
      } else {
        memory.opening = [...m.opening];
        memory.openingBlocked = [...(m.openingBlocked ?? [])];
      }
    }
    for (const v of s.attemptVerifieds) verifyMs.push(v.durationMs);
  }
  return { verifyMs, memory };
}

export interface StreamTrialOptions {
  manifest: StreamManifest;
  human: HumanRepo;
  runtime: StreamRepoRuntime;
  // 要试跑的步（清单里的步序）
  steps: readonly number[];
  conditions: readonly StreamCondition[];
  budget: StepBudget;
  concurrency: number;
  outDir: string;
  envs: StreamEnvFactory;
  agents: Partial<Record<"pigeon" | "minimal", StepAgent>>;
  gateway?: StreamModelGateway;
  limits?: LimitController;
  verifyTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface StreamTrialSummary {
  resultsFile: string;
  recommendationFile: string;
  recommendation: TrialRecommendation | null;
}

export async function runStreamTrial(options: StreamTrialOptions): Promise<StreamTrialSummary> {
  const log = (line: string) => options.log?.(line);
  mkdirSync(options.outDir, { recursive: true });
  const resultsFile = path.join(options.outDir, "results.jsonl");
  const recommendationFile = path.join(options.outDir, "recommendation.json");
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 1_800_000;
  const bySeq = new Map(options.manifest.steps.map((s) => [s.seq, s]));
  const streamOf = (seq: number) =>
    options.manifest.streams.find((s) => seq >= s.firstSeq && seq <= s.lastSeq)?.id;
  const work: { stream: string; step: StreamStep; condition: StreamCondition }[] = [];
  for (const seq of options.steps) {
    const step = bySeq.get(seq);
    const stream = streamOf(seq);
    if (step === undefined || stream === undefined) throw new Error(`清单里没有第 ${seq} 步`);
    if (step.kind !== "task" && step.kind !== "maintenance") {
      throw new Error(`第 ${seq} 步是${step.kind}，试跑只跑题与维护步`);
    }
    for (const condition of options.conditions) work.push({ stream, step, condition });
  }
  const keyOf = (w: { stream: string; step: StreamStep; condition: StreamCondition }) =>
    `${w.stream}-q${w.step.seq}-${w.condition}`;
  const done = new Set(
    readTrialRows(resultsFile)
      .filter((r) => r.error === undefined)
      .map((r) => `${r.stream}-q${r.seq}-${r.condition}`)
  );
  const queue = work.filter((w) => !done.has(keyOf(w)));
  log(`试跑：${work.length} 项（已完成 ${work.length - queue.length}），${options.concurrency} 路`);

  const one = async (w: { stream: string; step: StreamStep; condition: StreamCondition }) => {
    const key = keyOf(w);
    const { step, stream, condition } = w;
    const spec = CONDITION_SPECS[condition];
    const agent = options.agents[spec.agent];
    const base = { stream, seq: step.seq, kind: step.kind, commit: step.commit, condition };
    if (agent === undefined) {
      appendFileSync(
        resultsFile,
        `${JSON.stringify({ ...base, error: `条件 ${condition} 需要的 agent 没有接入` })}\n`
      );
      return;
    }
    const job = { stream: `${stream}q${step.seq}`, condition, attempt: 1 };
    for (let attempt = 1; attempt <= MAX_TRIAL_ATTEMPTS; attempt++) {
      const workDir = path.join(options.outDir, "steps", key);
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(path.join(workDir, ".pigeon"), { recursive: true });
      writeFileSync(
        path.join(workDir, ".pigeon", "verify.json"),
        `${JSON.stringify(verifyConfigFile(options.runtime.verifySteps, verifyTimeoutMs), null, 2)}\n`
      );
      const started = Date.now();
      log(`${key} 开始（第 ${attempt} 次）`);
      const env = await options.envs.open(job, { startCommit: step.parent });
      try {
        await env.ws.applyHumanFiles(step.humanFiles, (p) => options.human.show(step.commit, p));
        await syncEnv(options, env.ws, step.commit);
        const before = options.gateway?.meter(key);
        options.gateway?.resetPeak(key);
        const signalsBefore = options.limits?.signals ?? 0;
        const release = await options.limits?.acquire();
        let result: Awaited<ReturnType<StepAgent["run"]>>;
        try {
          result = await agent.run({
            job,
            step,
            prompt: step.prompt ?? step.message,
            condition: spec,
            target: env.target,
            budget: options.budget,
            verify: {
              steps: options.runtime.verifySteps,
              command: verifyScript(options.runtime.verifySteps),
              timeoutMs: verifyTimeoutMs,
            },
            workDir,
            humanTestFiles: new Set(
              options.human
                .tree(step.commit)
                .map((e) => e.path)
                .filter((p) => {
                  const kind = options.runtime.profile.classifyFile(p);
                  return kind === "test" || kind === "testaux";
                })
            ),
            ...(options.gateway !== undefined
              ? { modelBaseUrl: options.gateway.jobBaseUrl(key) }
              : {}),
          });
        } finally {
          release?.();
        }
        const delta =
          options.gateway !== undefined && before !== undefined
            ? meterDelta(options.gateway.meter(key), before)
            : undefined;
        const signalled = (options.limits?.signals ?? 0) !== signalsBefore;
        if (signalled || (delta?.upstreamFailures ?? 0) > 0 || result.interrupted !== undefined) {
          log(`${key} 被打断，作废重做：${result.interrupted ?? "限额信号或上游故障"}`);
          continue;
        }
        const facts = sessionFacts(workDir);
        const row: TrialRow = {
          ...base,
          status: result.status,
          turns: delta?.requests ?? result.turns,
          agentTurns: result.turns,
          tokens:
            delta !== undefined
              ? {
                  input: delta.input,
                  output: delta.output,
                  cacheRead: delta.cacheRead,
                  cacheWrite: delta.cacheWrite,
                  total: delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
                }
              : {
                  input: result.usage.input,
                  output: result.usage.output,
                  cacheRead: result.usage.cacheRead,
                  cacheWrite: result.usage.cacheWrite,
                  total: result.usage.totalTokens,
                },
          agentWallMs: result.wallMs,
          stepWallMs: Date.now() - started,
          verifyMs: facts.verifyMs,
          repairRounds: result.repair?.rounds ?? null,
          finalVerdict: result.repair?.finalVerdict ?? null,
          reverted: result.repair?.reverted ?? false,
          budgetExhausted: result.repair?.budgetExhausted ?? null,
          gateway:
            delta !== undefined
              ? {
                  queueMs: delta.queueMs,
                  accountRequests: delta.accountRequests,
                  peakInFlight: delta.peakInFlight,
                }
              : null,
          ...(spec.agent === "pigeon" ? { memory: facts.memory } : {}),
        };
        appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
        log(
          `${key} 完成：${row.status} 轮 ${row.turns} 墙钟 ${Math.round((row.agentWallMs ?? 0) / 60_000)} 分`
        );
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${key} 出错：${message}`);
        appendFileSync(resultsFile, `${JSON.stringify({ ...base, error: message })}\n`);
        return;
      } finally {
        await env.dispose().catch(() => {});
      }
    }
    appendFileSync(
      resultsFile,
      `${JSON.stringify({ ...base, error: `连续 ${MAX_TRIAL_ATTEMPTS} 次被打断` })}\n`
    );
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, async () => {
      for (;;) {
        const item = queue[next];
        next += 1;
        if (item === undefined) return;
        await one(item);
      }
    })
  );
  const recommendation = recommendBudget(readTrialRows(resultsFile));
  writeFileSync(recommendationFile, `${JSON.stringify(recommendation, null, 2)}\n`);
  return { resultsFile, recommendationFile, recommendation };
}
