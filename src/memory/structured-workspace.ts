// 结构化记忆的工作区探针与题面文件解析（决策 133 / 135）：挑选、核验与派生共用。
// - 探针：文件在不在、读文件、版本历史里的改名追踪、事发以来的改动行数、受跟踪文件清单。git 查不到（不是 git 工作区、
//   命令失败）按"查不到"处理；git 子进程超时则抛 StructuredMemoryGitTimeoutError，由调用方按"这次不给"处理并告警。
// - 题面直接指到的文件：题面里出现的路径，加上题面所附代码中导入语句解析出的文件；路径先归一化，含 .. 或跑出工作区的丢弃，
//   只保留仓库里受跟踪的文件。不解析代码，导入语句按文本匹配。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { workspaceRelative } from "../state/structured-memory.ts";

// git 子进程的超时（毫秒）
export const STRUCTURED_MEMORY_GIT_TIMEOUT_MS = 30_000;

export class StructuredMemoryGitTimeoutError extends Error {}

// 执行一条 git 命令：失败返回 undefined（查不到）；超时抛错
export function runStructuredMemoryGit(
  root: string,
  args: string[],
  timeoutMs: number = STRUCTURED_MEMORY_GIT_TIMEOUT_MS
): string | undefined {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ETIMEDOUT") {
      throw new StructuredMemoryGitTimeoutError(
        `git ${args[0] ?? ""} 超过 ${timeoutMs} 毫秒未返回`
      );
    }
    return undefined;
  }
}

// 工作区的 git 查询（改名追踪、改动幅度、仓库文件清单）
export interface WorkspaceProbe {
  root: string;
  exists(file: string): boolean;
  read(file: string): string | undefined;
  // 事发以来（毫秒时间戳）这个文件被改名成了什么（沿改名链走到底）；没改过名返回原路径
  renamedSince(file: string, since: number): string;
  // 事发以来这个文件改了多少行（已提交的加未提交的）
  changedLinesSince(file: string, since: number): number;
  // 受跟踪的文件（相对工作区根、正斜杠）
  tracked(): ReadonlySet<string>;
}

function sinceArg(since: number): string {
  return `--since=@${Math.max(0, Math.floor(since / 1000) - 1)}`;
}

interface RenameRecord {
  // 提交时间（秒）
  at: number;
  from: string;
  to: string;
}

// options.run：git 执行器（缺省 runStructuredMemoryGit，测试注入）。本探针一旦遇到 git 超时即锁定：后续查询不再调用 git，
// 直接抛出同一个超时错误（按"取不到"处理），避免每轮回炉都同步阻塞、吃掉墙钟预算
export function workspaceProbe(
  root: string,
  options: { run?: (args: string[]) => string | undefined } = {}
): WorkspaceProbe {
  const run = options.run ?? ((args: string[]) => runStructuredMemoryGit(root, args));
  let timedOut: StructuredMemoryGitTimeoutError | undefined;
  const git = (args: string[]): string | undefined => {
    if (timedOut !== undefined) {
      throw timedOut;
    }
    try {
      return run(args);
    } catch (error) {
      if (error instanceof StructuredMemoryGitTimeoutError) {
        timedOut = error;
      }
      throw error;
    }
  };
  let trackedFiles: Set<string> | undefined;
  let renames: RenameRecord[] | undefined;
  // 版本历史里的全部改名（按时间正序），一次读出
  const renameLog = (): RenameRecord[] => {
    if (renames !== undefined) {
      return renames;
    }
    const collected: RenameRecord[] = [];
    let at = 0;
    const log = git([
      "log",
      "--reverse",
      "--diff-filter=R",
      "-M",
      "--name-status",
      "--relative",
      "--format=%x01%ct",
    ]);
    for (const line of (log ?? "").split(/\r?\n/)) {
      if (line.startsWith("\u0001")) {
        at = Number.parseInt(line.slice(1), 10) || 0;
        continue;
      }
      const [status, from, to] = line.split("\t");
      if (status?.startsWith("R") === true && from !== undefined && to !== undefined) {
        collected.push({ at, from, to });
      }
    }
    renames = collected;
    return renames;
  };
  const exists = (file: string): boolean => {
    const full = join(root, file);
    return existsSync(full) && statSync(full).isFile();
  };
  return {
    root,
    exists,
    read: (file) => (exists(file) ? readFileSync(join(root, file), "utf8") : undefined),
    renamedSince: (file, since) => {
      const floor = Math.floor(since / 1000) - 1;
      let current = file;
      for (const rename of renameLog()) {
        if (rename.at >= floor && rename.from === current) {
          current = rename.to;
        }
      }
      return current;
    },
    changedLinesSince: (file, since) => {
      const sum = (text: string | undefined): number =>
        (text ?? "")
          .split(/\r?\n/)
          .map((line) => line.split("\t"))
          .reduce(
            (total, [added, removed]) =>
              total +
              (Number.parseInt(added ?? "", 10) || 0) +
              (Number.parseInt(removed ?? "", 10) || 0),
            0
          );
      return (
        sum(git(["log", sinceArg(since), "--numstat", "--format=", "--", file])) +
        sum(git(["diff", "--numstat", "HEAD", "--", file]))
      );
    },
    tracked: () => {
      trackedFiles ??= new Set(
        (git(["ls-files", "--cached"]) ?? "")
          .split(/\r?\n/)
          .filter((file) => file !== "" && !file.startsWith(".pigeon/"))
      );
      return trackedFiles;
    },
  };
}

