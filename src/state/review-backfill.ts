// 终端界面启动时后台补做复盘（决策 283、284）的配置与治理根下的状态文件形状：纯类型，无 IO。
// - 配置 .pigeon/review-backfill.json（人手写，可缺省）：三道闸的数值与租约时长；
// - 状态目录 .pigeon/review-backfill/：上线时刻（首次以新版本启动时记下）、按会话号的租约、按会话号的补做记录
//   （过时跳过、失败原因与次数）。一个会话是否已复盘不在这里登记，以会话存储里以它为父、跑完了的收尾复盘为准（192）。
import { type Static, Type } from "typebox";

export const REVIEW_BACKFILL_CONFIG_VERSION = 1;

export const ReviewBackfillConfigFileSchema = Type.Object(
  {
    version: Type.Literal(REVIEW_BACKFILL_CONFIG_VERSION),
    // 超过这么多天没有动静的会话视为过时，跳过且以后不再补
    maxAgeDays: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    // 每次启动最多补几个（从最新的开始）
    maxPerLaunch: Type.Optional(Type.Integer({ minimum: 0 })),
    // 租约时长（分钟）：超过即视为失效，别的进程可以接手
    leaseMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false }
);
export type ReviewBackfillConfigFile = Static<typeof ReviewBackfillConfigFileSchema>;

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
  file: ReviewBackfillConfigFile | undefined
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
