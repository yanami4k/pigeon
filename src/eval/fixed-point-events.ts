// 定点对照的事件认定（决策 138、139、151、157）：输入为"去掉记忆"条件一遍整流跑的输出目录（结果行、治理根里的会话、
// 每步落地后导出的流历史），程序按规则、在重跑之前确定事件。对每一步 k：
//   - 从流历史恢复第 k 步起点的工作区（上一步落地的提交，加上该步按规则写入的人写文件，与流中该步开工时一致）；
//     第 1 到 k−1 步开工时的树（run.started 记下的 stepStart.baseCommit）必须在导出的流历史里，取不到即报错；
//   - 治理根里放第 1 到 k−1 步的会话副本，以正式使用的推送代码（派生、合并、核验同一套）走一遍：开局按第 k 步的题面挑选，
//     回炉按第 k 步在无记忆跑中实际出现的各轮报错挑选；核验对象都是第 k 步起点的代码；
//   - 任一时机挑到至少一条记忆（核验通过）即为事件，记下挑到的条目与时机（开局或第几轮回炉）。
// 三组的固定挑选（157）同时定下：带记忆组给挑到的那几条、时机不变；带无关记忆组逐条换成取自其他文件的真实记忆
// （锚点不在本步题面指到的文件、不在本步改动的文件、不与被换的条目同锚点或同指纹；成文长度最接近者，平手取编号最小）；
// 不带组一条不给。清单不含时间戳与本机路径：同一输入得到逐字相同的清单。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createStructuredMemoryPush } from "../application/structured-memory.ts";
import { checkEntry, renderEntry } from "../memory/structured-select.ts";
import {
  buildMemoryEntries,
  loadStructuredMemory,
  type MemoryEntry,
} from "../memory/structured-store.ts";
import {
  hostWorkspaceAccess,
  localWorkspaceAccess,
  taskReferencedFiles,
} from "../memory/structured-workspace.ts";
import { listSessionIds, materializeSession } from "../persistence/session-read.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { ledgerFileChanges } from "../state/structured-memory.ts";
import { describeFingerprint } from "../state/verify-fingerprint.ts";
import { recordStepsOf } from "../state/verify-steps.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import type { HumanRepo } from "./stream-facts.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import type { StreamRepoRuntime } from "./stream-profiles.ts";
import { readStreamResults, type StreamResultLine, streamJobKey } from "./stream-results.ts";
import {
  CONDITION_SPECS,
  type StreamEnvFactory,
  type StreamEnvironment,
  syncEnv,
} from "./stream-runner.ts";

export const FIXED_POINT_GROUPS = ["memory", "irrelevant", "none"] as const;
export type FixedPointGroup = (typeof FIXED_POINT_GROUPS)[number];

// 一条被挑中（或被换上）的记忆
export interface MemoryItem {
  id: string;
  anchor: string;
  kind: "regression" | "reverted";
  step: string;
  fingerprint: string;
  fingerprintKey: string;
  // 推送文字的长度（无关记忆按它取最接近者）
  textLength: number;
  // 红转绿的补改文件（判定"记忆是否被用上"）；撤回类没有，为 null
  repairFiles: string[] | null;
}

export interface FixedSelection {
  opening: string[];
  repair: string[];
}

export interface FixedPointEvent {
  id: string;
  stream: string;
  seq: number;
  commit: string;
  kind: StreamStep["kind"];
  // 第 k 步起点：上一步结束时的提交
  startHead: string;
  // 放进治理根的第 1 到 k−1 步的会话文件
  priorSessionFiles: string[];
  // 这些会话开工时的树（重跑时一并带进工作区）
  priorStepStarts: string[];
  // 无记忆跑中第 k 步的会话与首个 Run（一致性核对的原尝试）
  stepSession: string;
  firstRunId: string;
  // 挑到的条目与时机：开局，或第几轮回炉
  picked: { opening: string[]; repair: { round: number; ids: string[] }[] };
  relevant: MemoryItem[];
  // 带无关记忆组：被换条目 → 换上的条目；找不到候选时为 null（该组缺失）
  irrelevant: { replaces: string; item: MemoryItem }[] | null;
  // 三组的固定挑选；缺失的组为 null
  fixed: Record<FixedPointGroup, FixedSelection | null>;
}

