// worker 工作树管理（M5.5 S1，决策 040）：隔离工作区第一版为 git 工作树。
// 目录 <治理根>/.pigeon/worktrees/<sessionId>-<name>（带会话编号：两个窗口的同名 worker 不撞目录），
// 分支 pigeon/<name>（同名分支已存在时由 git 响亮拒绝）。git 经参数数组直接调用，不经 shell；
// 名字先按白名单校验再进参数，杜绝被当成选项或路径穿越。合并由人用 git 完成，本模块不合并。
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { SessionId } from "../state/ids.ts";

export class WorktreeError extends Error {}

// worker 名：小写字母数字开头，小写字母数字与连字符，最长 40
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WorktreeHandle {
  name: string;
  sessionId: SessionId;
  path: string;
  branch: string;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  // 短分支名（去掉 refs/heads/）；分离头指针时缺省
  branch?: string;
}

export function assertWorkerName(name: string): void {
  if (!WORKER_NAME.test(name)) {
    throw new WorktreeError(
      `worker 名不合法：${JSON.stringify(name)}（小写字母数字开头，只含小写字母数字与连字符，最长 40）`
    );
  }
}

export function worktreePathFor(
  governanceRoot: string,
  sessionId: SessionId,
  name: string
): string {
  return join(governanceRoot, ".pigeon", "worktrees", `${sessionId}-${name}`);
}

export function worktreeBranchFor(name: string): string {
  return `pigeon/${name}`;
}

export interface AddWorktreeInput {
  // 主仓库根：工作树与分支建在它上面
  repoRoot: string;
  // M6.5 S2（决策 057）：工作树目录所在的治理根（放在其 .pigeon/worktrees 下）；缺省同仓库根（主会话派 worker）。
  // Eval 的治理根是输出目录，与仓库根分开
  governanceRoot?: string;
  sessionId: SessionId;
  name: string;
  // 起点提交；缺省 HEAD
  baseRef?: string;
}

export function addWorktree(input: AddWorktreeInput): WorktreeHandle {
  assertWorkerName(input.name);
  const baseRef = input.baseRef ?? "HEAD";
  if (baseRef.startsWith("-")) {
    throw new WorktreeError(`起点提交不合法：${baseRef}`);
  }
  const path = worktreePathFor(input.governanceRoot ?? input.repoRoot, input.sessionId, input.name);
  const branch = worktreeBranchFor(input.name);
  runGit(input.repoRoot, ["worktree", "add", "-b", branch, path, baseRef]);
  return { name: input.name, sessionId: input.sessionId, path, branch };
}

export function removeWorktree(input: { repoRoot: string; path: string; force?: boolean }): void {
  runGit(input.repoRoot, [
    "worktree",
    "remove",
    ...(input.force === true ? ["--force"] : []),
    resolve(input.path),
  ]);
}

// 删除 worker 分支（M6.5 S2：Eval 每次运行收尾清理工作树与分支）；只接受 pigeon/<合法 worker 名>
export function deleteBranch(input: { repoRoot: string; branch: string }): void {
  const name = input.branch.startsWith("pigeon/") ? input.branch.slice("pigeon/".length) : "";
  assertWorkerName(name);
  runGit(input.repoRoot, ["branch", "-D", input.branch]);
}

// 路径所在仓库的主仓库根（M6.5 S2：任务 repo 为 "." 时）——从工作树里调用同样返回主检出，
// 工作树与分支都建在主仓库上
export function mainRepoRoot(path: string): string {
  const commonDir = runGit(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  return dirname(resolve(commonDir));
}

// 路径所在仓库的 HEAD 短号与工作区是否有未提交改动（决策 061：Eval 结果行记 harness 版本；忽略文件不计）
export function describeHead(path: string): { commit: string; dirty: boolean } {
  const commit = runGit(path, ["rev-parse", "--short", "HEAD"]).trim();
  const dirty = runGit(path, ["status", "--porcelain"]).trim() !== "";
  return { commit, dirty };
}

// git worktree list --porcelain：空行分隔的块，每块 worktree / HEAD / branch|detached 行
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice("worktree ".length)) };
      entries.push(current);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

// 工作树内改动清单（工作树相对路径，含未跟踪文件，升序）：git status --porcelain -z；
// 改名与复制条目的原路径占下一段，跳过
export function changedFiles(worktreePath: string): string[] {
  const output = runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = new Set<string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length < 4) {
      continue;
    }
    files.add(part.slice(3));
    if (part.startsWith("R") || part.startsWith("C")) {
      index += 1;
    }
  }
  return [...files].sort();
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new WorktreeError(`git ${args.join(" ")} 失败：${detail}`);
  }
}
