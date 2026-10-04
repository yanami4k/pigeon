// write_file（tier: write，决策 358）：新建文本文件，或用给出的内容整体覆盖已存在的文件。与 edit_file 同规矩：限工作区（执行端
// 围栏）、不写受保护路径（治理层按写档与工作区围栏判定）、审批属写档、写前复核照 334（目标本身是符号链接拒写，路径在检查之后
// 变了拒写；新建时目标在检查之后被别人建了也不覆盖）。
// 覆盖已存在的文件前须本会话读过它，且读后未变（读取记录按读取当时整个文件的哈希判断）；成功后按写成的内容更新读取记录。
// 预检在内存完成、零写副作用，审批预览 diff 与执行共享同一段预检。内容原样写入，不改行尾。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { buildEditDiff, splitContent } from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import type { FileReadTracker } from "./read-tracker.ts";
import { changedSpan } from "./replace-edit.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

export const WRITE_FILE_TOOL = "write_file";

// 域错误（没读过、读后变了、目标不是常规文件）
export class WriteFileError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const WriteFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 文件的全部内容
  content: Type.String(),
});
export type WriteFileParams = Static<typeof WriteFileParamsSchema>;

export interface WriteFileDetails {
  resolvedPath: string;
  // 新建（否则为覆盖）
  created: boolean;
  bytes: number;
  lines: number;
  // unified-ish 展示 diff（审批与界面展示用）
  diff: string;
  addedLines: number;
  removedLines: number;
}

export const WRITE_FILE_DESCRIPTION =
  "新建文本文件，或用给出的内容整体覆盖已存在的文件（限工作区内）。" +
  "覆盖已存在的文件前须先在本会话用 read_file 读过它，且读后文件没有被改过；只改其中一部分请用 edit_file。" +
  "目录不存在会自动创建；目标是符号链接时拒写。";

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读写；reads 为本会话的读取记录
export function createWriteFileTool(
  workspace: string | WorkspaceHost,
  reads: FileReadTracker
): PigeonAgentTool<typeof WriteFileParamsSchema, WriteFileDetails> & PreviewableTool {
  const host = asWorkspaceHost(workspace);
  return {
    name: WRITE_FILE_TOOL,
    label: WRITE_FILE_TOOL,
    description: WRITE_FILE_DESCRIPTION,
    parameters: WriteFileParamsSchema,
    executionMode: "sequential",
    async preview(params) {
      return (await planWrite(host, reads, Value.Parse(WriteFileParamsSchema, params))).diff;
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<WriteFileDetails>> {
      const args = Value.Parse(WriteFileParamsSchema, params);
      const plan = await planWrite(host, reads, args);
      signal?.throwIfAborted();
      if (plan.created) {
        await (host.createText as NonNullable<WorkspaceHost["createText"]>)(
          plan.resolvedPath,
          args.content
        );
      } else {
        await host.writeText(plan.resolvedPath, args.content);
      }
      reads.record(plan.resolvedPath, args.content);
      const lines = splitContent(args.content).lines.length;
      return {
        content: [
          {
            type: "text",
            text: plan.created
              ? `已新建 ${args.path}（${lines} 行）`
              : `已覆盖 ${args.path}（${lines} 行；+${plan.addedLines} −${plan.removedLines} 行）`,
          },
        ],
        details: {
          resolvedPath: plan.resolvedPath,
          created: plan.created,
          bytes: Buffer.byteLength(args.content, "utf8"),
          lines,
          diff: plan.diff,
          addedLines: plan.addedLines,
          removedLines: plan.removedLines,
        },
      };
    },
  };
}

// 围栏 + 读过且读后未变的检查 + 内存里算出改动（零写副作用）
async function planWrite(host: WorkspaceHost, reads: FileReadTracker, args: WriteFileParams) {
  if (host.resolveForCreate === undefined || host.createText === undefined) {
    throw new WriteFileError("当前执行端不支持 write_file");
  }
  const target = await host.resolveForCreate(args.path);
  let oldLines: string[] = [];
  if (target.exists) {
    if (!(await host.isFile(target.path))) {
      throw new WriteFileError(`不是常规文件：${args.path}`);
    }
    const oldRaw = await host.readText(target.path);
    if (!reads.hasRead(target.path)) {
      throw new WriteFileError(
        `${args.path} 已存在：覆盖前须先在本会话用 read_file 读过它；只改其中一部分请用 edit_file`
      );
    }
    if (!reads.unchangedSinceRead(target.path, oldRaw)) {
      throw new WriteFileError(`${args.path} 在你读过之后被改过（例如被命令改了），请先重新读取`);
    }
    oldLines = splitContent(oldRaw).lines;
  }
  const applied = changedSpan(oldLines, splitContent(args.content).lines);
  return {
    resolvedPath: target.path,
    created: !target.exists,
    diff: buildEditDiff(args.path, oldLines, [applied]),
    addedLines: applied.added.length,
    removedLines: applied.removed.length,
  };
}
