// 注入清单（M5，决策 042 / 043 / 044）：常驻 Memory 与 Skill 的冻结身份形状。
// InjectionSnapshot v3（pi-runtime/snapshot.ts）与 Run 开始条目（state/session-entries.ts）
// 共用同一份 schema——"用的是哪版 Memory / Skill"在快照与账本里是同一种证据，杜绝漂移。
import { type Static, Type } from "typebox";
import { Sha256HexSchema } from "./hashing.ts";

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

// 结构化记忆的推送留痕（决策 134 / 157）：开关、挑选方式与开局给了哪几条（条目编号）。决策 174 后已停写，只为读旧会话保留。
// 开局那几条随注入快照冻结、每个 Run 的 Run 开始条目 同值；回炉那几条只记在该轮回炉 Run 的 Run 开始条目 上
export const StructuredMemorySelectionSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("fixed"),
]);
export type StructuredMemorySelection = Static<typeof StructuredMemorySelectionSchema>;

export const StructuredMemoryManifestSchema = Type.Object({
  // 关闭时两处都不推送（"去掉记忆"条件）
  enabled: Type.Boolean(),
  // auto 由程序按题面与报错挑选；fixed 由调用方指定条目（定点对照，决策 157）
  selection: StructuredMemorySelectionSchema,
  opening: Type.Array(Type.String({ minLength: 1 })),
  // 开局挑出来、但用前核验没过而被拦下的条目（没有被拦下的即缺省）
  openingBlocked: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type StructuredMemoryManifest = Static<typeof StructuredMemoryManifestSchema>;
