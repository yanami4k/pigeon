// 候选列表与详情（M6 S4，决策 065 子裁决 ⑤；M8 S6，决策 088 / 089 / 093）：
// `pigeon candidates [--all]` 与 `pigeon candidates show <选择器>` 的只读命令层。
// 跨会话读账本，状态由五族现算（状态不在候选目录里），一候选一行；详情给出审批要看的全部材料——
// 候选正文、与当前落点的 diff、来源链、扫描结果与四组回放的回执。纯字符串输出，cli 写 stdout。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { activationPathFor } from "../activation/activate.ts";
import {
  type AttemptRef,
  type CandidateStatus,
  isProducibleCandidateKind,
} from "../state/candidate.ts";
import type { CandidateVerifiedRecord } from "../state/event-log.ts";
import { activationDrift } from "./candidate-decision.ts";
import {
  buildCandidateIndex,
  type LocatedCandidate,
  readCandidateBody,
  resolveCandidate,
} from "./candidate-lookup.ts";

const STATUS_LABEL: Readonly<Record<CandidateStatus, string>> = {
  Proposed: "已提出",
  SecurityScanned: "已扫描",
  ScanRejected: "扫描拒收",
  EvidenceChecked: "已核证据",
  ReplayValidated: "回放通过",
  ReplayInconclusive: "回放未测出",
  ReplayRegressed: "回放回归",
  ValidationFailed: "验证失败",
  AwaitingApproval: "待批准",
  Approved: "已批准",
  Active: "已激活",
  Revoked: "已撤销",
  Rejected: "已拒绝",
  Superseded: "已取代",
};

const CONCLUSION_LABEL: Readonly<Record<string, string>> = {
  passed: "通过",
  inconclusive: "未测出",
  regressed: "回归",
};

const ARM_LABEL: Readonly<Record<string, string>> = {
  "failed-baseline": "失败侧·不带经验",
  "failed-with": "失败侧·带经验",
  "successful-baseline": "成功侧·不带经验",
  "successful-with": "成功侧·带经验",
};

// 待审数量（决策 088）：TUI 状态行只提示这个数字，不做面板。
// "待审" = 还等着人做决定、且确实可以批准的那些。回放结论为回归的候选一律不可批准（092），
// 翻案只能靠重验，把它算进待审会让状态行长期挂着一个人做不掉的数字。
export const PENDING_STATUSES: readonly CandidateStatus[] = [
  "SecurityScanned",
  "ReplayValidated",
  "ReplayInconclusive",
];

export function pendingApprovalCount(root: string): number {
  return buildCandidateIndex(root).candidates.filter((entry) =>
    PENDING_STATUSES.includes(entry.status)
  ).length;
}

export interface CandidatesCommandOptions {
  root: string;
  all?: boolean;
}

export function runCandidatesCommand(options: CandidatesCommandOptions): string {
  const projected = buildCandidateIndex(options.root).candidates;
  const hiddenRejected = projected.filter((item) => item.status === "ScanRejected").length;
  const visible =
    options.all === true ? projected : projected.filter((item) => item.status !== "ScanRejected");
  if (visible.length === 0) {
    return hiddenRejected > 0
      ? `尚无候选（另有 ${hiddenRejected} 个扫描拒收项已隐藏，用 --all 查看）\n`
      : "尚无候选\n";
  }
  const lines = visible.map((entry) => {
    const { candidate, status } = entry;
    const drift = activationDrift(options.root, entry);
    return [
      candidate.kind,
      candidate.name,
      candidate.contentHash.slice(0, 12),
      STATUS_LABEL[status] ?? status,
      ...(entry.verified !== undefined
        ? [
            `回放 ${CONCLUSION_LABEL[entry.verified.conclusion] ?? entry.verified.conclusion}（每组 ${entry.verified.n} 次，正 ${entry.verified.positiveDelta.toFixed(2)} 负 ${entry.verified.negativeDelta.toFixed(2)}）`,
          ]
        : []),
      ...(entry.activated?.unverified === true ? ["未经回放证实"] : []),
      ...(drift?.state === "drifted" ? ["已脱离批准版本"] : []),
      ...(drift?.state === "missing" ? ["落点文件已不在"] : []),
      `来源 会话 ${candidate.source.sessionId} ｜ ${candidate.source.runId} ｜ 产出会话 ${candidate.source.producerSessionId}`,
      new Date(candidate.createdAt).toISOString(),
    ].join(" ｜ ");
  });
  if (options.all !== true && hiddenRejected > 0) {
    lines.push(`（另有 ${hiddenRejected} 个扫描拒收项已隐藏，用 --all 查看）`);
  }
  return `${lines.join("\n")}\n`;
}

