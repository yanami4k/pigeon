// 结构化记忆的存与挂（决策 132 / 133）：记忆不单独存，是账本事实的跨会话视图，由程序现算。
// - 派生：逐个会话文件物化（不读正文）后按 state/structured-memory.ts 推出摩擦事实；改动文件在账本取法之外，
//   另用 git 比较相邻快照补上（git 不可用或快照已被回收时略过这一来源，以能取到的为准）。
// - 缓存：治理目录下 .pigeon/cache/structured-memory.json（治理目录不入库），按会话文件的大小与修改时间增量更新——
//   签名对不上即按账本重算，账本里已没有的会话从缓存里去掉。缓存可随时删除，删后从账本重建；格式版本或派生规则标记对不上
//   即整份作废重建；缓存文件损坏（不是合法 JSON 或形状不符）同样整份重建。读写缓存时的 IO 故障照常抛出，由调用方按
//   "这次不给"处理（决策 136 的平移口径）。
// - 挂：每条事实挂在若干文件上（state/structured-memory.ts 的 frictionAnchors），按锚点展开；同一锚点、同一种摩擦、
//   同一指纹的多条合并为一条，附出现次数，细节以最近一次为准。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import {
  JsonlEventLog,
  listSessionIds,
  materializeSession,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { repairRoundsOf } from "../state/repair-step.ts";
import {
  checkpointPairsOf,
  deriveSessionFrictions,
  type FileChangeEvent,
  type FrictionFact,
  FrictionFactSchema,
  type FrictionKind,
  frictionAnchors,
} from "../state/structured-memory.ts";
import type { Fingerprint, VerifyStepKind } from "../state/verify-fingerprint.ts";
import {
  runStructuredMemoryGit,
  taskReferencedFiles,
  workspaceProbe,
} from "./structured-workspace.ts";

// 缓存文件格式版本：对不上即整份作废重建（缓存可重建，不做迁移）
export const STRUCTURED_MEMORY_CACHE_VERSION = 1;
// 派生规则标记：改了"什么算摩擦、门槛怎么划"时推进，旧缓存随之作废、按新规则对全部历史重算
export const STRUCTURED_MEMORY_RULES_TAG = "2026-09-23.4";

export function structuredMemoryCachePath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "cache", "structured-memory.json");
}

function sessionsDirOf(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "sessions");
}

// 缓存形状：事实按真实 schema 校验（时间字段须是合法时间戳等）；形状不符即整份重建
export const StructuredMemoryCacheFileSchema = Type.Object({
  version: Type.Literal(STRUCTURED_MEMORY_CACHE_VERSION),
  rules: Type.String(),
  sessions: Type.Record(
    Type.String(),
    Type.Object({
      size: Type.Integer({ minimum: 0 }),
      mtimeMs: Type.Number(),
      facts: Type.Array(FrictionFactSchema),
    })
  ),
});

interface CachedSession {
  size: number;
  mtimeMs: number;
  facts: FrictionFact[];
}

interface CacheFile {
  version: typeof STRUCTURED_MEMORY_CACHE_VERSION;
  rules: string;
  sessions: Record<string, CachedSession>;
}

export interface StructuredMemoryLoad {
  facts: FrictionFact[];
  // 本次重算与沿用缓存的会话数（观察增量更新用）
  derived: number;
  reused: number;
}

// 缓存读写的 IO 故障（与派生本身的故障分开，调用方据此分类告警）
export class StructuredMemoryCacheError extends Error {}

