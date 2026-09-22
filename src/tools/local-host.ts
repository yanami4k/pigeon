// 执行端接口的本地实现（决策 098）：工作区是宿主上的一个目录，读写走 node:fs，命令作为宿主子进程在工作区根执行。
// 路径围栏沿用 paths.ts 的 realpath 口径；进程执行、文件清单与 .cmd / .bat 解析从 run-command.ts 原样平移，行为不变。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./paths.ts";
import type {
  HostExecOptions,
  HostExecPlan,
  HostExecResult,
  HostFileSnapshot,
  WorkspaceHost,
} from "./workspace-host.ts";

// 文件清单不跟进的目录：版本库元数据与依赖目录（工作树里的 node_modules 可能是指向主仓库的目录联接）
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export interface LocalHostOptions {
  // 平台（缺省 process.platform；测试注入）
  platform?: NodeJS.Platform;
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
    async isFile(resolvedPath) {
      return (await stat(resolvedPath)).isFile();
    },
    readText: (resolvedPath) => readFile(resolvedPath, "utf8"),
    writeText: (resolvedPath, content) => writeFile(resolvedPath, content, "utf8"),
    readTextSync: (inputPath) =>
      readFileSync(resolveWorkspacePath(workspaceRoot, inputPath), "utf8"),
    exec: (plan, execOptions) => runLocalProcess(plan, workspaceRoot, execOptions),
    async listFiles(limit) {
      return snapshotLocalFiles(workspaceRoot, limit);
    },
    findLauncherScript: (program, env) => windowsScript(program, workspaceRoot, env, platform),
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

function runLocalProcess(
  plan: HostExecPlan,
  cwd: string,
  options: HostExecOptions
): Promise<HostExecResult> {
  const collected = createHeadCollector(options.maxOutputBytes);
  let timedOut = false;
  const finish = (
    partial: Omit<HostExecResult, "outputBytes" | "outputHash" | "output" | "timedOut">
  ): HostExecResult => ({ ...partial, timedOut, ...collected.finish() });
  return new Promise((resolve) => {
    let settled = false;
    // 只决议一次且只在决议时收尾：启动失败时 error 与 close 两个事件都会到达，哈希只能 digest 一次
    const settle = (build: () => HostExecResult) => {
      if (!settled) {
        settled = true;
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
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle(() =>
        finish({ spawned: false, spawnError: error as NodeJS.ErrnoException, exitCode: null })
      );
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => collected.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => collected.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const onAbort = () => child.kill();
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

// 工作树文件清单：相对路径 → 大小与修改时间签名；跳过符号链接、目录联接与 SKIPPED_DIRS
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
        if (!SKIPPED_DIRS.has(entry.name)) {
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