export interface CandidateDetailOptions {
  root: string;
  selector: string;
}

export function runCandidateShowCommand(options: CandidateDetailOptions): string {
  const index = buildCandidateIndex(options.root);
  const entry = resolveCandidate(index, options.selector);
  const { candidate } = entry;
  const body = readCandidateBody(options.root, entry);
  // 决策 094：已停止产出的种类没有落点——旧的 Policy 候选照常读、照常列，只是不可批准、不可激活
  const target = isProducibleCandidateKind(candidate.kind)
    ? activationPathFor(candidate.kind, candidate.name)
    : undefined;
  const current = target === undefined ? undefined : readIfExists(path.join(options.root, target));
  const sections = [
    header(options.root, entry),
    sourceSection(entry),
    scanSection(entry),
    verificationSection(entry.verified),
    decisionSection(entry),
    target === undefined
      ? `## 与当前落点的差异\n（${candidate.kind} 已停止产出，没有激活落点：这条旧候选不可批准、不可激活）`
      : `## 与当前落点的差异（${target}）\n${diffSection(current, body)}`,
    `## 候选正文\n${body.endsWith("\n") ? body.slice(0, -1) : body}`,
  ];
  return `${sections.join("\n\n")}\n`;
}

function readIfExists(absolute: string): string | undefined {
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

function header(root: string, entry: LocatedCandidate): string {
  const { candidate, status } = entry;
  const drift = activationDrift(root, entry);
  const driftNote =
    drift === undefined || drift.state === "same"
      ? []
      : [
          drift.state === "drifted"
            ? `落点 ${drift.path}：已脱离批准版本（人改过；不阻止使用，决策 093）`
            : `落点 ${drift.path}：文件已不在`,
        ];
  return [
    `# ${candidate.kind}/${candidate.name}`,
    `状态：${STATUS_LABEL[status] ?? status}`,
    `内容哈希：${candidate.contentHash}（${candidate.bytes} 字节）`,
    `判断强度：${candidate.strength} ｜ 产出方：${candidate.origin}`,
    `摘要：${candidate.summary}`,
    ...(candidate.supersedes !== undefined ? [`取代：${candidate.supersedes}`] : []),
    ...driftNote,
  ].join("\n");
}

function attemptLine(label: string, ref: AttemptRef): string {
  const verification =
    ref.verification !== undefined
      ? ` ｜ 验证记录 ${ref.verification.sessionId}/${ref.verification.recordId}`
      : " ｜ 无验证记录（标签为未知）";
  return (
    `- ${label}：会话 ${ref.sessionId} ｜ ${ref.runId} ｜ 条目 ${ref.entryRange.from}–${ref.entryRange.to}` +
    ` ｜ 标签 ${ref.label}${verification}`
  );
}

function sourceSection(entry: LocatedCandidate): string {
  const { source, contrast } = entry.candidate;
  const lines = [
    "## 来源链",
    `- 被提炼/被审：会话 ${source.sessionId} ｜ ${source.runId}`,
    `- 产出会话：${source.producerSessionId}`,
    `- 支撑条目：${source.entryRunSeqs.join("、")} ｜ 正文回指摘要 ${source.contentDigest.slice(0, 16)}`,
  ];
  if (contrast !== undefined) {
    lines.push(`- 产物形态：${contrast.form}`);
    for (const ref of contrast.successful) {
      lines.push(attemptLine("成功侧", ref));
    }
    for (const ref of contrast.failed) {
      lines.push(attemptLine("失败侧", ref));
    }
    if (contrast.sharedPrefix !== undefined) {
      const prefix = contrast.sharedPrefix;
      lines.push(
        `- 共享前缀：会话 ${prefix.sessionId} ｜ ${prefix.runId} ｜ 条目 ${prefix.from}–${prefix.to}（只算一次）`
      );
    }
    for (const ref of contrast.others ?? []) {
      lines.push(attemptLine("同组其余尝试", ref));
    }
  } else {
    lines.push("- 无对比来源块：单来源候选，没有成败两侧，回放无从比较");
  }
  return lines.join("\n");
}

function scanSection(entry: LocatedCandidate): string {
  const scan = entry.candidate.scan;
  if (scan.hits.length === 0) {
    return `## 扫描结果\n- 扫描器 v${scan.scannerVersion}：无命中`;
  }
  return [
    `## 扫描结果\n- 扫描器 v${scan.scannerVersion}：命中 ${scan.hits.length} 项（扫描拒收，永不参与激活）`,
    ...scan.hits.map((hit) => `  - ${hit.rule}：${hit.detail}`),
  ].join("\n");
}

function verificationSection(verified: CandidateVerifiedRecord | undefined): string {
  if (verified === undefined) {
    return "## 四组回放回执\n- 尚未验证（pigeon verify <选择器>）";
  }
  const environment = verified.environment;
  const arms = verified.arms.map((arm) => {
    const wilson = `Wilson [${arm.wilson.low.toFixed(2)}, ${arm.wilson.high.toFixed(2)}]（只作参考，不参与判定）`;
    const atK = arm.passAtK
      .map((value, index) => `pass@${index + 1}=${value.toFixed(2)}`)
      .join(" ");
    const powK = arm.passPowK
      .map((value, index) => `pass^${index + 1}=${value.toFixed(2)}`)
      .join(" ");
    return [
      `- ${ARM_LABEL[arm.arm] ?? arm.arm}：${arm.passes}/${arm.runs} 通过（${(arm.passRate * 100).toFixed(0)}%）`,
      `  ${atK}`,
      `  ${powK}`,
      `  ${wilson}`,
    ].join("\n");
  });
  return [
    `## 四组回放回执（${new Date(verified.verifiedAt).toISOString()}）`,
    `- 结论：${CONCLUSION_LABEL[verified.conclusion] ?? verified.conclusion}` +
      ` ｜ 每组 ${verified.n} 次 ｜ 大效应门槛 ${verified.effectThreshold}`,
    `- 正回放差 ${verified.positiveDelta.toFixed(2)} ｜ 负回放差 ${verified.negativeDelta.toFixed(2)}`,
    ...arms,
    "### 环境摘要",
    `- 模型：${environment.model.provider}/${environment.model.id}` +
      (environment.model.thinkingLevel !== undefined
        ? ` ｜ 推理档位 ${environment.model.thinkingLevel}`
        : "") +
      (environment.model.maxOutputTokens !== undefined
        ? ` ｜ 单轮输出上限 ${environment.model.maxOutputTokens}`
        : ""),
    `- harness：${environment.harness.commit}${environment.harness.dirty ? "（有未提交改动）" : ""}` +
      ` ｜ Node ${environment.runtime.node} ｜ 平台 ${environment.runtime.platform}`,
    `- 预算：${JSON.stringify(environment.budget)} ｜ 验证命令：${environment.verify.command}`,
    `- 经验集合哈希：${environment.experienceSetHash}（共 ${environment.experiences.length} 条）`,
    `- 各次运行会话号：${verified.runs.map((run) => `${run.arm}#${run.index} ${run.sessionId} ${run.verdict}`).join("；")}`,
  ].join("\n");
}

function decisionSection(entry: LocatedCandidate): string {
  const { decided, activated } = entry;
  if (decided === undefined) {
    return "## 决定与激活\n- 尚无决定";
  }
  const lines = [
    "## 决定与激活",
    `- 动作：${decided.action} ｜ 理由（${decided.reasonSource === "human" ? "人写" : "系统默认"}）：${decided.reason}`,
    `- 时间：${new Date(decided.decidedAt).toISOString()}`,
  ];
  if (decided.supersededBy !== undefined) {
    lines.push(`- 被取代为：${decided.supersededBy}`);
  }
  if (activated !== undefined) {
    lines.push(
      `- 激活落点：${activated.path} ｜ 激活内容哈希 ${activated.activatedHash.slice(0, 12)}` +
        (activated.unverified ? " ｜ 未经回放证实" : "")
    );
  }
  return lines.join("\n");
}

// 行级 diff（审批展示用，非 git apply 格式）：最长公共子序列，超大文件退化为整体替换展示
const DIFF_MAX_LINES = 2000;

export function diffSection(before: string | undefined, after: string): string {
  if (before === undefined) {
    return "（落点上还没有同名文件：本次激活是新增）";
  }
  if (before === after) {
    return "（落点内容与候选正文逐字相同）";
  }
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return `（两侧各 ${oldLines.length} / ${newLines.length} 行，超出逐行对比上限，按整体替换看待）`;
  }
  return renderLineDiff(oldLines, newLines).join("\n");
}

function renderLineDiff(oldLines: readonly string[], newLines: readonly string[]): string[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  // lcs[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        oldLines[i] === newLines[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(`-${oldLines[i]}`);
      i++;
    } else {
      out.push(`+${newLines[j]}`);
      j++;
    }
  }
  for (; i < rows; i++) {
    out.push(`-${oldLines[i]}`);
  }
  for (; j < columns; j++) {
    out.push(`+${newLines[j]}`);
  }
  return out;
}
