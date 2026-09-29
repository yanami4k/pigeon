// 工具调用结果的显示（决策 286 第 3 项）：工具调用行下方显示结果，缺省收起——只给前几行与剩余行数；Ctrl+O 展开或收起全部。
// 编辑类工具（结果 details 里带 diff 的：edit_file、replace 编辑）显示 diff 而不是回执全文；展开后也有上限，超出的注明截断。
// 纯 ASCII 前缀；内容本身在进 Text 之前由 message-flow 统一净化（决策 036）。

// 收起时显示的行数
export const TOOL_PREVIEW_LINES = 3;
// 展开后显示的行数上限与总字符上限
export const TOOL_EXPANDED_LINES = 200;
export const TOOL_EXPANDED_CHARS = 20_000;
// 收起时单行的字符上限（超长单行不让一行预览撑满屏）
const PREVIEW_LINE_CHARS = 200;
const INDENT = "  | ";

export interface ToolResultView {
  isError: boolean;
  text: string;
  diff?: string;
}

// 工具结果的 details 里带的展示 diff（edit-file.ts、replace-edit.ts 的 details.diff）
export function diffOfDetails(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff.trim() !== "" ? diff : undefined;
}

function clip(line: string, chars: number): string {
  const graphemes = [...line];
  return graphemes.length > chars ? `${graphemes.slice(0, chars).join("")}...` : line;
}

function sourceLines(result: ToolResultView): string[] {
  const body = result.diff ?? result.text;
  const lines = body.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

// 结果块的文本（不含工具调用行本身）；没有可显示的内容时为空串（Text 渲染零行）
export function toolResultBody(result: ToolResultView, expanded: boolean): string {
  const lines = sourceLines(result);
  if (lines.length === 0) return "";
  const out: string[] = [];
  if (!expanded) {
    for (const line of lines.slice(0, TOOL_PREVIEW_LINES)) {
      out.push(`${INDENT}${clip(line, PREVIEW_LINE_CHARS)}`);
    }
    const rest = lines.length - TOOL_PREVIEW_LINES;
    if (rest > 0) out.push(`${INDENT}... +${rest} lines (ctrl+o to expand)`);
    return out.join("\n");
  }
  let chars = 0;
  let shown = 0;
  let clipped = false;
  for (const line of lines) {
    if (shown >= TOOL_EXPANDED_LINES) break;
    if (chars + line.length > TOOL_EXPANDED_CHARS) {
      // 字符上限落在这一行中间：这一行截到上限为止
      out.push(`${INDENT}${clip(line, TOOL_EXPANDED_CHARS - chars)}`);
      shown += 1;
      clipped = true;
      break;
    }
    out.push(`${INDENT}${line}`);
    chars += line.length;
    shown += 1;
  }
  if (shown < lines.length || clipped) {
    out.push(
      `${INDENT}... truncated: ${lines.length - shown} more lines not shown (limit ${TOOL_EXPANDED_LINES} lines / ${TOOL_EXPANDED_CHARS} chars)`
    );
  } else {
    out.push(`${INDENT}(ctrl+o to collapse)`);
  }
  return out.join("\n");
}
