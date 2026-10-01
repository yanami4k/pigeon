// 工作目录快照（决策 278、279 共用）：把工作目录的当前状态——受跟踪文件的当前内容，加上未跟踪且未被 .gitignore
// 忽略的新文件——写成一个以 HEAD 为父的提交，挂在 refs/pigeon/ 下的专用引用上，防止被 git 回收。沙箱开工（278）与
// 本机派 worker（279）都从它起步。做法沿用 078 的临时索引快照：复制用户索引为临时 GIT_INDEX_FILE（只为复用文件状态
// 缓存）→ add -A → 治理目录 .pigeon 还原到 HEAD 的样子 → write-tree → commit-tree → update-ref；用户的工作目录、
// 暂存区、当前分支与 HEAD 一律不碰。工作目录与 HEAD 没有差别时直接用 HEAD，不另建提交、不挂引用。
// 快照引用的清理由调用方在相应生命周期收尾时做（worker 分支删除、沙箱会话收尾）。git 经参数数组直接调用，不经 shell。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROGRAM_OWNED_PATHS } from "../state/paths.ts";

export class WorkdirSnapshotError extends Error {}

// 快照引用一律挂在这个前缀下
export const SNAPSHOT_REF_ROOT = "refs/pigeon/";

export interface WorkdirSnapshot {
  // 起点提交：有未提交改动时是快照提交，否则就是 HEAD
  commit: string;
  head: string;
  // 是否另建了快照提交
  snapshot: boolean;
  // 相对 HEAD 带入的未提交改动（仓库相对路径，升序；含新建与删除的文件）；没有快照时为空
  files: string[];
  // 快照提交挂的引用；没有快照时缺省
  ref?: string;
}

// 快照提交的作者身份固定，不依赖用户的 git 配置
const IDENTITY = {
  GIT_AUTHOR_NAME: "pigeon",
  GIT_AUTHOR_EMAIL: "pigeon@localhost",
  GIT_COMMITTER_NAME: "pigeon",
  GIT_COMMITTER_EMAIL: "pigeon@localhost",
};

// 列表类命令在大仓库里输出可达数十 MiB
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new WorkdirSnapshotError(`git ${args.join(" ")} 失败：${detail}`);
  }
}

// 仓库根（工作树的顶层目录）；不是 git 工作区即报错
export function repoToplevel(repoRoot: string): string {
  let top: string;
  try {
    top = git(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    throw new WorkdirSnapshotError(`不是 git 工作区，不能生成工作目录快照：${repoRoot}`, {
      cause: error,
    });
  }
  if (top === "") {
    throw new WorkdirSnapshotError(`不是 git 工作区，不能生成工作目录快照：${repoRoot}`);
  }
  return top;
}

// 工作目录当前的文件树（树对象号）：临时索引上 add -A，再把治理目录 .pigeon 还原到 HEAD 的样子（会话文件在变不算改动；
// 不能用排除路径写法——.pigeon 被 .gitignore 忽略时 git add 会因路径命中忽略项报错），然后 write-tree。
// 被 .gitignore 忽略的文件由 add -A 自然排除
export function workdirTree(top: string): string {
  const indexFile = join(tmpdir(), `pigeon-workdir-${randomBytes(8).toString("hex")}`);
  try {
    const realIndex = git(top, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]).trim();
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, indexFile);
      // 保留原索引文件的时间戳：git 把"改动时间不早于索引写入时间"的文件视为可能在同一秒内改过（racy git），会重新读内容比对；
      // 复制出来的索引若带新的时间戳，这层保护就没了——同一秒内改过、大小又没变的文件会被当成没改而漏出快照
      const stat = statSync(realIndex);
      utimesSync(indexFile, stat.atime, stat.mtime);
    }
    const env = { GIT_INDEX_FILE: indexFile };
    git(top, ["add", "-A", "--", "."], env);
    git(top, ["reset", "-q", "--", ...PROGRAM_OWNED_PATHS], env);
    return git(top, ["write-tree"], env).trim();
  } finally {
    rmSync(indexFile, { force: true });
  }
}

export function snapshotWorkdir(input: { repoRoot: string; ref: string }): WorkdirSnapshot {
  if (!input.ref.startsWith(SNAPSHOT_REF_ROOT) || input.ref.length <= SNAPSHOT_REF_ROOT.length) {
    throw new WorkdirSnapshotError(`快照引用须在 ${SNAPSHOT_REF_ROOT} 下：${input.ref}`);
  }
  const top = repoToplevel(input.repoRoot);
  let head: string;
  try {
    head = git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).trim();
  } catch {
    head = "";
  }
  if (head === "") {
    throw new WorkdirSnapshotError("仓库还没有提交，不能生成工作目录快照：请先提交一次");
  }
  const tree = workdirTree(top);
  const headTree = git(top, ["rev-parse", `${head}^{tree}`]).trim();
  if (tree === headTree) {
    // 没有未提交的改动：起点就是 HEAD。同名引用若是上次进程异常退出留下的，已无用，顺手删掉
    deleteSnapshotRef(top, input.ref);
    return { commit: head, head, snapshot: false, files: [] };
  }
  const files = git(top, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", headTree, tree])
    .split("\0")
    .filter((path) => path !== "")
    .sort();
  const commit = git(
    top,
    ["commit-tree", tree, "-p", head, "-m", "pigeon workdir snapshot"],
    IDENTITY
  ).trim();
  git(top, ["update-ref", input.ref, commit]);
  return { commit, head, snapshot: true, files, ref: input.ref };
}

// 删除快照引用；引用本就不存在也算删掉
export function deleteSnapshotRef(repoRoot: string, ref: string): void {
  if (!ref.startsWith(SNAPSHOT_REF_ROOT)) {
    throw new WorkdirSnapshotError(`只删 ${SNAPSHOT_REF_ROOT} 下的快照引用：${ref}`);
  }
  git(repoRoot, ["update-ref", "-d", ref]);
}

// 引用当前指向的提交；不存在返回 undefined
export function readSnapshotRef(repoRoot: string, ref: string): string | undefined {
  try {
    const commit = git(repoRoot, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).trim();
    return commit === "" ? undefined : commit;
  } catch {
    return undefined;
  }
}

// ---- 后台补做复盘的读取根（决策 283）：从退出快照或沙箱交回的提交检出临时工作树，用完删除 ----

// 提交在仓库里是否还在
export function commitExists(repoRoot: string, commit: string): boolean {
  try {
    git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// 本地分支的最新提交；分支不存在或不是 git 工作区返回 undefined
export function branchTip(repoRoot: string, branch: string): string | undefined {
  return readSnapshotRef(repoRoot, `refs/heads/${branch}`);
}

// 在 dir 检出 commit 的临时工作树（分离头指针，不建分支、不动当前分支与工作目录）
export function addDetachedWorktree(repoRoot: string, dir: string, commit: string): void {
  git(repoRoot, ["worktree", "add", "--detach", "--force", dir, commit]);
}

// 删除临时工作树：先按 git 的方式删，删不掉再直接删目录并清掉登记
export function removeWorktree(repoRoot: string, dir: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(repoRoot, ["worktree", "prune"]);
    } catch {
      // 登记没清掉只是多一条过期登记，git 之后会自行清理
    }
  }
}
