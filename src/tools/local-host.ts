// 执行端接口的本地实现（决策 098）：工作区是宿主上的一个目录，读写走 node:fs，命令作为宿主子进程在工作区根执行。
// 路径围栏沿用 paths.ts 的 realpath 口径；进程执行、文件清单与 .cmd / .bat 解析从 run-command.ts 原样平移，行为不变。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    readBytes: (resolvedPath) => readFile(resolvedPath),
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

// 辅助程序的绝对路径（决策 368）：给了绝对路径的照用；只给名字的在 PATH 的绝对目录里找，跳过空项、相对目录与工作区之内的
// 目录——进程启动按 PATH 找程序（Node 以 shell: false 启动时不在当前目录找），PATH 里的相对目录或落在工作区之内的目录
// 会让工作区里放好的同名程序被执行，故不把裸名字交给它；Windows 只认 .exe、.com。找不到为 undefined
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

// 输出收集：全量计字节数与哈希，只留开头 maxBytes 字节（本地与容器实现共用）。
// 决策 356：给了 tailBytes 另留末尾、另计总行数；给了 fullOutput 且输出超过开头加末尾两段时，从超过的那一刻起把全量输出
// （含此前留在内存里的部分）写进文件，至多 fullOutput.maxBytes 字节。文件以独占方式新建、不跟随链接；建目录、打开或写入
// 出错（磁盘满、文件已在、被换成链接）即停止落盘、关掉文件，照常给出头尾并在结果里写明原因，不让异常漏到数据回调外。
// 开头与末尾按字节截取后对齐到 UTF-8 字符边界（不出现半个字符）
export interface HeadCollector {
  push(chunk: Buffer): void;
  bytes(): number;
  // 收尾：哈希只能取一次
  finish(): Pick<
    HostExecResult,
    | "outputBytes"
    | "outputHash"
    | "output"
    | "tail"
    | "outputLines"
    | "fullOutputSaved"
    | "fullOutputError"
  >;
}

// Windows 没有 O_NOFOLLOW；独占新建本身不跟随最后一级的链接
const SPILL_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

// 开头去掉末尾不完整的 UTF-8 字符
function utf8Head(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && ((buffer[index] ?? 0) & 0xc0) === 0x80) {
    index -= 1;
    continuation += 1;
  }
  if (index < 0) return buffer;
  const lead = buffer[index] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return width > continuation + 1 ? buffer.subarray(0, index) : buffer;
}

// 末尾去掉开头不完整的 UTF-8 字符（续字节）
function utf8Tail(buffer: Buffer): Buffer {
  let index = 0;
  while (index < buffer.length && index < 3 && ((buffer[index] ?? 0) & 0xc0) === 0x80) index += 1;
  return buffer.subarray(index);
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
  let spillError: string | undefined;
  const stopSpill = (error: unknown): void => {
    spillError = error instanceof Error ? error.message : String(error);
    if (spill !== undefined) {
      try {
        closeSync(spill.fd);
      } catch {
        // 已关
      }
      spill = undefined;
    }
  };
  const spillWrite = (chunk: Buffer): void => {
    if (spill === undefined || extras.fullOutput === undefined) return;
    const room = extras.fullOutput.maxBytes - spill.written;
    const piece = room < chunk.length ? chunk.subarray(0, Math.max(0, room)) : chunk;
    try {
      if (piece.length > 0) {
        writeSync(spill.fd, piece);
        spill.written += piece.length;
      }
    } catch (error) {
      stopSpill(error);
      return;
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
          spillError === undefined &&
          outputBytes > maxBytes + tailBytes
        ) {
          // 头一回超过：此前的输出全在开头与末尾两段里（开头之后的部分是末尾缓冲的最后 before − 开头 字节）；
          // 先于本块进开头缓冲，免得本块的开头一段写两遍
          try {
            mkdirSync(path.dirname(extras.fullOutput.path), { recursive: true });
            spill = {
              fd: openSync(extras.fullOutput.path, SPILL_FLAGS, 0o600),
              written: 0,
              partial: false,
            };
          } catch (error) {
            stopSpill(error);
          }
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
      const headAll = Buffer.concat(head);
      const headText = (outputBytes > headBytes ? utf8Head(headAll) : headAll).toString("utf8");
      const base = { outputBytes, outputHash: hash.digest("hex") };
      if (tailBytes <= 0) {
        return { ...base, output: headText };
      }
      const outputLines = newlines + (lastByte !== undefined && lastByte !== 0x0a ? 1 : 0);
      const kept = tailBuffer();
      if (spill !== undefined) {
        try {
          closeSync(spill.fd);
        } catch (error) {
          stopSpill(error);
        }
      }
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
        tail: utf8Tail(kept).toString("utf8"),
        outputLines,
        ...(spill !== undefined && spillError === undefined
          ? { fullOutputSaved: { bytes: spill.written, partial: spill.partial } }
          : {}),
        ...(spillError !== undefined ? { fullOutputError: spillError } : {}),
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
  options: HostExecOptions,
  // 分开的 stdout / stderr 各自保留的上限（缺省 HOST_SEPARATE_STREAM_CAP）
  streamCap: number = HOST_SEPARATE_STREAM_CAP
): Promise<HostExecResult> {
  const collected = createHeadCollector(options.maxOutputBytes, collectorExtras(options));
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

// 决策 360：只按 PATH 找程序（不查工作树根与当前目录，PATH 里的相对目录也跳过）：不带扩展名的同一目录里 .exe / .com 优先于
// .cmd / .bat；找不到给 undefined。带命令前缀范围的 worker 在 Windows 上用它，免得工作树里的同名程序顶替前缀写的程序
export function windowsPathProgram(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const extensions = path.extname(program) !== "" ? [""] : [".exe", ".com", ".cmd", ".bat"];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
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
