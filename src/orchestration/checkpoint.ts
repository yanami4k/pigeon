// 工作区快照（M7 S5，决策 078）：只在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交——
// 临时 GIT_INDEX_FILE（以用户索引为起点复制一份，只为复用文件状态缓存）→ add -A → write-tree → commit-tree → update-ref，
// 挂到 refs/pigeon/checkpoints/<会话>/<序号>。用户的工作区、暂存区、当前分支与 HEAD 一律不碰；
// 治理目录 .pigeon 不进快照（会话文件在变不算文件改变）。快照成链：首个快照的父提交是改前基线（首次改动之前的
// 工作区状态），之后每个快照的父提交是上一个快照。分叉时从分叉点之前最近的快照开独立工作树（见 S6）。
// 非 git 工作区不打快照；构造快照器即明确报错，不降级。git 经参数数组直接调用，不经 shell。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, type Dirent, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
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
        try {
          recordStartIgnored(workspaceRoot, sessionId);
        } catch {
          // 记不下开工忽略清单不影响基线：撤回时取不到清单，退回保守做法并告警
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

// 开工忽略清单（决策 154 修订）：快照不含被忽略的文件，撤回时无从区分被忽略的东西是开工前就有、还是 agent 新弄出来的。
// 所以每一步开工记基线时，另记一份当时已被忽略的路径清单（ls-files --others --ignored --exclude-standard --directory），
// 存成 git 对象挂在该会话专用的 ref 上——与快照同在仓库里，进程崩溃后撤回不靠进程内存也能取回
export const IGNORED_LIST_REF_PREFIX = "refs/pigeon/start-ignored/";

export function startIgnoredRef(sessionId: SessionId): string {
  return `${IGNORED_LIST_REF_PREFIX}${sessionId}`;
}

function listIgnored(workspaceRoot: string): string {
  return git(workspaceRoot, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
}

// 记下开工忽略清单；这个会话已经记过就不覆盖（续跑时看到的已不是开工时的样子）
function recordStartIgnored(workspaceRoot: string, sessionId: SessionId): void {
  const ref = startIgnoredRef(sessionId);
  try {
    git(workspaceRoot, ["rev-parse", "--verify", "-q", ref]);
    return;
  } catch {
    // 还没有记过
  }
  const blob = git(
    workspaceRoot,
    ["hash-object", "-w", "--stdin"],
    undefined,
    listIgnored(workspaceRoot)
  ).trim();
  git(workspaceRoot, ["update-ref", ref, blob]);
}

// 取回开工忽略清单；没有记过（旧快照，或清单丢失）返回 undefined
export function readStartIgnored(
  workspaceRoot: string,
  sessionId: SessionId
): string[] | undefined {
  let text: string;
  try {
    text = git(workspaceRoot, ["cat-file", "blob", startIgnoredRef(sessionId)]);
  } catch {
    return undefined;
  }
  return text.split("\0").filter((name) => name !== "");
}

// 原地恢复到某个快照提交（决策 142：回炉到上限仍失败即撤回到这一步起点）。"逐字一致"的范围与快照相同：受跟踪的文件，
// 加上未跟踪且未被忽略的文件；治理目录不动。只写工作树：用户的 HEAD、暂存区与分支一律不碰——目标内容经临时索引写回。
// 范围限在工作区根之下（工作区根可以是仓库的子目录）。
// 写回：真实索引的副本做单树合并并刷新文件状态，内容没变的文件不重写（保留修改时间，不因文件被占用而失败）；
// 真实索引里有未解决的冲突时单树合并做不了，退回按目标提交新建临时索引、全部重写。
// 删除集（决策 154 修订）：给了开工忽略清单时，现存的全部未跟踪路径（含被忽略的）与已暂存却不在目标里的条目都是候选；
// 在目标里、是治理目录、或是开工时就被忽略的，一律不动，其余删掉——agent 新弄出来的被忽略文件因此也清掉。
// 含受保护路径的目录不整删，逐层下探，只删不受保护的部分。开工时已被忽略的内容若在这一步里被改动或删除，不在恢复范围内。
// 没给清单时退回保守做法：现存被忽略的路径一律不删，只删未被忽略且不在目标里的（由调用方告警）。
// 可重复执行：已经一致时再执行一次结果不变
export function restoreWorkspaceTo(
  workspaceRoot: string,
  commit: string,
  startIgnored?: readonly string[]
): void {
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
    writeBack(workspaceRoot, commit, target);
  }
  // 开工忽略清单：目录条目下面若还列了别的条目（目录里只有被忽略的文件时 git 两者都列），按逐个文件保护；
  // 否则这个目录是按规则整体被忽略的（如 node_modules/），整棵子树都保护
  const ignored = startIgnored ?? [];
  const ignoredFiles = new Set(ignored.filter((name) => !name.endsWith("/")));
  const ignoredDirs = ignored.filter(
    (name) =>
      name.endsWith("/") && !ignored.some((other) => other !== name && other.startsWith(name))
  );
  const isProtected = (name: string): boolean =>
    governance(name) ||
    targetSet.has(name) ||
    // 起点里的嵌套仓库以 gitlink 收进，名字不带斜杠，而未跟踪列表里带斜杠
    (name.endsWith("/") && targetSet.has(name.slice(0, -1))) ||
    ignoredFiles.has(name) ||
    ignoredDirs.some((dir) => name === dir || name.startsWith(dir));
  // 目录下是否有要保留的东西：目标里的文件、开工时就被忽略的路径
  const holdsKept = (dir: string): boolean =>
    target.some((file) => file.startsWith(dir)) ||
    ignored.some((name) => name !== dir && name.startsWith(dir));
  const visit = (name: string): void => {
    if (isProtected(name)) {
      return;
    }
    if (name.endsWith("/") && holdsKept(name)) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(workspaceRoot, name), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        visit(
          entry.isDirectory() && !entry.isSymbolicLink()
            ? `${name}${entry.name}/`
            : `${name}${entry.name}`
        );
      }
      return;
    }
    removeEntry(join(workspaceRoot, name.endsWith("/") ? name.slice(0, -1) : name));
  };
  const untracked = split(
    git(workspaceRoot, [
      "ls-files",
      "-z",
      "--others",
      // 没有开工忽略清单：被忽略的一律不碰。此时不能折叠目录——--directory 不看目录里面，目录本身没被忽略就整个列出，
      // 里面全是被忽略的文件（如自带 * 的 .venv/）也会被连带删掉；逐个列出未被忽略的文件
      ...(startIgnored === undefined ? ["--exclude-standard"] : ["--directory"]),
    ])
  );
  // 已暂存却不在目标里的条目（agent 执行 git add 暂存的文件或嵌套仓库）；有冲突时同一路径列多次
  const staged = [...new Set(split(git(workspaceRoot, ["ls-files", "-z", "--cached"])))].filter(
    (name) => !targetSet.has(name)
  );
  for (const name of [...untracked, ...staged]) {
    visit(name);
  }
}

