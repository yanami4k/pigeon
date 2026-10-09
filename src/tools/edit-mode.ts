// 编辑模式（决策 061）：hashline = 按 N#TAG 锚点与快照标签的稀疏编辑；replace = 原文替换（old_string 在文件里
// 必须恰好出现一次）。两种模式的工具名都叫 edit_file，策略、grant 与角色清单不随模式变化，
// 只有参数形态、寻址方式、工具描述与 read_file 的输出格式随模式切换。
// 决策 062：缺省改为 replace，hashline 保留为可选项。061 之前写下、没有 editMode 字段的 Eval 结果行确实是 hashline 跑的，
// 读取时按 hashline 补齐（LEGACY_RESULT_EDIT_MODE），不跟着缺省值变
export const EDIT_MODES = ["hashline", "replace"] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export const DEFAULT_EDIT_MODE: EditMode = "replace";

export const LEGACY_RESULT_EDIT_MODE: EditMode = "hashline";

// 两种模式共用的报错文案前缀：编辑没有产生实际变化（两处抛错共用同一常量）
export const EDIT_NO_CHANGE_PREFIX = "编辑没有产生任何实际变化";

export function isEditMode(value: string): value is EditMode {
  return (EDIT_MODES as readonly string[]).includes(value);
}
