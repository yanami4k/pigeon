// worker 工具的作用范围（决策 360）：派 worker 时可给某件工具附加范围，只能比派出方更窄——文件类工具限路径（相对 worker
// 工作树的根，目录含其下全部），跑命令限命令前缀。本模块是可附加范围的工具登记表与判定本身：范围的规整、范围之间的包含、
// 派出时范围路径是否经过符号链接、一次调用是否越界。
// 路径的判定：调用目标解析成真实路径（含符号链接），须落在范围路径的字面位置之内（只把工作树根取真实路径，范围路径本身不解析）。
// 派出时范围路径自身或其上级是符号链接即拒，故范围路径都是真实路径；worker 事后建或改符号链接也绕不出范围（代价：范围路径
// 要写真实路径）。路径上有悬空的符号链接即越界。
// 派出参数的校验在 orchestration/roles.ts，逐调用的拒绝在治理层（application/governance.ts）。
// 命令前缀按词比对，且只放行不经 shell 的单条命令：管道、重定向、串联、命令替换与换行一律越界，免得用 ; && | 把别的命令接在
// 合规的开头后面。
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ToolScope } from "../state/session-payloads.ts";
import { GLOB_TOOL } from "./glob.ts";
import { GREP_TOOL } from "./grep.ts";
import { isOutsideRelative } from "./paths.ts";
import { type CommandInspection, parseCommandLine, RUN_COMMAND_TOOL } from "./run-command.ts";

// 可附加作用范围的工具登记表：工具名 → 范围种类（paths 限路径或目录，commandPrefixes 限命令前缀）。
// 派出参数的校验、spawn_worker 的说明与报错里的清单都从这里取；write_file（限路径）、grep 与 glob（限目录）合并后各加一行
export const SCOPABLE_TOOLS: Readonly<Record<string, "paths" | "commandPrefixes">> = {
  read_file: "paths",
  edit_file: "paths",
  // 决策 360：读类限目录——grep、glob 按 path 参数判定（不给 path 即越界）
  [GREP_TOOL]: "paths",
  [GLOB_TOOL]: "paths",
  [RUN_COMMAND_TOOL]: "commandPrefixes",
};

export function scopeKindOf(tool: string): "paths" | "commandPrefixes" | undefined {
  return Object.hasOwn(SCOPABLE_TOOLS, tool) ? SCOPABLE_TOOLS[tool] : undefined;
}

// 范围路径规整成相对工作树根的正斜杠形式（根为 "."）；绝对路径、盘符开头与含 .. 的给 undefined
export function normalizeScopePath(input: string): string | undefined {
  const unified = input.trim().replaceAll("\\", "/");
  if (
    unified === "" ||
    unified.startsWith("/") ||
    /^[A-Za-z]:/.test(unified) ||
    unified.split("/").includes("..")
  ) {
    return undefined;
  }
  const normal = path.posix.normalize(unified).replace(/\/+$/, "");
  return normal === "" ? "." : normal;
}

// 命令前缀切成词（与 run_command 同一切分规则）；含换行或 shell 语法、引号未闭合、为空的给 undefined
export function commandPrefixWords(prefix: string): string[] | undefined {
  if (/[\r\n]/.test(prefix)) {
    return undefined;
  }
  try {
    return parseCommandLine(prefix);
  } catch {
    return undefined;
  }
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, index) => words[index] === word);
}

