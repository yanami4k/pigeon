// hashline：按内容哈希锚点寻址行的编辑算法层（纯函数，零副作用）。
// 自建最小实现——设计参考 oh-my-pi hashline（docs/research/oh-my-pi-design-performance.md §2.1），
// 仓库不依赖 @oh-my-pi/hashline。核心思想：把"复述旧文本"改成"引用已见内容"，
// 锚点 `N#TAG` = 行号 + 该行内容哈希，行号漂移或内容变化都会导致 tag 不匹配而拒绝。
import { createHash } from "node:crypto";
import { EDIT_NO_CHANGE_PREFIX } from "./edit-mode.ts";

// 锚点类报错文案的稳定标记：抛错处模板与 Eval 的编辑报错分类（eval/process.ts）共用，
// 改文案时两侧一起动，分类不会静默落"其他"
export const HASHLINE_ANCHOR_MISS_MARK = "未命中";
export const HASHLINE_OUT_OF_RANGE_MARK = "越界";

export class HashlineError extends Error {}

// 行锚点标签：行内容 sha256 的前 4 位 hex。行号定位置、tag 防漂移，
// 单行误判概率 1/65536，多锚点编辑联合概率更低
export function lineTag(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, 4);
}

// 全文件快照标签：read_file 输出、edit_file 预检（过期快照拒绝）的凭据
export function snapshotTag(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

const ANCHOR_PATTERN = /^(\d+)#([0-9a-f]{4})$/;

// 解析 `N#TAG` 锚点；N 为 1-based 行号，畸形一律拒绝
export function parseAnchor(anchor: string): { line: number; tag: string } {
  const match = ANCHOR_PATTERN.exec(anchor);
  if (match === null) {
    throw new HashlineError(`畸形锚点：${JSON.stringify(anchor)}，期望形如 12#a1b2`);
  }
  const line = Number(match[1]);
  if (line < 1) {
    throw new HashlineError(`锚点行号必须 ≥ 1：${JSON.stringify(anchor)}`);
  }
  return { line, tag: match[2] as string };
}

// 文本切行：剥 BOM、行尾统一 LF、末尾换行单独记账（避免出现幻影空行）
export interface SplitContent {
  bom: "" | "\uFEFF";
  eol: "\n" | "\r\n";
  lines: string[];
  trailingNewline: boolean;
}

export function splitContent(raw: string): SplitContent {
  const bom = raw.startsWith("\uFEFF") ? ("\uFEFF" as const) : "";
  const body = bom === "" ? raw : raw.slice(1);
  // 行尾探测规则同上游 edit-diff：第一个出现的换行符定罪，混行尾文件统一成那一种
  const eol = detectEol(body);
  // 空内容没有行（split 会给出幻影单行 [""]，特判掉）
  if (body === "") {
    return { bom, eol, lines: [], trailingNewline: false };
  }
  const normalized = body.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n");
  const trailingNewline = parts.length > 1 && parts[parts.length - 1] === "";
  if (trailingNewline) {
    parts.pop();
  }
  return { bom, eol, lines: parts, trailingNewline };
}

function detectEol(body: string): "\n" | "\r\n" {
  const crlf = body.indexOf("\r\n");
  const lf = body.indexOf("\n");
  return crlf !== -1 && crlf === lf - 1 ? "\r\n" : "\n";
}

// 拼回文本：恢复 BOM 与原行尾风格
export function joinContent(
  lines: string[],
  meta: Pick<SplitContent, "bom" | "eol" | "trailingNewline">
): string {
  const body = lines.join(meta.eol) + (meta.trailingNewline && lines.length > 0 ? meta.eol : "");
  return meta.bom + body;
}

// hashline 编辑操作：replace（换行/换范围）| insertAfter（锚点后插入）| delete（删行/删范围）
export type HashlineEdit =
  | { op: "replace"; anchor: string; endAnchor?: string; lines: string[] }
  | { op: "insertAfter"; anchor: string; lines: string[] }
  | { op: "delete"; anchor: string; endAnchor?: string };

// 一处已应用的编辑：原始坐标（1-based 闭区间）+ 删了什么、加了什么，供 diff 生成
export interface AppliedEdit {
  kind: HashlineEdit["op"];
  startLine: number;
  endLine: number;
  removed: string[];
  added: string[];
}

// 应用一批编辑：先在原坐标系整体预检（锚点全部命中、范围两两不重叠、有实际变化），
// 全部通过才从后往前落到行数组副本——任一失败抛错，输入行数组不被修改（原子性由调用方
// "预检通过才写盘"保证，本函数零 IO）。
export function applyHashlineEdits(
  lines: readonly string[],
  edits: readonly HashlineEdit[]
): { lines: string[]; applied: AppliedEdit[] } {
  if (edits.length === 0) {
    throw new HashlineError(" edits 为空：至少给一处编辑");
  }
  // 预检一：解析全部锚点并校验 tag（行号漂移/内容变化在此现形）
  const resolved = edits.map((edit, index) => resolveEdit(lines, edit, index));
  // 预检二：范围两两不重叠（保守：insertAfter 占据锚点行，与被覆盖行同址也算重叠）
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (a !== undefined && b !== undefined && a.start <= b.end && b.start <= a.end) {
        throw new HashlineError(
          `多处编辑的行范围重叠（edits[${i}] 与 edits[${j}]），请合并成一处再提`
        );
      }
    }
  }
  // 落地：按位置从后往前，前面的偏移量不会因后面的增删而错位
  const next = [...lines];
  const ordered = resolved.map((r, index) => ({ r, index })).sort((x, y) => y.r.start - x.r.start);
  const applied: AppliedEdit[] = [];
  for (const { r, index } of ordered) {
    const edit = edits[index];
    if (edit === undefined) {
      continue;
    }
    if (edit.op === "insertAfter") {
      next.splice(r.start + 1, 0, ...r.added);
    } else {
      next.splice(r.start, r.end - r.start + 1, ...r.added);
    }
    applied.unshift({
      kind: edit.op,
      startLine: r.start + 1,
      endLine: r.end + 1,
      removed: r.removed,
      added: r.added,
    });
  }
  // 预检三：必须有实际变化（"替换后内容不变"是错误，模型可能搞错了特殊字符）
  if (next.length === lines.length && next.every((line, i) => line === lines[i])) {
    throw new HashlineError(EDIT_NO_CHANGE_PREFIX);
  }
  return { lines: next, applied };
}

