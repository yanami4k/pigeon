// worker 结果叠加（决策 279）：只取 worker 相对起点快照自己的改动，以快照里的版本为共同祖先逐文件三方合并，写进主工作目录。
// 硬性规则：
//   ① 只写入 worker 改过的文件，worker 没碰的文件一律不动；
//   ② 不删除、不回退主工作目录里的任何文件——worker 删除的文件不自动删，只列出；主工作目录已删而 worker 改了的文件不写回；
//   ③ 不设撤销；
//   ④ 叠不上（主工作目录在同一处也改了、双方各自新建了内容不同的同名文件、二进制文件双方都改）即列为冲突，不写入
//      冲突的那部分，worker 的分支与工作树原样保留；
//   ⑤ 逐文件用 git merge-file 三方合并，不依赖主仓库的暂存区，也不用会因主工作目录有未提交改动而整体失败的做法。
// worker 的改动取它工作树的当前内容（可能未提交）：与快照同一种临时索引写成树对象，再与起点快照比对。
// 三方的内容都取 git 里经清理过滤后的样子，写回时经 cat-file --filters 还原成工作树形式（行尾转换等按仓库配置）。
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { repoToplevel, workdirTree } from "./workdir-snapshot.ts";

// 中途失败时带上已经写进去的部分（叠加不设撤销，调用方据此如实交代）
export class OverlayError extends Error {
  partial?: OverlayResult;
}

export interface OverlayInput {
  // 主仓库（叠进它的工作目录）；可以是仓库里的任一目录
  repoRoot: string;
  // worker 的起点快照提交（共同祖先）
  base: string;
  // worker 的工作树路径：改动取它的当前内容
  worktreePath: string;
}

export interface OverlayResult {
  // 已写进主工作目录的文件
  applied: string[];
  // 主工作目录本已与 worker 一致、无需写入的文件
  unchanged: string[];
  // 叠不上、未写入的文件
  conflicts: string[];
  // worker 删除的文件（主工作目录里未删）
  deletedByWorker: string[];
}

// 列表类命令在大仓库里输出可达数十 MiB
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function gitBuffer(cwd: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(input !== undefined ? { input } : {}),
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      Buffer.isBuffer(stderr) && stderr.length > 0
        ? stderr.toString("utf8").trim()
        : typeof stderr === "string" && stderr.trim() !== ""
          ? stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);
    throw new OverlayError(`git ${args.join(" ")} 失败：${detail}`);
  }
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return gitBuffer(cwd, args, input).toString("utf8").trim();
}

// 树里某路径的模式与对象号；不存在返回 undefined
function entryOf(
  top: string,
  tree: string,
  path: string
): { mode: string; blob: string } | undefined {
  const line = git(top, ["ls-tree", "-z", tree, "--", path]).replace(/\0$/, "");
  if (line === "") {
    return undefined;
  }
  const [meta = ""] = line.split("\t");
  const [mode = "", , blob = ""] = meta.split(" ");
  return { mode, blob };
}

// 二进制判定与 git 同一口径：开头 8000 字节里有 NUL
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

// 把 git 里的一个 blob 按仓库对该路径配置的过滤（行尾转换等）还原成工作树形式，写到主工作目录
function writeBlob(top: string, path: string, blob: string, target: string, mode: string): void {
  const content = gitBuffer(top, ["cat-file", "--filters", `--path=${path}`, blob]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode === "100755" && process.platform !== "win32") {
    chmodSync(target, 0o755);
  }
}

export function overlayWorkerChanges(input: OverlayInput): OverlayResult {
  const top = repoToplevel(input.repoRoot);
  const topResolved = resolve(top);
  const workerTree = workdirTree(repoToplevel(input.worktreePath));
  const base = git(top, ["rev-parse", "--verify", "-q", `${input.base}^{commit}`]);
  if (base === "") {
    throw new OverlayError(`起点快照不存在：${input.base}`);
  }
  const result: OverlayResult = { applied: [], unchanged: [], conflicts: [], deletedByWorker: [] };
  // worker 相对起点的改动：状态与路径成对，NUL 分隔
  const parts = git(top, [
    "diff-tree",
    "-r",
    "-z",
    "--name-status",
    "--no-renames",
    base,
    workerTree,
  ]).split("\0");
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index] ?? "";
    const path = parts[index + 1] ?? "";
    if (status === "" || path === "" || path === ".pigeon" || path.startsWith(".pigeon/")) {
      continue;
    }
    changes.push({ status: status.charAt(0), path });
  }
  const scratch = mkdtempSync(join(tmpdir(), "pigeon-overlay-"));
  try {
    applyChanges(top, topResolved, base, workerTree, changes, scratch, result);
  } catch (error) {
    const failure =
      error instanceof OverlayError
        ? error
        : new OverlayError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    failure.partial = sorted(result);
    throw failure;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return sorted(result);
}

