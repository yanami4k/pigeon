// 候选状态投影（M6，决策 065；M8 S2，决策 089 / 092 / 093）：候选状态不入元数据、不写进候选目录，
// 由账本的五族现算——提出、筛查（M6）与验证回执、决定、激活（M8）。
//
// 判定顺序（先到先得，前一条命中即定）：
//   1. 扫描拒收：确定性扫描有命中，永不参与激活，压过之后的一切记录（含误落的批准与激活记录）——
//      "候选不能通过改字段或内部工具调用跳过审批"的最后一道；
//   2. 已取代：同名新候选的元数据回指本哈希，或决定族记了取代动作（093 与 065 同构）；
//   3. 决定族的最后一条：拒绝 / 撤销 / 批准（批准后有激活记录即已激活，否则已批准）；
//   4. 验证回执的最后一条：通过 / 未测出 / 回归三值各一态；
//   5. 筛查无命中即已扫描，只有提出记录即已提出。
// 取"最后一条"而非"第一条"：决定与验证都可以重来（回归翻案只能靠重验，092），现状由最新一条表达。
import type { CandidateStatus, ReviewerCandidate } from "./candidate.ts";
import type {
  CandidateActivatedRecord,
  CandidateDecidedRecord,
  CandidateProposedRecord,
  CandidateScreenedRecord,
  CandidateVerifiedRecord,
} from "./event-log.ts";

// 投影输入：物化会话里的五族（MaterializedSession 满足）
export interface CandidateProjectionSource {
  candidateProposeds: readonly CandidateProposedRecord[];
  candidateScreeneds: readonly CandidateScreenedRecord[];
  candidateVerifieds: readonly CandidateVerifiedRecord[];
  candidateDecideds: readonly CandidateDecidedRecord[];
  candidateActivateds: readonly CandidateActivatedRecord[];
}

export interface ProjectedCandidate {
  candidate: ReviewerCandidate;
  status: CandidateStatus;
  proposed: CandidateProposedRecord;
  screened?: CandidateScreenedRecord;
  // M8：最后一条验证回执、决定与激活记录（在场时）
  verified?: CandidateVerifiedRecord;
  decided?: CandidateDecidedRecord;
  activated?: CandidateActivatedRecord;
}

export interface ProjectCandidatesOptions {
  // 已被取代的候选哈希（跨会话时由 collectSupersededHashes 在全量会话上算出）
  supersededHashes?: ReadonlySet<string>;
  // 跨会话的验证、决定与激活三族（M8 收口修复）：这三族不一定落在候选的来源会话文件里——
  // 来源会话可能正被另一个进程写着（单写者约束，040），审批命令便把它们写进自己的会话文件。
  // 在场时用它们取代本会话的同名三族；顺序按时间排好，"最后一条"才有意义。
  records?: {
    verifieds: readonly CandidateVerifiedRecord[];
    decideds: readonly CandidateDecidedRecord[];
    activateds: readonly CandidateActivatedRecord[];
  };
}

// 跨会话收集三族并按时间排序：同一毫秒时按记录号兜底，保证"最后一条"稳定可复算
export function collectCandidateRecords(
  sources: readonly CandidateProjectionSource[]
): NonNullable<ProjectCandidatesOptions["records"]> {
  const byTime = <T extends { timestamp: number; id: string }>(records: T[]): T[] =>
    records.sort((left, right) =>
      left.timestamp !== right.timestamp
        ? left.timestamp - right.timestamp
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0
    );
  return {
    verifieds: byTime(sources.flatMap((source) => [...source.candidateVerifieds])),
    decideds: byTime(sources.flatMap((source) => [...source.candidateDecideds])),
    activateds: byTime(sources.flatMap((source) => [...source.candidateActivateds])),
  };
}

// 被取代的候选哈希：同名新候选元数据里的 supersedes 回指，加上决定族里的取代动作。
// 跨会话时先在全部会话上算一遍再投影——同一个名字可能在别的会话里被重新提炼出新版本
export function collectSupersededHashes(
  sources: readonly CandidateProjectionSource[]
): Set<string> {
  const superseded = new Set<string>();
  for (const source of sources) {
    for (const record of source.candidateProposeds) {
      const { supersedes } = record.candidate;
      if (supersedes !== undefined) {
        superseded.add(supersedes);
      }
    }
    for (const record of source.candidateDecideds) {
      if (record.action === "supersede") {
        superseded.add(record.contentHash);
      }
    }
  }
  return superseded;
}

export function projectCandidates(
  session: CandidateProjectionSource,
  options: ProjectCandidatesOptions = {}
): ProjectedCandidate[] {
  const superseded = options.supersededHashes ?? collectSupersededHashes([session]);
  return session.candidateProposeds.map((proposed) => {
    const { contentHash } = proposed.candidate;
    const byHash = <T extends { contentHash: string }>(records: readonly T[]): T | undefined =>
      records.findLast((record) => record.contentHash === contentHash);
    const pool = options.records ?? {
      verifieds: session.candidateVerifieds,
      decideds: session.candidateDecideds,
      activateds: session.candidateActivateds,
    };
    const screened = byHash(session.candidateScreeneds);
    const verified = byHash(pool.verifieds);
    const decided = byHash(pool.decideds);
    const activated = byHash(pool.activateds);
    return {
      candidate: proposed.candidate,
      status: statusOf({
        screened,
        verified,
        decided,
        activated,
        superseded: superseded.has(contentHash),
      }),
      proposed,
      ...(screened !== undefined ? { screened } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(decided !== undefined ? { decided } : {}),
      ...(activated !== undefined ? { activated } : {}),
    };
  });
}

function statusOf(input: {
  screened: CandidateScreenedRecord | undefined;
  verified: CandidateVerifiedRecord | undefined;
  decided: CandidateDecidedRecord | undefined;
  activated: CandidateActivatedRecord | undefined;
  superseded: boolean;
}): CandidateStatus {
  if (input.screened !== undefined && input.screened.hits.length > 0) {
    return "ScanRejected";
  }
  if (input.superseded) {
    return "Superseded";
  }
  if (input.decided !== undefined) {
    switch (input.decided.action) {
      case "reject":
        return "Rejected";
      case "revoke":
        return "Revoked";
      case "supersede":
        return "Superseded";
      case "approve":
        return input.activated !== undefined ? "Active" : "Approved";
    }
  }
  if (input.verified !== undefined) {
    switch (input.verified.conclusion) {
      case "passed":
        return "ReplayValidated";
      case "inconclusive":
        return "ReplayInconclusive";
      case "regressed":
        return "ReplayRegressed";
    }
  }
  return input.screened === undefined ? "Proposed" : "SecurityScanned";
}
