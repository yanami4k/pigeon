// 工具的上限类设置：settings.json 的 tools 一节，按工具分子键（决策 368 起）。目前只有 grep、glob 的结果条数上限；
// read_file 的字节与单行上限、run_command 的头尾与落盘上限以后也放在这一节。
import { type Static, Type } from "typebox";

export const DEFAULT_GREP_MAX_RESULTS = 200;
export const DEFAULT_GLOB_MAX_RESULTS = 100;

const MaxResultsSchema = Type.Object(
  { maxResults: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false }
);

export const ToolsSectionSchema = Type.Object(
  {
    grep: Type.Optional(MaxResultsSchema),
    glob: Type.Optional(MaxResultsSchema),
  },
  { additionalProperties: false }
);
export type ToolsSection = Static<typeof ToolsSectionSchema>;

export interface SearchLimits {
  grepMaxResults: number;
  globMaxResults: number;
}

export function searchLimits(section: ToolsSection | undefined): SearchLimits {
  return {
    grepMaxResults: section?.grep?.maxResults ?? DEFAULT_GREP_MAX_RESULTS,
    globMaxResults: section?.glob?.maxResults ?? DEFAULT_GLOB_MAX_RESULTS,
  };
}
