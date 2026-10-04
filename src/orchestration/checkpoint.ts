// 工作区快照（M7 S5，决策 078）：只在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交——
// 临时 GIT_INDEX_FILE（首次以用户索引为起点复制一份，只为复用文件状态缓存）→ add -A → write-tree → commit-tree → update-ref，
// 挂到 refs/pigeon/checkpoints/<会话>/<序号>。用户的工作区、暂存区、当前分支与 HEAD 一律不碰；
// 程序状态 .pigeon/state 与个人设置 .pigeon/settings.local.json 不进快照，add 时经临时忽略文件把它们算作被忽略、git 不进这两处（会话文件在变不算文件改变；决策 325 起
// 仓库已跟踪的 .pigeon/settings.json 与 .pigeon/skills 是项目内容，照常进快照）。快照成链：首个快照的父提交是改前基线（首次改动之前的
// 工作区状态），之后每个快照的父提交是上一个快照。分叉时从分叉点之前最近的快照开独立工作树（见 S6）。
// 非 git 工作区不打快照；构造快照器即明确报错，不降级。git 经参数数组直接调用，不经 shell。
// 决策 350：git 一律异步执行（快照在后台拍，不占事件循环），同一实例的操作经串行队列逐个执行；单条命令有上限，
// 调用方可传中止信号提前杀掉。会话内复用同一个临时索引（add -A 只处理增量），索引路径、已有快照编号、工作区前缀与用户的全局忽略文件只在首次操作时取一次；
// 某条命令失败或被中止时丢弃临时索引（可能留下半截内容或锁文件），下次从用户索引重新复制。
// racy-git 保护：git 只在条目的文件修改时间不早于索引文件的修改时间时才比内容，所以索引文件的修改时间不能晚于其中条目
// 最后一次入索引的时间。复制出的副本修改时间是"现在"，必须设回用户索引的修改时间；此后临时索引只由 git 自己写：
// 写时按读入时的索引修改时间认出临界条目，其中内容已变的抹掉长度（下次必比内容），内容没变的此刻确实干净、之后再改
// 修改时间必然变化，复用不破坏这一保护。
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "../state/ids.ts";
import { PROGRAM_OWNED_PATHS } from "../state/paths.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import { killProcessTree, processGroupSpawnOptions } from "../tools/process-tree.ts";

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
  beforeChange(signal?: AbortSignal): Promise<void>;
  // 工具落定后调用：文件树与上一次（快照或基线）不同则生成快照；没有改变返回 undefined
  afterChange(signal?: AbortSignal): Promise<CheckpointResult | undefined>;
  // 现状快照：分叉时没有可用快照，给出当前文件状态的提交（挂 ref，不接入快照链）
  snapshotNow(signal?: AbortSignal): Promise<CheckpointResult>;
  // 给已有提交挂一个快照 ref（改前基线在分叉时被引用，防止被 git 回收）；返回 ref
  pin(commit: string, signal?: AbortSignal): Promise<string>;
  // 排队的操作做完后删掉临时索引；之后再用会重新复制
  close(): Promise<void>;
}

// 快照提交的作者身份固定，不依赖用户的 git 配置
const IDENTITY = {
  GIT_AUTHOR_NAME: "pigeon",
  GIT_AUTHOR_EMAIL: "pigeon@localhost",
  GIT_COMMITTER_NAME: "pigeon",
  GIT_COMMITTER_EMAIL: "pigeon@localhost",
};

// 列表类命令在大仓库里输出可达数十 MiB：缺省 1 MiB 的上限会报 ENOBUFS
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// 单条 git 命令的上限：git 卡住时到点杀掉，排在后面的操作不会被永远堵住
const GIT_TIMEOUT_MS = 60_000;

function failure(args: string[], error: unknown, stderr: unknown): CheckpointError {
  const detail =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return new CheckpointError(`git ${args.join(" ")} 失败：${detail}`);
}

// 本文件的 git（同步与异步两条）一律加固（tools/git-hardening.ts：不跑 fsmonitor、钩子与 .gitattributes 指派的过滤）。
// 加固参数按目录缓存，构造快照器时的同步检查先取一次，之后的异步 git 不再为它阻塞
function gitSync(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", [...hardenedGitArgs(cwd), ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw failure(args, error, (error as { stderr?: unknown }).stderr);
  }
}

