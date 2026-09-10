// read_file（tier: read）：Pigeon 自有只读文件工具，AgentTool 兼容形状（上游类型经 wrap.ts 桥接）。
// 输出与 edit_file 协同（M3 切片 2）：头部带全文件快照标签 [PATH#TAG]，每行带 hashline 锚点
// N#TAG——edit_file 的快照预检与锚点寻址完全消费这里给出的标签。
// 行为参考 harness/tools/read 笔记：offset 1-based；窗口截断时给出下一窗口提示。
import { readFile, stat } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { lineTag, snapshotTag, splitContent } from "./hashline.ts";
import { resolveWorkspacePath } from "./paths.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

// 单次默认最多返回行数，防止一次把大文件全塞进上下文
const DEFAULT_READ_LIMIT = 2000;

export const ReadFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 起始行，1-based；缺省从第 1 行开始
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  // 最多读取行数；缺省 2000
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ReadFileParams = Static<typeof ReadFileParamsSchema>;

export interface ReadFileDetails {
  // 解析并围栏后的真实绝对路径
  resolvedPath: string;
  // 全文件快照标签：edit_file 的 snapshot 参数来源
  snapshot: string;
  totalLines: number;
  offset: number;
  limit: number;
  returnedLines: number;
}

export function createReadFileTool(
  workspaceRoot: string
): PigeonAgentTool<typeof ReadFileParamsSchema, ReadFileDetails> {
  return {
    name: "read_file",
    label: "read_file",
    description:
      "读取工作区内文本文件。输出每行带锚点前缀 N#TAG（N 为行号，TAG 为内容哈希），" +
      "头部 [PATH#TAG] 是全文件快照。edit_file 编辑时必须使用本工具给出的锚点与快照；" +
      "文件被截断时按提示的 offset 继续读取。",
    parameters: ReadFileParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<ReadFileDetails>> {
      const args = Value.Parse(ReadFileParamsSchema, params);
      const resolvedPath = resolveWorkspacePath(workspaceRoot, args.path);
      if (!(await stat(resolvedPath)).isFile()) {
        throw new Error(`不是常规文件：${args.path}`);
      }
      const raw = await readFile(resolvedPath, "utf8");
      const snapshot = snapshotTag(raw);
      const { lines } = splitContent(raw);
      const totalLines = lines.length;
      if (totalLines === 0) {
        return {
          content: [{ type: "text", text: `[${args.path}#${snapshot}] 空文件` }],
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
        throw new Error(
          `offset ${offset} 超出文件范围（共 ${totalLines} 行）；请给出 1-${totalLines} 之间的 offset`
        );
      }
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const end = Math.min(offset + limit - 1, totalLines);
      const window = lines.slice(offset - 1, end);
      const body = window
        .map((line, index) => `${offset + index}#${lineTag(line)}| ${line}`)
        .join("\n");
      const remaining = totalLines - end;
      const hint =
        remaining > 0 ? `\n还有 ${remaining} 行未读，下一窗口参数 offset=${end + 1}` : "";
      return {
        content: [
          {
            type: "text",
            text: `[${args.path}#${snapshot}] 共 ${totalLines} 行（窗口 ${offset}-${end}）\n${body}${hint}`,
          },
        ],
        details: {
          resolvedPath,
          snapshot,
          totalLines,
          offset,
          limit,
          returnedLines: window.length,
        },
      };
    },
  };
}
