// Candidate（ROADMAP §4 Candidate 流）：学习产物的暂存形态。
// Agent 不能自我授权（§3.1）：Candidate 必须走完状态机、经人工审批（AwaitingApproval → Active）后才生效；
// M6 只走到提出、已扫描（或扫描拒收），回放验证与审批归 M8。
//
// v2（M6，决策 065 子裁决 ①）：只放写一次即不可变的元数据——种类、名字、内容哈希与字节数、来源四项、
// 一句话摘要、判断强度、扫描结果、取代关系。状态不入 schema，由账本的提出与筛查两族现算（§3.5：
// 可变状态写进候选文件会制造第二事实源）。正文按种类各自格式放在候选目录里，不在元数据里。
// v1 从无写入方且缺正文与哈希：迁移不编造字段，迁成"由 v1 迁移"的保留形状（只留原有的名字、摘要、来源引用与时间）。
// v3（M7，决策 075）：v2 字段不变，加法式新增对比来源块（成败两侧尝试引用、共享前缀、标签与验证记录引用、产物形态）；
// 来源新增"提炼器"——对提炼候选，source 的会话与 Run 取主证据一侧，producerSessionId 为提炼器会话；单来源候选不带该块。
import { type Static, Type } from "typebox";
import { EntryIdSchema, RunIdSchema, SessionIdSchema } from "./ids.ts";
import { Sha256HexSchema } from "./message-content.ts";
import { type Migration, MigrationRegistry } from "./migration.ts";

export const CANDIDATE_VERSION = 3;

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

// 五个标签（决策 072）：由账本现算，写进对比来源块的是提炼当时的现算结果
export const OutcomeLabelSchema = Type.Union([
  Type.Literal("Passed"),
  Type.Literal("Failed"),
  Type.Literal("Abandoned"),
  Type.Literal("Unknown"),
  Type.Literal("InfrastructureError"),
]);
export type OutcomeLabel = Static<typeof OutcomeLabelSchema>;

// 对比来源块里的一次尝试引用：治理根、会话、Run、条目范围、标签、验证记录引用（在哪个会话文件、哪条记录）
export const AttemptRefSchema = Type.Object(
  {
    governanceRoot: Type.String({ minLength: 1 }),
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    entryRange: Type.Object({
      from: Type.Integer({ minimum: 1 }),
      to: Type.Integer({ minimum: 1 }),
    }),
    label: OutcomeLabelSchema,
    verification: Type.Optional(
      Type.Object({ sessionId: SessionIdSchema, recordId: EntryIdSchema })
    ),
  },
  { additionalProperties: false }
);
export type AttemptRef = Static<typeof AttemptRefSchema>;

// 对比来源块（决策 075）：产物形态为教训、流程或步骤集；分叉场景另记共享前缀的范围（只算一次）；
// 其余同组尝试只记在 others 里（每侧只取一个进对比）
export const ContrastSourceSchema = Type.Object(
  {
    form: Type.Union([Type.Literal("lesson"), Type.Literal("workflow"), Type.Literal("procedure")]),
    successful: Type.Array(AttemptRefSchema),
    failed: Type.Array(AttemptRefSchema),
    sharedPrefix: Type.Optional(
      Type.Object(
        {
          sessionId: SessionIdSchema,
          runId: RunIdSchema,
          from: Type.Integer({ minimum: 1 }),
          to: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false }
      )
    ),
    others: Type.Optional(Type.Array(AttemptRefSchema)),
  },
  { additionalProperties: false }
);
export type ContrastSource = Static<typeof ContrastSourceSchema>;

// Reviewer 与提炼器产出的候选元数据
export const ReviewerCandidateSchema = Type.Object(
  {
    version: Type.Literal(CANDIDATE_VERSION),
    origin: Type.Union([Type.Literal("reviewer"), Type.Literal("distiller")]),
    kind: CandidateKindSchema,
    name: CandidateNameSchema,
    // 正文 sha256（同哈希即同候选）与 UTF-8 字节数
    contentHash: Sha256HexSchema,
    bytes: Type.Integer({ minimum: 0 }),
    // 来源四项：被审或被提炼的会话与 Run、产出该候选的会话、支撑它的条目号，加上这些条目正文回指哈希的摘要。
    // producerSessionId 是中性命名（065 修订）：审阅器、提炼器与将来的验证器都写这里，产出方类别由 origin 区分
    source: Type.Object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      producerSessionId: SessionIdSchema,
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
    // M7（决策 075）：对比来源块；单来源候选缺省
    contrast: Type.Optional(ContrastSourceSchema),
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
// v2 → v3（决策 075）：加法式演进（新增可选对比来源块与提炼器来源）——v2 字段原样保留，版本推进；
// 另按 065 修订把来源里的产出会话字段改成中性命名（v2 记的 reviewSessionId 原样搬到 producerSessionId，值不变）。
// v1 迁移而来的保留形状没有 source，不受影响。
candidateMigrations.register("candidate", 2, (doc) => {
  const source = doc.source as Record<string, unknown> | undefined;
  if (source === undefined || !("reviewSessionId" in source)) {
    return { ...doc, version: 3 };
  }
  const { reviewSessionId, ...rest } = source;
  return { ...doc, version: 3, source: { ...rest, producerSessionId: reviewSessionId } };
});

export function migrateCandidateToCurrent(raw: unknown): Candidate {
  return candidateMigrations.migrate(
    "candidate",
    raw as Record<string, unknown>,
    CANDIDATE_VERSION,
    CandidateSchema
  );
}