function cacheIo<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new StructuredMemoryCacheError(
      `结构化记忆缓存读写失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function emptyCache(): CacheFile {
  return {
    version: STRUCTURED_MEMORY_CACHE_VERSION,
    rules: STRUCTURED_MEMORY_RULES_TAG,
    sessions: {},
  };
}

// 读缓存：不存在、损坏、版本或规则标记对不上都视为空（随后整份重建）；读文件本身的 IO 故障照常抛出
function readCache(path: string): CacheFile {
  if (!existsSync(path)) {
    return emptyCache();
  }
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyCache();
  }
  if (!Value.Check(StructuredMemoryCacheFileSchema, raw)) {
    return emptyCache();
  }
  const cache = raw as CacheFile;
  return cache.rules === STRUCTURED_MEMORY_RULES_TAG ? cache : emptyCache();
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
}

// 相邻快照之间改了哪些文件（取法之三）；git 不可用、快照提交已被回收时略过（git 超时照常抛出）
function snapshotChanges(
  session: Parameters<typeof checkpointPairsOf>[0],
  workspace: string | undefined
): FileChangeEvent[] {
  if (workspace === undefined || !existsSync(workspace)) {
    return [];
  }
  const events: FileChangeEvent[] = [];
  for (const pair of checkpointPairsOf(session)) {
    const files = lines(
      runStructuredMemoryGit(workspace, [
        "diff",
        "--name-only",
        "--no-renames",
        "--relative",
        pair.from,
        pair.to,
      ])
    );
    if (files.length > 0) {
      events.push({ at: pair.at, files });
    }
  }
  return events;
}

// 开工时已是脏状态的文件：首个快照的改前基线是"开工时的工作区"挂在当时 HEAD 之下的提交，两者之差即未提交的改动
// （例如跑批器预置进工作区、尚未提交的人写测试）。没有改前基线（没有快照）或 git 取不到时返回 undefined（未知）
function dirtyAtStart(
  session: Pick<MaterializedSession, "checkpoints">,
  workspace: string
): string[] | undefined {
  const base = session.checkpoints.find((record) => record.payload.baseCommit !== undefined)
    ?.payload.baseCommit;
  if (base === undefined) {
    return undefined;
  }
  const output = runStructuredMemoryGit(workspace, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "--relative",
    "-r",
    "--root",
    base,
  ]);
  return output === undefined ? undefined : lines(output);
}

// 账本里的题面原文：首个 Run 的第一条用户消息（旁置内容文件里的正文）；取不到返回 undefined
function taskTextOf(
  governanceRoot: string,
  session: Pick<MaterializedSession, "sessionId" | "runStarteds">
): string | undefined {
  const firstRun = session.runStarteds[0]?.runId;
  if (firstRun === undefined) {
    return undefined;
  }
  const content = readMessageContentFileDetailed(
    JsonlEventLog.contentFilePathFor(sessionsDirOf(governanceRoot), session.sessionId)
  );
  const first = content.records
    .filter((record) => record.runId === firstRun && record.role === "user")
    .sort((left, right) => left.runSeq - right.runSeq)[0];
  return first?.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// 一个会话派生出的事实（事件文件物化不读正文；题面原文另从内容文件取）。工作区已不在、或取不到改前基线时，
// 题面测试文件认定不全：这一会话不产出测试步的红转绿（其他步照常、撤回照记），结果标为不完整、不写进缓存，下次再算
export function deriveSessionFacts(
  governanceRoot: string,
  sessionId: SessionId
): { facts: FrictionFact[]; complete: boolean } {
  const session = materializeSession(sessionsDirOf(governanceRoot), sessionId, { content: false });
  const workspace = session.attemptVerifieds.find(
    (record) => record.target.sessionId === sessionId
  )?.workspace;
  if (repairRoundsOf(session) === 0 || workspace === undefined) {
    return { facts: [], complete: true };
  }
  const present = existsSync(workspace);
  const dirty = present ? dirtyAtStart(session, workspace) : undefined;
  const task = taskTextOf(governanceRoot, session);
  const facts = deriveSessionFrictions(session, {
    snapshotChanges: present ? snapshotChanges(session, workspace) : [],
    dirtyAtStart: dirty ?? [],
    taskFiles:
      task !== undefined && present
        ? taskReferencedFiles(task, workspaceProbe(workspace), { mentionedUntracked: true })
        : [],
    taskTestsUnknown: dirty === undefined,
  });
  return { facts, complete: dirty !== undefined };
}

// 读取全部事实：缓存命中的会话沿用，签名对不上或新出现的会话按账本重算，账本里已没有的会话丢掉；有变化才回写缓存
export function loadStructuredMemory(
  governanceRoot: string,
  options: { persist?: boolean } = {}
): StructuredMemoryLoad {
  const cachePath = structuredMemoryCachePath(governanceRoot);
  const cache = cacheIo(() => readCache(cachePath));
  const dir = sessionsDirOf(governanceRoot);
  const next: CacheFile = emptyCache();
  let derived = 0;
  let reused = 0;
  let changed = !existsSync(cachePath);
  // 派生结果不完整的会话：本次照用，但不写进缓存
  const uncached: FrictionFact[] = [];
  for (const sessionId of listSessionIds(dir)) {
    const stat = statSync(join(dir, `${sessionId}.jsonl`));
    const cached = cache.sessions[sessionId];
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      next.sessions[sessionId] = cached;
      reused += 1;
      continue;
    }
    const result = deriveSessionFacts(governanceRoot, sessionId);
    derived += 1;
    changed = true;
    if (!result.complete) {
      uncached.push(...result.facts);
      continue;
    }
    next.sessions[sessionId] = { size: stat.size, mtimeMs: stat.mtimeMs, facts: result.facts };
  }
  if (Object.keys(cache.sessions).some((sessionId) => next.sessions[sessionId] === undefined)) {
    changed = true;
  }
  // 只读调用方（列出命令）不回写缓存
  if (changed && options.persist !== false) {
    cacheIo(() => {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileAtomic(cachePath, `${JSON.stringify(next)}\n`);
    });
  }
  const facts = [...Object.values(next.sessions).flatMap((entry) => entry.facts), ...uncached];
  facts.sort((left, right) => left.at - right.at);
  return { facts, derived, reused };
}

// 一条记忆：挂在一个文件上的一种摩擦的一个指纹，同类多次出现合并
export interface MemoryEntry {
  id: string;
  anchor: string;
  kind: FrictionKind;
  stepName: string;
  stepKind: VerifyStepKind;
  fingerprint: Fingerprint;
  fingerprintKey: string;
  // 同类出现过几次
  count: number;
  // 细节以最近一次为准
  latest: FrictionFact;
  // 来源会话（按首次出现的时间顺序、不重复）
  sessions: SessionId[];
}

function entryId(anchor: string, kind: FrictionKind, key: string): string {
  return `mem_${createHash("sha256").update(`${anchor}\u0000${kind}\u0000${key}`).digest("hex").slice(0, 12)}`;
}

// 按锚点展开并合并（同一锚点、同一种摩擦、同一指纹）；按最近一次出现的时间从新到旧排列
export function buildMemoryEntries(facts: readonly FrictionFact[]): MemoryEntry[] {
  const entries = new Map<string, MemoryEntry>();
  const ordered = [...facts].sort((left, right) => left.at - right.at);
  for (const fact of ordered) {
    for (const anchor of frictionAnchors(fact)) {
      const id = entryId(anchor, fact.kind, fact.fingerprintKey);
      const existing = entries.get(id);
      if (existing === undefined) {
        entries.set(id, {
          id,
          anchor,
          kind: fact.kind,
          stepName: fact.stepName,
          stepKind: fact.stepKind,
          fingerprint: fact.fingerprint,
          fingerprintKey: fact.fingerprintKey,
          count: 1,
          latest: fact,
          sessions: [fact.sessionId],
        });
        continue;
      }
      existing.count += 1;
      existing.latest = fact;
      existing.fingerprint = fact.fingerprint;
      if (!existing.sessions.includes(fact.sessionId)) {
        existing.sessions.push(fact.sessionId);
      }
    }
  }
  return [...entries.values()].sort((left, right) => right.latest.at - left.latest.at);
}
