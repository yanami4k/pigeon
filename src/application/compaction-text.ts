// 上下文压缩的界面文案（决策 189）：命令行对话、终端界面与无头运行的告警共用。每次压缩提示一行——压成了给压缩前后的
// token 数，自动压缩没压成与压缩前回调失败给原因与后果；不常显用量。手动压缩没有压成时说明原因。
import type {
  CompactionNotice,
  CompactionOutcome,
  CompactionTrigger,
  ManualCompactionOutcome,
} from "../pi-runtime/index.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";

const TRIGGER_LABELS: Readonly<Record<CompactionTrigger, string>> = {
  turn: "自动，轮间",
  "run-start": "自动，Run 开始前",
  manual: "手动",
};

// 没压成的原因
function reasonOf(outcome: Exclude<ManualCompactionOutcome, { kind: "compacted" }>): string {
  switch (outcome.kind) {
    case "failed":
      return failureDetail(outcome.error);
    case "skipped":
      switch (outcome.reason) {
        case "nothing-to-summarize":
          return "最近保留的消息之外没有更早的对话可摘要";
        case "store-unavailable":
          return "会话文件没有打开";
        case "disabled":
          return "本会话没有开启上下文压缩";
      }
  }
}

// 一条压缩提示的一行文字
export function compactionNoticeText(notice: CompactionNotice): string {
  switch (notice.kind) {
    case "compacted":
      return `上下文已压缩（${TRIGGER_LABELS[notice.trigger]}）：约 ${notice.tokensBefore} → ${notice.tokensAfter} token`;
    case "incomplete":
      return `上下文压缩未完成（${TRIGGER_LABELS[notice.trigger]}）：${reasonOf(notice.outcome)}；本轮按原上下文继续`;
    case "hook-failed":
      return `压缩前回调失败：${failureDetail(notice.error)}；压缩照常进行`;
  }
}

// 手动压缩没有压成时的说明；压成了返回 undefined（那一行由压缩提示给出）
export function manualCompactionText(outcome: ManualCompactionOutcome): string | undefined {
  if (outcome.kind === "compacted") {
    return undefined;
  }
  if (outcome.kind === "failed") {
    return `压缩失败：${reasonOf(outcome)}`;
  }
  return outcome.reason === "nothing-to-summarize"
    ? `没有可压缩的内容：${reasonOf(outcome)}`
    : `无法压缩：${reasonOf(outcome)}`;
}

// 无头运行的压缩告警：自动压缩没压成与压缩前回调失败写标准错误输出，两类各按原因去重、同一类只说一次（warnings.ts 口径）；
// 压成了不告警
export function compactionWarner(sink?: WarnSink): (notice: CompactionNotice) => void {
  const incomplete = dedupedWarner(sink);
  const hookFailed = dedupedWarner(sink);
  return (notice) => {
    if (notice.kind === "incomplete") {
      incomplete(causeOf(notice.outcome), compactionNoticeText(notice));
    } else if (notice.kind === "hook-failed") {
      hookFailed(notice.error, compactionNoticeText(notice));
    }
  };
}

// 去重的类别：失败即原始错误，跳过即原因
function causeOf(outcome: Exclude<CompactionOutcome, { kind: "compacted" }>): unknown {
  return outcome.kind === "failed" ? outcome.error : new Error(outcome.reason);
}

// /compact 之后的文字即重点；空白即不给
export function compactFocusOf(command: string): string | undefined {
  const focus = command
    .trim()
    .replace(/^\/compact\b/, "")
    .trim();
  return focus === "" ? undefined : focus;
}