export interface FixedPointScan {
  stream: string;
  seq: number;
  event: boolean;
  reason: string;
}

export interface FixedPointEventList {
  version: 1;
  repo: string;
  noMemory: { attempt: number; streams: { id: string; resultsDigest: string }[] };
  events: FixedPointEvent[];
  scanned: FixedPointScan[];
}

// 导出的流历史里取不到某步开工时的树：跑批器没保住它，派生会把该步的测试红转绿判为未知——响亮报错，不静默少记
export class StepStartMissingError extends Error {
  override name = "StepStartMissingError";
}

// 无记忆整流里的一个作业（流 × no-memory × 遍次）
export interface NoMemoryJob {
  stream: string;
  attempt: number;
  jobDir: string;
  sessionsDir: string;
  rows: StreamResultLine[];
  bundle(): Buffer;
  // 某步完成时治理根里的会话文件；null 为流开始之前（空）
  sessionFilesAfter(seq: number | null): string[];
}

export function openNoMemoryJob(dir: string, stream: string, attempt = 1): NoMemoryJob {
  const job = { stream, condition: "no-memory" as const, attempt };
  const jobDir = path.join(dir, "streams", `${stream}-no-memory-${attempt}`);
  if (!existsSync(jobDir))
    throw new Error(`无记忆整流里没有作业目录：streams/${stream}-no-memory-${attempt}`);
  const rows = readStreamResults(path.join(dir, "results.jsonl"))
    .filter((r) => streamJobKey(r) === streamJobKey(job))
    .sort((a, b) => a.seq - b.seq);
  return {
    stream,
    attempt,
    jobDir,
    sessionsDir: path.join(jobDir, ".pigeon", "sessions"),
    rows,
    bundle: () => readFileSync(path.join(jobDir, "history.bundle")),
    sessionFilesAfter(seq) {
      if (seq === null) return [];
      const file = path.join(jobDir, `sessions-${seq}.json`);
      if (!existsSync(file))
        throw new Error(`无记忆整流缺第 ${seq} 步完成时的会话清单：sessions-${seq}.json`);
      return (JSON.parse(readFileSync(file, "utf8")) as string[]).slice().sort();
    },
  };
}

// 这个作业结果行的摘要：重跑据此确认事件清单出自同一份输出
export function resultsDigestOf(job: NoMemoryJob): string {
  return createHash("sha256").update(JSON.stringify(job.rows)).digest("hex").slice(0, 16);
}

