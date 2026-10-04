// 执行端接口的本地实现（决策 098）：工作区是宿主上的一个目录，读写走 node:fs，命令作为宿主子进程在工作区根执行。
// 路径围栏沿用 paths.ts 的 realpath 口径；进程执行、文件清单与 .cmd / .bat 解析从 run-command.ts 原样平移，行为不变。
// 文件变化的取证（决策 348）：git 工作区按 git status 找候选；非 git 工作区异步全量扫描（扫描期间不卡住进程）。
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hardenedGitArgs } from "./git-hardening.ts";
import {
  assertWritePathUnchanged,
  resolveWorkspacePath,
  resolveWorkspaceWritePath,
} from "./paths.ts";
import {
  killProcessTree,
  processGroupSpawnOptions,
  trackChild,
  untrackChild,
} from "./process-tree.ts";
import {
  GIT_STATUS_ARGS,
  gitFileState,
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  type HostFileState,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
  MISSING_SIGNATURE,
  parseGitStatus,
  type WorkspaceHost,
} from "./workspace-host.ts";

export interface LocalHostOptions {
  // 平台（缺省 process.platform；测试注入）
  platform?: NodeJS.Platform;
}

export function createLocalWorkspaceHost(
  workspaceRoot: string,
  options: LocalHostOptions = {}
): WorkspaceHost {
  const platform = options.platform ?? process.platform;
  // 工作区在 git 仓库里的前缀（会话内取一次）；不是 git 工作区、或工作区根被外层仓库忽略时为 undefined
  let gitPrefix: Promise<string | undefined> | undefined;
  // 决策 352：Windows 上程序查找（工作区根与 PATH 逐目录找 .cmd / .bat）按"查找方式 + PATH + 程序名"缓存，会话内有效。
  // 找到的脚本取用前确认仍在；没找到的在命令报"程序不存在"时作废
  const launchers = new Map<string, string | undefined>();
  const launcherKey = (program: string, env: NodeJS.ProcessEnv) =>
    `root-and-path\0${pathValueOf(env)}\0${program}`;
  return {
    platform,
    root: workspaceRoot,
    async resolveExisting(inputPath) {
      return resolveWorkspacePath(workspaceRoot, inputPath);
    },
    async resolveForWrite(inputPath) {
      return resolveWorkspaceWritePath(workspaceRoot, inputPath);
    },
    async isFile(resolvedPath) {
      return (await stat(resolvedPath)).isFile();
    },
    readText: (resolvedPath) => readFile(resolvedPath, "utf8"),
    async writeText(resolvedPath, content) {
      assertWritePathUnchanged(resolvedPath);
      await writeFile(resolvedPath, content, "utf8");
    },
    exec: (plan, execOptions) => runLocalProcess(plan, workspaceRoot, execOptions),
    async listFiles(limit) {
      return scanLocalFiles(workspaceRoot, limit);
    },
    async fileState(limit, before) {
      gitPrefix ??= workspaceGitPrefix(workspaceRoot);
      const prefix = await gitPrefix;
      if (prefix !== undefined && before?.kind !== "scan") {
        const state = await localGitState(workspaceRoot, prefix, limit, before);
        // git status 失败（命令删了 .git、弄坏了索引等）：改用全量扫描并注明
        return (
          state ?? { kind: "scan", fallback: true, ...(await scanLocalFiles(workspaceRoot, limit)) }
        );
      }
      return {
        kind: "scan",
        ...(before?.kind === "scan" && before.fallback === true ? { fallback: true as const } : {}),
        ...(await scanLocalFiles(workspaceRoot, limit)),
      };
    },
    findLauncherScript(program, env) {
      if (platform !== "win32") {
        return undefined;
      }
      const key = launcherKey(program, env);
      if (launchers.has(key)) {
        const cached = launchers.get(key);
        if (cached === undefined || existsSync(cached)) {
          return cached;
        }
      }
      const found = windowsScript(program, workspaceRoot, env, platform);
      launchers.set(key, found);
      return found;
    },
    forgetLauncherScript(program) {
      for (const key of [...launchers.keys()]) {
        if (key.endsWith(`\0${program}`)) {
          launchers.delete(key);
        }
      }
    },
  };
}

// 工具工厂的入参：给目录即本地工作区，给实现即由该实现承接
export function asWorkspaceHost(workspace: string | WorkspaceHost): WorkspaceHost {
  return typeof workspace === "string" ? createLocalWorkspaceHost(workspace) : workspace;
}

// 输出收集：全量计字节数与哈希，只留开头 maxBytes 字节（本地与容器实现共用）
export interface HeadCollector {
  push(chunk: Buffer): void;
  bytes(): number;
  // 收尾：哈希只能取一次
  finish(): { outputBytes: number; outputHash: string; output: string };
}

