// 终端界面启动时后台补做复盘（决策 283、284、295）与复盘模型（296）的配置、治理根下的状态文件形状：纯类型，无 IO。
// - 配置 .pigeon/memory-review.json（人手写，可缺省）：三道闸的数值、租约时长，以及日常使用中复盘所用的模型；
// - 状态目录 .pigeon/review-backfill/：上线时刻（首次以新版本启动时记下）、按会话号的租约、按会话号的补做记录
//   （过时跳过、失败原因与次数）。一个会话要不要补做不在这里登记，以会话存储里以它为父、跑完了的各次复盘覆盖到的位置为准（295）。
import { type Static, Type } from "typebox";

export const MEMORY_REVIEW_CONFIG_VERSION = 1;

// 复盘模型（296）：与会话的模型同一套写法（provider 与模型号），经同一个模型接入发出
export const ReviewModelSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type ReviewModel = Static<typeof ReviewModelSchema>;

export const MemoryReviewConfigFileSchema = Type.Object(
  {
    version: Type.Literal(MEMORY_REVIEW_CONFIG_VERSION),
    // 指定后日常使用中的全部复盘（压缩前、收尾、补做）都用它；不指定时压缩前与收尾复盘用会话本身的模型，补做用本次启动的模型
    reviewModel: Type.Optional(ReviewModelSchema),
    // 超过这么多天没有动静的会话视为过时，跳过且以后不再补
    maxAgeDays: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    // 每次启动最多补几个（从最新的开始）
    maxPerLaunch: Type.Optional(Type.Integer({ minimum: 0 })),
    // 租约时长（分钟）：超过即视为失效，别的进程可以接手
    leaseMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false }
);
export type MemoryReviewConfigFile = Static<typeof MemoryReviewConfigFileSchema>;

// 生效的数值
export interface ReviewBackfillSettings {
  maxAgeMs: number;
  maxPerLaunch: number;
  leaseMs: number;
}

// 缺省（284）：7 天、每次 5 个；租约 30 分钟（复盘墙钟上限 15 分钟的两倍）
export const DEFAULT_REVIEW_BACKFILL: Readonly<ReviewBackfillSettings> = {
  maxAgeMs: 7 * 24 * 60 * 60_000,
  maxPerLaunch: 5,
  leaseMs: 30 * 60_000,
};

export function reviewBackfillSettings(
  file: MemoryReviewConfigFile | undefined
): ReviewBackfillSettings {
  return {
    maxAgeMs:
      file?.maxAgeDays !== undefined
        ? file.maxAgeDays * 24 * 60 * 60_000
        : DEFAULT_REVIEW_BACKFILL.maxAgeMs,
    maxPerLaunch: file?.maxPerLaunch ?? DEFAULT_REVIEW_BACKFILL.maxPerLaunch,
    leaseMs:
      file?.leaseMinutes !== undefined
        ? file.leaseMinutes * 60_000
        : DEFAULT_REVIEW_BACKFILL.leaseMs,
  };
}

// 上线时刻：只补此刻之后产生的会话
export const BackfillSinceSchema = Type.Object({
  version: Type.Literal(1),
  since: Type.Integer({ minimum: 0 }),
});
export type BackfillSince = Static<typeof BackfillSinceSchema>;

// 租约：持有进程与时刻，过了 expiresAt 即失效
export const BackfillLeaseSchema = Type.Object({
  version: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  holder: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 0 }),
  acquiredAt: Type.Integer({ minimum: 0 }),
  expiresAt: Type.Integer({ minimum: 0 }),
});
export type BackfillLease = Static<typeof BackfillLeaseSchema>;

// 补做记录：过时跳过（以后不再补），或失败（原因与次数，留待之后的启动重试）
export const BackfillRecordSchema = Type.Union([
  Type.Object({
    version: Type.Literal(1),
    sessionId: Type.String({ minLength: 1 }),
    status: Type.Literal("stale"),
    lastActivityAt: Type.Integer({ minimum: 0 }),
    skippedAt: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    version: Type.Literal(1),
    sessionId: Type.String({ minLength: 1 }),
    status: Type.Literal("failed"),
    failures: Type.Integer({ minimum: 1 }),
    lastError: Type.String(),
    lastFailedAt: Type.Integer({ minimum: 0 }),
  }),
]);
export type BackfillRecord = Static<typeof BackfillRecordSchema>;