function sessionIdsIn(files: readonly string[]): string[] {
  return files
    .filter(
      (f) => f.endsWith(".jsonl") && !f.endsWith(".messages.jsonl") && !f.endsWith(".legacy.jsonl")
    )
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

// 会话开工时的树：容器模式下 run.started 的 stepStart.baseCommit；回炉开启却没记下即报错
function stepStartOf(sessionsDir: string, sessionId: string): string | undefined {
  const session = materializeSession(sessionsDir, sessionId as SessionId, { content: false });
  const base = session.runStarteds.find((r) => r.payload.stepStart?.baseCommit !== undefined)
    ?.payload.stepStart?.baseCommit;
  if (base === undefined && session.attemptVerifieds.length > 0) {
    throw new StepStartMissingError(
      `会话 ${sessionId} 做过回炉验证，run.started 却没有记下开工时的树：派生无法认定题面测试`
    );
  }
  return base;
}

// 在宿主上把流历史切到 head：只留 head 可达的提交（后面各步的提交不进工作区），另带上指定的开工时的树
// （原名取它在导出的流历史里的引用名；每个的父提交必须是 head 或其祖先）。取不到即报错
export function sliceHistory(input: {
  bundle: Buffer;
  head: string;
  keep: readonly string[];
  scratch: string;
}): Buffer {
  mkdirSync(input.scratch, { recursive: true });
  const dir = mkdtempSync(path.join(input.scratch, "slice-"));
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  const ok = (args: readonly string[]) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  try {
    git(["init", "-q", "--bare"]);
    const file = path.join(dir, "full.bundle");
    writeFileSync(file, input.bundle);
    git(["fetch", "-q", file, "+refs/*:refs/src/*"]);
    if (!ok(["cat-file", "-e", `${input.head}^{commit}`])) {
      throw new Error(`导出的流历史里没有起点提交 ${input.head}`);
    }
    git(["update-ref", "refs/heads/main", input.head]);
    const refs = ["refs/heads/main"];
    for (const sha of [...new Set(input.keep)].sort()) {
      if (!ok(["cat-file", "-e", `${sha}^{commit}`])) {
        throw new StepStartMissingError(
          `导出的流历史里没有开工时的树 ${sha}：跑批器须给每步开工时的树建引用并随流历史导出`
        );
      }
      const parent = git(["rev-parse", `${sha}^`]).trim();
      if (!ok(["merge-base", "--is-ancestor", parent, input.head])) {
        throw new Error(`开工时的树 ${sha} 不在起点 ${input.head} 之前，不能带进这一步`);
      }
      const named = git([
        "for-each-ref",
        "--format=%(refname)",
        "--points-at",
        sha,
        "refs/src/pigeon/",
      ])
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .sort()[0];
      const name =
        named !== undefined
          ? `refs/${named.slice("refs/src/".length)}`
          : `refs/pigeon/step-start/${sha}`;
      git(["update-ref", name, sha]);
      refs.push(name);
    }
    const out = path.join(dir, "slice.bundle");
    git(["bundle", "create", "-q", out, ...refs]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

export interface StepStartContext {
  runtime: StreamRepoRuntime;
  human: HumanRepo;
}

// 把工作区摆成第 k 步开工时的样子：核验开工时的树都在，回到起点提交，写入该步的人写文件，按人的提交切依赖环境
// （与跑批器每步开工前同一套动作）
export async function prepareStepStart(
  ctx: StepStartContext,
  env: StreamEnvironment,
  step: StreamStep,
  input: { startHead: string; keep: readonly string[] }
): Promise<void> {
  const { ws } = env;
  // 开工时的树随切片后的流历史带进来（恢复时一并取回 refs/pigeon/step-start 下的引用）；这里逐个核验在不在
  for (const sha of input.keep) {
    const r = await ws.run(["git", "cat-file", "-e", `${sha}^{commit}`], 60_000);
    if (r.exitCode !== 0) throw new StepStartMissingError(`工作区里没有开工时的树 ${sha}`);
  }
  await ws.rollback(input.startHead);
  await ws.applyHumanFiles(step.humanFiles, (p) => ctx.human.show(step.commit, p));
  await syncEnv(ctx, ws, step.commit);
}

// 治理根里放入给定的会话文件副本（不带缓存：结构化记忆从会话现算）
export function seedGovernanceRoot(
  root: string,
  sessionsDir: string,
  files: readonly string[]
): void {
  const target = path.join(root, ".pigeon", "sessions");
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(path.join(sessionsDir, file), path.join(target, file));
}

function itemOf(entry: MemoryEntry): MemoryItem {
  return {
    id: entry.id,
    anchor: entry.anchor,
    kind: entry.kind,
    step: entry.stepName,
    fingerprint: describeFingerprint(entry.fingerprint),
    fingerprintKey: entry.fingerprintKey,
    textLength: renderEntry(entry).length,
    repairFiles: entry.kind === "regression" ? [...(entry.latest.repairFiles ?? [])] : null,
  };
}

// 带无关记忆组的取法（157、139）：每条被换的条目换成一条取自其他文件的真实记忆——候选须核验通过，锚点不在 excluded
// （本步题面指到的文件与本步改动的文件）里，不与任何被换条目同锚点或同指纹（同指纹即同一件事，成文相同）；
// 取成文长度与被换条目最接近者，平手按编号取最小；同一事件里不重复取同一条、也不取同指纹的两条。
// 有一条找不到候选即返回 null（该组缺失）
export function chooseIrrelevant(
  relevant: readonly MemoryEntry[],
  pool: readonly MemoryEntry[],
  excluded: ReadonlySet<string>
): Map<string, MemoryEntry> | null {
  const anchors = new Set(relevant.map((e) => e.anchor));
  const keys = new Set(relevant.map((e) => e.fingerprintKey));
  const candidates = pool.filter(
    (e) => !excluded.has(e.anchor) && !anchors.has(e.anchor) && !keys.has(e.fingerprintKey)
  );
  const usedKeys = new Set<string>();
  const chosen = new Map<string, MemoryEntry>();
  for (const entry of relevant) {
    const length = renderEntry(entry).length;
    const best = candidates
      .filter((c) => !usedKeys.has(c.fingerprintKey))
      .map((c) => ({ c, gap: Math.abs(renderEntry(c).length - length) }))
      .sort((a, b) => a.gap - b.gap || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))[0];
    if (best === undefined) return null;
    usedKeys.add(best.c.fingerprintKey);
    chosen.set(entry.id, best.c);
  }
  return chosen;
}

export interface IdentifyOptions {
  manifest: StreamManifest;
  runtime: StreamRepoRuntime;
  human: HumanRepo;
  noMemoryDir: string;
  attempt?: number;
  streams?: readonly string[];
  envs: StreamEnvFactory;
  // 经执行端访问该环境的工作区（派生、挑选与核验都在那里做）
  hostFor(target: { container: string; root: string }): WorkspaceHost;
  // 宿主上的临时目录（切流历史、治理根副本）
  scratch: string;
  log?: (line: string) => void;
}

const MEMORY_KINDS = new Set<StreamStep["kind"]>(["task", "maintenance"]);

export async function identifyEvents(options: IdentifyOptions): Promise<FixedPointEventList> {
  const attempt = options.attempt ?? 1;
  const streamIds = options.streams ?? options.manifest.streams.map((s) => s.id);
  const bySeq = new Map(options.manifest.steps.map((s) => [s.seq, s]));
  const events: FixedPointEvent[] = [];
  const scanned: FixedPointScan[] = [];
  const digests: { id: string; resultsDigest: string }[] = [];
  mkdirSync(options.scratch, { recursive: true });
  for (const stream of streamIds) {
    const segment = options.manifest.streams.find((s) => s.id === stream);
    if (segment === undefined) throw new Error(`清单里没有流 ${stream}`);
    const job = openNoMemoryJob(options.noMemoryDir, stream, attempt);
    digests.push({ id: stream, resultsDigest: resultsDigestOf(job) });
    let bundle: Buffer | undefined;
    for (const [index, row] of job.rows.entries()) {
      const scan = (event: boolean, reason: string) =>
        scanned.push({ stream, seq: row.seq, event, reason });
      const step = bySeq.get(row.seq);
      if (step === undefined) throw new Error(`清单里没有第 ${row.seq} 步`);
      if (!MEMORY_KINDS.has(row.kind) || !row.judged) {
        scan(false, "这一步没有跑 agent");
        continue;
      }
      const prev = index > 0 ? job.rows[index - 1] : undefined;
      if (prev === undefined || prev.seq !== row.seq - 1) {
        // 流的第一步（或断档）：此前没有会话
        if (prev === undefined) {
          scan(false, "流的第一步，此前没有会话");
          continue;
        }
        throw new Error(`无记忆整流的结果行断档：第 ${prev.seq} 步之后是第 ${row.seq} 步`);
      }
      const priorFiles = job.sessionFilesAfter(prev.seq);
      const stepIds = sessionIdsIn(job.sessionFilesAfter(row.seq)).filter(
        (id) => !sessionIdsIn(priorFiles).includes(id)
      );
      if (stepIds.length === 0) {
        scan(false, "这一步没有会话");
        continue;
      }
      if (stepIds.length > 1)
        throw new Error(`第 ${row.seq} 步有 ${stepIds.length} 个会话，应为一个`);
      const stepSession = stepIds[0] as string;
      const priorIds = sessionIdsIn(priorFiles);
      if (priorIds.length === 0) {
        scan(false, "此前没有会话");
        continue;
      }
      const keep = priorIds
        .map((id) => stepStartOf(job.sessionsDir, id))
        .filter((b): b is string => b !== undefined);
      bundle ??= job.bundle();
      const sliced = sliceHistory({ bundle, head: prev.head, keep, scratch: options.scratch });
      const found = await pickAt(options, {
        stream,
        segmentStart: segment.startCommit,
        step,
        startHead: prev.head,
        sliced,
        keep,
        priorFiles,
        sessionsDir: job.sessionsDir,
        stepSession,
      });
      if (found === null) {
        scan(false, "没有挑到记忆");
        continue;
      }
      scan(true, "挑到记忆");
      events.push({
        id: `${stream}-${row.seq}`,
        stream,
        seq: row.seq,
        commit: step.commit,
        kind: step.kind,
        startHead: prev.head,
        priorSessionFiles: priorFiles,
        priorStepStarts: [...new Set(keep)].sort(),
        stepSession,
        firstRunId: found.firstRunId,
        picked: found.picked,
        relevant: found.relevant,
        irrelevant: found.irrelevant,
        fixed: found.fixed,
      });
      options.log?.(
        `事件 ${stream}-${row.seq}：开局 ${found.picked.opening.length} 条、回炉 ${found.picked.repair.length} 轮；` +
          `无关记忆组${found.irrelevant === null ? "缺失" : "已定"}`
      );
    }
  }
  return {
    version: 1,
    repo: options.manifest.repo,
    noMemory: { attempt, streams: digests },
    events,
    scanned,
  };
}

interface Picked {
  firstRunId: string;
  picked: FixedPointEvent["picked"];
  relevant: MemoryItem[];
  irrelevant: FixedPointEvent["irrelevant"];
  fixed: FixedPointEvent["fixed"];
}

// 在第 k 步起点上以正式推送代码挑一遍；没挑到返回 null
async function pickAt(
  options: IdentifyOptions,
  input: {
    stream: string;
    segmentStart: string;
    step: StreamStep;
    startHead: string;
    sliced: Buffer;
    keep: readonly string[];
    priorFiles: readonly string[];
    sessionsDir: string;
    stepSession: string;
  }
): Promise<Picked | null> {
  const { step } = input;
  const original = materializeSession(input.sessionsDir, input.stepSession as SessionId, {
    content: false,
  });
  const firstRunId = original.runStarteds[0]?.runId;
  if (firstRunId === undefined) throw new Error(`第 ${step.seq} 步的会话里没有 Run`);
  const env = await options.envs.open(
    { stream: `${input.stream}-events`, condition: "no-memory", attempt: step.seq },
    { startCommit: input.segmentStart, resume: { head: input.startHead, bundle: input.sliced } }
  );
  const governance = mkdtempSync(path.join(options.scratch, `gov-${input.stream}-${step.seq}-`));
  try {
    await prepareStepStart(options, env, step, input);
    seedGovernanceRoot(governance, input.sessionsDir, input.priorFiles);
    const host = options.hostFor(env.target);
    // 认定必须可复现：推送代码里任何"这次不给"的故障都响亮报错，不静默当作没挑到
    const faults: string[] = [];
    const push = createStructuredMemoryPush({
      governanceRoot: governance,
      workspaceRoot: path.join(governance, "workspace"),
      workspaceHost: host,
      sessionId: newSessionId(),
      options: { warn: (line) => faults.push(line) },
    });
    const prompt = step.prompt ?? step.message;
    push.opening(prompt);
    // 无记忆跑中第 k 步实际出现的各轮回炉：第 r 轮的附加内容按第 r 次验证的各步结论挑选
    const gates = original.attemptVerifieds
      .filter((g) => g.target.sessionId === input.stepSession)
      .sort((a, b) => a.timestamp - b.timestamp);
    const rounds = Math.max(0, original.runStarteds.length - 1);
    for (let round = 1; round <= rounds; round++) {
      const gate = gates[round - 1];
      if (gate === undefined)
        throw new Error(`第 ${step.seq} 步第 ${round} 轮回炉之前没有验证记录`);
      push.repairAppendix({
        round,
        maxRounds: CONDITION_SPECS["no-memory"].repairRounds,
        outcome: {
          command: [...gate.command],
          exitCode: gate.exitCode,
          ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
          timedOut: gate.timedOut,
          ...(gate.error !== undefined ? { error: gate.error } : {}),
          durationMs: gate.durationMs,
          outputBytes: gate.outputBytes,
          outputHash: gate.outputHash,
          output: gate.output,
          truncated: gate.truncated,
          verdict: gate.verdict,
        },
        steps: recordStepsOf(gate),
      });
    }
    if (faults.length > 0) throw new Error(`事件认定时结构化记忆出故障：${faults.join("；")}`);
    const summary = push.summary();
    const repair = summary.repair
      .map((ids, i) => ({ round: i + 1, ids }))
      .filter((r) => r.ids.length > 0);
    if (summary.opening.length === 0 && repair.length === 0) return null;
    // 候选池：第 k 步起点派生出、核验通过的全部条目
    const access = hostWorkspaceAccess(host);
    const entries = buildMemoryEntries(
      loadStructuredMemory(governance, {
        persist: false,
        accessFor: (workspace) =>
          workspace === host.root ? access : localWorkspaceAccess(workspace),
      }).facts
    );
    const byId = new Map(entries.map((e) => [e.id, e]));
    const probe = access.probe();
    const relevantIds = [...new Set([...summary.opening, ...repair.flatMap((r) => r.ids)])];
    const relevant = relevantIds.map((id) => {
      const entry = byId.get(id);
      if (entry === undefined) throw new Error(`挑到的条目 ${id} 不在派生出的条目里`);
      return entry;
    });
    const workspace = original.attemptVerifieds[0]?.workspace ?? host.root;
    const excluded = new Set<string>([
      ...taskReferencedFiles(prompt, probe, { mentionedUntracked: true }),
      ...options.human.changes(step.parent, step.commit).map((c) => c.path),
      ...ledgerFileChanges(original, workspace).flatMap((e) => e.files),
    ]);
    const pool = entries.filter((e) => checkEntry(e, probe).ok);
    const replaced = chooseIrrelevant(relevant, pool, excluded);
    const memory: FixedSelection = {
      opening: [...summary.opening],
      repair: [...new Set(repair.flatMap((r) => r.ids))],
    };
    const swap = (map: Map<string, MemoryEntry>, ids: readonly string[]) =>
      ids.map((id) => (map.get(id) as MemoryEntry).id);
    return {
      firstRunId,
      picked: { opening: [...summary.opening], repair },
      relevant: relevant.map(itemOf),
      irrelevant:
        replaced === null
          ? null
          : relevant.map((e) => ({
              replaces: e.id,
              item: itemOf(replaced.get(e.id) as MemoryEntry),
            })),
      fixed: {
        memory,
        irrelevant:
          replaced === null
            ? null
            : { opening: swap(replaced, memory.opening), repair: swap(replaced, memory.repair) },
        none: { opening: [], repair: [] },
      },
    };
  } finally {
    rmSync(governance, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await env.dispose();
  }
}

export function writeEventList(file: string, list: FixedPointEventList): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
}

export function readEventList(file: string): FixedPointEventList {
  const list = JSON.parse(readFileSync(file, "utf8")) as FixedPointEventList;
  if (list.version !== 1) throw new Error(`事件清单版本不对：${String(list.version)}`);
  return list;
}

// 列出会话文件里的会话编号（供重跑找出新会话）
export function sessionIdsOf(sessionsDir: string): string[] {
  return listSessionIds(sessionsDir).map(String);
}
