// 执行端接口的容器实现（决策 098）：工作区是一个运行中容器里的目录，读写与执行都经 docker CLI 的 exec 进入容器。
// 跨边界的四件事各自在这里保证：
//   ① 超时与中止：只杀 docker exec 客户端会把容器内的进程留成孤儿，故一律"杀客户端 + 重启整个容器"——
//      重启终结容器的 PID namespace，该命令起的所有进程随之消失；容器的可写层在重启前后保留，工作区内容不丢；
//   ② 退出码保真：docker exec 原样带回命令退出码（被信号终止为 128+N）；程序不存在（OCI 运行时报 126/127）
//      还原为 ENOENT，与本地实现同一口径；守护进程层面的失败（容器不在、守护进程不可达）按环境错误上抛，
//      不冒充命令的退出码；
//   ③ 输出截断：与本地实现共用同一个收集器——全量计字节数与哈希，只留开头；
//   ④ 路径映射：模型给的路径在容器内按工作区根解析（符号链接解析后）再判包含，宿主路径不参与。
// 宿主环境变量不进容器：容器内环境由镜像与本实现的 env 选项决定。
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createHeadCollector } from "../tools/local-host.ts";
import { WorkspacePathError, WorkspacePathNotFoundError } from "../tools/paths.ts";
import type {
  HostExecOptions,
  HostExecPlan,
  HostExecResult,
  HostFileSnapshot,
  WorkspaceHost,
} from "../tools/workspace-host.ts";

// 环境错误：docker 自身或容器出了问题（区别于命令的非零退出）
export class ContainerHostError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

export interface ContainerHostOptions {
  // 容器名或 id（须已在运行）
  container: string;
  // 容器内的工作区根（绝对路径）
  root: string;
  // docker CLI 的调用前缀（缺省 ["docker"]；测试注入替身）
  docker?: readonly string[];
  // 每次 exec 带入容器的环境变量（如外部基准镜像里激活测试环境所需的 PATH）
  env?: Readonly<Record<string, string>>;
  // 辅助调用（解析路径、读写文件、列清单、重启容器）的超时，缺省 60 秒
  helperTimeoutMs?: number;
}

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;
// 同步读的缓冲上限
const SYNC_READ_MAX_BYTES = 256 * 1024 * 1024;
// 路径不存在时辅助脚本用的退出码
const EXIT_MISSING = 3;

interface HelperResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

