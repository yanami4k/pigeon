// 候选落盘（M6 S3，决策 065 及其子裁决）：Controller 从 Reviewer 的结构化收尾结果里解析候选并写入暂存目录——
// 模型只产出结论，程序落盘，Reviewer 自身不持有任何写工具。
// - 解析：typebox 校验；不合格（含没有结构化结果）只记一条 review.unparsable，不落任何文件。
// - 身份：正文 sha256 即候选身份；目录 .pigeon/candidates/<种类>/<名字>-<哈希前 16 位>/，写入后不可变；
//   同哈希已存在则跳过（不写文件、不重复记账），天然去重。同名不同哈希即新候选，元数据标记取代旧哈希。
// - 正文：Skill 为 SKILL.md、Memory 为整个 markdown 文件、Policy 只写自然语言建议（SUGGESTION.txt）。
// - 原子：先写同级临时目录，再整体改名为最终目录；改名失败时清掉临时目录。
// - 扫描：确定性规则逐个文件扫描，命中照常暂存，扫描结果内嵌在元数据里（状态由账本现算为扫描拒收）。
// - 记账：候选文件写好后，在被审主会话的会话文件里落 candidate.proposed（决策 128：筛查记录已退役）。
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { materializeSession } from "../persistence/session-read.ts";
import {
  CANDIDATE_VERSION,
  type CandidateKind,
  CandidateNameSchema,
  isProducibleCandidateKind,
  ProducibleCandidateKindSchema,
  type ReviewerCandidate,
} from "../state/candidate.ts";
import type { CandidateProposedInput, ObservationInput } from "../state/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { scanCandidateFiles } from "./scan.ts";

// Reviewer 交回的结构化结果（与 prompt.ts 的输出格式同源）
export const ReviewerResultSchema = Type.Object({
  candidates: Type.Array(
    Type.Object({
      kind: ProducibleCandidateKindSchema,
      name: CandidateNameSchema,
      summary: Type.String({ minLength: 1, maxLength: 300 }),
      strength: Type.Number({ minimum: 0, maximum: 1 }),
      content: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
      sourceRunSeqs: Type.Array(Type.Integer({ minimum: 1 })),
    })
  ),
});
export type ReviewerResult = Static<typeof ReviewerResultSchema>;

// 被审主会话的会话文件（JsonlEventLog 满足）
export interface CandidateSink {
  appendCandidateProposed(input: CandidateProposedInput): unknown;
  appendObservation(input: ObservationInput): unknown;
}

export interface PersistCandidatesInput {
  governanceRoot: string;
  // 被审会话所在的会话目录（算来源内容摘要用）
  sessionsDir: string;
  sink: CandidateSink;
  structured: unknown;
  source: { sessionId: SessionId; runId: RunId; producerSessionId: SessionId };
  model: { provider: string; id: string };
  usage?: { turns: number; totalTokens: number };
  now?: () => number;
}

export interface PersistCandidatesResult {
  written: ReviewerCandidate[];
  // 同哈希已存在而跳过的条数
  duplicates: number;
  // 不可解析时的原因
  unparsable?: string;
}

// 候选正文的文件名（按种类）：暂存目录与 M8 的详情视图、回放取正文共用同一份约定
export const BODY_FILE: Readonly<Record<CandidateKind, (name: string) => string>> = {
  skill: () => "SKILL.md",
  memory: (name) => `${name}.md`,
  policy: () => "SUGGESTION.txt",
};

export const CANDIDATES_DIR = path.join(".pigeon", "candidates");

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 来源内容摘要：支撑条目在账本里的正文回指哈希，按条目号排序后拼接取 sha256（缺回指的条目记为空串）
export function sourceDigest(
  sessionsDir: string,
  sessionId: SessionId,
  runId: RunId,
  runSeqs: number[]
): string {
  const session = materializeSession(sessionsDir, sessionId, { content: false });
  const hashes = [...new Set(runSeqs)]
    .sort((left, right) => left - right)
    .map((runSeq) => {
      const entry = session.entries.find((item) => item.runId === runId && item.runSeq === runSeq);
      return `${runSeq}:${entry?.contentHash ?? ""}`;
    });
  return sha256(hashes.join("\n"));
}

// 同名旧候选（不同哈希）里最新的一个：取代关系指向它
function latestSameName(kindDir: string, name: string, contentHash: string): string | undefined {
  if (!existsSync(kindDir)) {
    return undefined;
  }
  let latest: { hash: string; createdAt: number } | undefined;
  for (const entry of readdirSync(kindDir)) {
    if (!entry.startsWith(`${name}-`) || entry.startsWith(".")) {
      continue;
    }
    const metaPath = path.join(kindDir, entry, "candidate.json");
    if (!existsSync(metaPath)) {
      continue;
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ReviewerCandidate;
      if (meta.name !== name || meta.contentHash === contentHash) {
        continue;
      }
      if (latest === undefined || meta.createdAt >= latest.createdAt) {
        latest = { hash: meta.contentHash, createdAt: meta.createdAt };
      }
    } catch {
      // 读不出的旧元数据不参与取代判断
    }
  }
  return latest?.hash;
}

