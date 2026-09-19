// 候选列表（M6 S4，决策 065 子裁决 ⑤）：pigeon candidates [--all] 的只读命令层。
// 跨会话读账本、由提出与筛查两族现算状态（状态不在候选目录里），一候选一行：种类、名字、哈希前缀、
// 状态、来源与时间。缺省隐藏扫描拒收项（永不参与激活）；--all 全部列出。纯字符串输出，cli 写 stdout。
import path from "node:path";
import { listSessionIds, materializeSession } from "../persistence/session-read.ts";
import { type ProjectedCandidate, projectCandidates } from "../state/candidate-status.ts";

const STATUS_LABEL: Readonly<Record<string, string>> = {
  Proposed: "已提出",
  SecurityScanned: "已扫描",
  ScanRejected: "扫描拒收",
};

export interface CandidatesCommandOptions {
  root: string;
  all?: boolean;
}

export function runCandidatesCommand(options: CandidatesCommandOptions): string {
  const sessionsDir = path.join(options.root, ".pigeon", "sessions");
  const projected: ProjectedCandidate[] = [];
  for (const sessionId of listSessionIds(sessionsDir)) {
    projected.push(
      ...projectCandidates(materializeSession(sessionsDir, sessionId, { content: false }))
    );
  }
  const hiddenRejected = projected.filter((item) => item.status === "ScanRejected").length;
  const visible = (
    options.all === true ? projected : projected.filter((item) => item.status !== "ScanRejected")
  ).sort((left, right) => left.candidate.createdAt - right.candidate.createdAt);
  if (visible.length === 0) {
    return hiddenRejected > 0
      ? `尚无候选（另有 ${hiddenRejected} 个扫描拒收项已隐藏，用 --all 查看）\n`
      : "尚无候选\n";
  }
  const lines = visible.map(({ candidate, status }) =>
    [
      candidate.kind,
      candidate.name,
      candidate.contentHash.slice(0, 12),
      STATUS_LABEL[status] ?? status,
      `来源 会话 ${candidate.source.sessionId} ｜ ${candidate.source.runId} ｜ 产出会话 ${candidate.source.producerSessionId}`,
      new Date(candidate.createdAt).toISOString(),
    ].join(" ｜ ")
  );
  if (options.all !== true && hiddenRejected > 0) {
    lines.push(`（另有 ${hiddenRejected} 个扫描拒收项已隐藏，用 --all 查看）`);
  }
  return `${lines.join("\n")}\n`;
}
