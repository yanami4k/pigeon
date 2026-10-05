// 工作目录快照的大小上限（决策 381）：settings.json 的 snapshot 一节。快照（worker 与沙箱的起点、检查点与退出快照、编排脚本的
// 快照、worker 交回时写的树）里未跟踪且未被忽略的文件，单个超过 untrackedFileMaxBytes 的跳过；其余合计超过
// untrackedTotalMaxBytes 时从大到小继续跳过，直到不超过上限。已跟踪的文件不受限。不给的取缺省。
// 挑选是纯函数；列出未跟踪文件与写树在 tools/untracked-files.ts 与各快照处。
import { type Static, Type } from "typebox";

export const DEFAULT_UNTRACKED_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UNTRACKED_TOTAL_MAX_BYTES = 200 * 1024 * 1024;

export const SnapshotSectionSchema = Type.Object(
  {
    // 单个未跟踪文件超过这么多字节即不进快照
    untrackedFileMaxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    // 进快照的未跟踪文件合计至多这么多字节
    untrackedTotalMaxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type SnapshotSection = Static<typeof SnapshotSectionSchema>;

export interface UntrackedLimits {
  fileMaxBytes: number;
  totalMaxBytes: number;
}

export const DEFAULT_UNTRACKED_LIMITS: UntrackedLimits = {
  fileMaxBytes: DEFAULT_UNTRACKED_FILE_MAX_BYTES,
  totalMaxBytes: DEFAULT_UNTRACKED_TOTAL_MAX_BYTES,
};

export function untrackedLimitsOf(section: SnapshotSection | undefined): UntrackedLimits {
  return {
    fileMaxBytes: section?.untrackedFileMaxBytes ?? DEFAULT_UNTRACKED_FILE_MAX_BYTES,
    totalMaxBytes: section?.untrackedTotalMaxBytes ?? DEFAULT_UNTRACKED_TOTAL_MAX_BYTES,
  };
}

// 没进快照的一个文件：路径相对拍快照的目录，正斜杠
export interface SkippedFile {
  path: string;
  bytes: number;
}

// 从未跟踪文件里挑出不进快照的：先跳过单个超限的，再把其余按大小从大到小跳过，直到合计不超过上限。
// 结果按大小从大到小、同大小按路径排
export function pickOversized(
  files: readonly SkippedFile[],
  limits: UntrackedLimits
): SkippedFile[] {
  const bySize = [...files].sort(
    (left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : 1)
  );
  const skipped: SkippedFile[] = [];
  let total = 0;
  for (const file of bySize) {
    if (file.bytes > limits.fileMaxBytes) {
      skipped.push(file);
    } else {
      total += file.bytes;
    }
  }
  for (const file of bySize) {
    if (total <= limits.totalMaxBytes) break;
    if (file.bytes > limits.fileMaxBytes) continue;
    skipped.push(file);
    total -= file.bytes;
  }
  return skipped;
}

// 人与模型读的大小：MiB 保留一位小数，不足 0.1 MiB 按 KiB
export function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 0.1 ? `${mib.toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

// 跳过清单的一行文字：路径（大小）以顿号相接
export function skippedFilesText(skipped: readonly SkippedFile[]): string {
  return skipped.map((file) => `${file.path}（${formatBytes(file.bytes)}）`).join("、");
}