// 异步执行一条 git：到上限或收到中止信号即杀掉它的整个进程树（git 可能再起子进程，Windows 上只杀 git.exe 会留下它们），
// 以独立进程组拉起（非 Windows）。输出超过上限同样杀掉并报错
function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal | undefined } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted === true) {
      reject(failure(args, new Error("已中止"), undefined));
      return;
    }
    const child = spawn("git", [...hardenedGitArgs(cwd), ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...processGroupSpawnOptions(),
      ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let killedFor: string | undefined;
    const kill = (reason: string) => {
      if (killedFor === undefined) {
        killedFor = reason;
        killProcessTree(child, "SIGKILL");
      }
    };
    const timer = setTimeout(
      () => kill(`超过 ${GIT_TIMEOUT_MS} 毫秒未结束，已终止`),
      GIT_TIMEOUT_MS
    );
    const onAbort = () => kill("已中止");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) {
        kill("输出超过上限，已终止");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      reject(failure(args, error, undefined));
    });
    child.on("close", (code) => {
      done();
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (killedFor !== undefined) {
        reject(failure(args, new Error(killedFor), undefined));
      } else if (code !== 0) {
        reject(failure(args, new Error(`退出码 ${code}`), errorText));
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

// 快照的 add 用的忽略文件：临时 core.excludesFile，内容为用户原有的全局忽略文件加上本工作区前缀下的程序状态两条
// （.pigeon/state/ 与 .pigeon/settings.local.json）。这两处因此在任何仓库里都算被忽略：git add -A 不进 .pigeon/state
// （会话存储在那里不断建删临时锁文件，后台拍时 git 扫到一闪而过的文件会整次失败），也不收个人设置；不用排除路径，
// 就不会触发 git 对"显式点名被忽略路径"报的退出码 1，成败只看退出码。仓库自己的 .gitignore 与 .git/info/exclude
// 照常生效（优先级高于全局忽略文件）。读不到用户原有的全局忽略文件时只含这两条
export function snapshotExcludes(original: string, workspacePrefix: string): string {
  // 前缀里的通配字符按字面匹配
  const literal = workspacePrefix.replace(/[\\*?[]/g, (char) => `\\${char}`);
  // 开头的 / 锚在仓库根；不带结尾的 /，目录与文件都认
  const owned = PROGRAM_OWNED_PATHS.map((path) => `/${literal}${path}`);
  const head = original === "" || original.endsWith("\n") ? original : `${original}\n`;
  return `${head}${owned.join("\n")}\n`;
}

// git 缺省的全局忽略文件（没配 core.excludesFile 时）
function defaultGlobalExcludes(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== ""
    ? join(xdg, "git", "ignore")
    : join(process.env.HOME ?? homedir(), ".config", "git", "ignore");
}

export function isGitWorkspace(workspaceRoot: string): boolean {
  try {
    return gitSync(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function checkpointRefPrefix(sessionId: SessionId): string {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/`;
}

// 进程退出时清掉还在用的临时文件（临时索引与忽略文件；会话没走到 close 的情况）
const liveTempFiles = new Set<string>();
let exitHookInstalled = false;
function removeTempFile(file: string): void {
  rmSync(file, { force: true });
  rmSync(`${file}.lock`, { force: true });
  liveTempFiles.delete(file);
}
function trackTempFile(file: string): void {
  liveTempFiles.add(file);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const live of [...liveTempFiles]) {
        removeTempFile(live);
      }
    });
  }
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
  const run = (args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal) =>
    git(workspaceRoot, args, { ...(env !== undefined ? { env } : {}), signal });

  // 同一实例的操作逐个执行：临时索引、序号与快照链都是实例内的共享状态
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };

  let initialized = false;
  let counter = 0;
  let previous: string | undefined;
  let lastTree: string | undefined;
  let realIndex = "";
  let baseTree: string | undefined;
  // 首次改动之前记基线失败：之后看到的树已是改后的，不能当改前基线——此后不再产出改前基线，
  // 读改前基线的地方因此得到"没有起点"，而不是一个改到一半的状态
  let baseLost = false;
  let indexFile: string | undefined;
  // 快照的 add 用的临时忽略文件：内容在首次操作时定，文件用时建、close 时删
  let excludesContent = "";
  let excludesFile: string | undefined;

  // 恢复的会话接着已有快照编号与快照链；用户索引的位置会话内不变
  const init = async (signal?: AbortSignal): Promise<void> => {
    if (initialized) {
      return;
    }
    const existing = (
      await run(["for-each-ref", "--format=%(refname) %(objectname)", prefix], undefined, signal)
    )
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [ref = "", commit = ""] = line.split(" ");
        return { n: Number(ref.slice(prefix.length)), commit };
      })
      .filter((entry) => Number.isInteger(entry.n))
      .sort((left, right) => left.n - right.n);
    const last = existing.at(-1);
    const tree =
      last !== undefined
        ? (await run(["rev-parse", `${last.commit}^{tree}`], undefined, signal)).trim()
        : undefined;
    // 工作区在仓库里的前缀（忽略文件里的路径锚在仓库根）与用户索引的位置，一次取
    const [workspacePrefix = "", indexPath = ""] = (
      await run(
        ["rev-parse", "--show-prefix", "--path-format=absolute", "--git-path", "index"],
        undefined,
        signal
      )
    ).split(/\r?\n/);
    realIndex = indexPath.trim();
    // 用户原有的全局忽略文件：配了 core.excludesFile 用它（git config 没配时以退出码 1 结束），没配用 git 的缺省位置
    let globalExcludes = defaultGlobalExcludes();
    try {
      globalExcludes =
        (await run(["config", "--path", "--get", "core.excludesFile"], undefined, signal)).trim() ||
        globalExcludes;
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
    }
    let original = "";
    try {
      original = readFileSync(globalExcludes, "utf8");
    } catch {
      // 读不到即只含程序状态两条
    }
    excludesContent = snapshotExcludes(original, workspacePrefix.trim());
    counter = last?.n ?? 0;
    previous = last?.commit;
    lastTree = tree;
    initialized = true;
  };

  // 丢弃临时索引：先忘掉它（下次一定重新复制），再尽力删；删不掉不另抛，调用方原来的错误照旧上抛
  const dropIndex = (): void => {
    const file = indexFile;
    indexFile = undefined;
    if (file !== undefined) {
      try {
        removeTempFile(file);
      } catch {
        // 留下的文件由进程退出时的清理再试一次
      }
    }
  };

  // 工作区当前文件树：临时索引上 add -A（排除治理目录）再 write-tree
  const currentTree = async (signal?: AbortSignal): Promise<string> => {
    if (indexFile === undefined) {
      const file = join(tmpdir(), `pigeon-index-${randomBytes(8).toString("hex")}`);
      trackTempFile(file);
      if (existsSync(realIndex)) {
        // 先取修改时间再复制：其间用户索引若被改写，副本只会比取到的时间新，设回的时间只会偏早（偏早只多比内容）。
        // Date 只到毫秒、向下取整，同样不会晚于原值
        const { atime, mtime } = statSync(realIndex);
        copyFileSync(realIndex, file);
        utimesSync(file, atime, mtime);
      }
      indexFile = file;
    }
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await addAll(env, signal);
      // 仓库里已跟踪的程序状态（排除路径不动已在索引里的条目）从临时索引里摘掉
      await run(
        ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "-q", "--", ...PROGRAM_OWNED_PATHS],
        env,
        signal
      );
      return (await run(["write-tree"], env, signal)).trim();
    } catch (error) {
      dropIndex();
      throw error;
    }
  };

  // add -A 带上临时忽略文件（见 snapshotExcludes），git 不进 Pigeon 自己的程序状态；成败只看退出码
  const addAll = (env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
    if (excludesFile === undefined) {
      const file = join(tmpdir(), `pigeon-excludes-${randomBytes(8).toString("hex")}`);
      trackTempFile(file);
      writeFileSync(file, excludesContent);
      excludesFile = file;
    }
    return run(
      ["-c", `core.excludesFile=${excludesFile.split("\\").join("/")}`, "add", "-A", "--", "."],
      env,
      signal
    );
  };

  const headCommit = async (signal?: AbortSignal): Promise<string | undefined> => {
    try {
      return (
        (await run(["rev-parse", "--verify", "--quiet", "HEAD"], undefined, signal)).trim() ||
        undefined
      );
    } catch (error) {
      // 中止要上抛；其余（没有提交的新仓库）即没有 HEAD
      if (signal?.aborted === true) {
        throw error;
      }
      return undefined;
    }
  };

  const commitTree = async (
    tree: string,
    parent: string | undefined,
    message: string,
    signal?: AbortSignal
  ): Promise<string> =>
    (
      await run(
        ["commit-tree", tree, ...(parent !== undefined ? ["-p", parent] : []), "-m", message],
        IDENTITY,
        signal
      )
    ).trim();

  // ref 写入一律带旧值守卫：新建传 null（git 的空旧值即"该 ref 必须不存在"），更新传旧提交号做比较交换。
  // 同一会话若有并发的快照器实例（序号计数各在各的内存里，构造时从 refs 读到同一个起点），后写者会撞上同一个序号；
  // 这里明确报错，不静默覆盖——被覆盖的快照会失去唯一引用，之后可能被 git 回收，钉住的改前基线随之丢失。
  const writeRef = async (
    ref: string,
    commit: string,
    expected: string | null,
    signal?: AbortSignal
  ): Promise<void> => {
    try {
      await run(["update-ref", ref, commit, expected ?? ""], undefined, signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CheckpointError(
        expected === null
          ? `快照 ref ${ref} 已存在，拒绝覆盖（同一会话存在并发的快照器实例）：${detail}`
          : `快照 ref ${ref} 的旧值已变，拒绝覆盖（同一会话存在并发的快照器实例）：${detail}`
      );
    }
  };

  const nextRef = async (commit: string, signal?: AbortSignal): Promise<string> => {
    counter += 1;
    const ref = `${prefix}${counter}`;
    await writeRef(ref, commit, null, signal);
    return ref;
  };

  return {
    beforeChange: (signal) =>
      serial(async () => {
        try {
          await init(signal);
          if (lastTree === undefined && baseTree === undefined && !baseLost) {
            baseTree = await currentTree(signal);
          }
        } catch (error) {
          // 初始化失败同样算基线丢失：还没记下基线时就不能再记
          if (baseTree === undefined) {
            baseLost = true;
          }
          throw error;
        }
      }),
    afterChange: (signal) =>
      serial(async () => {
        await init(signal);
        const tree = await currentTree(signal);
        const reference = lastTree ?? baseTree;
        if (reference === undefined) {
          if (baseLost) {
            // 基线丢了：现状照样打成快照（不带改前基线），账本因此留下"有快照、无改前基线"，续跑也认得出起点丢失
            const commit = await commitTree(
              tree,
              await headCommit(signal),
              `pigeon checkpoint ${sessionId} #${counter + 1}`,
              signal
            );
            const ref = await nextRef(commit, signal);
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
          baseCommit = await commitTree(
            baseTree,
            await headCommit(signal),
            `pigeon checkpoint ${sessionId} base`,
            signal
          );
        }
        const commit = await commitTree(
          tree,
          previous ?? baseCommit,
          `pigeon checkpoint ${sessionId} #${counter + 1}`,
          signal
        );
        const ref = await nextRef(commit, signal);
        previous = commit;
        lastTree = tree;
        return { ref, commit, tree, ...(baseCommit !== undefined ? { baseCommit } : {}) };
      }),
    snapshotNow: (signal) =>
      serial(async () => {
        await init(signal);
        const tree = await currentTree(signal);
        const commit = await commitTree(
          tree,
          previous ?? (await headCommit(signal)),
          `pigeon checkpoint ${sessionId} now`,
          signal
        );
        return { ref: await nextRef(commit, signal), commit, tree };
      }),
    pin: (commit, signal) =>
      serial(async () => {
        await init(signal);
        return nextRef(commit, signal);
      }),
    close: () =>
      serial(async () => {
        dropIndex();
        if (excludesFile !== undefined) {
          removeTempFile(excludesFile);
          excludesFile = undefined;
        }
      }),
  };
}
