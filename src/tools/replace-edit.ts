// edit_file 的 replace 式实现（tier: write，决策 061）：参数 { path, old_string, new_string }，口径参照 str_replace 惯例。
//   ① 原文必须在文件里恰好出现一次：0 次拒绝并提示重新 read_file 核对；多次拒绝并给出出现次数与各处起始行号；
//      精确匹配，不做空白宽松；新旧相同拒绝；
//   ② 匹配前文件内容与参数都按 LF 规整，写回保留原文件的 BOM、行尾风格与末尾换行（复用 hashline.ts 的 split/join）；
//   ③ 不带快照参数：原文匹配本身就是按内容寻址；
//   ④ 预检在内存完成、零写副作用，审批预览 diff、内容证据探针与执行共享同一段预检；
//   ⑤ 成功回执："已在 X 应用 N 处替换（+a −b 行）"，并写明改动在新文件里的行区间，附上下各两行带行号的内容
//      （决策 366；改动行多时只列头尾各三行），不回传 diff 或锚点。
//   ⑥ 决策 419：edits 给出一组 {old_string, new_string}（与顶层的 old_string、new_string 二选一）。每处都按改动前的
//      原文定位、照①校验，各处在原文里不得交叠；全部通过才一起写入，任一处不通过整组不写，报错写明是 edits 的第几项。
// 工具名沿用 edit_file，写档、串行执行、工作区路径围栏与 hashline 版一致。同一次回复里连发的几个编辑按顺序执行（353）。
// 决策 358：成功写入后按写成的内容更新本会话的读取记录。
// 决策 407：放权时（options.outsideWrites）接受工作区以外的路径，说明随之交代。
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
import {
  assertWritePathText,
  OUTSIDE_WRITE_SENTENCE,
  type WritePathOptions,
  type WriteToolOptions,
} from "./paths.ts";
import type { FileReadTracker } from "./read-tracker.ts";
import { planAndWrite, type WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

// 域错误（模型给的原文不对、不唯一或无变化）；带归类标记，tools/error-kind.ts 读标记归 domain
// 报错文案的稳定前缀（抛错处共用同一常量）
export const REPLACE_NOT_FOUND_PREFIX = "old_string not found";
export const REPLACE_NOT_UNIQUE_PREFIX = "old_string is not unique";

export class ReplaceEditError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

const ReplacePairSchema = Type.Object({
  old_string: Type.String({ minLength: 1 }),
  new_string: Type.String(),
});

export const ReplaceEditParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 单处修改：文件里要替换的原文，须逐字一致且恰好出现一次
  old_string: Type.Optional(Type.String({ minLength: 1 })),
  new_string: Type.Optional(Type.String()),
  // 多处修改（决策 419）：各处都按改动前的原文定位
  edits: Type.Optional(Type.Array(ReplacePairSchema, { minItems: 1 })),
});
export type ReplaceEditParams = Static<typeof ReplaceEditParamsSchema>;
type ReplacePair = Static<typeof ReplacePairSchema>;

export interface ReplaceEditDetails {
  resolvedPath: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  // unified-ish 展示 diff（审批展示用）
  diff: string;
  addedLines: number;
  removedLines: number;
}

