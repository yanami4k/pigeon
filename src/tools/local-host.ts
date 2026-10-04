// 执行端接口的本地实现（决策 098）：工作区是宿主上的一个目录，读写走 node:fs，命令作为宿主子进程在工作区根执行。
// 路径围栏沿用 paths.ts 的 realpath 口径；进程执行、文件清单与 .cmd / .bat 解析从 run-command.ts 原样平移，行为不变。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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
  classifyLocalReadPaths,
  containedIn,
  LOCAL_PATH_RULES,
  resolveLocalReadPath,
} from "./read-deny.ts";
import {
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  helperEnv,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
  type WorkspaceHost,
} from "./workspace-host.ts";

export interface LocalHostOptions {
  // 平台（缺省 process.platform；测试注入）
  platform?: NodeJS.Platform;
  // 禁读名单里 ~ 展开用的家目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
}

export function createLocalWorkspaceHost(
  workspaceRoot: string,
  options: LocalHostOptions = {}
): WorkspaceHost {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    root: workspaceRoot,
    async resolveExisting(inputPath) {
      return resolveWorkspacePath(workspaceRoot, inputPath);
    },
    async resolveForWrite(inputPath) {
      return resolveWorkspaceWritePath(workspaceRoot, inputPath);
    },
    async resolveForRead(inputPath, deny) {
      return resolveLocalReadPath(workspaceRoot, inputPath, deny, options.homeDir ?? homedir());
    },
    classifyReadPaths: (relPaths, deny, signal) =>
      classifyLocalReadPaths(workspaceRoot, relPaths, deny, options.homeDir ?? homedir(), signal),
    // 辅助程序：先解析成绝对路径再启动（不在工作区里找程序）；环境屏蔽 git 的全局与系统配置、不带 ripgrep 配置；
    // 两路输出各自留到 maxOutputBytes
    async execHelper(program, args, execOptions) {
      const env = helperEnv(execOptions.env, process.platform);
      const resolved = resolveHelperProgram(program, env, workspaceRoot);
      if (resolved === undefined) {
        return programNotFound(program);
      }
      return runLocalProcess(
        { program: resolved, args: [...args], verbatim: false },
        workspaceRoot,
        { ...execOptions, env },
        execOptions.maxOutputBytes
      );
    },
    async fileMtimes(relPaths) {
      const times = new Map<string, number>();
      // 分批并发，免得一次开上万个文件句柄
      for (let start = 0; start < relPaths.length; start += 256) {
        await Promise.all(
          relPaths.slice(start, start + 256).map(async (rel) => {
            try {
              times.set(rel, (await stat(path.join(workspaceRoot, rel))).mtimeMs);
            } catch {
              // 列出之后被删除的文件：不在结果里
            }
          })
        );
      }
      return times;
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
      return snapshotLocalFiles(workspaceRoot, limit);
    },
    findLauncherScript: (program, env) => windowsScript(program, workspaceRoot, env, platform),
  };
}

// 辅助程序的绝对路径（决策 368）：给了绝对路径的照用；只给名字的在 PATH 的绝对目录里找，跳过空项、相对目录与工作区之内的
// 目录——Windows 的进程启动会先在当前目录（即工作区）找程序，故不把裸名字交给它；Windows 只认 .exe、.com。找不到为 undefined
export function resolveHelperProgram(
  program: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot: string
): string | undefined {
  if (path.isAbsolute(program)) return program;
  if (/[\\/]/.test(program)) return undefined;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const names =
    process.platform === "win32" && path.extname(program) === ""
      ? [`${program}.exe`, `${program}.com`]
      : [program];
  let realRoot: string;
  try {
    realRoot = realpathSync.native(workspaceRoot);
  } catch {
    realRoot = path.resolve(workspaceRoot);
  }
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    let realDir: string;
    try {
      realDir = realpathSync.native(dir);
    } catch {
      continue;
    }
    if (containedIn(realRoot, realDir, LOCAL_PATH_RULES)) continue;
    for (const name of names) {
      const candidate = path.join(realDir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 这个目录里没有
      }
    }
  }
  return undefined;
}

// 找不到程序：与启动失败同一形态（spawnError 的 code 为 ENOENT）
function programNotFound(program: string): HostExecResult {
  const error: NodeJS.ErrnoException = new Error(`找不到程序：${program}`);
  error.code = "ENOENT";
  const empty = createHeadCollector(0).finish();
  return {
    spawned: false,
    spawnError: error,
    exitCode: null,
    timedOut: false,
    ...empty,
    stdout: "",
    stderr: "",
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
  options: HostExecOptions,
  // 分开的 stdout / stderr 各自保留的上限（缺省 HOST_SEPARATE_STREAM_CAP）
  streamCap: number = HOST_SEPARATE_STREAM_CAP
): Promise<HostExecResult> {
  const collected = createHeadCollector(options.maxOutputBytes);
  const stdoutOnly = createHeadCollector(streamCap);
  const stderrOnly = createHeadCollector(streamCap);
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
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
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

// 工作树文件清单：相对路径 → 大小与修改时间签名；跳过符号链接、目录联接与 workspace-host.ts 两份名单里的目录
function snapshotLocalFiles(root: string, limit: number): HostFileSnapshot {
  const files = new Map<string, string>();
  let truncated = false;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        const skipped =
          LISTING_SKIPPED_DIRS.includes(entry.name) ||
          (dir === root && LISTING_SKIPPED_ROOT_DIRS.includes(entry.name));
        if (!skipped) {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (files.size >= limit) {
        truncated = true;
        return;
      }
      try {
        const fileStat = statSync(full);
        files.set(
          path.relative(root, full).split(path.sep).join("/"),
          `${fileStat.size}:${fileStat.mtimeMs}`
        );
      } catch {
        // 执行期间被删除的文件：按不存在处理
      }
    }
  };
  walk(root);
  return { files, truncated };
}