// inner 是否不比 outer 宽（同一件工具的两份范围，嵌套派出时用）：路径逐条落在 outer 某条之内，前缀逐条以 outer 某条开头
export function scopeWithin(inner: ToolScope, outer: ToolScope): boolean {
  if (outer.paths !== undefined) {
    const outerPaths = outer.paths;
    return (
      inner.paths !== undefined &&
      inner.commandPrefixes === undefined &&
      inner.paths.every((child) =>
        outerPaths.some(
          (parent) => parent === "." || child === parent || child.startsWith(`${parent}/`)
        )
      )
    );
  }
  if (outer.commandPrefixes !== undefined) {
    const outerWords = outer.commandPrefixes.map((prefix) => commandPrefixWords(prefix) ?? []);
    return (
      inner.commandPrefixes !== undefined &&
      inner.paths === undefined &&
      inner.commandPrefixes.every((prefix) => {
        const words = commandPrefixWords(prefix);
        return (
          words !== undefined &&
          outerWords.some((parent) => parent.length > 0 && startsWithWords(words, parent))
        );
      })
    );
  }
  return true;
}

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// 真实路径：目标还不存在时取最近一级存在的上级的真实路径再接上其余部分（如将要新建的文件）；
// 路径上有悬空的符号链接（在却解析不了）或解析出别的错，给 undefined
function realOf(target: string): string | undefined {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch (error) {
      const parent = path.dirname(current);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        exists(current) ||
        parent === current
      ) {
        return undefined;
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// 路径是否落在范围内：目标的真实路径落在某条范围路径的字面位置之内（win32 下 path.relative 不分大小写）
export function pathWithinScope(
  workspaceRoot: string,
  scopePaths: readonly string[],
  inputPath: string
): boolean {
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    return false;
  }
  const target = realOf(path.resolve(root, inputPath));
  return (
    target !== undefined &&
    scopePaths.some((scope) => !isOutsideRelative(path.relative(path.resolve(root, scope), target)))
  );
}

// 派出时查范围路径：自身或某一级上级是符号链接时给出拒绝理由（指向工作树内即写明真实路径），否则 undefined
export function scopePathLinkProblem(workspaceRoot: string, scopePath: string): string | undefined {
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    return undefined;
  }
  let current = root;
  for (const part of scopePath === "." ? [] : scopePath.split("/")) {
    current = path.join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return undefined;
    }
    if (isLink) {
      const real = realOf(path.join(root, scopePath));
      const relative = real !== undefined ? path.relative(root, real) : undefined;
      if (relative === undefined || isOutsideRelative(relative)) {
        return `范围路径 ${scopePath} 经符号链接指向工作树之外或不存在的位置，不能用作作用范围`;
      }
      const target = relative === "" ? "." : relative.replaceAll("\\", "/");
      return `范围路径 ${scopePath} 经符号链接指向 ${target}，请改用真实路径 ${target}`;
    }
  }
  return undefined;
}

// 一次调用越出作用范围时给出拒绝理由（原样交给模型）；在范围内给 undefined。
// 文件类工具看 path 参数，跑命令看治理层的只读检查结果
export function scopeViolation(
  scope: ToolScope,
  call: { workspaceRoot?: string; args: unknown; inspection?: CommandInspection }
): string | undefined {
  if (scope.paths !== undefined) {
    const target = (call.args as { path?: unknown } | null)?.path;
    const allowed = scope.paths.join("、");
    if (typeof target !== "string" || target === "") {
      return `本 worker 的 ${scope.tool} 限定了作用范围（${allowed}），调用须给出其中的 path`;
    }
    if (
      call.workspaceRoot === undefined ||
      !pathWithinScope(call.workspaceRoot, scope.paths, target)
    ) {
      return `路径 ${target} 不在本 worker 的 ${scope.tool} 作用范围内：只能用于 ${allowed} 之内`;
    }
    return undefined;
  }
  if (scope.commandPrefixes !== undefined) {
    const inspection = call.inspection;
    // 本就执行不了的（如只按 PATH 找不到程序、引号未闭合）交回原因
    if (inspection?.mode === "invalid" && inspection.error !== undefined) {
      return inspection.error;
    }
    const words = scope.commandPrefixes.map((prefix) => commandPrefixWords(prefix) ?? []);
    const single =
      inspection !== undefined &&
      (inspection.mode === "direct" || inspection.mode === "launcher") &&
      !/[\r\n]/.test(inspection.command) &&
      inspection.argv !== undefined;
    const argv = single ? (inspection.argv ?? []) : [];
    if (single && words.some((prefix) => prefix.length > 0 && startsWithWords(argv, prefix))) {
      return undefined;
    }
    return (
      `命令不在本 worker 的 ${scope.tool} 作用范围内：只能运行以${scope.commandPrefixes.map((prefix) => `「${prefix}」`).join("、")}开头、` +
      "不经 shell 的单条命令（不能含管道、重定向、串联、命令替换或换行）"
    );
  }
  return undefined;
}

// worker 系统提示里交代作用范围的一句；没有范围给空串
export function scopePromptSentence(scopes: readonly ToolScope[]): string {
  const parts = scopes.flatMap((scope) =>
    scope.paths !== undefined
      ? [`${scope.tool} 只能用于 ${scope.paths.join("、")} 之内的路径`]
      : scope.commandPrefixes !== undefined
        ? [
            `${scope.tool} 只能运行以${scope.commandPrefixes.map((prefix) => `「${prefix}」`).join("、")}开头、不经 shell 的单条命令`,
          ]
        : []
  );
  return parts.length > 0
    ? `部分工具限定了作用范围，超出的调用会被拒绝：${parts.join("；")}。`
    : "";
}
