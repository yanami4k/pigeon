// 工作目录快照（决策 278、279 共用）：把工作目录的当前状态——受跟踪文件的当前内容，加上未跟踪且未被 .gitignore
// 忽略的新文件——写成一个以 HEAD 为父的提交，挂在 refs/pigeon/ 下的专用引用上，防止被 git 回收。沙箱开工（278）与
// 本机派 worker（279）都从它起步。做法沿用 078 的临时索引快照：复制用户索引为临时 GIT_INDEX_FILE（只为复用文件状态
// 缓存）→ add -A → 程序状态 .pigeon/state 与个人设置 .pigeon/settings.local.json 还原到 HEAD 的样子（决策 325），仓库没跟踪的 .pigeon/.gitignore 撤出 → write-tree → commit-tree → update-ref；用户的工作目录、
// 暂存区、当前分支与 HEAD 一律不碰。工作目录与 HEAD 没有差别时直接用 HEAD，不另建提交、不挂引用。
// 快照引用的清理由调用方在相应生命周期收尾时做（worker 分支删除、沙箱会话收尾）。git 经参数数组直接调用，不经 shell。
// 决策 381：未跟踪且未被忽略的文件按 snapshot 一节的上限挑出过大的，不暂存、不进树，跳过清单随结果交回（已跟踪的照常收）。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProgramOwnedPath, PIGEON_GITIGNORE_REL, PROGRAM_OWNED_PATHS } from "../state/paths.ts";
import {
  DEFAULT_UNTRACKED_LIMITS,
  type SkippedFile,
  type UntrackedLimits,
} from "../state/snapshot-config.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import { addPathspecFile, oversizedUntracked, pathspecFileArgs } from "../tools/untracked-files.ts";

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
  // 决策 381：过大而没进快照的未跟踪文件（路径相对仓库根）
  skipped: SkippedFile[];
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

// 加固过的 git（tools/git-hardening.ts：不跑 fsmonitor、钩子与 .gitattributes 指派的过滤）
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", [...hardenedGitArgs(cwd), ...args], {
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
// 被 .gitignore 忽略的文件由 add -A 自然排除；过大的未跟踪文件（381）经路径规格排除，跳过清单一并交回
export function workdirTree(
  top: string,
  limits: UntrackedLimits = DEFAULT_UNTRACKED_LIMITS
): { tree: string; skipped: SkippedFile[] } {
  const indexFile = join(tmpdir(), `pigeon-workdir-${randomBytes(8).toString("hex")}`);
  let specFile: string | undefined;
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
    // 程序写出的 .pigeon/.gitignore（仓库没跟踪：用户索引里没有）不带进快照——否则随沙箱与 worker 的分支交回，
    // 合并时与主工作目录里同名的未跟踪文件相撞；仓库跟踪着的是项目内容，照常带
    const gitignoreTracked =
      git(top, ["ls-files", "--cached", "--", PIGEON_GITIGNORE_REL], env).trim() !== "";
    // 未跟踪与否按用户的索引判定（不带临时索引）；程序状态本就撤出，不计入
    let skipped: SkippedFile[];
    try {
      skipped = oversizedUntracked(top, limits, { drop: isProgramOwnedPath });
    } catch (error) {
      throw new WorkdirSnapshotError(
        `列出未跟踪文件失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    specFile = skipped.length > 0 ? addPathspecFile(skipped) : undefined;
    git(
      top,
      ["add", "-A", ...(specFile !== undefined ? pathspecFileArgs(specFile) : ["--", "."])],
      env
    );
    git(top, ["reset", "-q", "--", ...PROGRAM_OWNED_PATHS], env);
    if (!gitignoreTracked) {
      git(top, ["rm", "-q", "--cached", "--ignore-unmatch", "--", PIGEON_GITIGNORE_REL], env);
    }
    return { tree: git(top, ["write-tree"], env).trim(), skipped };
  } finally {
    rmSync(indexFile, { force: true });
    if (specFile !== undefined) rmSync(specFile, { force: true });
  }
}

export function snapshotWorkdir(input: {
  repoRoot: string;
  ref: string;
  // 决策 381：未跟踪文件的上限（缺省取产品缺省）
  limits?: UntrackedLimits;
}): WorkdirSnapshot {
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
  const { tree, skipped } = workdirTree(top, input.limits);
  const headTree = git(top, ["rev-parse", `${head}^{tree}`]).trim();
  if (tree === headTree) {
    // 没有未提交的改动：起点就是 HEAD。同名引用若是上次进程异常退出留下的，已无用，顺手删掉
    deleteSnapshotRef(top, input.ref);
    return { commit: head, head, snapshot: false, files: [], skipped };
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
  return { commit, head, snapshot: true, files, ref: input.ref, skipped };
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
