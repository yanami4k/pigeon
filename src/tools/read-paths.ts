// 读档工具（read_file、grep、glob）的路径解析（决策 355）：不限工作区，按符号链接解析后的真实路径判定落在工作区之内
// 还是之外——工作区外的读取怎样放行由 read_file 与治理层决定，grep、glob 只搜工作区之内。
// 本机取真实路径用系统的 realpath（realpathSync.native）：Windows 上把 8.3 短名、大小写与 \\?\ 前缀归一到同一写法；
// Windows 与 macOS 的缺省文件系统不分大小写，包含关系也不分大小写比较。设备前缀、UNC 与数据流的写法不另设规则，
// 照解析后的真实路径判工作区内外（决策 412）。
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { WorkspacePathError, WorkspacePathNotFoundError } from "./paths.ts";

// 读档的解析结果：path 为符号链接解析后的真实路径，outside 为它是否落在工作区根之外
export interface ReadTarget {
  path: string;
  outside: boolean;
}

// grep、glob 的结果逐条分类：落在工作区内、经链接落在工作区外
export type ReadPathClass = "ok" | "outside";

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

// 本机读档解析（不限工作区）：目标须存在
export function resolveLocalReadPath(workspaceRoot: string, inputPath: string): ReadTarget {
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
  return { path: realTarget, outside: !containedIn(realRoot, realTarget, LOCAL_PATH_RULES) };
}

// 一条结果的分类：真实路径落在工作区根之内为可读，否则为工作区外
export function classifyRealPath(
  realRoot: string,
  realTarget: string,
  rules: PathRules
): ReadPathClass {
  return containedIn(realRoot, realTarget, rules) ? "ok" : "outside";
}

// 结果分类：可读、经链接落在工作区外，另给各自的真实路径（grep -r 降级据此复核实际打开的文件）；取不到真实
// 路径的不在结果里。incomplete 为检查中途超时或中止，后面的没查到
export interface ReadPathClassification {
  classes: Map<string, ReadPathClass>;
  realPaths: Map<string, string>;
  incomplete: boolean;
}

// 一次并发检查的文件数
const CLASSIFY_BATCH = 64;

// 本机：grep、glob 的结果（相对工作区根的路径）逐个按真实路径分类——异步分批，每批之间看中止信号
export async function classifyLocalReadPaths(
  workspaceRoot: string,
  relPaths: readonly string[],
  signal?: AbortSignal
): Promise<ReadPathClassification> {
  const realRoot = await realpath(workspaceRoot);
  const classes = new Map<string, ReadPathClass>();
  const realPaths = new Map<string, string>();
  for (let start = 0; start < relPaths.length; start += CLASSIFY_BATCH) {
    if (signal?.aborted === true) {
      return { classes, realPaths, incomplete: true };
    }
    await Promise.all(
      relPaths.slice(start, start + CLASSIFY_BATCH).map(async (rel) => {
        let real: string;
        try {
          real = await realpath(path.join(realRoot, rel));
        } catch {
          return;
        }
        classes.set(rel, classifyRealPath(realRoot, real, LOCAL_PATH_RULES));
        realPaths.set(rel, real);
      })
    );
  }
  return { classes, realPaths, incomplete: false };
}