// 把一处编辑解析成原坐标系内的闭区间 [start, end]（0-based）与增删内容
function resolveEdit(
  lines: readonly string[],
  edit: HashlineEdit,
  index: number
): { start: number; end: number; removed: string[]; added: string[] } {
  const anchor = checkAnchor(lines, edit.anchor, index, "anchor");
  const end =
    "endAnchor" in edit && edit.endAnchor !== undefined
      ? checkAnchor(lines, edit.endAnchor, index, "endAnchor")
      : anchor;
  if (end < anchor) {
    throw new HashlineError(`edits[${index}] 的 endAnchor 在 anchor 之前，范围倒置`);
  }
  // insertAfter 只在锚点行之后插入，不删除任何行；锚点行只决定位置（范围仍占锚点行，供重叠检测）
  const removed = edit.op === "insertAfter" ? [] : lines.slice(anchor, end + 1);
  const added = edit.op === "delete" ? [] : edit.lines;
  return { start: anchor, end, removed, added };
}

// 校验锚点：格式、行号在界内、该行内容 tag 匹配；返回 0-based 行下标
function checkAnchor(
  lines: readonly string[],
  anchor: string,
  index: number,
  role: string
): number {
  const { line, tag } = parseAnchor(anchor);
  if (line > lines.length) {
    throw new HashlineError(
      `edits[${index}] 的 ${role} ${HASHLINE_OUT_OF_RANGE_MARK}：第 ${line} 行不存在（共 ${lines.length} 行）`
    );
  }
  const actual = lineTag(lines[line - 1] as string);
  if (actual !== tag) {
    throw new HashlineError(
      `edits[${index}] 的 ${role} ${HASHLINE_ANCHOR_MISS_MARK}：第 ${line} 行当前标签为 ${actual}，` +
        `锚点是 ${tag}——文件可能已变化，请重新 read_file 获取最新锚点`
    );
  }
  return line - 1;
}

// unified-ish 展示 diff（审批展示用，切片 4 消费；非 git apply 格式）：
// 每处编辑一个 hunk，带 2 行上下文，删行 -、加行 +
export function buildEditDiff(
  path: string,
  oldLines: readonly string[],
  applied: readonly AppliedEdit[]
): string {
  const hunks = applied.map((edit) => {
    // insertAfter 的上文含锚点行本身（锚点行及其前 1 行）；replace / delete 的上文是被改范围之前 2 行
    const contextBefore =
      edit.kind === "insertAfter"
        ? oldLines.slice(Math.max(0, edit.startLine - 2), edit.startLine)
        : oldLines.slice(Math.max(0, edit.startLine - 3), edit.startLine - 1);
    const contextAfter = oldLines.slice(edit.endLine, edit.endLine + 2);
    const body = [
      ...contextBefore.map((line) => ` ${line}`),
      ...edit.removed.map((line) => `-${line}`),
      ...edit.added.map((line) => `+${line}`),
      ...contextAfter.map((line) => ` ${line}`),
    ];
    return [`@@ ${edit.startLine}#${lineTag(oldLines[edit.startLine - 1] ?? "")} @@`, ...body].join(
      "\n"
    );
  });
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}