export function replaceEditDescription(outsideWrites: boolean): string {
  return [
    `Edits an existing text file${outsideWrites ? "" : " in the workspace"} by replacing old_string with new_string.`,
    outsideWrites ? OUTSIDE_WRITE_SENTENCE : "",
    "Read the file with read_file first.",
    "old_string must match the file's text exactly (including indentation and whitespace, without the line-number prefix) " +
      "and appear exactly once in the file; if it appears more than once, add surrounding context to make it unique. " +
      "An old_string identical to new_string is refused.",
    "Put several changes to the same file into one call: give edits as a list of {old_string, new_string} " +
      "(and omit the top-level old_string and new_string). Every edit is located in the original text before any change, " +
      "each must be unique, and they must not overlap; they are written together only if all pass, and if any fails, none is written.",
    "Changes to several files can be sent as several edit_file calls in one reply; they run in order.",
    "The receipt gives the changed lines' range in the new file, with two lines of context above and below.",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读写；reads 为本会话的读取记录（决策 358）
export function createReplaceEditTool(
  workspace: string | WorkspaceHost,
  reads?: FileReadTracker,
  options: WriteToolOptions = {}
): PigeonAgentTool<typeof ReplaceEditParamsSchema, ReplaceEditDetails> & PreviewableTool {
  const host = asWorkspaceHost(workspace);
  const outside = options.outsideWrites === true;
  const pathOptions: WritePathOptions = { outside };
  return {
    name: "edit_file",
    label: "edit_file",
    description: replaceEditDescription(outside),
    parameters: ReplaceEditParamsSchema,
    executionMode: "sequential",
    async preview(params) {
      const plan = await planReplace(
        host,
        Value.Parse(ReplaceEditParamsSchema, params),
        pathOptions
      );
      return buildEditDiff(plan.args.path, plan.oldLines, plan.applied);
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<ReplaceEditDetails>> {
      const args = Value.Parse(ReplaceEditParamsSchema, params);
      // 决策 349：预检与落盘经 planAndWrite（写入时原文已变即用新原文重算一次）；决策 358：写成后更新读取记录
      const plan = await planAndWrite({
        host,
        inputPath: args.path,
        plan: () => planReplace(host, args, pathOptions),
        contentOf: (planned) => planned.newRaw,
        signal,
      });
      reads?.record(plan.resolvedPath, Buffer.from(plan.newRaw, "utf8"));
      const addedLines = plan.applied.reduce((total, span) => total + span.added.length, 0);
      const removedLines = plan.applied.reduce((total, span) => total + span.removed.length, 0);
      return {
        content: [
          {
            type: "text",
            text:
              `Applied ${plan.count} replacement${plan.count === 1 ? "" : "s"} in ${args.path} (+${addedLines} −${removedLines} lines)` +
              receiptSpans(splitContent(plan.newRaw).lines, plan.applied),
          },
        ],
        details: {
          resolvedPath: plan.resolvedPath,
          beforeSnapshot: plan.beforeSnapshot,
          afterSnapshot: snapshotTag(plan.newRaw),
          diff: buildEditDiff(args.path, plan.oldLines, plan.applied),
          addedLines,
          removedLines,
        },
      };
    },
  };
}

// 读 + 围栏 + 唯一匹配预检 + 内存落地（零写副作用）；多处时全部定位、查过交叠才拼出新内容，任一处不通过即抛错
async function planReplace(
  host: WorkspaceHost,
  args: ReplaceEditParams,
  pathOptions: WritePathOptions
) {
  const { pairs, batch } = pairsOf(args);
  // 决策 334：要写的文件本身是符号链接即拒写
  assertWritePathText(args.path);
  const resolvedPath = await host.resolveForWrite(args.path, pathOptions);
  if (!(await host.isFile(resolvedPath))) {
    throw new ReplaceEditError(`Not a regular file: ${args.path}`);
  }
  const raw = await host.readText(resolvedPath);
  const split = splitContent(raw);
  const text =
    split.lines.join("\n") + (split.trailingNewline && split.lines.length > 0 ? "\n" : "");
  const located = pairs.map((pair, index) => locate(text, pair, args.path, batch ? index : -1));
  // 各处都在原文里定位；按位置排序后相邻两处不交叠即全部不交叠（排序稳定，同起点时序号小的在前）
  const ordered = [...located].sort((a, b) => a.start - b.start);
  for (let k = 1; k < ordered.length; k += 1) {
    const before = ordered[k - 1] as LocatedSpan;
    const after = ordered[k] as LocatedSpan;
    if (after.start < before.end) {
      const [first, second] = [before.index, after.index].sort((a, b) => a - b);
      throw new ReplaceEditError(
        `The old_string of edits[${first}] and edits[${second}] overlap in the original text: ` +
          "every edit is located in the original text before any change, so merge them into one"
      );
    }
  }
  const replaced = spliceSpans(text, 0, text.length, ordered);
  // 各处单看都有变化，合起来仍可能与原文相同（例如一处删掉的正是另一处补上的）
  if (replaced === text) {
    throw new ReplaceEditError(
      `${EDIT_NO_CHANGE_PREFIX}: taken together, the replacements leave the text unchanged`
    );
  }
  const newLines = linesOf(replaced);
  const newRaw = joinContent(newLines, {
    bom: split.bom,
    eol: split.eol,
    trailingNewline: replaced.endsWith("\n") && newLines.length > 0,
  });
  const groups = lineGroups(text, split.lines.length, ordered);
  return {
    args,
    resolvedPath,
    beforeSnapshot: snapshotTag(raw),
    oldLines: split.lines,
    newRaw,
    count: pairs.length,
    // 只有一段改动时同单处：整个文件去掉公共前后缀；几段时逐段在各自的行区间里算
    applied:
      groups.length === 1
        ? [changedSpan(split.lines, newLines)]
        : groups.map((group) => groupSpan(text, split.lines, group)),
  };
}

// 单处（顶层 old_string、new_string）与多处（edits）二选一；单处即只有一项的一组，报错文案照旧不带序号
function pairsOf(args: ReplaceEditParams): { pairs: readonly ReplacePair[]; batch: boolean } {
  if (args.edits !== undefined) {
    if (args.old_string !== undefined || args.new_string !== undefined) {
      throw new ReplaceEditError(
        "Use either edits or the top-level old_string and new_string, not both"
      );
    }
    return { pairs: args.edits, batch: true };
  }
  if (args.old_string === undefined || args.new_string === undefined) {
    throw new ReplaceEditError(
      "Missing old_string or new_string: a single change needs both; for several changes to the same file, use edits"
    );
  }
  return { pairs: [{ old_string: args.old_string, new_string: args.new_string }], batch: false };
}

// 一处替换在原文（LF 规整后）里的位置 [start, end) 与换上的文字；index 为 edits 里的序号（单处为 -1，报错不带序号）
interface LocatedSpan {
  index: number;
  start: number;
  end: number;
  newString: string;
}

function locate(text: string, pair: ReplacePair, path: string, index: number): LocatedSpan {
  // 报错以稳定前缀开头，edits 的第几项写在前缀之后
  const where = index >= 0 ? ` in edits[${index}]` : "";
  const oldString = pair.old_string.replaceAll("\r\n", "\n");
  const newString = pair.new_string.replaceAll("\r\n", "\n");
  if (oldString === newString) {
    throw new ReplaceEditError(
      `${EDIT_NO_CHANGE_PREFIX}${where}: old_string and new_string are identical`
    );
  }
  const positions: number[] = [];
  for (
    let found = text.indexOf(oldString);
    found !== -1;
    found = text.indexOf(oldString, found + 1)
  ) {
    positions.push(found);
  }
  const first = positions[0];
  if (first === undefined) {
    throw new ReplaceEditError(
      `${REPLACE_NOT_FOUND_PREFIX}${where}: read the file again with read_file and check the original text, ` +
        "including indentation and whitespace, without the line-number prefix" +
        (index >= 0
          ? "; every edit is located in the original text before any change, so it cannot refer to text produced by another edit"
          : "")
    );
  }
  if (positions.length > 1) {
    const startLines = positions.map((position) => lineNumberAt(text, position));
    throw new ReplaceEditError(
      `${REPLACE_NOT_UNIQUE_PREFIX}${where}: it appears ${positions.length} times in ${path} ` +
        `(starting at lines ${startLines.join(", ")}); add surrounding context to make it unique`
    );
  }
  return { index, start: first, end: first + oldString.length, newString };
}

// text 的 [from, to) 一段按 spans（已按位置排好、互不交叠、都落在这一段里）换掉后的文字
function spliceSpans(text: string, from: number, to: number, spans: readonly LocatedSpan[]) {
  let out = "";
  let cursor = from;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.newString;
    cursor = span.end;
  }
  return out + text.slice(cursor, to);
}

// LF 文本切成行数组：末尾换行不算多出一行，空文本没有行
function linesOf(text: string): string[] {
  return text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

// 原文的行下标（0 起）闭区间与落在其中的几处替换
interface LineGroup {
  first: number;
  last: number;
  spans: LocatedSpan[];
}

// 按行归段：一处替换占起点所在行到终点所在行（终点恰在换行之后时连下一行也算上，替换可能把它并上来）；
// 行区间相交的几处归为一段。spans 已按位置排好且互不交叠
function lineGroups(text: string, lineCount: number, spans: readonly LocatedSpan[]): LineGroup[] {
  const lineAt = (position: number): number =>
    Math.min(lineNumberAt(text, position), lineCount) - 1;
  const groups: LineGroup[] = [];
  for (const span of spans) {
    const first = lineAt(span.start);
    const last = lineAt(span.end);
    const current = groups[groups.length - 1];
    if (current !== undefined && first <= current.last) {
      current.last = Math.max(current.last, last);
      current.spans.push(span);
    } else {
      groups.push({ first, last, spans: [span] });
    }
  }
  return groups;
}

// 一段改动在原文行区间里换前换后去掉公共前后缀，坐标换回整个原文
function groupSpan(text: string, oldLines: readonly string[], group: LineGroup): AppliedEdit {
  const lineStart = (line: number): number =>
    line >= oldLines.length
      ? text.length
      : oldLines.slice(0, line).reduce((total, content) => total + content.length + 1, 0);
  const region = spliceSpans(text, lineStart(group.first), lineStart(group.last + 1), group.spans);
  const span = changedSpan(oldLines.slice(group.first, group.last + 1), linesOf(region));
  return { ...span, startLine: span.startLine + group.first, endLine: span.endLine + group.first };
}

// 回执里的改动处：一段时同单处；几段时逐段写明，各段起始行按前面各段的增删换算到新文件
function receiptSpans(newLines: readonly string[], applied: readonly AppliedEdit[]): string {
  if (applied.length === 1) {
    const only = applied[0] as AppliedEdit;
    return changeContext(newLines, only.startLine, only.added.length);
  }
  let shift = 0;
  const parts = applied.map((span, index) => {
    const start = span.startLine + shift;
    shift += span.added.length - span.removed.length;
    // changeContext 以 "; " 开头，段号之后改用冒号接上
    return `\nRegion ${index + 1}: ${changeContext(newLines, start, span.added.length).slice(2)}`;
  });
  return `; ${applied.length} changed regions${parts.join("")}`;
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
        ? `at the end of the new file (after line ${newLines.length})`
        : `before line ${start} of the new file`;
    return `; deleted ${where}:\n${numbered(start - CONTEXT_LINES, start + CONTEXT_LINES - 1).join("\n")}`;
  }
  const end = start + count - 1;
  const span =
    count > SPAN_SHOWN_WHOLE
      ? [
          ...numbered(start, start + SPAN_EDGE - 1),
          `… (${count - 2 * SPAN_EDGE} more lines)`,
          ...numbered(end - SPAN_EDGE + 1, end),
        ]
      : numbered(start, end);
  return (
    `; lines ${start}–${end} of the new file:\n` +
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