export function createHeadCollector(maxBytes: number): HeadCollector {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let outputBytes = 0;
  return {
    push(chunk) {
      hash.update(chunk);
      outputBytes += chunk.length;
      if (headBytes < maxBytes) {
        const piece = chunk.subarray(0, maxBytes - headBytes);
        head.push(piece);
        headBytes += piece.length;
      }
    },
    bytes: () => outputBytes,
    finish: () => ({
      outputBytes,
      outputHash: hash.digest("hex"),
      output: Buffer.concat(head).toString("utf8"),
    }),
  };
}

// 终止后等 close 的宽限（毫秒）：孙进程占着输出管道时 close 迟迟不来，超时形同虚设，故到点销毁管道、按结果收尾
const KILL_GRACE_MS = 5000;

// 分开的 stdout / stderr 各自保留的开头上限
export const HOST_SEPARATE_STREAM_CAP = 64 * 1024;

function runLocalProcess(
  plan: HostExecPlan,
  cwd: string,
  options: HostExecOptions
): Promise<HostExecResult> {
  const collected = createHeadCollector(options.maxOutputBytes);
  const stdoutOnly = createHeadCollector(HOST_SEPARATE_STREAM_CAP);
  const stderrOnly = createHeadCollector(HOST_SEPARATE_STREAM_CAP);
  let timedOut = false;
  const finish = (
    partial: Omit<
      HostExecResult,
      "outputBytes" | "outputHash" | "output" | "timedOut" | "stdout" | "stderr"
    >
  ): HostExecResult => ({
    ...partial,
    timedOut,
    ...collected.finish(),
    stdout: stdoutOnly.finish().output,
    stderr: stderrOnly.finish().output,
  });
  return new Promise((resolve) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // 只决议一次且只在决议时收尾：启动失败时 error 与 close 两个事件都会到达，哈希只能 digest 一次
    const settle = (build: () => HostExecResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(grace);
        untrackChild(child);
        resolve(build());
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.program, plan.args, {
        cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
        // 以独立进程组拉起：超时或中止时对整组发信号，覆盖子进程再起的 node / pytest 等孙进程
        ...processGroupSpawnOptions(),
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
      trackChild(child);
      // 标准输入（钩子事件 JSON）：写完即收尾，命令读完自行结束
      child.stdin?.on("error", () => {});
      if (options.stdin !== undefined) child.stdin?.end(options.stdin, "utf8");
    } catch (error) {
      settle(() =>
        finish({ spawned: false, spawnError: error as NodeJS.ErrnoException, exitCode: null })
      );
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      collected.push(chunk);
      stdoutOnly.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      collected.push(chunk);
      stderrOnly.push(chunk);
    });
    // 超时与中止都 SIGKILL 整组并给宽限：close 在宽限内不来（孙进程仍占管道）就销毁管道、按当前结果收尾
    const terminate = () => {
      killProcessTree(child, "SIGKILL");
      if (grace === undefined) {
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(() => finish({ spawned: true, exitCode: null }));
        }, KILL_GRACE_MS);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      settle(() => finish({ spawned: child.pid !== undefined, spawnError: error, exitCode: null }));
    });
    child.on("close", (code, signal) => {
      cleanup();
      settle(() =>
        finish({
          spawned: true,
          exitCode: code,
          ...(signal !== null ? { signal } : {}),
        })
      );
    });
  });
}

function pathValueOf(env: NodeJS.ProcessEnv): string {
  return Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
}

