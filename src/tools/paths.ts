// 路径围栏：工具层的工作区根约束。上游 edit 工具零路径限制（见 harness/tools/edit 笔记 §5.7），
// Pigeon 的工具实现必须在落地前自行解析并拒绝逃逸——与 registry 的 pathConfinement 声明对齐。
import { lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {}

// 目标不存在（其余围栏错误——越界、不可读——仍是父类）：调用方据此区分"没有这个文件"与"解析不了"
export class WorkspacePathNotFoundError extends WorkspacePathError {}

// 决策 334：写入前复核不通过（路径在检查之后变了，或要写的文件是符号链接），拒写
export class WorkspaceWriteRefusedError extends WorkspacePathError {}

// path.relative 的结果是否表示越界：恰好是 ..、以 .. 加路径分隔符开头、或是绝对路径（win32 跨盘符时给出绝对路径）。
// 只看"以 .. 开头"会把名字本身以两个点开头的合法文件或目录（..notes.txt、..cache/）误判为越界。
// 路径围栏与 Skill 资源围栏共用这一口径
export function isOutsideRelative(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// 把 inputPath 解析成工作区根内的真实绝对路径；逃逸（../、根外绝对路径、
// 符号链接/junction 解析后越界）一律拒绝。目标必须已存在（realpath 解析符号链接的前提）——
// M3 的 read/edit 都只面向既有文件。
export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const realRoot = realpathSync(workspaceRoot);
  const resolved = path.resolve(realRoot, inputPath);
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code === "ENOENT" || code === "ENOTDIR"
      ? new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`)
      : new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
  }
  // path.relative 判包含关系：win32 下大小写不敏感，越界时为 .. 加分隔符开头或给出绝对路径
  const rel = path.relative(realRoot, realTarget);
  if (isOutsideRelative(rel)) {
    throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
  }
  return realTarget;
}

// 判定工作区相对路径 inputPath 解析后是否落在工作区相对目录 dir 之内——grant 目录限定
// （决策 3a）的确定性匹配，与 resolveWorkspacePath 同一 realpath 机制。目录或目标不存在
// （realpath 解析失败）→ false：授权判定不猜，不匹配回落人工审批
export function isPathInsideDir(workspaceRoot: string, dir: string, inputPath: string): boolean {
  let realRoot: string;
  let realDir: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(workspaceRoot);
    realDir = realpathSync(path.resolve(realRoot, dir));
    realTarget = realpathSync(path.resolve(realRoot, inputPath));
  } catch {
    return false;
  }
  const rel = path.relative(realDir, realTarget);
  return !isOutsideRelative(rel);
}

// 决策 334：写工具的路径解析——同 resolveWorkspacePath，另在模型给的路径本身（最后一级）是符号链接时拒写并指出其指向
//（路径上的目录是符号链接的照常解析）
export function resolveWorkspaceWritePath(workspaceRoot: string, inputPath: string): string {
  const resolved = resolveWorkspacePath(workspaceRoot, inputPath);
  const given = path.resolve(realpathSync(workspaceRoot), inputPath);
  if (lstatSync(given).isSymbolicLink()) {
    throw symlinkRefused(inputPath, readlinkSync(given));
  }
  return resolved;
}

// 决策 334：写入前复核——resolvedPath 是检查时解析出的真实路径，重新解析须仍得到它自己；目标成了符号链接、
// 已不存在或解析到别处（路径上某层目录被换成了符号链接）即拒写。检查与写入之间的空隙无法完全关闭，这里只挡住常见情形
export function assertWritePathUnchanged(resolvedPath: string): void {
  let link: string | undefined;
  try {
    if (lstatSync(resolvedPath).isSymbolicLink()) {
      link = readlinkSync(resolvedPath);
    }
  } catch {
    throw pathChanged(resolvedPath, undefined);
  }
  if (link !== undefined) {
    throw symlinkRefused(resolvedPath, link);
  }
  let now: string | undefined;
  try {
    now = realpathSync(resolvedPath);
  } catch {
    now = undefined;
  }
  if (now !== resolvedPath) {
    throw pathChanged(resolvedPath, now);
  }
}

// 写类工具（edit_file、write_file）的路径参数含换行或其他控制字符即拒绝：shell 与各层解析对这类字符的处理不一，
// 实际落点可能与审批、受保护路径判定的对象不一致
export function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertWritePathText(inputPath: string): void {
  if (hasControlChar(inputPath)) {
    throw new WorkspaceWriteRefusedError(
      `路径含换行或其他控制字符，拒绝写入：${JSON.stringify(inputPath)}`
    );
  }
}

export function symlinkRefused(inputPath: string, target: string): WorkspaceWriteRefusedError {
  return new WorkspaceWriteRefusedError(
    `要写的文件是符号链接（${inputPath} → ${target}），拒绝写入：请改为编辑它指向的文件`
  );
}

export function pathChanged(
  resolvedPath: string,
  now: string | undefined
): WorkspaceWriteRefusedError {
  return new WorkspaceWriteRefusedError(
    `路径已变：${resolvedPath} 在检查之后${now === undefined ? "已不存在" : `改为解析到 ${now}`}，拒绝写入；` +
      "请重新 read_file 后再编辑"
  );
}

// 路径上最深的已存在一层（符号链接本身也算存在）与其下尚不存在的各段
function deepestExisting(target: string): { existing: string; rest: string[] } {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      lstatSync(current);
      return { existing: current, rest };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { existing: current, rest };
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// 决策 358：write_file 的解析。目标已存在：同 resolveWorkspaceWritePath（模型给的路径本身是符号链接即拒写）；
// 不存在：路径上最深的已存在一层按真实路径解析（须是目录），拼上其余各段，须仍在工作区根内
export function resolveWorkspaceCreatePath(
  workspaceRoot: string,
  inputPath: string
): { path: string; exists: boolean } {
  const realRoot = realpathSync(workspaceRoot);
  const given = path.resolve(realRoot, inputPath);
  const { existing, rest } = deepestExisting(given);
  if (rest.length === 0) {
    return { path: resolveWorkspaceWritePath(workspaceRoot, inputPath), exists: true };
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new WorkspacePathError(`路径上的 ${existing} 解析不了（悬空的符号链接？）：${inputPath}`);
  }
  if (!lstatSync(realExisting).isDirectory()) {
    throw new WorkspacePathError(`路径上的 ${existing} 不是目录：${inputPath}`);
  }
  const target = path.join(realExisting, ...rest);
  if (isOutsideRelative(path.relative(realRoot, target))) {
    throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
  }
  return { path: target, exists: false };
}

// 决策 358 照 334：新建前复核——路径上最深的已存在一层的真实路径须仍是它自己（没被换成符号链接），补建中间目录，
// 以"不存在才建"写入；检查之后被别人建了即拒写，不覆盖
export function createWorkspaceFile(resolvedPath: string, content: string): void {
  const { existing, rest } = deepestExisting(resolvedPath);
  if (rest.length === 0) {
    throw new WorkspaceWriteRefusedError(`文件在检查之后已被创建，未覆盖：${resolvedPath}`);
  }
  let now: string | undefined;
  try {
    now = realpathSync(existing);
  } catch {
    now = undefined;
  }
  if (now !== existing) {
    throw pathChanged(resolvedPath, now);
  }
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  try {
    writeFileSync(resolvedPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceWriteRefusedError(`文件在检查之后已被创建，未覆盖：${resolvedPath}`);
    }
    throw error;
  }
}
