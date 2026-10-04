// read_file（tier: read）：Pigeon 自有只读文件工具，AgentTool 兼容形状（上游类型经 wrap.ts 桥接）。
// 输出与 edit_file 协同（M3 切片 2）：头部带全文件快照标签 [PATH#TAG]，每行带 hashline 锚点
// N#TAG——edit_file 的快照预检与锚点寻址完全消费这里给出的标签。
// 行为参考 harness/tools/read 笔记：offset 1-based；窗口截断时给出下一窗口提示。
// 决策 357：单次正文至多 maxBytes 字节（缺省 50 KiB），单行超过 maxLineChars 字符（缺省 2000）截断并注明；按字节上限停下时
// 照翻页提示给出续读的 offset。
// 决策 356：pigeon://outputs/<编号> 是本会话落盘的命令输出，在路径判定之前识别，直接从会话落盘目录读，不经执行端。
import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DEFAULT_READ_FILE_MAX_BYTES,
  DEFAULT_READ_FILE_MAX_LINE_CHARS,
  type ReadFileLimits,
} from "../state/tools-config.ts";
import { type CommandOutputStore, isOutputsUri, OutputPathError } from "./command-output.ts";
import type { EditMode } from "./edit-mode.ts";
import { lineTag, snapshotTag, splitContent } from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

// 单次默认最多返回行数，防止一次把大文件全塞进上下文
const DEFAULT_READ_LIMIT = 2000;

// 域错误类（M4 S2 错误分类判据）：offset 越界 / 目标非文件等模型侧错误，
// 与环境异常（fs ErrnoException）区分——error-kind.ts 按类归 domain
export class ReadFileError extends Error {}
export const ReadFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 起始行，1-based；缺省从第 1 行开始
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  // 最多读取行数；缺省 2000
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ReadFileParams = Static<typeof ReadFileParamsSchema>;

export interface ReadFileDetails {
  // 解析并围栏后的规范路径（本地为宿主绝对路径，容器工作区为容器内路径；落盘输出为宿主上的落盘文件）
  resolvedPath: string;
  // 全文件快照标签：edit_file 的 snapshot 参数来源
  snapshot: string;
  totalLines: number;
  offset: number;
  limit: number;
  returnedLines: number;
  // 决策 357：本次截断显示的超长行数；按字节上限提前停下
  truncatedLines?: number;
  byteLimited?: boolean;
}

export interface ReadFileToolOptions {
  // 决策 061：replace 编辑模式下输出不带行标签与快照标签，每行 `行号| 内容`；缺省 hashline 输出不变
  editMode?: EditMode;
  // 决策 357：单次字节与单行字符上限；缺省 50 KiB 与 2000
  limits?: ReadFileLimits;
  // 决策 356：本会话的落盘目录（不给即不认虚拟路径）
  outputs?: CommandOutputStore;
}

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读取；工具不判断自己在哪
export function createReadFileTool(
  workspace: string | WorkspaceHost,
  options: ReadFileToolOptions = {}
): PigeonAgentTool<typeof ReadFileParamsSchema, ReadFileDetails> {
  const host = asWorkspaceHost(workspace);
  const replaceMode = options.editMode === "replace";
  const maxBytes = options.limits?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
  const maxLineChars = options.limits?.maxLineChars ?? DEFAULT_READ_FILE_MAX_LINE_CHARS;
  // 取内容：虚拟路径先于路径判定，直接读会话落盘目录；其余经执行端围栏后读取
  const load = async (inputPath: string): Promise<{ resolvedPath: string; raw: string }> => {
    if (isOutputsUri(inputPath)) {
      if (options.outputs === undefined) {
        throw new OutputPathError(`本会话没有落盘的命令输出：${inputPath}`);
      }
      const file = options.outputs.resolve(inputPath);
      return { resolvedPath: file, raw: await readFile(file, "utf8") };
    }
    const resolvedPath = await host.resolveExisting(inputPath);
    if (!(await host.isFile(resolvedPath))) {
      throw new ReadFileError(`不是常规文件：${inputPath}`);
    }
    const raw = await host.readText(resolvedPath);
    return { resolvedPath, raw };
  };
  return {
    name: "read_file",
    label: "read_file",
    description: replaceMode
      ? "读取工作区内文本文件。输出每行形如「行号| 内容」，头部 [PATH] 给出总行数与窗口。" +
        "edit_file 的 old_string 取自内容部分，不要带行号前缀；文件被截断时按提示的 offset 继续读取。"
      : "读取工作区内文本文件。输出每行带锚点前缀 N#TAG（N 为行号，TAG 为内容哈希），" +
        "头部 [PATH#TAG] 是全文件快照。edit_file 编辑时必须使用本工具给出的锚点与快照；" +
        "文件被截断时按提示的 offset 继续读取。",
    parameters: ReadFileParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadFileDetails>> {
      const args = Value.Parse(ReadFileParamsSchema, params);
      const { resolvedPath, raw } = await load(args.path);
      const snapshot = snapshotTag(raw);
      const { lines } = splitContent(raw);
      const totalLines = lines.length;
      if (totalLines === 0) {
        return {
          content: [
            {
              type: "text",
              text: `[${replaceMode ? args.path : `${args.path}#${snapshot}`}] 空文件`,
            },
          ],
          details: {
            resolvedPath,
            snapshot,
            totalLines: 0,
            offset: 1,
            limit: args.limit ?? DEFAULT_READ_LIMIT,
            returnedLines: 0,
          },
        };
      }
      const offset = args.offset ?? 1;
      if (offset > totalLines) {
        throw new ReadFileError(
          `offset ${offset} 超出文件范围（共 ${totalLines} 行）；请给出 1-${totalLines} 之间的 offset`
        );
      }
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const last = Math.min(offset + limit - 1, totalLines);
      // 逐行排版：超长行截断并注明；累计字节超过上限即停（至少给一行）
      const rendered: string[] = [];
      let bytes = 0;
      let truncatedLines = 0;
      let byteLimited = false;
      for (let number = offset; number <= last; number += 1) {
        const line = lines[number - 1] ?? "";
        const shown = line.length > maxLineChars ? clipLine(line, maxLineChars) : line;
        const text = replaceMode ? `${number}| ${shown}` : `${number}#${lineTag(line)}| ${shown}`;
        const size = Buffer.byteLength(text, "utf8") + 1;
        if (rendered.length > 0 && bytes + size > maxBytes) {
          byteLimited = true;
          break;
        }
        if (shown !== line) truncatedLines += 1;
        rendered.push(text);
        bytes += size;
      }
      const end = offset + rendered.length - 1;
      const remaining = totalLines - end;
      const hint =
        remaining > 0
          ? `\n${byteLimited ? `本次输出已达 ${maxBytes} 字节上限；` : ""}还有 ${remaining} 行未读，下一窗口参数 offset=${end + 1}`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `[${replaceMode ? args.path : `${args.path}#${snapshot}`}] 共 ${totalLines} 行（窗口 ${offset}-${end}）\n${rendered.join("\n")}${hint}`,
          },
        ],
        details: {
          resolvedPath,
          snapshot,
          totalLines,
          offset,
          limit,
          returnedLines: rendered.length,
          ...(truncatedLines > 0 ? { truncatedLines } : {}),
          ...(byteLimited ? { byteLimited } : {}),
        },
      };
    },
  };
}

// 超长行只显示前 maxChars 个字符（不切断代理对）并注明原长
function clipLine(line: string, maxChars: number): string {
  let cut = maxChars;
  const code = line.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${line.slice(0, cut)}…（本行共 ${line.length} 字符，超过 ${maxChars} 已截断）`;
}
