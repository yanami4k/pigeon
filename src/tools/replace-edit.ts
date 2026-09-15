// edit_file 的 replace 式实现（tier: write，决策 061）：参数 { path, old_string, new_string }，口径参照 str_replace 惯例。
//   ① 原文必须在文件里恰好出现一次：0 次拒绝并提示重新 read_file 核对；多次拒绝并给出出现次数与各处起始行号；
//      精确匹配，不做空白宽松；新旧相同拒绝；
//   ② 匹配前文件内容与参数都按 LF 规整，写回保留原文件的 BOM、行尾风格与末尾换行（复用 hashline.ts 的 split/join）；
//   ③ 不带快照参数：原文匹配本身就是按内容寻址；
//   ④ 预检在内存完成、零写副作用，审批预览 diff、内容证据探针与执行共享同一段预检；
//   ⑤ 成功回执与 hashline 版形状对齐（"已在 X 应用 1 处替换（+a −b 行）"），不回传 diff 或锚点。
// 工具名沿用 edit_file，写档、串行执行、工作区路径围栏与 hashline 版一致。
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type AppliedEdit,
  buildEditDiff,
  joinContent,
  snapshotTag,
  splitContent,
} from "./hashline.ts";
import { resolveWorkspacePath } from "./paths.ts";
import type {
  ContentEvidenceTool,
  PigeonAgentTool,
  PigeonToolResult,
  PreviewableTool,
} from "./wrap.ts";

// 域错误（模型给的原文不对、不唯一或无变化）；带归类标记，tools/error-kind.ts 读标记归 domain
export class ReplaceEditError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const ReplaceEditParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 文件里要替换的原文，须逐字一致且恰好出现一次
  old_string: Type.String({ minLength: 1 }),
  new_string: Type.String(),
});
export type ReplaceEditParams = Static<typeof ReplaceEditParamsSchema>;

export interface ReplaceEditDetails {
  resolvedPath: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  // unified-ish 展示 diff（审批展示用）
  diff: string;
  addedLines: number;
  removedLines: number;
}

export const REPLACE_EDIT_DESCRIPTION =
  "编辑工作区内已存在的文本文件：把 old_string 替换为 new_string。必须先用 read_file 读取；" +
  "old_string 须与文件原文逐字一致（含缩进与空白，不带行号前缀），且在文件里恰好出现一次，" +
  "出现多次时加上前后文使其唯一；old_string 与 new_string 相同会被拒绝。";

export function createReplaceEditTool(
  workspaceRoot: string
): PigeonAgentTool<typeof ReplaceEditParamsSchema, ReplaceEditDetails> &
  PreviewableTool &
  ContentEvidenceTool {
  return {
    name: "edit_file",
    label: "edit_file",
    description: REPLACE_EDIT_DESCRIPTION,
    parameters: ReplaceEditParamsSchema,
    executionMode: "sequential",
    async preview(params) {
      const plan = await planReplace(workspaceRoot, Value.Parse(ReplaceEditParamsSchema, params));
      return buildEditDiff(plan.args.path, plan.oldLines, [plan.applied]);
    },
    // 内容证据探针（M4 D5 哈希自动确证）：与执行同一段预检；失败返回 null，治理层降级为人工对账
    async probeContentEvidence(params) {
      try {
        const plan = await planReplace(workspaceRoot, Value.Parse(ReplaceEditParamsSchema, params));
        return {
          path: plan.args.path,
          beforeHash: plan.beforeSnapshot,
          expectedAfterHash: snapshotTag(plan.newRaw),
        };
      } catch {
        return null;
      }
    },
    hashContentTarget(params) {
      try {
        const args = Value.Parse(ReplaceEditParamsSchema, params);
        return snapshotTag(readFileSync(resolveWorkspacePath(workspaceRoot, args.path), "utf8"));
      } catch {
        return null;
      }
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<ReplaceEditDetails>> {
      const args = Value.Parse(ReplaceEditParamsSchema, params);
      const plan = await planReplace(workspaceRoot, args);
      signal?.throwIfAborted();
      await writeFile(plan.resolvedPath, plan.newRaw, "utf8");
      const addedLines = plan.applied.added.length;
      const removedLines = plan.applied.removed.length;
      return {
        content: [
          {
            type: "text",
            text: `已在 ${args.path} 应用 1 处替换（+${addedLines} −${removedLines} 行）`,
          },
        ],
        details: {
          resolvedPath: plan.resolvedPath,
          beforeSnapshot: plan.beforeSnapshot,
          afterSnapshot: snapshotTag(plan.newRaw),
          diff: buildEditDiff(args.path, plan.oldLines, [plan.applied]),
          addedLines,
          removedLines,
        },
      };
    },
  };
}

// 读 + 围栏 + 唯一匹配预检 + 内存落地（零写副作用）
async function planReplace(workspaceRoot: string, args: ReplaceEditParams) {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, args.path);
  if (!(await stat(resolvedPath)).isFile()) {
    throw new ReplaceEditError(`不是常规文件：${args.path}`);
  }
  const raw = await readFile(resolvedPath, "utf8");
  const split = splitContent(raw);
  const text =
    split.lines.join("\n") + (split.trailingNewline && split.lines.length > 0 ? "\n" : "");
  const oldString = args.old_string.replaceAll("\r\n", "\n");
  const newString = args.new_string.replaceAll("\r\n", "\n");
  if (oldString === newString) {
    throw new ReplaceEditError("编辑没有产生任何实际变化：old_string 与 new_string 相同");
  }
  const positions: number[] = [];
  for (
    let index = text.indexOf(oldString);
    index !== -1;
    index = text.indexOf(oldString, index + 1)
  ) {
    positions.push(index);
  }
  const first = positions[0];
  if (first === undefined) {
    throw new ReplaceEditError(
      "未找到 old_string：请重新 read_file 核对原文，含缩进与空白，不要带行号前缀"
    );
  }
  if (positions.length > 1) {
    const startLines = positions.map((position) => lineNumberAt(text, position));
    throw new ReplaceEditError(
      `old_string 不唯一：在 ${args.path} 中出现 ${positions.length} 次（起始行 ${startLines.join("、")}），` +
        "请加上下文使其唯一"
    );
  }
  const replaced = text.slice(0, first) + newString + text.slice(first + oldString.length);
  const endsWithNewline = replaced.endsWith("\n");
  const newLines =
    replaced === "" ? [] : (endsWithNewline ? replaced.slice(0, -1) : replaced).split("\n");
  const newRaw = joinContent(newLines, {
    bom: split.bom,
    eol: split.eol,
    trailingNewline: endsWithNewline && newLines.length > 0,
  });
  return {
    args,
    resolvedPath,
    beforeSnapshot: snapshotTag(raw),
    oldLines: split.lines,
    newRaw,
    applied: changedSpan(split.lines, newLines),
  };
}

function lineNumberAt(text: string, position: number): number {
  let line = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < position;
    index = text.indexOf("\n", index + 1)
  ) {
    line += 1;
  }
  return line;
}

// 改前改后行数组去掉公共前缀与公共后缀，剩下的就是这 1 处替换涉及的行（+a −b 行与审批 diff 的依据）
function changedSpan(oldLines: readonly string[], newLines: readonly string[]): AppliedEdit {
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    kind: "replace",
    startLine: prefix + 1,
    endLine: oldLines.length - suffix,
    removed: oldLines.slice(prefix, oldLines.length - suffix),
    added: newLines.slice(prefix, newLines.length - suffix),
  };
}
