// Candidate（ROADMAP §4 Candidate 流）：学习产物的暂存形态。
// Agent 不能自我授权（§3.1）：Candidate 必须走完状态机、经人工审批
// （AwaitingApproval → Active）后才生效。
import { type Static, Type } from "typebox";

export const CANDIDATE_VERSION = 1;

// 状态机（ROADMAP §4）：
// Proposed → SecurityScanned → EvidenceChecked → ReplayValidated / ValidationFailed
//          → AwaitingApproval → Active / Rejected / Superseded
export const CandidateStatusSchema = Type.Union([
  Type.Literal("Proposed"),
  Type.Literal("SecurityScanned"),
  Type.Literal("EvidenceChecked"),
  Type.Literal("ReplayValidated"),
  Type.Literal("ValidationFailed"),
  Type.Literal("AwaitingApproval"),
  Type.Literal("Active"),
  Type.Literal("Rejected"),
  Type.Literal("Superseded"),
]);
export type CandidateStatus = Static<typeof CandidateStatusSchema>;

export const CandidateSchema = Type.Object({
  version: Type.Literal(CANDIDATE_VERSION),
  // 暂存区标识；Candidate 不属于五类稳定标识，暂存期用普通字符串
  id: Type.String({ minLength: 1 }),
  status: CandidateStatusSchema,
  // 来源引用：产出该 Candidate 的 Reviewer Run / Session，供激活前回查证据
  sourceRef: Type.String({ minLength: 1 }),
  // 内容摘要；激活决策必须回查完整内容而非仅凭摘要
  summary: Type.String(),
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
});

export type Candidate = Static<typeof CandidateSchema>;