export function createContainerWorkspaceHost(options: ContainerHostOptions): WorkspaceHost {
  const [dockerProgram = "docker", ...dockerPrefix] = options.docker ?? ["docker"];
  const helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const root = path.posix.normalize(options.root);
  const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  const execArgs = (interactive: boolean, command: readonly string[]): string[] => [
    ...dockerPrefix,
    "exec",
    ...(interactive ? ["-i"] : []),
    "-w",
    root,
    ...envArgs,
    options.container,
    ...command,
  ];

  // 辅助调用：输出整体收下（文件内容、解析结果）
  const helper = (args: string[], input?: string): Promise<HelperResult> =>
    dockerOnce([dockerProgram], args, helperTimeoutMs, input);

  const daemonFailure = (result: { exitCode: number | null; stderr: string }): boolean =>
    result.exitCode === null ||
    /^(Error response from daemon|Cannot connect to)/m.test(result.stderr);

  // 容器内解析：目标须存在；符号链接解析后的规范路径
  const RESOLVE_SCRIPT = `[ -e "$1" ] || exit ${EXIT_MISSING}; readlink -f -- "$1"`;
  let realRoot: string | undefined;
  const insideRoot = (base: string, target: string): boolean =>
    target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
  const checkResolved = (
    inputPath: string,
    result: { exitCode: number | null; stderr: string },
    stdout: string,
    base: string | undefined
  ): string => {
    if (daemonFailure(result)) {
      throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
    }
    const target = stdout.replace(/\n$/, "");
    if (result.exitCode === EXIT_MISSING) {
      throw new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`);
    }
    if (result.exitCode !== 0 || target === "") {
      throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
    }
    if (base !== undefined && !insideRoot(base, target)) {
      throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
    }
    return target;
  };
  const resolveRoot = async (): Promise<string> => {
    if (realRoot === undefined) {
      const result = await helper(execArgs(false, ["sh", "-c", RESOLVE_SCRIPT, "sh", root]));
      realRoot = checkResolved(root, result, result.stdout.toString("utf8"), undefined);
    }
    return realRoot;
  };

  const restart = async (): Promise<void> => {
    const result = await helper([...dockerPrefix, "restart", "-t", "0", options.container]);
    if (result.exitCode !== 0) {
      throw new ContainerHostError(`容器重启失败：${result.stderr.trim()}`);
    }
  };

  return {
    platform: "linux",
    root,
    async resolveExisting(inputPath) {
      const base = await resolveRoot();
      const result = await helper(execArgs(false, ["sh", "-c", RESOLVE_SCRIPT, "sh", inputPath]));
      return checkResolved(inputPath, result, result.stdout.toString("utf8"), base);
    },
    async isFile(resolvedPath) {
      const result = await helper(execArgs(false, ["test", "-f", resolvedPath]));
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      return result.exitCode === 0;
    },
    async readText(resolvedPath) {
      const result = await helper(execArgs(false, ["cat", "--", resolvedPath]));
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`读取失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
      return result.stdout.toString("utf8");
    },
    async writeText(resolvedPath, content) {
      // 截断重写同一个文件：权限与属主不变
      const result = await helper(
        execArgs(true, ["sh", "-c", 'cat > "$1"', "sh", resolvedPath]),
        content
      );
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`写入失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
    },
    readTextSync(inputPath) {
      const run = (command: readonly string[]) => {
        const result = spawnSync(dockerProgram, execArgs(false, command), {
          timeout: helperTimeoutMs,
          windowsHide: true,
          // 缺省缓冲只有 1 MB：大文件会被判成失败
          maxBuffer: SYNC_READ_MAX_BYTES,
        });
        if (result.error !== undefined) {
          throw new ContainerHostError(`docker 拉不起来：${result.error.message}`);
        }
        return {
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr.toString("utf8"),
        };
      };
      const base = run(["sh", "-c", RESOLVE_SCRIPT, "sh", root]);
      const realBase = checkResolved(root, base, base.stdout.toString("utf8"), undefined);
      const resolved = run(["sh", "-c", RESOLVE_SCRIPT, "sh", inputPath]);
      const target = checkResolved(inputPath, resolved, resolved.stdout.toString("utf8"), realBase);
      const content = run(["cat", "--", target]);
      if (content.exitCode !== 0) {
        throw new ContainerHostError(`读取失败：${target}（${content.stderr.trim()}）`);
      }
      return content.stdout.toString("utf8");
    },
    exec(plan: HostExecPlan, execOptions: HostExecOptions): Promise<HostExecResult> {
      const collected = createHeadCollector(execOptions.maxOutputBytes);
      // OCI 运行时与守护进程的报错可能落在任一输出流：两路各留一小段开头用来识别
      let stderrHead = "";
      let stdoutHead = "";
      return new Promise((resolve, reject) => {
        let timedOut = false;
        let terminating: Promise<void> | undefined;
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(dockerProgram, execArgs(false, [plan.program, ...plan.args]), {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          reject(
            new ContainerHostError(
              `docker 拉不起来：${error instanceof Error ? error.message : String(error)}`
            )
          );
          return;
        }
        child.stdout?.on("data", (chunk: Buffer) => {
          collected.push(chunk);
          if (stdoutHead.length < 2048) {
            stdoutHead += chunk.toString("utf8");
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          collected.push(chunk);
          if (stderrHead.length < 2048) {
            stderrHead += chunk.toString("utf8");
          }
        });
        // 终止：杀客户端只断开连接，容器内进程仍在跑；重启容器才杀得干净（见文件头 ①）
        const terminate = (): void => {
          if (terminating === undefined) {
            child.kill("SIGKILL");
            terminating = restart();
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, execOptions.timeoutMs);
        const onAbort = (): void => terminate();
        execOptions.signal?.addEventListener("abort", onAbort, { once: true });
        if (execOptions.signal?.aborted === true) {
          terminate();
        }
        const cleanup = (): void => {
          clearTimeout(timer);
          execOptions.signal?.removeEventListener("abort", onAbort);
        };
        child.on("error", (error) => {
          cleanup();
          reject(new ContainerHostError(`docker 拉不起来：${error.message}`));
        });
        child.on("close", (code, signal) => {
          cleanup();
          const settle = (): void => {
            const output = collected.finish();
            if (terminating !== undefined) {
              resolve({ spawned: true, exitCode: null, timedOut, ...output });
              return;
            }
            // 进程没起来（OCI 运行时报错）：程序不存在还原为 ENOENT、不可执行为 EACCES，与本地实现同一口径；
            // 其余（如工作目录不存在）是容器侧的环境问题
            const ociFailure = [stderrHead, stdoutHead].find((head) =>
              /^OCI runtime exec failed/m.test(head)
            );
            if ((code === 126 || code === 127) && ociFailure !== undefined) {
              const missing =
                /executable file not found|no such file or directory/i.test(ociFailure) &&
                !/chdir to cwd/i.test(ociFailure);
              if (!missing && !/permission denied/i.test(ociFailure)) {
                reject(new ContainerHostError(`容器内进程起不来：${ociFailure.trim()}`));
                return;
              }
              const spawnError: NodeJS.ErrnoException = new Error(ociFailure.trim());
              spawnError.code = missing ? "ENOENT" : "EACCES";
              resolve({ spawned: false, spawnError, exitCode: null, timedOut, ...output });
              return;
            }
            if (daemonFailure({ exitCode: code, stderr: stderrHead })) {
              reject(new ContainerHostError(`容器不可用：${stderrHead.trim()}`));
              return;
            }
            resolve({
              spawned: true,
              exitCode: code,
              ...(signal !== null ? { signal } : {}),
              timedOut,
              ...output,
            });
          };
          if (terminating !== undefined) {
            // 等容器重启完成再交还结果：下一条命令不会撞上正在重启的容器
            terminating.then(settle, reject);
          } else {
            settle();
          }
        });
      });
    },
    async listFiles(limit): Promise<HostFileSnapshot> {
      // 不跟进版本库元数据与依赖目录（与本地实现同一口径）；多取一行用来判定是否超限
      const script =
        "find . \\( -name .git -o -name node_modules \\) -prune -o -type f " +
        `-exec stat -c '%n\t%s:%y' {} + | head -n ${limit + 1}`;
      const result = await helper(execArgs(false, ["sh", "-c", script]));
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const files = new Map<string, string>();
      let truncated = false;
      for (const line of result.stdout.toString("utf8").split("\n")) {
        const tab = line.lastIndexOf("\t");
        if (tab <= 0) {
          continue;
        }
        if (files.size >= limit) {
          truncated = true;
          break;
        }
        files.set(line.slice(0, tab).replace(/^\.\//, ""), line.slice(tab + 1));
      }
      return { files, truncated };
    },
    findLauncherScript: () => undefined,
  };
}

export interface StartContainerOptions {
  image: string;
  name: string;
  docker?: readonly string[];
  // docker run 的附加参数（内存上限等）
  runArgs?: readonly string[];
  timeoutMs?: number;
}

function dockerOnce(
  docker: readonly string[],
  args: readonly string[],
  timeoutMs: number,
  input?: string | Buffer
): Promise<HelperResult> {
  const [program = "docker", ...prefix] = docker;
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...prefix, ...args], {
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (input !== undefined) {
      // 容器侧提前退出时写端会报 EPIPE：结果以退出码为准
      child.stdin?.on("error", () => {});
      if (typeof input === "string") child.stdin?.end(input, "utf8");
      else child.stdin?.end(input);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ContainerHostError(`docker 拉不起来：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

// 起一个常驻容器当工作区：主进程只负责占位（--init 让 1 号进程回收孤儿），活都经 exec 进去干
export async function startWorkspaceContainer(options: StartContainerOptions): Promise<void> {
  const docker = options.docker ?? ["docker"];
  const result = await dockerOnce(
    docker,
    [
      "run",
      "-d",
      "--init",
      "--name",
      options.name,
      ...(options.runArgs ?? []),
      options.image,
      "tail",
      "-f",
      "/dev/null",
    ],
    options.timeoutMs ?? 300_000
  );
  if (result.exitCode !== 0) {
    throw new ContainerHostError(`容器起不来（${options.image}）：${result.stderr.trim()}`);
  }
}

// 强制移除容器；容器本就不存在视为已移除
export async function removeWorkspaceContainer(
  name: string,
  docker: readonly string[] = ["docker"]
): Promise<void> {
  const result = await dockerOnce(docker, ["rm", "-f", name], 120_000);
  if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
    throw new ContainerHostError(`容器移除失败（${name}）：${result.stderr.trim()}`);
  }
}

// 按标签列出容器名（含已停止的）：任务源据此认领并清理自己留下的残留容器
export async function listContainersByLabel(
  label: string,
  docker: readonly string[] = ["docker"]
): Promise<string[]> {
  const result = await dockerOnce(
    docker,
    ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"],
    DEFAULT_HELPER_TIMEOUT_MS
  );
  if (result.exitCode !== 0) {
    throw new ContainerHostError(`列出容器失败：${result.stderr.trim()}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// 在容器内执行一条辅助命令并收下全部输出（任务源取 diff、建基线用；延续式跑批经 stdin 送入人的文件与起点历史）
export async function containerExec(input: {
  container: string;
  command: readonly string[];
  workdir?: string;
  docker?: readonly string[];
  timeoutMs?: number;
  // 送入命令标准输入的内容（可为二进制）
  stdin?: string | Buffer;
}): Promise<{ exitCode: number | null; stdout: string; stdoutBytes: Buffer; stderr: string }> {
  const result = await dockerOnce(
    input.docker ?? ["docker"],
    [
      "exec",
      ...(input.stdin !== undefined ? ["-i"] : []),
      ...(input.workdir !== undefined ? ["-w", input.workdir] : []),
      input.container,
      ...input.command,
    ],
    input.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    input.stdin
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stdoutBytes: result.stdout,
    stderr: result.stderr,
  };
}
