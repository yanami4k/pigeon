// worker 工作树管理（M5.5 S1，决策 040）：隔离工作区第一版为 git 工作树。
// 目录 <治理根>/.pigeon/worktrees/<sessionId>-<name>（带会话编号：两个窗口的同名 worker 不撞目录），
// 分支 pigeon/<name>（同名分支已存在时由 git 响亮拒绝）。git 经参数数组直接调用，不经 shell；
// 名字先按白名单校验再进参数，杜绝被当成选项或路径穿越。合并由人用 git 完成，本模块不合并。
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
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
  // 主仓库根（= 治理根）
  repoRoot: string;
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
  const path = worktreePathFor(input.repoRoot, input.sessionId, input.name);
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
