// 注入清单（M5，决策 042 / 043 / 044）：常驻 Memory 与 Skill 的冻结身份形状。
// InjectionSnapshot v3（pi-runtime/snapshot.ts）与 run.started 观察记录（state/event-log.ts）
// 共用同一份 schema——"用的是哪版 Memory / Skill"在快照与账本里是同一种证据，杜绝漂移。
import { type Static, Type } from "typebox";
import { Sha256HexSchema } from "./message-content.ts";

// 常驻 Memory 单文件身份：included=false 表示超预算只列文件名未注入；truncated 只可能出现在
// 被部分装入的那个文件上（偏好文件永不截断）
export const MemoryManifestEntrySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  hash: Sha256HexSchema,
  bytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  included: Type.Boolean(),
});
export type MemoryManifestEntry = Static<typeof MemoryManifestEntrySchema>;

// Skill 目录下单个文件的冻结身份（path 相对 Skill 目录，正斜杠）
export const SkillFileManifestEntrySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  hash: Sha256HexSchema,
  bytes: Type.Integer({ minimum: 0 }),
});
export type SkillFileManifestEntry = Static<typeof SkillFileManifestEntrySchema>;

// 单个 Skill 的冻结身份：开会话时全部文件的哈希清单（load_skill 读取时比对，043）
export const SkillManifestEntrySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  files: Type.Array(SkillFileManifestEntrySchema),
});
export type SkillManifestEntry = Static<typeof SkillManifestEntrySchema>;
