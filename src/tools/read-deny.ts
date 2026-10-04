// 读档禁读名单（决策 355）：凭据所在的目录与文件，读档工具（read_file、grep、glob）一律不读——放手模式不例外，
// 工作区内外都不例外（工作区是家目录或它的上级时，~/.ssh 就在工作区内）。
// 判定按符号链接解析后的真实路径：目标的真实路径等于某一项或落在其下即拒；每一项取展开 ~ 后的字面路径，
// 它存在时另取其真实路径（~/.ssh 本身是符号链接时，指向处同样禁读）。~ 按执行端的家目录展开（容器里是容器内的家目录）。
// 本机取真实路径用系统的 realpath（realpathSync.native）：Windows 上把 8.3 短名、大小写与 \\?\ 前缀归一到同一写法；
// Windows 与 macOS 的缺省文件系统不分大小写，包含关系也不分大小写比较。Windows 上设备前缀（\\?\、\\.\）与
// 数据流（name:stream、::$DATA）的写法不经解析直接拒绝。
// 名单写成一处常量；设置的 permissions.readDeny 只能往上追加，不能删减。
// 只管读档工具：run_command 经 shell 读文件不在此列（由命令审批把关）。已知限制：硬链接指向同一文件、路径却不同，
// 无法一般地识别。
import { realpathSync } from "node:fs";
import path from "node:path";
import { SETTINGS_FILE, userPigeonRel } from "../state/paths.ts";
import { WorkspacePathError, WorkspacePathNotFoundError } from "./paths.ts";

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

// Windows 的设备前缀或数据流写法：不经解析直接拒读
export class UnsupportedPathFormError extends WorkspacePathError {}

// 读档的解析结果：path 为符号链接解析后的真实路径，outside 为它是否落在工作区根之外
export interface ReadTarget {
  path: string;
  outside: boolean;
}

// grep、glob 的结果逐条分类：可读、落在工作区外、禁读
export type ReadPathClass = "ok" | "outside" | "denied";

// 生效的名单：内置在前，设置追加的在后，去重
export function readDenyList(extra: readonly string[] = []): string[] {
  return [...new Set([...BUILTIN_READ_DENY, ...extra])];
}

// 路径的比较口径：执行端的路径写法与是否不分大小写
export interface PathRules {
  p: path.PlatformPath;
  insensitive: boolean;
}

// 本机：Windows 与 macOS 不分大小写（两者缺省的文件系统如此）
export const LOCAL_PATH_RULES: PathRules = {
  p: path,
  insensitive: process.platform === "win32" || process.platform === "darwin",
};

// 容器：Linux，区分大小写
export const POSIX_PATH_RULES: PathRules = { p: path.posix, insensitive: false };

// child 等于 parent 或落在其下
export function containedIn(parent: string, child: string, rules: PathRules): boolean {
  const fold = (value: string) => (rules.insensitive ? value.toLowerCase() : value);
  const rel = rules.p.relative(fold(parent), fold(child));
  return (
    rel === "" || !(rel === ".." || rel.startsWith(`..${rules.p.sep}`) || rules.p.isAbsolute(rel))
  );
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

// 判定：target（真实路径）落在哪一项之内；不在名单里返回 undefined
export function deniedEntry(
  target: string,
  resolved: readonly ResolvedDenyEntry[],
  rules: PathRules
): string | undefined {
  for (const { entry, paths } of resolved) {
    if (paths.some((candidate) => containedIn(candidate, target, rules))) {
      return entry;
    }
  }
  return undefined;
}

export function readDeniedMessage(inputPath: string, entry: string): string {
  return `禁读：${inputPath} 落在凭据位置 ${entry} 之内，读档工具一律不读（决策 355）`;
}

// Windows 上不经解析直接拒绝的写法：设备前缀（\\?\、\\.\、\??\，正反斜杠都算）与数据流（盘符之后再出现冒号）
export function unsupportedWindowsPathForm(inputPath: string): boolean {
  if (/^[\\/]{2}[?.][\\/]/.test(inputPath) || /^[\\/]\?\?[\\/]/.test(inputPath)) {
    return true;
  }
  return (/^[A-Za-z]:/.test(inputPath) ? inputPath.slice(2) : inputPath).includes(":");
}

function realpathOrUndefined(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

// 本机：各项的候选路径
export function resolveDenyEntriesLocal(
  entries: readonly string[],
  home: string
): ResolvedDenyEntry[] {
  return entries.map((entry) => {
    const literal = expandDenyEntry(entry, home, path);
    const real = realpathOrUndefined(literal);
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
  if (process.platform === "win32" && unsupportedWindowsPathForm(inputPath)) {
    throw new UnsupportedPathFormError(`不支持的路径写法（设备前缀或数据流）：${inputPath}`);
  }
  const realRoot = realpathSync.native(workspaceRoot);
  let realTarget: string;
  try {
    realTarget = realpathSync.native(path.resolve(realRoot, inputPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code === "ENOENT" || code === "ENOTDIR"
      ? new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`)
      : new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
  }
  const entry = deniedEntry(realTarget, resolveDenyEntriesLocal(deny, home), LOCAL_PATH_RULES);
  if (entry !== undefined) {
    throw new ReadDeniedError(readDeniedMessage(inputPath, entry));
  }
  return { path: realTarget, outside: !containedIn(realRoot, realTarget, LOCAL_PATH_RULES) };
}

// 一条结果的分类：先看禁读（落在工作区外的禁读也记禁读），再看是否落在工作区外
export function classifyRealPath(
  realRoot: string,
  realTarget: string,
  entries: readonly ResolvedDenyEntry[],
  rules: PathRules
): ReadPathClass {
  if (deniedEntry(realTarget, entries, rules) !== undefined) {
    return "denied";
  }
  return containedIn(realRoot, realTarget, rules) ? "ok" : "outside";
}

// 本机：grep、glob 的结果（相对工作区根的路径）逐条按真实路径分类；取不到真实路径的（已删除）不在结果里
export function classifyLocalReadPaths(
  workspaceRoot: string,
  relPaths: readonly string[],
  deny: readonly string[],
  home: string
): Map<string, ReadPathClass> {
  const realRoot = realpathSync.native(workspaceRoot);
  const entries = resolveDenyEntriesLocal(deny, home);
  const classes = new Map<string, ReadPathClass>();
  for (const rel of relPaths) {
    const real = realpathOrUndefined(path.join(realRoot, rel));
    if (real !== undefined) {
      classes.set(rel, classifyRealPath(realRoot, real, entries, LOCAL_PATH_RULES));
    }
  }
  return classes;
}
