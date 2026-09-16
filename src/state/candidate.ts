// Candidate（ROADMAP §4 Candidate 流）：学习产物的暂存形态。
// Agent 不能自我授权（§3.1）：Candidate 必须走完状态机、经人工审批（AwaitingApproval → Active）后才生效；
// M6 只走到提出、已扫描（或扫描拒收），回放验证与审批归 M8。
//
// v2（M6，决策 065 子裁决 ①）：只放写一次即不可变的元数据——种类、名字、内容哈希与字节数、来源四项、
// 一句话摘要、判断强度、扫描结果、取代关系。状态不入 schema，由账本的提出与筛查两族现算（§3.5：
// 可变状态写进候选文件会制造第二事实源）。正文按种类各自格式放在候选目录里，不在元数据里。
// v1 从无写入方且缺正文与哈希：迁移不编造字段，迁成"由 v1 迁移"的保留形状（只留原有的名字、摘要、来源引用与时间）。
import { type Static, Type } from "typebox";
import { RunIdSchema, SessionIdSchema } from "./ids.ts";
import { Sha256HexSchema } from "./message-content.ts";
import { type Migration, MigrationRegistry } from "./migration.ts";

export const CANDIDATE_VERSION = 2;

// 状态机（ROADMAP §4）；M6 新增 ScanRejected：确定性扫描命中，永不参与激活
// Proposed → SecurityScanned | ScanRejected → EvidenceChecked → ReplayValidated / ValidationFailed
//          → AwaitingApproval → Active / Rejected / Superseded
export const CandidateStatusSchema = Type.Union([
  Type.Literal("Proposed"),
  Type.Literal("SecurityScanned"),
  Type.Literal("ScanRejected"),
  Type.Literal("EvidenceChecked"),
  Type.Literal("ReplayValidated"),
  Type.Literal("ValidationFailed"),
  Type.Literal("AwaitingApproval"),
  Type.Literal("Active"),
  Type.Literal("Rejected"),
  Type.Literal("Superseded"),
]);
export type CandidateStatus = Static<typeof CandidateStatusSchema>;

export const CandidateKindSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("skill"),
  Type.Literal("policy"),
]);
export type CandidateKind = Static<typeof CandidateKindSchema>;

// 候选名：目录名的一部分，限小写字母、数字与短横线
export const CandidateNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

export const ScanHitSchema = Type.Object({
  rule: Type.Union([
    Type.Literal("invisible-char"),
    Type.Literal("injection"),
    Type.Literal("exfiltration"),
    Type.Literal("executable"),
  ]),
  detail: Type.String(),
});
export type ScanHitRecord = Static<typeof ScanHitSchema>;

export const ScanResultSchema = Type.Object({
  scannerVersion: Type.String({ minLength: 1 }),
  hits: Type.Array(ScanHitSchema),
});

// Reviewer 产出的候选元数据
export const ReviewerCandidateSchema = Type.Object(
  {
    version: Type.Literal(CANDIDATE_VERSION),
    origin: Type.Literal("reviewer"),
    kind: CandidateKindSchema,
    name: CandidateNameSchema,
    // 正文 sha256（同哈希即同候选）与 UTF-8 字节数
    contentHash: Sha256HexSchema,
    bytes: Type.Integer({ minimum: 0 }),
    // 来源四项：被审会话与 Run、审阅会话、支撑它的条目号，加上这些条目正文回指哈希的摘要
    source: Type.Object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      reviewSessionId: SessionIdSchema,
      entryRunSeqs: Type.Array(Type.Integer({ minimum: 1 })),
      contentDigest: Sha256HexSchema,
    }),
    summary: Type.String({ minLength: 1, maxLength: 300 }),
    // Reviewer 判断强度：只表判断强度，不表权限或生效资格（§6）
    strength: Type.Number({ minimum: 0, maximum: 1 }),
    scan: ScanResultSchema,
    // 取代关系：同名旧候选的内容哈希
    supersedes: Type.Optional(Sha256HexSchema),
    createdAt: Type.Integer({ minimum: 0 }),
    // 状态不入 schema：多出来的字段（如 status）一律拒绝
  },
  { additionalProperties: false }
);
export type ReviewerCandidate = Static<typeof ReviewerCandidateSchema>;

// v1 迁移而来的保留形状：不编造 v1 没有的字段
export const MigratedV1CandidateSchema = Type.Object(
  {
    version: Type.Literal(CANDIDATE_VERSION),
    origin: Type.Literal("migrated-v1"),
    name: Type.String({ minLength: 1 }),
    summary: Type.String(),
    sourceRef: Type.String({ minLength: 1 }),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CandidateSchema = Type.Union([ReviewerCandidateSchema, MigratedV1CandidateSchema]);
export type Candidate = Static<typeof CandidateSchema>;

// v1 → v2：v1 的 id 成为名字，状态与更新时间丢弃（状态改由账本现算）
export const migrateCandidateV1toV2: Migration = (doc) => ({
  version: 2,
  origin: "migrated-v1",
  name: doc.id,
  summary: doc.summary,
  sourceRef: doc.sourceRef,
  createdAt: doc.createdAt,
});

export const candidateMigrations = new MigrationRegistry();
candidateMigrations.register("candidate", 1, migrateCandidateV1toV2);

export function migrateCandidateToCurrent(raw: unknown): Candidate {
  return candidateMigrations.migrate(
    "candidate",
    raw as Record<string, unknown>,
    CANDIDATE_VERSION,
    CandidateSchema
  );
}