// Windows 下程序解析到的 .cmd / .bat 路径（非 Windows 或解析到可执行文件时返回 undefined）：
// 显式带 .cmd / .bat 扩展名的按工作区根与 PATH 定位；不带扩展名的按工作区根、PATH 逐目录找，
// 同一目录里 .exe / .com 优先（与 PATHEXT 的缺省次序一致）
export function windowsScript(
  program: string,
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== "win32" || program === "") {
    return undefined;
  }
  const pathValue = pathValueOf(env);
  const lower = program.toLowerCase();
  const hasSeparator = program.includes("/") || program.includes("\\");
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    if (hasSeparator) {
      return path.resolve(root, program);
    }
    for (const dir of [root, ...pathValue.split(path.delimiter)]) {
      const candidate = path.join(dir, program);
      if (dir !== "" && existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
  if (hasSeparator || path.extname(program) !== "") {
    return undefined;
  }
  for (const dir of [root, ...pathValue.split(path.delimiter)]) {
    if (dir === "") {
      continue;
    }
    if (
      [".exe", ".com"].some((extension) => existsSync(path.join(dir, `${program}${extension}`)))
    ) {
      return undefined;
    }
    for (const extension of [".cmd", ".bat"]) {
      const candidate = path.join(dir, `${program}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// 工作树文件清单：相对路径 → 大小与修改时间签名；跳过符号链接、目录联接与 workspace-host.ts 两份名单里的目录。
// 异步遍历（决策 348）：同时读至多 SCAN_CONCURRENCY 个目录，一个目录里的文件并发取 stat；遍历期间不卡住进程
const SCAN_CONCURRENCY = 8;

async function scanLocalFiles(root: string, limit: number): Promise<HostFileSnapshot> {
  const files = new Map<string, string>();
  let counted = 0;
  let truncated = false;
  const visit = async (dir: string, pending: string[]): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const found: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        const skipped =
          LISTING_SKIPPED_DIRS.includes(entry.name) ||
          (dir === root && LISTING_SKIPPED_ROOT_DIRS.includes(entry.name));
        if (!skipped) {
          pending.push(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (counted >= limit) {
        truncated = true;
        break;
      }
      counted += 1;
      found.push(full);
    }
    await Promise.all(
      found.map(async (full) => {
        try {
          const fileStat = await stat(full);
          files.set(
            path.relative(root, full).split(path.sep).join("/"),
            `${fileStat.size}:${fileStat.mtimeMs}`
          );
        } catch {
          // 执行期间被删除的文件：按不存在处理
        }
      })
    );
  };
  // 并发池：有空位就从待读目录里取一个；读到的子目录补进待读，全部读完（没有在读的）即收工
  const pending = [root];
  let busy = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (busy < SCAN_CONCURRENCY && pending.length > 0 && !truncated) {
        const dir = pending.shift() as string;
        busy += 1;
        void visit(dir, pending).finally(() => {
          busy -= 1;
          pump();
        });
      }
      if (busy === 0) {
        resolve();
      }
    };
    pump();
  });
  return { files, truncated };
}

// 在 cwd 跑一条加固过的 git（git-hardening.ts）；失败（不是 git 工作区、没有 git、超时、非零退出）为 undefined
function runGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...hardenedGitArgs(), ...args],
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : undefined)
    );
  });
}

// 工作区在所在仓库里的前缀；不是 git 工作区为 undefined。工作区根本身被外层仓库忽略时同样为 undefined：
// git status 不会报出被忽略目录里的任何改动，按非 git 工作区全量扫描
async function workspaceGitPrefix(root: string): Promise<string | undefined> {
  const out = await runGit(root, ["rev-parse", "--show-prefix"]);
  if (out === undefined) {
    return undefined;
  }
  const prefix = out.replace(/\r?\n$/, "");
  if (prefix !== "" && (await runGit(root, ["check-ignore", "-q", "--", "."])) !== undefined) {
    return undefined;
  }
  return prefix;
}

// 嵌套仓库与子模块往下取它们自己的 git status 的层数；更深的整棵扫描
const NESTED_REPO_DEPTH = 3;

// git 工作区的取证：git status 报出的路径（与命令前报出的路径）逐个取 lstat 签名。status 报出的目录里有 .git 的（嵌套仓库、
// 子模块）不按目录签名比，逐个取它们自己的 status；取不到的、嵌套过深的那棵子树整棵扫描，文件按未跟踪记。
// 工作区根所在仓库的 git status 失败时为 undefined（调用方退回全量扫描）
async function localGitState(
  root: string,
  prefix: string,
  limit: number,
  before: HostFileState | undefined
): Promise<HostFileState | undefined> {
  const statuses = new Map<string, "tracked" | "untracked">();
  const signatures = new Map<string, string>();
  const sign = async (file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
    try {
      const fileStat = await lstat(path.join(root, file));
      signatures.set(file, `${fileStat.size}:${fileStat.mtimeMs}`);
      return fileStat;
    } catch {
      signatures.set(file, MISSING_SIGNATURE);
      return undefined;
    }
  };
  // 取一个仓库（dir 相对工作区根，空或以 / 结尾）的 status 合进 statuses；交回其中的嵌套仓库，失败为 undefined
  const collect = async (
    dir: string,
    strip: string,
    governance: boolean
  ): Promise<string[] | undefined> => {
    const output = await runGit(path.join(root, dir), GIT_STATUS_ARGS);
    if (output === undefined) {
      return undefined;
    }
    const nested: string[] = [];
    await Promise.all(
      [...parseGitStatus(output, strip, governance)].map(async ([file, status]) => {
        const key = dir + file.replace(/\/$/, "");
        const fileStat = await sign(key);
        if (fileStat?.isDirectory() === true && existsSync(path.join(root, key, ".git"))) {
          signatures.delete(key);
          nested.push(`${key}/`);
          return;
        }
        statuses.set(key, status);
      })
    );
    return nested;
  };
  let queue = await collect("", prefix, true);
  if (queue === undefined) {
    return undefined;
  }
  for (let depth = 1; queue.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of queue) {
      const inner = depth <= NESTED_REPO_DEPTH ? await collect(dir, "", false) : undefined;
      if (inner !== undefined) {
        next.push(...inner);
        continue;
      }
      const tree = await scanLocalFiles(path.join(root, dir), limit);
      for (const [file, signature] of tree.files) {
        statuses.set(dir + file, "untracked");
        signatures.set(dir + file, signature);
      }
    }
    queue = next;
  }
  if (before?.kind === "git") {
    await Promise.all(
      [...before.entries.keys()].filter((file) => !signatures.has(file)).map((file) => sign(file))
    );
  }
  return gitFileState(statuses, (file) => signatures.get(file) ?? MISSING_SIGNATURE, limit, before);
}
