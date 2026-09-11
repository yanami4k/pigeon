// 工具错误分类（M4 S2，D7 ToolExecution 级判据）：
//   domain      = 工具自身域错误（路径逃逸 / 文件不存在 / hashline 锚不匹配 / 参数校验失败）
//                 ——模型或调用侧的问题，归「业务失败」；
//   environment = 环境异常（磁盘/权限/文件系统调用抛出的 ErrnoException）——归「基础设施错误」；
//   undefined   = 判不出（普通 Error、abort 信号、非错误值）——不贴标签，
//                 冷分类落「未知」默认桶（宁标不知道，不贴错标签——标签要喂 M6+ 蒸馏）。
import { ParseError } from "typebox/value";
import type { ToolErrorKind } from "../state/tool-execution.ts";
import { EditFileError } from "./edit-file.ts";
import { HashlineError } from "./hashline.ts";
import { WorkspacePathError } from "./paths.ts";
import { ReadFileError } from "./read-file.ts";

export function classifyToolError(error: unknown): ToolErrorKind | undefined {
  if (
    error instanceof EditFileError ||
    error instanceof HashlineError ||
    error instanceof ReadFileError ||
    error instanceof WorkspacePathError ||
    error instanceof ParseError
  ) {
    return "domain";
  }
  // Node fs 系异常的标识：Error 且携带字符串 code（ENOENT/EACCES/ENOSPC…）
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return "environment";
  }
  return undefined;
}
