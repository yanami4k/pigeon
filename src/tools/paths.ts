// 路径围栏：工具层的工作区根约束。上游 edit 工具零路径限制（见 harness/tools/edit 笔记 §5.7），
// Pigeon 的工具实现必须在落地前自行解析并拒绝逃逸——与 registry 的 pathConfinement 声明对齐。
import { realpathSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {}

// 把 inputPath 解析成工作区根内的真实绝对路径；逃逸（../、根外绝对路径、
// 符号链接/junction 解析后越界）一律拒绝。目标必须已存在（realpath 解析符号链接的前提）——
// M3 的 read/edit 都只面向既有文件。
export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const realRoot = realpathSync(workspaceRoot);
  const resolved = path.resolve(realRoot, inputPath);
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
  }
  // path.relative 判包含关系：win32 下大小写不敏感，越界时以 .. 开头或给出绝对路径
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
  }
  return realTarget;
}
