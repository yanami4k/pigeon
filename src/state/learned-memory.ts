// 推送记忆与复盘在 Run 开始条目里的记录形状（决策 175、191、192、207、283）：纯类型，无 IO。
// - 推送的记忆：会话开始冻结的 MEMORY.md 的身份（路径、哈希、字节数、条数、上限），与常驻 Memory 的清单分开；
// - 复盘：复盘会话的种类（收尾 / 压缩前）与模板版本（175：按会话与模板版本存档）；覆盖到来源会话的哪一条记录（283 补充）；
//   终端界面启动时后台补做的复盘另记读代码的来处（283）。后两项为加法式字段，旧会话照常可读。
import { type Static, Type } from "typebox";
import { Sha256HexSchema } from "./hashing.ts";

export const PushedMemoryManifestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  hash: Sha256HexSchema,
  bytes: Type.Integer({ minimum: 0 }),
  entries: Type.Integer({ minimum: 0 }),
  limitChars: Type.Integer({ minimum: 1 }),
});
export type PushedMemoryManifestRecord = Static<typeof PushedMemoryManifestSchema>;

// 复盘覆盖到来源会话的哪一条记录：分叉点，即来源主分支上最后一条消息条目的条目号与序号（seq）
export const ReviewCoverageSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
});
export type ReviewCoverage = Static<typeof ReviewCoverageSchema>;

const CommitSchema = Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" });

// 补做复盘读代码的来处（283）：本机会话读退出快照，沙箱会话读交回的分支；没有快照的读当前工作目录并写明原因
export const ReviewReadSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal("exit-snapshot"), commit: CommitSchema }),
  Type.Object({
    kind: Type.Literal("sandbox-branch"),
    branch: Type.String({ minLength: 1 }),
    commit: CommitSchema,
  }),
  Type.Object({ kind: Type.Literal("workdir"), reason: Type.String({ minLength: 1 }) }),
]);
export type ReviewReadSource = Static<typeof ReviewReadSourceSchema>;

export const MemoryReviewTagSchema = Type.Object({
  kind: Type.Union([Type.Literal("closing"), Type.Literal("pre-compaction")]),
  template: Type.String({ minLength: 1 }),
  covers: Type.Optional(ReviewCoverageSchema),
  // 终端界面启动时后台补做的复盘（种类记收尾）：读代码的来处
  backfill: Type.Optional(Type.Object({ readFrom: ReviewReadSourceSchema })),
});
export type MemoryReviewTag = Static<typeof MemoryReviewTagSchema>;
