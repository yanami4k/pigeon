// 工作区快照（M7 S5，决策 078）：只在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交——
// 临时 GIT_INDEX_FILE（以用户索引为起点复制一份，只为复用文件状态缓存）→ add -A → write-tree → commit-tree → update-ref，
// 挂到 refs/pigeon/checkpoints/<会话>/<序号>。用户的工作区、暂存区、当前分支与 HEAD 一律不碰；
// 治理目录 .pigeon 不进快照（会话文件在变不算文件改变）。快照成链：首个快照的父提交是改前基线（首次改动之前的
// 工作区状态），之后每个快照的父提交是上一个快照。分叉时从分叉点之前最近的快照开独立工作树（见 S6）。
// 非 git 工作区不打快照；构造快照器即明确报错，不降级。git 经参数数组直接调用，不经 shell。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "../state/ids.ts";

export const CHECKPOINT_REF_PREFIX = "refs/pigeon/checkpoints/";

export class NotGitWorkspaceError extends Error {}
export class CheckpointError extends Error {}

export interface CheckpointResult {
  ref: string;
  commit: string;
  tree: string;
  // 只有会话的首个快照带：首次改动之前的工作区状态
  baseCommit?: string;
}

export interface Checkpointer {
  // 写或命令工具执行前调用：会话首次改动之前记下基线树（只在内存里，不生成提交）
  beforeChange(): void;
  // 工具落定后调用：文件树与上一次（快照或基线）不同则生成快照；没有改变返回 undefined
  afterChange(): CheckpointResult | undefined;
  // 现状快照：分叉时没有可用快照，给出当前文件状态的提交（挂 ref，不接入快照链）
  snapshotNow(): CheckpointResult;
  // 给已有提交挂一个快照 ref（改前基线在分叉时被引用，防止被 git 回收）；返回 ref
  pin(commit: string): string;
}

// 快照提交的作者身份固定，不依赖用户的 git 配置
const IDENTITY = {
  GIT_AUTHOR_NAME: "pigeon",
  GIT_AUTHOR_EMAIL: "pigeon@localhost",
  GIT_COMMITTER_NAME: "pigeon",
  GIT_COMMITTER_EMAIL: "pigeon@localhost",
};

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
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
    throw new CheckpointError(`git ${args.join(" ")} 失败：${detail}`);
  }
}

export function isGitWorkspace(workspaceRoot: string): boolean {
  try {
    return git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function checkpointRefPrefix(sessionId: SessionId): string {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/`;
}

export function createCheckpointer(input: {
  workspaceRoot: string;
  sessionId: SessionId;
}): Checkpointer {
  const { workspaceRoot, sessionId } = input;
  if (!isGitWorkspace(workspaceRoot)) {
    throw new NotGitWorkspaceError(`工作区不是 git 工作区，不能生成快照：${workspaceRoot}`);
  }
  const prefix = checkpointRefPrefix(sessionId);
  // 恢复的会话接着已有快照编号与快照链
  const existing = git(workspaceRoot, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [ref = "", commit = ""] = line.split(" ");
      return { n: Number(ref.slice(prefix.length)), commit };
    })
    .filter((entry) => Number.isInteger(entry.n))
    .sort((left, right) => left.n - right.n);
  let counter = existing.at(-1)?.n ?? 0;
  let previous: string | undefined = existing.at(-1)?.commit;
  let lastTree: string | undefined =
    previous !== undefined
      ? git(workspaceRoot, ["rev-parse", `${previous}^{tree}`]).trim()
      : undefined;
  let baseTree: string | undefined;

  // 工作区当前文件树：临时索引上 add -A（排除治理目录）再 write-tree
  const currentTree = (): string => {
    const indexFile = join(tmpdir(), `pigeon-index-${randomBytes(8).toString("hex")}`);
    try {
      const realIndex = git(workspaceRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ]).trim();
      if (existsSync(realIndex)) {
        copyFileSync(realIndex, indexFile);
      }
      const env = { GIT_INDEX_FILE: indexFile };
      git(workspaceRoot, ["add", "-A", "--", "."], env);
      // 治理目录不进快照：不能用排除路径写法（.pigeon 已被 .gitignore 忽略时 git add 会因路径命中忽略项报错），
      // 改为加完再从临时索引里摘掉
      git(
        workspaceRoot,
        ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "-q", "--", ".pigeon"],
        env
      );
      return git(workspaceRoot, ["write-tree"], env).trim();
    } finally {
      rmSync(indexFile, { force: true });
    }
  };

  const headCommit = (): string | undefined => {
    try {
      return git(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim() || undefined;
    } catch {
      return undefined;
    }
  };

  const commitTree = (tree: string, parent: string | undefined, message: string): string =>
    git(
      workspaceRoot,
      ["commit-tree", tree, ...(parent !== undefined ? ["-p", parent] : []), "-m", message],
      IDENTITY
    ).trim();

  // ref 写入一律带旧值守卫：新建传 null（git 的空旧值即"该 ref 必须不存在"），更新传旧提交号做比较交换。
  // 同一会话若有并发的快照器实例（序号计数各在各的内存里，构造时从 refs 读到同一个起点），后写者会撞上同一个序号；
  // 这里明确报错，不静默覆盖——被覆盖的快照会失去唯一引用，之后可能被 git 回收，钉住的改前基线随之丢失。
  const writeRef = (ref: string, commit: string, expected: string | null): void => {
    try {
      git(workspaceRoot, ["update-ref", ref, commit, expected ?? ""]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CheckpointError(
        expected === null
          ? `快照 ref ${ref} 已存在，拒绝覆盖（同一会话存在并发的快照器实例）：${detail}`
          : `快照 ref ${ref} 的旧值已变，拒绝覆盖（同一会话存在并发的快照器实例）：${detail}`
      );
    }
  };

  const nextRef = (commit: string): string => {
    counter += 1;
    const ref = `${prefix}${counter}`;
    writeRef(ref, commit, null);
    return ref;
  };

  return {
    beforeChange: () => {
      if (lastTree === undefined && baseTree === undefined) {
        baseTree = currentTree();
      }
    },
    afterChange: () => {
      const tree = currentTree();
      const reference = lastTree ?? baseTree;
      if (reference === undefined) {
        // 没有记过基线：把现状当基线，本次不算改变
        baseTree = tree;
        return undefined;
      }
      if (tree === reference) {
        return undefined;
      }
      let baseCommit: string | undefined;
      if (previous === undefined && baseTree !== undefined) {
        baseCommit = commitTree(baseTree, headCommit(), `pigeon checkpoint ${sessionId} base`);
      }
      const commit = commitTree(
        tree,
        previous ?? baseCommit,
        `pigeon checkpoint ${sessionId} #${counter + 1}`
      );
      const ref = nextRef(commit);
      previous = commit;
      lastTree = tree;
      return { ref, commit, tree, ...(baseCommit !== undefined ? { baseCommit } : {}) };
    },
    snapshotNow: () => {
      const tree = currentTree();
      const commit = commitTree(
        tree,
        previous ?? headCommit(),
        `pigeon checkpoint ${sessionId} now`
      );
      return { ref: nextRef(commit), commit, tree };
    },
    pin: (commit) => nextRef(commit),
  };
}
