// 候选状态投影（M6，决策 065）：候选状态不入元数据、不写进候选目录，由账本的提出与筛查两族现算。
// M6 阶段只有三种：已提出（只有提出记录）、已扫描（筛查无命中）、扫描拒收（筛查有命中，永不参与激活）。
// 回放验证、审批与激活归 M8，届时在此加判据。
import type { CandidateStatus, ReviewerCandidate } from "./candidate.ts";
import type { CandidateProposedRecord, CandidateScreenedRecord } from "./event-log.ts";

export interface ProjectedCandidate {
  candidate: ReviewerCandidate;
  status: CandidateStatus;
  proposed: CandidateProposedRecord;
  screened?: CandidateScreenedRecord;
}

export function projectCandidates(session: {
  candidateProposeds: readonly CandidateProposedRecord[];
  candidateScreeneds: readonly CandidateScreenedRecord[];
}): ProjectedCandidate[] {
  return session.candidateProposeds.map((proposed) => {
    const screened = session.candidateScreeneds.findLast(
      (record) => record.contentHash === proposed.candidate.contentHash
    );
    const status: CandidateStatus =
      screened === undefined
        ? "Proposed"
        : screened.hits.length > 0
          ? "ScanRejected"
          : "SecurityScanned";
    return {
      candidate: proposed.candidate,
      status,
      proposed,
      ...(screened !== undefined ? { screened } : {}),
    };
  });
}
