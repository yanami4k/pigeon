// 推送记忆与复盘在 Run 开始条目里的记录形状（决策 175、191、192、207）：纯类型，无 IO。
// - 推送的记忆：会话开始冻结的 MEMORY.md 的身份（路径、哈希、字节数、条数、上限），与常驻 Memory 的清单分开；
// - 复盘：复盘会话的种类（收尾 / 压缩前）与模板版本（175：按会话与模板版本存档）。
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

export const MemoryReviewTagSchema = Type.Object({
  kind: Type.Union([Type.Literal("closing"), Type.Literal("pre-compaction")]),
  template: Type.String({ minLength: 1 }),
});
export type MemoryReviewTag = Static<typeof MemoryReviewTagSchema>;
