// 执行端接口的本地实现（决策 098）：工作区是宿主上的一个目录，读写走 node:fs，命令作为宿主子进程在工作区根执行。
// 路径围栏沿用 paths.ts 的 realpath 口径；进程执行、文件清单与 .cmd / .bat 解析从 run-command.ts 原样平移，行为不变。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertWritePathUnchanged,
  createWorkspaceFile,
  resolveWorkspaceCreatePath,
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
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
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
    async resolveForCreate(inputPath) {
      return resolveWorkspaceCreatePath(workspaceRoot, inputPath);
    },
    async createText(resolvedPath, content) {
      createWorkspaceFile(resolvedPath, content);
    },
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

// 输出收集：全量计字节数与哈希，只留开头 maxBytes 字节（本地与容器实现共用）。
// 决策 356：给了 tailBytes 另留末尾、另计总行数；给了 fullOutput 且输出超过开头加末尾两段时，从超过的那一刻起把全量输出
// （含此前留在内存里的部分）写进文件，至多 fullOutput.maxBytes 字节
export interface HeadCollector {
  push(chunk: Buffer): void;
  bytes(): number;
  // 收尾：哈希只能取一次
  finish(): Pick<
    HostExecResult,
    "outputBytes" | "outputHash" | "output" | "tail" | "outputLines" | "fullOutputSaved"
  >;
}

export interface CollectorExtras {
  tailBytes?: number;
  fullOutput?: { path: string; maxBytes: number };
}

export function createHeadCollector(maxBytes: number, extras: CollectorExtras = {}): HeadCollector {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let outputBytes = 0;
  const tailBytes = extras.tailBytes ?? 0;
  // 末尾：最近 tailBytes 字节（按块存，超出的从前面丢）
  const tail: Buffer[] = [];
  let tailHeld = 0;
  let newlines = 0;
  let lastByte: number | undefined;
  let spill: { fd: number; written: number; partial: boolean } | undefined;
  const spillWrite = (chunk: Buffer): void => {
    if (spill === undefined || extras.fullOutput === undefined) return;
    const room = extras.fullOutput.maxBytes - spill.written;
    const piece = room < chunk.length ? chunk.subarray(0, Math.max(0, room)) : chunk;
    if (piece.length > 0) {
      writeSync(spill.fd, piece);
      spill.written += piece.length;
    }
    if (piece.length < chunk.length) spill.partial = true;
  };
  const tailBuffer = (): Buffer => Buffer.concat(tail).subarray(Math.max(0, tailHeld - tailBytes));
  return {
    push(chunk) {
      hash.update(chunk);
      const before = outputBytes;
      outputBytes += chunk.length;
      if (tailBytes > 0) {
        for (const byte of chunk) if (byte === 0x0a) newlines += 1;
        if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
        if (
          extras.fullOutput !== undefined &&
          spill === undefined &&
          outputBytes > maxBytes + tailBytes
        ) {
          // 头一回超过：此前的输出全在开头与末尾两段里（开头之后的部分是末尾缓冲的最后 before − 开头 字节）；
          // 先于本块进开头缓冲，免得本块的开头一段写两遍
          mkdirSync(path.dirname(extras.fullOutput.path), { recursive: true });
          spill = { fd: openSync(extras.fullOutput.path, "w"), written: 0, partial: false };
          spillWrite(Buffer.concat(head));
          const kept = tailBuffer();
          spillWrite(kept.subarray(kept.length - Math.max(0, before - headBytes)));
        }
        spillWrite(chunk);
      }
      if (headBytes < maxBytes) {
        const piece = chunk.subarray(0, maxBytes - headBytes);
        head.push(piece);
        headBytes += piece.length;
      }
      if (tailBytes <= 0) return;
      tail.push(chunk);
      tailHeld += chunk.length;
      while (tail.length > 1 && tailHeld - (tail[0]?.length ?? 0) >= tailBytes) {
        tailHeld -= tail.shift()?.length ?? 0;
      }
    },
    bytes: () => outputBytes,
    finish: () => {
      const headText = Buffer.concat(head).toString("utf8");
      const base = { outputBytes, outputHash: hash.digest("hex") };
      if (tailBytes <= 0) {
        return { ...base, output: headText };
      }
      const outputLines = newlines + (lastByte !== undefined && lastByte !== 0x0a ? 1 : 0);
      const kept = tailBuffer();
      if (spill !== undefined) closeSync(spill.fd);
      if (outputBytes <= maxBytes + tailBytes) {
        // 没超过：开头之后的部分是末尾缓冲的最后 总量 − 开头 字节，拼回全量
        const rest = kept.subarray(kept.length - Math.max(0, outputBytes - headBytes));
        return {
          ...base,
          output: Buffer.concat([Buffer.concat(head), rest]).toString("utf8"),
          outputLines,
        };
      }
      return {
        ...base,
        output: headText,
        tail: kept.toString("utf8"),
        outputLines,
        ...(spill !== undefined
          ? { fullOutputSaved: { bytes: spill.written, partial: spill.partial } }
          : {}),
      };
    },
  };
}

// 执行选项里与头尾保留、全文落盘有关的部分（本地与容器实现共用）
export function collectorExtras(options: HostExecOptions): CollectorExtras {
  return {
    ...(options.tailBytes !== undefined ? { tailBytes: options.tailBytes } : {}),
    ...(options.fullOutput !== undefined ? { fullOutput: options.fullOutput } : {}),
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
  const collected = createHeadCollector(options.maxOutputBytes, collectorExtras(options));
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
