// 上下文压缩的界面文案（决策 189）：命令行对话与终端界面共用。每次压缩（自动或手动）提示一行压缩前后的 token 数，
// 不常显用量；手动压缩没有压成时说明原因。
import type {
  CompactionNotice,
  CompactionTrigger,
  ManualCompactionOutcome,
} from "../pi-runtime/index.ts";

const TRIGGER_LABELS: Readonly<Record<CompactionTrigger, string>> = {
  turn: "自动，轮间",
  "run-start": "自动，Run 开始前",
  manual: "手动",
};

// 压缩完成的一行提示
export function compactionNoticeText(notice: CompactionNotice): string {
  return `上下文已压缩（${TRIGGER_LABELS[notice.trigger]}）：约 ${notice.tokensBefore} → ${notice.tokensAfter} token`;
}

// 手动压缩没有压成时的说明；压成了返回 undefined（那一行由压缩提示给出）
export function manualCompactionText(outcome: ManualCompactionOutcome): string | undefined {
  switch (outcome.kind) {
    case "compacted":
      return undefined;
    case "failed":
      return `压缩失败：${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
    case "skipped":
      switch (outcome.reason) {
        case "nothing-to-summarize":
          return "没有可压缩的内容：最近保留的消息之外没有更早的对话";
        case "store-unavailable":
          return "无法压缩：会话文件没有打开";
        case "disabled":
          return "本会话没有开启上下文压缩";
      }
  }
}

// /compact 之后的文字即重点；空白即不给
export function compactFocusOf(command: string): string | undefined {
  const focus = command
    .trim()
    .replace(/^\/compact\b/, "")
    .trim();
  return focus === "" ? undefined : focus;
}