// 把目标提交的文件写回工作树（经临时索引，不碰真实索引）
function writeBack(workspaceRoot: string, commit: string, target: readonly string[]): void {
  const indexFile = join(tmpdir(), `pigeon-restore-index-${randomBytes(8).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    const realIndex = git(workspaceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]).trim();
    let merged = false;
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, indexFile);
      try {
        // 单树合并：与真实索引内容相同的条目沿用其文件状态
        git(workspaceRoot, ["read-tree", "-m", commit], env);
        merged = true;
      } catch {
        // 真实索引里有未解决的冲突等：单树合并做不了，下面退回新建临时索引
        rmSync(indexFile, { force: true });
      }
    }
    if (!merged) {
      git(workspaceRoot, ["read-tree", commit], env);
    }
    try {
      // 刷新：内容没变而文件状态过期（或新建索引里没有文件状态）的条目不再被当作改过
      git(workspaceRoot, ["update-index", "-q", "--refresh"], env);
    } catch {
      // 有条目需要更新时 --refresh 以非零退出；这正是接下来要写回的那些文件
    }
    git(workspaceRoot, ["checkout-index", "-f", "-z", "--stdin"], env, `${target.join("\0")}\0`);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

// 删掉一个条目：真目录才递归删；符号链接或 junction 只删链接本身，不碰它指向的内容；文件与已暂存的 gitlink 同样按 lstat 处理
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