export function persistReviewerCandidates(input: PersistCandidatesInput): PersistCandidatesResult {
  const now = input.now ?? Date.now;
  if (!Value.Check(ReviewerResultSchema, input.structured)) {
    const reason =
      input.structured === undefined
        ? "审阅没有交回结构化结果"
        : `结构化结果不符合格式：${[...Value.Errors(ReviewerResultSchema, input.structured)]
            .slice(0, 3)
            .map((error) => `${error.instancePath || "/"} ${error.message}`)
            .join("；")}`;
    input.sink.appendObservation({
      kind: "review.unparsable",
      runId: input.source.runId,
      payload: { producerSessionId: input.source.producerSessionId, reason },
    });
    return { written: [], duplicates: 0, unparsable: reason };
  }
  const written: ReviewerCandidate[] = [];
  let duplicates = 0;
  for (const item of input.structured.candidates) {
    const candidate = stageCandidate({
      governanceRoot: input.governanceRoot,
      kind: item.kind,
      name: item.name,
      content: item.content,
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "reviewer",
        kind: item.kind,
        name: item.name,
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId: input.source.sessionId,
          runId: input.source.runId,
          producerSessionId: input.source.producerSessionId,
          entryRunSeqs: item.sourceRunSeqs,
          contentDigest: sourceDigest(
            input.sessionsDir,
            input.source.sessionId,
            input.source.runId,
            item.sourceRunSeqs
          ),
        },
        summary: item.summary,
        strength: item.strength,
        scan: facts.scan,
        ...(facts.supersedes !== undefined ? { supersedes: facts.supersedes } : {}),
        createdAt: now(),
      }),
    });
    // 同哈希即同候选：已存在则跳过（不写文件、不重复记账）
    if (candidate === undefined) {
      duplicates += 1;
      continue;
    }
    input.sink.appendCandidateProposed({
      runId: input.source.runId,
      candidate,
      model: { ...input.model },
      ...(input.usage !== undefined ? { usage: { ...input.usage } } : {}),
    });
    written.push(candidate);
  }
  return { written, duplicates };
}

export interface StageCandidateInput {
  governanceRoot: string;
  kind: CandidateKind;
  name: string;
  content: string;
  // 由写盘事实（哈希、字节数、扫描结果、取代关系）组装元数据
  build: (facts: {
    contentHash: string;
    bytes: number;
    scan: ReviewerCandidate["scan"];
    supersedes?: string;
  }) => ReviewerCandidate;
}

// 暂存一份候选（M6 落盘口径，M7 提炼器复用）：按正文哈希定目录，同哈希已存在返回 undefined（不写文件）；
// 确定性扫描后组装元数据，先写同级临时目录再整体改名
// 候选目录名与正文路径（治理根相对）：身份是正文哈希，目录名取其前 16 位
export function candidateDirName(name: string, contentHash: string): string {
  return `${name}-${contentHash.slice(0, 16)}`;
}

export function candidateBodyPath(kind: CandidateKind, name: string, contentHash: string): string {
  return path.join(
    CANDIDATES_DIR,
    kind,
    candidateDirName(name, contentHash),
    BODY_FILE[kind](name)
  );
}

export function stageCandidate(input: StageCandidateInput): ReviewerCandidate | undefined {
  // 决策 094：写侧只认 Memory 与 Skill；policy 取值只为读旧候选而保留
  if (!isProducibleCandidateKind(input.kind)) {
    throw new Error(`候选种类 ${input.kind} 已停止产出（决策 094）：只能落 memory 或 skill`);
  }
  const contentHash = sha256(input.content);
  const kindDir = path.join(input.governanceRoot, CANDIDATES_DIR, input.kind);
  const finalDir = path.join(kindDir, `${input.name}-${contentHash.slice(0, 16)}`);
  if (existsSync(finalDir)) {
    return undefined;
  }
  const bodyFile = BODY_FILE[input.kind](input.name);
  const scan = scanCandidateFiles({ [bodyFile]: input.content });
  const supersedes = latestSameName(kindDir, input.name, contentHash);
  const candidate = input.build({
    contentHash,
    bytes: Buffer.byteLength(input.content, "utf8"),
    scan,
    ...(supersedes !== undefined ? { supersedes } : {}),
  });
  mkdirSync(kindDir, { recursive: true });
  const tempDir = path.join(kindDir, `.${input.name}-${randomBytes(6).toString("hex")}.tmp`);
  mkdirSync(tempDir);
  try {
    writeFileSync(path.join(tempDir, bodyFile), input.content, "utf8");
    writeFileSync(
      path.join(tempDir, "candidate.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8"
    );
    renameSync(tempDir, finalDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return candidate;
}
