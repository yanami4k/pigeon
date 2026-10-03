// read_file（tier: read）：Pigeon 自有只读文件工具，AgentTool 兼容形状（上游类型经 wrap.ts 桥接）。
// 输出与 edit_file 协同（M3 切片 2）：头部带全文件快照标签 [PATH#TAG]，每行带 hashline 锚点
// N#TAG——edit_file 的快照预检与锚点寻址完全消费这里给出的标签。
// 行为参考 harness/tools/read 笔记：offset 1-based；窗口截断时给出下一窗口提示。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { EditMode } from "./edit-mode.ts";
import { lineTag, snapshotTag, splitContent } from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import { WorkspacePathError } from "./paths.ts";
import { type ReadTarget, readDenyList } from "./read-deny.ts";
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
  // 解析并围栏后的规范路径（本地为宿主绝对路径，容器工作区为容器内路径）
  resolvedPath: string;
  // 全文件快照标签：edit_file 的 snapshot 参数来源
  snapshot: string;
  totalLines: number;
  offset: number;
  limit: number;
  returnedLines: number;
}

// 决策 355：工作区以外的读取怎样放行——放手模式自动放行（allowed）、非放手模式经人批准（approval）、
// 没有审批通道即拒（refused，缺省）。只决定工具说明的说法；实际放行由治理层按调用授予（authorizeOutsideRead），
// 没有授权一律拒读
export type OutsideReadMode = "allowed" | "approval" | "refused";

export interface ReadFileToolOptions {
  // 决策 061：replace 编辑模式下输出不带行标签与快照标签，每行 `行号| 内容`；缺省 hashline 输出不变
  editMode?: EditMode;
  outsideReads?: OutsideReadMode;
  // 决策 355：设置追加的禁读项（permissions.readDeny）；内置名单总在
  readDeny?: readonly string[];
}

// 工作区以外的文件未获授权：路径围栏错误的一种
export class OutsideReadNotApprovedError extends WorkspacePathError {}

// 可选能力（治理层使用）：只读检查这次调用是否读工作区以外的文件，并按调用授予，一次一用
export interface OutsideReadTool {
  // 解析后落在工作区以外时返回其真实路径；在工作区内、不存在、禁读或解析不了返回 undefined
  inspectOutsideRead(params: unknown): Promise<string | undefined>;
  authorizeOutsideRead(toolCallId: string): void;
}

const OUTSIDE_SENTENCES: Readonly<Record<OutsideReadMode, string>> = {
  allowed: "工作区以外的文件也可读（用绝对路径），只读、不能改；凭据目录（如 ~/.ssh）不可读。",
  approval:
    "工作区以外的文件也可读（用绝对路径），须经人批准（可按目录放权），只读、不能改；凭据目录（如 ~/.ssh）不可读。",
  refused: "",
};

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读取；工具不判断自己在哪
export function createReadFileTool(
  workspace: string | WorkspaceHost,
  options: ReadFileToolOptions = {}
): PigeonAgentTool<typeof ReadFileParamsSchema, ReadFileDetails> & OutsideReadTool {
  const host = asWorkspaceHost(workspace);
  const replaceMode = options.editMode === "replace";
  const outsideReads = options.outsideReads ?? "refused";
  const deny = readDenyList(options.readDeny);
  // 治理层授予的工作区外读取（toolCallId），执行时取用即删
  const outsideApproved = new Set<string>();
  // 执行端没有读档解析时只读工作区之内（照 resolveExisting），也不判禁读名单
  const resolveTarget = async (inputPath: string): Promise<ReadTarget> =>
    host.resolveForRead !== undefined
      ? host.resolveForRead(inputPath, deny)
      : { path: await host.resolveExisting(inputPath), outside: false };
  const lead = outsideReads === "refused" ? "读取工作区内文本文件。" : "读取文本文件。";
  return {
    name: "read_file",
    label: "read_file",
    description:
      (replaceMode
        ? `${lead}输出每行形如「行号| 内容」，头部 [PATH] 给出总行数与窗口。` +
          "edit_file 的 old_string 取自内容部分，不要带行号前缀；文件被截断时按提示的 offset 继续读取。"
        : `${lead}输出每行带锚点前缀 N#TAG（N 为行号，TAG 为内容哈希），` +
          "头部 [PATH#TAG] 是全文件快照。edit_file 编辑时必须使用本工具给出的锚点与快照；" +
          "文件被截断时按提示的 offset 继续读取。") + OUTSIDE_SENTENCES[outsideReads],
    parameters: ReadFileParamsSchema,
    executionMode: "parallel",
    async inspectOutsideRead(params) {
      const target = (params as { path?: unknown } | null)?.path;
      if (host.resolveForRead === undefined || typeof target !== "string" || target === "") {
        return undefined;
      }
      try {
        const resolved = await host.resolveForRead(target, deny);
        return resolved.outside ? resolved.path : undefined;
      } catch {
        return undefined;
      }
    },
    authorizeOutsideRead(toolCallId) {
      outsideApproved.add(toolCallId);
    },
    async execute(toolCallId, params): Promise<PigeonToolResult<ReadFileDetails>> {
      const approved = outsideApproved.delete(toolCallId);
      const args = Value.Parse(ReadFileParamsSchema, params);
      const target = await resolveTarget(args.path);
      if (target.outside && !approved) {
        throw new OutsideReadNotApprovedError(
          `路径越出工作区根：${args.path}（工作区以外的文件须经批准才能读）`
        );
      }
      const resolvedPath = target.path;
      if (!(await host.isFile(resolvedPath))) {
        throw new ReadFileError(`不是常规文件：${args.path}`);
      }
      const raw = await host.readText(resolvedPath);
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
      const end = Math.min(offset + limit - 1, totalLines);
      const window = lines.slice(offset - 1, end);
      const body = window
        .map((line, index) =>
          replaceMode ? `${offset + index}| ${line}` : `${offset + index}#${lineTag(line)}| ${line}`
        )
        .join("\n");
      const remaining = totalLines - end;
      const hint =
        remaining > 0 ? `\n还有 ${remaining} 行未读，下一窗口参数 offset=${end + 1}` : "";
      return {
        content: [
          {
            type: "text",
            text: `[${replaceMode ? args.path : `${args.path}#${snapshot}`}] 共 ${totalLines} 行（窗口 ${offset}-${end}）\n${body}${hint}`,
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
