// 候选检索（M8 S6，决策 065 / 089）：跨会话读账本，按内容哈希前缀或 种类/名字 定位一个候选，
// 并取出它的正文与来源会话。状态由账本现算（不落候选目录），取代关系在全量会话上算一遍再投影——
// 同一个名字可能在别的会话里被重新提炼出新版本。
//
// 选择器故意只认"能唯一确定一个候选"的两种写法：内容哈希前缀（身份即哈希）与 种类/名字（在同名候选
// 只剩一个未被取代的版本时够用）。匹配到多个一律响亮失败并列出全部候选——审批动作不作用在猜出来的对象上。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listSessionIds, materializeSession } from "../persistence/session-read.ts";
import { candidateBodyPath } from "../review/candidates.ts";
import {
  collectCandidateRecords,
  collectSupersededHashes,
  type ProjectedCandidate,
  projectCandidates,
} from "../state/candidate-status.ts";
import type { SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { sha256Hex } from "../state/message-content.ts";
import { sessionsDirOf } from "./workspace.ts";

export class CandidateLookupError extends Error {}

// 一条候选上的互斥锁：验证与四个决定动作（批准 / 拒绝 / 撤销 / 取代）共用这一把。
// 它们都会改动这条候选的账本记录或落点文件，谁都不能与另一件并行——两个进程同时批准与撤销时，
// 决定记录的先后随机，而落点文件可能被删除那一方赢在最后，状态投影却按最后一条决定算出已激活
export function candidateLockPath(governanceRoot: string, contentHash: string): string {
  return path.join(governanceRoot, ".pigeon", "candidate-locks", `${contentHash}.lock`);
}

export interface LocatedCandidate extends ProjectedCandidate {
  // 候选提出与筛查两族所在的会话。验证、决定与激活三族不一定在同一个文件里——
  // 来源会话可能正被另一个进程写着，审批与验证命令便写进自己的会话文件（M8 收口修复）
  hostSessionId: SessionId;
}

export interface CandidateIndex {
  candidates: LocatedCandidate[];
  // 会话号 → 物化结果（复用，避免同一次命令里反复读同一个会话文件）
  sessions: Map<SessionId, MaterializedSession>;
}

export function buildCandidateIndex(governanceRoot: string): CandidateIndex {
  const sessionsDir = sessionsDirOf(governanceRoot);
  const sessions = new Map<SessionId, MaterializedSession>();
  for (const sessionId of listSessionIds(sessionsDir)) {
    sessions.set(sessionId, materializeSession(sessionsDir, sessionId, { content: false }));
  }
  const supersededHashes = collectSupersededHashes([...sessions.values()]);
  // 三族跨会话收集：决定与激活可能落在别的会话文件里
  const records = collectCandidateRecords([...sessions.values()]);
  const candidates: LocatedCandidate[] = [];
  for (const [hostSessionId, session] of sessions) {
    for (const projected of projectCandidates(session, { supersededHashes, records })) {
      candidates.push({ ...projected, hostSessionId });
    }
  }
  candidates.sort((left, right) => left.candidate.createdAt - right.candidate.createdAt);
  return { candidates, sessions };
}

// 选择器：内容哈希前缀（至少 4 位十六进制）或 种类/名字
export function matchesSelector(entry: LocatedCandidate, selector: string): boolean {
  const query = selector.trim();
  if (query === "") {
    return false;
  }
  if (/^[0-9a-f]{4,64}$/i.test(query)) {
    return entry.candidate.contentHash.startsWith(query.toLowerCase());
  }
  const [kind, name] = query.split("/");
  return name !== undefined && entry.candidate.kind === kind && entry.candidate.name === name;
}

export function resolveCandidate(index: CandidateIndex, selector: string): LocatedCandidate {
  const matched = index.candidates.filter((entry) => matchesSelector(entry, selector));
  if (matched.length === 0) {
    throw new CandidateLookupError(
      `没有匹配的候选：${selector}（用内容哈希前缀或 种类/名字；pigeon candidates 列出全部）`
    );
  }
  if (matched.length > 1) {
    const listed = matched
      .map(
        (entry) =>
          `${entry.candidate.kind}/${entry.candidate.name} ${entry.candidate.contentHash.slice(0, 12)}`
      )
      .join("、");
    throw new CandidateLookupError(
      `候选选择器 ${selector} 匹配到 ${matched.length} 个：${listed}。请给出更长的内容哈希前缀`
    );
  }
  return matched[0] as LocatedCandidate;
}

// 候选正文：按哈希不可变写入暂存目录（065），此处只读，且读出来就立刻按内容哈希核对。
//
// 核对必须在这一层做，不能留到写落点之后（M8 收口修复）：批准路径原先是"读正文 → 落批准记录 →
// 写落点 → 才比对哈希"，被篡改的正文已经写进装载目录才报错，既无回滚，账本里也已经留下一条批准记录，
// 而漂移检测因为没有激活记录并不会报。正文的身份就是它的哈希，读到对不上即是暂存目录被动过，
// 一切后续动作（批准、激活、回放装载、详情展示）都不该继续。
export function readCandidateBody(governanceRoot: string, entry: LocatedCandidate): string {
  const { kind, name, contentHash } = entry.candidate;
  const relative = candidateBodyPath(kind, name, contentHash);
  const absolute = path.join(governanceRoot, relative);
  if (!existsSync(absolute)) {
    throw new CandidateLookupError(
      `候选正文不在暂存目录里：${relative}（账本有提出记录但文件已被移走，拒绝按记录重建正文）`
    );
  }
  const raw = readFileSync(absolute);
  const actual = sha256Hex(raw);
  if (actual !== contentHash) {
    throw new CandidateLookupError(
      `候选正文与内容哈希对不上：${relative}（账本记 ${contentHash.slice(0, 12)}，` +
        `文件现状 ${actual.slice(0, 12)}）——暂存目录被动过，拒绝继续`
    );
  }
  return raw.toString("utf8");
}
