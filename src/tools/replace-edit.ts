// edit_file 的 replace 式实现（tier: write，决策 061）：参数 { path, old_string, new_string }，口径参照 str_replace 惯例。
//   ① 原文必须在文件里恰好出现一次：0 次拒绝并提示重新 read_file 核对；多次拒绝并给出出现次数与各处起始行号；
//      精确匹配，不做空白宽松；新旧相同拒绝；
//   ② 匹配前文件内容与参数都按 LF 规整，写回保留原文件的 BOM、行尾风格与末尾换行（复用 hashline.ts 的 split/join）；
//   ③ 不带快照参数：原文匹配本身就是按内容寻址；
//   ④ 预检在内存完成、零写副作用，审批预览 diff、内容证据探针与执行共享同一段预检；
//   ⑤ 成功回执："已在 X 应用 1 处替换（+a −b 行）"，并写明这处改动在新文件里的行区间，附上下各两行带行号的内容
//      （决策 366；改动行多时只列头尾各三行），不回传 diff 或锚点。
// 工具名沿用 edit_file，写档、串行执行、工作区路径围栏与 hashline 版一致。同一次回复里连发的几个编辑按顺序执行（353）。
// 决策 358：成功写入后按写成的内容更新本会话的读取记录。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EDIT_NO_CHANGE_PREFIX } from "./edit-mode.ts";
import {
  type AppliedEdit,
  buildEditDiff,
  joinContent,
  snapshotTag,
  splitContent,
} from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import { assertWritePathText } from "./paths.ts";
import type { FileReadTracker } from "./read-tracker.ts";
import { planAndWrite, type WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

// 域错误（模型给的原文不对、不唯一或无变化）；带归类标记，tools/error-kind.ts 读标记归 domain
// 报错文案的稳定前缀（抛错处共用同一常量）
export const REPLACE_NOT_FOUND_PREFIX = "未找到 old_string";
export const REPLACE_NOT_UNIQUE_PREFIX = "old_string 不唯一";

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
  "出现多次时加上前后文使其唯一；old_string 与 new_string 相同会被拒绝。" +
  "对同一文件或几个文件的多处修改，可以在同一次回复里连发几个 edit_file，会按顺序执行。" +
  "回执给出这处改动在新文件里的行区间与上下各两行。";

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读写；reads 为本会话的读取记录（决策 358）
export function createReplaceEditTool(
  workspace: string | WorkspaceHost,
  reads?: FileReadTracker
): PigeonAgentTool<typeof ReplaceEditParamsSchema, ReplaceEditDetails> & PreviewableTool {
  const host = asWorkspaceHost(workspace);
  return {
    name: "edit_file",
    label: "edit_file",
    description: REPLACE_EDIT_DESCRIPTION,
    parameters: ReplaceEditParamsSchema,
    executionMode: "sequential",
    async preview(params) {
      const plan = await planReplace(host, Value.Parse(ReplaceEditParamsSchema, params));
      return buildEditDiff(plan.args.path, plan.oldLines, [plan.applied]);
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<ReplaceEditDetails>> {
      const args = Value.Parse(ReplaceEditParamsSchema, params);
      // 决策 349：预检与落盘经 planAndWrite（写入时原文已变即用新原文重算一次）；决策 358：写成后更新读取记录
      const plan = await planAndWrite({
        host,
        inputPath: args.path,
        plan: () => planReplace(host, args),
        contentOf: (planned) => planned.newRaw,
        signal,
      });
      reads?.record(plan.resolvedPath, Buffer.from(plan.newRaw, "utf8"));
      const addedLines = plan.applied.added.length;
      const removedLines = plan.applied.removed.length;
      return {
        content: [
          {
            type: "text",
            text:
              `已在 ${args.path} 应用 1 处替换（+${addedLines} −${removedLines} 行）` +
              changeContext(splitContent(plan.newRaw).lines, plan.applied.startLine, addedLines),
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
async function planReplace(host: WorkspaceHost, args: ReplaceEditParams) {
  // 决策 334：要写的文件本身是符号链接即拒写
  assertWritePathText(args.path);
  const resolvedPath = await host.resolveForWrite(args.path);
  if (!(await host.isFile(resolvedPath))) {
    throw new ReplaceEditError(`不是常规文件：${args.path}`);
  }
  const raw = await host.readText(resolvedPath);
  const split = splitContent(raw);
  const text =
    split.lines.join("\n") + (split.trailingNewline && split.lines.length > 0 ? "\n" : "");
  const oldString = args.old_string.replaceAll("\r\n", "\n");
  const newString = args.new_string.replaceAll("\r\n", "\n");
  if (oldString === newString) {
    throw new ReplaceEditError(`${EDIT_NO_CHANGE_PREFIX}：old_string 与 new_string 相同`);
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
      `${REPLACE_NOT_FOUND_PREFIX}：请重新 read_file 核对原文，含缩进与空白，不要带行号前缀`
    );
  }
  if (positions.length > 1) {
    const startLines = positions.map((position) => lineNumberAt(text, position));
    throw new ReplaceEditError(
      `${REPLACE_NOT_UNIQUE_PREFIX}：在 ${args.path} 中出现 ${positions.length} 次（起始行 ${startLines.join("、")}），` +
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

// 回执的行区间与上下文（决策 366）：start 为改动在新文件里的起始行（1 起），count 为新文件里改动的行数（0 为纯删除）。
// 带行号的写法同 replace 模式的 read_file；改动行多于 8 行时只列头尾各三行
const CONTEXT_LINES = 2;
const SPAN_SHOWN_WHOLE = 8;
const SPAN_EDGE = 3;
export function changeContext(newLines: readonly string[], start: number, count: number): string {
  const numbered = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let line = Math.max(1, from); line <= Math.min(to, newLines.length); line += 1) {
      out.push(`${line}| ${newLines[line - 1] ?? ""}`);
    }
    return out;
  };
  if (count === 0) {
    const where =
      start > newLines.length
        ? `新文件末尾（第 ${newLines.length} 行之后）`
        : `新文件第 ${start} 行之前`;
    return `；删去处在${where}：\n${numbered(start - CONTEXT_LINES, start + CONTEXT_LINES - 1).join("\n")}`;
  }
  const end = start + count - 1;
  const span =
    count > SPAN_SHOWN_WHOLE
      ? [
          ...numbered(start, start + SPAN_EDGE - 1),
          `…（中间 ${count - 2 * SPAN_EDGE} 行）`,
          ...numbered(end - SPAN_EDGE + 1, end),
        ]
      : numbered(start, end);
  return (
    `；新文件第 ${start}–${end} 行：\n` +
    [
      ...numbered(start - CONTEXT_LINES, start - 1),
      ...span,
      ...numbered(end + 1, end + CONTEXT_LINES),
    ].join("\n")
  );
}

// 改前改后行数组去掉公共前缀与公共后缀，剩下的就是这 1 处替换涉及的行（+a −b 行与审批 diff 的依据；write_file 的审批
// diff 也用它）
export function changedSpan(oldLines: readonly string[], newLines: readonly string[]): AppliedEdit {
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