function sorted(result: OverlayResult): OverlayResult {
  return {
    applied: [...result.applied].sort(),
    unchanged: [...result.unchanged].sort(),
    conflicts: [...result.conflicts].sort(),
    deletedByWorker: [...result.deletedByWorker].sort(),
  };
}

function applyChanges(
  top: string,
  topResolved: string,
  base: string,
  workerTree: string,
  changes: ReadonlyArray<{ status: string; path: string }>,
  scratch: string,
  result: OverlayResult
): void {
  for (const { status, path } of changes) {
    const target = resolve(top, path);
    if (!target.startsWith(topResolved + sep)) {
      throw new OverlayError(`worker 改动的路径越出仓库：${path}`);
    }
    if (status === "D") {
      // ② worker 删除的不自动删
      result.deletedByWorker.push(path);
      continue;
    }
    const theirs = entryOf(top, workerTree, path);
    if (theirs === undefined) {
      continue;
    }
    // 主工作目录里这个路径现在的样子
    let kind: "missing" | "file" | "other";
    try {
      const stat = lstatSync(target);
      kind = stat.isFile() ? "file" : "other";
    } catch {
      kind = "missing";
    }
    const ancestor = entryOf(top, base, path);
    // 符号链接、子模块、换了类型：不合并，列为冲突
    const special = (mode: string | undefined) =>
      mode !== undefined && mode !== "100644" && mode !== "100755";
    if (kind === "other" || special(theirs.mode) || special(ancestor?.mode)) {
      result.conflicts.push(path);
      continue;
    }
    if (ancestor === undefined) {
      // worker 新建的文件：主工作目录没有就写入；已有且内容相同视为一致，不同即冲突
      if (kind === "missing") {
        writeBlob(top, path, theirs.blob, target, theirs.mode);
        result.applied.push(path);
      } else if (git(top, ["hash-object", `--path=${path}`, "--", target]) === theirs.blob) {
        result.unchanged.push(path);
      } else {
        result.conflicts.push(path);
      }
      continue;
    }
    if (kind === "missing") {
      // ② 主工作目录已删掉的文件不写回（写回等于回退删除）
      result.conflicts.push(path);
      continue;
    }
    const ours = git(top, ["hash-object", `--path=${path}`, "--", target]);
    if (ours === theirs.blob) {
      result.unchanged.push(path);
      continue;
    }
    if (ours === ancestor.blob) {
      // 主工作目录自快照以来没改这个文件：直接取 worker 的版本
      writeBlob(top, path, theirs.blob, target, theirs.mode);
      result.applied.push(path);
      continue;
    }
    // ④⑤ 双方都改了：三方合并；二进制不合并。主工作目录的版本先入对象库（前面只算了哈希），三方都从 git 里取经清理过滤后的内容
    git(top, ["hash-object", "-w", `--path=${path}`, "--", target]);
    const oursContent = gitBuffer(top, ["cat-file", "blob", ours]);
    const baseContent = gitBuffer(top, ["cat-file", "blob", ancestor.blob]);
    const theirsContent = gitBuffer(top, ["cat-file", "blob", theirs.blob]);
    if (isBinary(oursContent) || isBinary(baseContent) || isBinary(theirsContent)) {
      result.conflicts.push(path);
      continue;
    }
    const oursFile = join(scratch, "ours");
    const baseFile = join(scratch, "base");
    const theirsFile = join(scratch, "theirs");
    writeFileSync(oursFile, oursContent);
    writeFileSync(baseFile, baseContent);
    writeFileSync(theirsFile, theirsContent);
    let merged: Buffer | undefined;
    try {
      merged = execFileSync(
        "git",
        [
          "merge-file",
          "-p",
          "-L",
          "工作目录",
          "-L",
          "起点快照",
          "-L",
          "worker",
          oursFile,
          baseFile,
          theirsFile,
        ],
        {
          cwd: top,
          maxBuffer: GIT_MAX_BUFFER,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }
      );
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      // 退出码为冲突数（1 到 127）：叠不上；其余是 merge-file 自身的故障
      if (typeof status === "number" && status > 0 && status <= 127) {
        result.conflicts.push(path);
        continue;
      }
      const stderr = (error as { stderr?: unknown }).stderr;
      throw new OverlayError(
        `合并 ${path} 失败：${Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(error)}`
      );
    }
    // 合并结果先入对象库再经过滤还原：写出来的行尾等与仓库配置一致
    const mergedBlob = git(top, ["hash-object", "-w", "--stdin", `--path=${path}`], merged);
    writeBlob(top, path, mergedBlob, target, theirs.mode);
    result.applied.push(path);
  }
}
