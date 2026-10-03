// 读档禁读名单（决策 355）：凭据所在的目录与文件，读档工具（read_file、grep、glob）一律不读——放手模式不例外，
// 工作区内外都不例外（工作区是家目录或它的上级时，~/.ssh 就在工作区内）。
// 判定按符号链接解析后的真实路径：目标的真实路径等于某一项或落在其下即拒；每一项取展开 ~ 后的字面路径，
// 它存在时另取其真实路径（~/.ssh 本身是符号链接时，指向处同样禁读）。~ 按执行端的家目录展开（容器里是容器内的家目录）。
// 名单写成一处常量；设置的 permissions.readDeny 只能往上追加，不能删减。
// 只管读档工具：run_command 经 shell 读文件不在此列（由命令审批把关）。
import { realpathSync } from "node:fs";
import path from "node:path";
import { SETTINGS_FILE, userPigeonRel } from "../state/paths.ts";
import { isOutsideRelative, WorkspacePathError, WorkspacePathNotFoundError } from "./paths.ts";

export const BUILTIN_READ_DENY: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  // Pigeon 自己存放凭据之处：用户级设置——mcp 一节里服务的 env 可能带令牌（key 本身只走环境变量）
  userPigeonRel(SETTINGS_FILE),
];

// 落在禁读名单里：读档工具拒读（路径围栏错误的一种，归模型侧的域错误）
export class ReadDeniedError extends WorkspacePathError {}

// 读档的解析结果：path 为符号链接解析后的真实路径，outside 为它是否落在工作区根之外
export interface ReadTarget {
  path: string;
  outside: boolean;
}

// 生效的名单：内置在前，设置追加的在后，去重
export function readDenyList(extra: readonly string[] = []): string[] {
  return [...new Set([...BUILTIN_READ_DENY, ...extra])];
}

// 一项展开 ~ 后的字面路径
export function expandDenyEntry(entry: string, home: string, p: path.PlatformPath): string {
  if (entry === "~") {
    return home;
  }
  return /^~[/\\]/.test(entry) ? p.join(home, entry.slice(2)) : p.normalize(entry);
}

// 一项及其候选路径（字面路径与存在时的真实路径）
export interface ResolvedDenyEntry {
  entry: string;
  paths: readonly string[];
}

// 判定：target（真实路径）落在哪一项之内；不在名单里返回 undefined。p 为执行端的路径口径（容器为 posix，
// win32 下 relative 不区分大小写）
export function deniedEntry(
  target: string,
  resolved: readonly ResolvedDenyEntry[],
  p: path.PlatformPath
): string | undefined {
  for (const { entry, paths } of resolved) {
    for (const candidate of paths) {
      const rel = p.relative(candidate, target);
      if (rel === "" || !(rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel))) {
        return entry;
      }
    }
  }
  return undefined;
}

export function readDeniedMessage(inputPath: string, entry: string): string {
  return `禁读：${inputPath} 落在凭据位置 ${entry} 之内，读档工具一律不读（决策 355）`;
}

// 本机：各项的候选路径
export function resolveDenyEntriesLocal(
  entries: readonly string[],
  home: string
): ResolvedDenyEntry[] {
  return entries.map((entry) => {
    const literal = expandDenyEntry(entry, home, path);
    let real: string | undefined;
    try {
      real = realpathSync(literal);
    } catch {
      real = undefined;
    }
    return { entry, paths: real !== undefined && real !== literal ? [literal, real] : [literal] };
  });
}

// 本机读档解析（不限工作区）：目标须存在；禁读即抛 ReadDeniedError
export function resolveLocalReadPath(
  workspaceRoot: string,
  inputPath: string,
  deny: readonly string[],
  home: string
): ReadTarget {
  const realRoot = realpathSync(workspaceRoot);
  let realTarget: string;
  try {
    realTarget = realpathSync(path.resolve(realRoot, inputPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code === "ENOENT" || code === "ENOTDIR"
      ? new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`)
      : new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
  }
  const entry = deniedEntry(realTarget, resolveDenyEntriesLocal(deny, home), path);
  if (entry !== undefined) {
    throw new ReadDeniedError(readDeniedMessage(inputPath, entry));
  }
  return { path: realTarget, outside: isOutsideRelative(path.relative(realRoot, realTarget)) };
}

// 名单里落在工作区根之内的部分：相对工作区根的路径（正斜杠）；grep、glob 据此滤掉结果。
// 工作区根本身落在某一项之内时为 ["."]（整片禁读）
export function denyWithinRoot(
  realRoot: string,
  resolved: readonly ResolvedDenyEntry[],
  p: path.PlatformPath
): string[] {
  if (deniedEntry(realRoot, resolved, p) !== undefined) {
    return ["."];
  }
  const within = new Set<string>();
  for (const { paths } of resolved) {
    for (const candidate of paths) {
      const rel = p.relative(realRoot, candidate);
      if (rel !== "" && !(rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel))) {
        within.add(rel.split(p.sep).join("/"));
      }
    }
  }
  return [...within];
}

// 相对路径（正斜杠）是否落在某个禁读前缀之下（含其本身；"." 为整片）
export function underDeniedPrefix(relPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || relPath === prefix || relPath.startsWith(`${prefix}/`)
  );
}
