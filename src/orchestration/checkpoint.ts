// 工作区快照（M7 S5，决策 078）：只在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交——
// 临时 GIT_INDEX_FILE（以用户索引为起点复制一份，只为复用文件状态缓存）→ add -A → write-tree → commit-tree → update-ref，
// 挂到 refs/pigeon/checkpoints/<会话>/<序号>。用户的工作区、暂存区、当前分支与 HEAD 一律不碰；
// 治理目录 .pigeon 不进快照（会话文件在变不算文件改变）。快照成链：首个快照的父提交是改前基线（首次改动之前的
// 工作区状态），之后每个快照的父提交是上一个快照。分叉时从分叉点之前最近的快照开独立工作树（见 S6）。
// 非 git 工作区不打快照；构造快照器即明确报错，不降级。git 经参数数组直接调用，不经 shell。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// 列表类命令（ls-tree、ls-files）在大仓库里输出可达数十 MiB：缺省 1 MiB 的上限会报 ENOBUFS，
// 抛在写回之后即工作区只恢复一半
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(input !== undefined ? { input } : {}),
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

// 这个会话在 git 里是否已有快照 ref（账本里的快照记录可能因进程崩在 ref 写入之后而缺失）
export function hasCheckpointRefs(workspaceRoot: string, sessionId: SessionId): boolean {
  if (!isGitWorkspace(workspaceRoot)) {
    return false;
  }
  return (
    git(workspaceRoot, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      checkpointRefPrefix(sessionId),
    ]).trim() !== ""
  );
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
  // 首次改动之前记基线失败：之后看到的树已是改后的，不能当改前基线——此后不再产出改前基线，
  // 撤回因此走"没有起点"的显式报错，而不是恢复到一个改到一半的状态
  let baseLost = false;

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
      if (lastTree === undefined && baseTree === undefined && !baseLost) {
        try {
          baseTree = currentTree();
        } catch (error) {
          baseLost = true;
          throw error;
        }
      }
    },
    afterChange: () => {
      const tree = currentTree();
      const reference = lastTree ?? baseTree;
      if (reference === undefined) {
        if (baseLost) {
          // 基线丢了：现状照样打成快照（不带改前基线），账本因此留下"有快照、无改前基线"，续跑也认得出起点丢失
          const commit = commitTree(
            tree,
            headCommit(),
            `pigeon checkpoint ${sessionId} #${counter + 1}`
          );
          const ref = nextRef(commit);
          previous = commit;
          lastTree = tree;
          return { ref, commit, tree };
        }
        // 没有记过基线：把现状当基线，本次不算改变
        baseTree = tree;
        return undefined;
      }
      if (tree === reference) {
        return undefined;
      }
      let baseCommit: string | undefined;
      if (previous === undefined && baseTree !== undefined && !baseLost) {
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

// 原地恢复到某个快照提交（决策 142：回炉到上限仍失败即撤回到这一步起点）。范围与快照相同：受跟踪的文件，
// 加上未跟踪且未被忽略的文件（忽略规则以还原后的为准）；被忽略的文件与治理目录不动。只写工作树：用户的 HEAD、暂存区与分支一律不碰——
// 目标内容经临时索引写回。范围限在工作区根之下（工作区根可以是仓库的子目录）。
// 顺序：先把目标里的文件（含 .gitignore）逐个写回，再删掉目标里没有的 .gitignore（agent 新建的），
// 最后按还原后的忽略规则列出范围内的文件、删掉目标里没有的——删除集若按改动后的忽略规则算，
// agent 删掉的忽略规则会让原本被忽略的依赖目录被当作多余文件删掉，agent 新增的忽略规则会让被它隐藏的新文件漏删。
// 不在范围内：.git/info/exclude 与全局忽略配置（不进快照），agent 改了它们时删除集照改后的算。
// 写回用真实索引的副本做单树合并并刷新文件状态：内容没变的文件不重写（保留修改时间，不因文件被占用而失败）。
// 可重复执行：已经一致时再执行一次结果不变
export function restoreWorkspaceTo(workspaceRoot: string, commit: string): void {
  if (!isGitWorkspace(workspaceRoot)) {
    throw new NotGitWorkspaceError(`工作区不是 git 工作区，不能恢复快照：${workspaceRoot}`);
  }
  const split = (text: string): string[] => text.split("\0").filter((name) => name !== "");
  const governance = (name: string): boolean => name === ".pigeon" || name.startsWith(".pigeon/");
  // 路径一律相对工作区根（ls-tree 与 ls-files 在子目录里只列该子树，路径相对当前目录）
  const target = split(git(workspaceRoot, ["ls-tree", "-r", "-z", "--name-only", commit])).filter(
    (name) => !governance(name)
  );
  const targetSet = new Set(target);
  if (target.length > 0) {
    const indexFile = join(tmpdir(), `pigeon-restore-index-${randomBytes(8).toString("hex")}`);
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
      // 单树合并：与真实索引内容相同的条目沿用其文件状态；再刷新，内容没变而状态过期的条目也不再被当作改过
      git(workspaceRoot, ["read-tree", "-m", commit], env);
      try {
        git(workspaceRoot, ["update-index", "-q", "--refresh"], env);
      } catch {
        // 有条目需要更新时 --refresh 以非零退出；这正是接下来要写回的那些文件
      }
      git(workspaceRoot, ["checkout-index", "-f", "-z", "--stdin"], env, `${target.join("\0")}\0`);
    } finally {
      rmSync(indexFile, { force: true });
    }
  }
  // agent 新建的 .gitignore（目标里没有）先删掉，它们不该影响下面的删除集；只删所在目录未被忽略的——
  // 被忽略目录里的 .gitignore（如依赖目录自带的）不在范围内。由浅到深处理，外层删掉后内层按新规则判断
  const extraIgnores = split(
    git(workspaceRoot, ["ls-files", "-z", "--others", "--", ":(glob)**/.gitignore"])
  )
    .filter((name) => !governance(name) && !targetSet.has(name))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  for (const name of extraIgnores) {
    const file = join(workspaceRoot, name);
    const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
    if (dir === "") {
      rmSync(file, { force: true });
      continue;
    }
    // 目录是否被忽略要按外层规则判断：check-ignore 会把目录自己的 .gitignore（如内容为 *）也算进去，
    // 所以先拿掉它再判断；目录被外层规则忽略（依赖目录之类）即原样写回
    const content = readFileSync(file);
    rmSync(file, { force: true });
    if (isIgnored(workspaceRoot, dir)) {
      writeFileSync(file, content);
    }
  }
  const current = split(
    git(workspaceRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  );
  for (const name of current) {
    if (governance(name) || targetSet.has(name)) {
      continue;
    }
    // 未跟踪的目录条目（嵌套仓库列成"目录/"）：起点里就有（快照以 gitlink 收进、名字不带斜杠）即不动；
    // 目标里有文件落在它下面时也不动（那些文件已写回）；其余整个删掉
    if (name.endsWith("/")) {
      if (targetSet.has(name.slice(0, -1)) || target.some((file) => file.startsWith(name))) {
        continue;
      }
      removeEntry(join(workspaceRoot, name.slice(0, -1)));
      continue;
    }
    rmSync(join(workspaceRoot, name), { force: true });
  }
}

// 目录路径是否被忽略（按当前工作区里的忽略规则）
function isIgnored(workspaceRoot: string, dir: string): boolean {
  try {
    git(workspaceRoot, ["check-ignore", "-q", "--", dir]);
    return true;
  } catch {
    return false;
  }
}

// 删掉一个目录条目：真目录才递归删；符号链接或 junction 只删链接本身，不碰它指向的内容
function removeEntry(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    rmSync(path, { force: true });
    return;
  }
  rmSync(path, { recursive: true, force: true });
}