// ---- 题面指到的文件 ----

// 路径样的记号：可带盘符、ASCII 路径字符组成、以扩展名结尾；中文与标点天然断开记号
const PATH_TOKEN = /(?:\b[A-Za-z]:)?[\w@.\\/-]*[\w@-]\.[A-Za-z0-9]{1,8}/g;
const JS_IMPORT = [
  /\bfrom\s+["']([^"'\n]+)["']/g,
  /\bimport\s+["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const PY_FROM_IMPORT = /^\s*from\s+(\.*[\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface Mention {
  index: number;
  file: string;
}

// 路径归一化为相对工作区根的正斜杠路径；含 .. 段、仍是绝对路径（跑出工作区）或为空的返回 undefined
function insideWorkspace(file: string, root: string): string | undefined {
  const relative = workspaceRelative(file, root);
  if (relative === "" || /^([A-Za-z]:)?\//.test(relative) || relative.split("/").includes("..")) {
    return undefined;
  }
  const normalized = posix.normalize(relative);
  return normalized === "." || normalized.startsWith("../") ? undefined : normalized;
}

// 相对导入：以所附代码所在文件（题面里在它之前最近提到的那个文件）为基准；带扩展名的原样，不带的补常见扩展名与 index
function resolveRelative(
  tracked: ReadonlySet<string>,
  baseFile: string | undefined,
  spec: string
): string[] {
  const base = baseFile !== undefined ? posix.dirname(baseFile) : ".";
  const joined = posix.normalize(posix.join(base, spec));
  if (joined.startsWith("..")) {
    return [];
  }
  const candidates = [
    joined,
    ...JS_EXTENSIONS.map((extension) => `${joined}${extension}`),
    ...JS_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
    // TS 里 .js 后缀的导入指向同名 .ts
    ...(joined.endsWith(".js") ? [`${joined.slice(0, -3)}.ts`, `${joined.slice(0, -3)}.tsx`] : []),
  ];
  return candidates.filter((file) => tracked.has(file)).slice(0, 1);
}

// Python 点号模块：a.b.c → 仓库里以 a/b/c.py 或 a/b/c/__init__.py 结尾的文件（相对导入以基准文件所在目录起算）
function resolvePython(
  tracked: ReadonlySet<string>,
  baseFile: string | undefined,
  spec: string
): string[] {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const modulePath = spec
    .slice(dots)
    .split(".")
    .filter((part) => part !== "")
    .join("/");
  if (dots > 0) {
    let dir = baseFile !== undefined ? posix.dirname(baseFile) : ".";
    for (let level = 1; level < dots; level += 1) {
      dir = posix.dirname(dir);
    }
    const target = modulePath === "" ? dir : posix.join(dir, modulePath);
    return [`${target}.py`, `${target}/__init__.py`]
      .filter((file) => tracked.has(file))
      .slice(0, 1);
  }
  if (modulePath === "") {
    return [];
  }
  const suffixes = [`${modulePath}.py`, `${modulePath}/__init__.py`];
  return [...tracked].filter((file) =>
    suffixes.some((suffix) => file === suffix || file.endsWith(`/${suffix}`))
  );
}

// 题面直接指到的仓库内文件：出现的路径，加上所附代码里导入语句解析出的文件（按出现顺序、去重；只留受跟踪的）
// options.mentionedUntracked：题面直接写出的路径不要求当前受跟踪（派生认定题面测试时用——该文件事后可能已改名或删除，
// 宁可题面集合大、记得少）；开局挑选缺省只留受跟踪的
export function taskReferencedFiles(
  task: string,
  probe: WorkspaceProbe,
  options: { mentionedUntracked?: boolean } = {}
): string[] {
  const tracked = probe.tracked();
  const found: string[] = [];
  const add = (file: string, anyFile = false) => {
    if ((anyFile || tracked.has(file)) && !found.includes(file)) {
      found.push(file);
    }
  };
  // 提到的路径都可作所附代码的基准（题面附的测试文件在这一步开始时可能还不在仓库里）
  const mentions: Mention[] = [];
  for (const match of task.matchAll(PATH_TOKEN)) {
    const file = insideWorkspace(match[0], probe.root);
    if (file === undefined) {
      continue;
    }
    if (file.includes("/")) {
      mentions.push({ index: match.index ?? 0, file });
    }
    add(file, options.mentionedUntracked === true);
  }
  const baseAt = (index: number): string | undefined =>
    mentions.filter((mention) => mention.index < index).at(-1)?.file;
  for (const pattern of JS_IMPORT) {
    for (const match of task.matchAll(pattern)) {
      const spec = match[1] ?? "";
      if (spec.startsWith(".")) {
        for (const file of resolveRelative(tracked, baseAt(match.index ?? 0), spec)) {
          add(file);
        }
      } else {
        const file = insideWorkspace(spec, probe.root);
        if (file !== undefined) {
          add(file);
        }
      }
    }
  }
  for (const match of task.matchAll(PY_FROM_IMPORT)) {
    for (const file of resolvePython(tracked, baseAt(match.index ?? 0), match[1] ?? "")) {
      add(file);
    }
  }
  for (const match of task.matchAll(PY_IMPORT)) {
    for (const spec of (match[1] ?? "").split(",")) {
      for (const file of resolvePython(tracked, baseAt(match.index ?? 0), spec.trim())) {
        add(file);
      }
    }
  }
  return found;
}
