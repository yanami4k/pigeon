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
import { spawn } from "node:child_process";
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

// 这一步的起点缺了"开工时的树"：无法按起点还原受保护的文件
export class StepStartLostError extends Error {}

// 一次还原的路径条数上限：避免撞上命令行长度限制
const RESTORE_BATCH = 200;
// "开工时的树"的提交：复制真实索引到临时索引，在其上 add -A 写成树，以起点提交（$1）为父提交；打印新提交
const START_TREE_SCRIPT = [
  "set -e",
  'idx="$(git rev-parse --git-path index)"; tmp="$idx.pigeon-start"; rm -f "$tmp"',
  '[ -f "$idx" ] && cp "$idx" "$tmp"',
  'export GIT_INDEX_FILE="$tmp"',
  "git add -A",
  'tree="$(git write-tree)"',
  'rm -f "$tmp"',
  'git -c user.name=pigeon -c user.email=pigeon@localhost commit-tree "$tree" -p "$1" -m "pigeon step start"',
].join("\n");
// 与开工时的树（$1）相比，现在被改动、删除或换了类型的文件（不含新建的）：同样在临时索引上 add -A 写成树再比，
// 不动真实索引与工作区；路径以 NUL 分隔
// agent 能改的 git 设置不得影响跑批器自己的 git 操作：不执行 .git/hooks 里的钩子，不跑 fsmonitor 程序
const SAFE_GIT = 'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; };';
// 相对开工时的树改过的路径：临时索引从开工时的树读起（不沿用工作区索引，agent 在里面设的 skip-worktree 与
// assume-unchanged 标记因此不起作用），再把工作区全部加进来比较
const CHANGED_SINCE_START_SCRIPT = [
  "set -e",
  SAFE_GIT,
  'idx="$(g rev-parse --git-path index)"; tmp="$idx.pigeon-now"; rm -f "$tmp"',
  'export GIT_INDEX_FILE="$tmp"',
  'g read-tree "$1"',
  "g add -A",
  'tree="$(g write-tree)"',
  'rm -f "$tmp"',
  'g diff-tree -r -z --name-only --no-renames --diff-filter=MDT "$1" "$tree"',
].join("\n");

// 把给定路径还原成开工时的版本：先去掉工作区索引里这些路径的 skip-worktree 与 assume-unchanged 标记（否则检出会跳过
// 它们；标记要以参数给路径才生效，--stdin 读入的路径不带标记操作；两种标记一次只认最后一个，分两次去），再检出
// （换成了目录的也由检出换回文件）、取消暂存；全程不执行钩子
const UNMARK = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false update-index";
// agent 留下的未解决冲突（merge、stash pop 等）先收成干净的索引：去掉进行中的合并状态，冲突路径按工作区里的样子暂存，
// 否则去标记会报 Unable to mark file、这一步被当成服务故障
const SETTLE_CONFLICTS = [
  'gd="$(g rev-parse --git-dir)";',
  'rm -f -- "$gd/MERGE_HEAD" "$gd/MERGE_MSG" "$gd/MERGE_MODE" "$gd/AUTO_MERGE" "$gd/CHERRY_PICK_HEAD" "$gd/REVERT_HEAD" &&',
  "g diff -z --name-only --diff-filter=U | xargs -0 -r git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A -- &&",
].join(" ");
const RESTORE_FROM_START_SCRIPT = [
  SAFE_GIT,
  'base="$1"; shift;',
  SETTLE_CONFLICTS,
  `g ls-files -z -- "$@" | xargs -0 -r ${UNMARK} --no-skip-worktree -- &&`,
  `g ls-files -z -- "$@" | xargs -0 -r ${UNMARK} --no-assume-unchanged -- &&`,
  'g checkout -q "$base" -- "$@" && g reset -q -- "$@"',
].join(" ");

// 跑批器与执行端自己在容器里执行的内部命令用的 shell：/bin/sh 取绝对路径（docker exec 按镜像的 PATH 找 sh，而镜像的
// PATH 可能以 agent 能改指的链接开头，例如 /opt/venv/bin），脚本开头把系统目录放到 PATH 最前（sh、find、git、chmod、
// timeout、rm 等都从 root 所有的系统目录解析）。只放到最前、不整个替换：本机测试的假 docker 在本机执行，本机的 git 在
// 系统目录之外；跑批器用到的工具在镜像里都位于系统目录，两种做法等效
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// 同时屏蔽全局与系统 git 配置（agent 能写 ~/.gitconfig，其中的 filter 驱动会在执行端的 git add 里被执行），并让 python
// 不加载用户目录下的 site（~/.local 下的 .pth、usercustomize 与同名包；切换依赖环境的脚本以 stream 身份跑 python）
export function trustedShell(script: string, ...args: readonly string[]): string[] {
  return [
    "/bin/sh",
    "-c",
    `PATH="${SYSTEM_PATH}:$PATH"; export PATH GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 PYTHONNOUSERSITE=1\n${script}`,
    "sh",
    ...args,
  ];
}
// 以固定 PATH 执行一条命令（argv[0] 从系统目录解析）
export function trustedCommand(argv: readonly string[]): string[] {
  return trustedShell('exec "$@"', ...argv);
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
  // 给"开工时的树"建的引用（如 refs/pigeon/step-start/<流>/<步>）：开工时的树是挂在起点提交下的独立提交，没有引用会被
  // 垃圾回收；有了引用，它随流历史一起导出，事后取得到
  stepStartRef?: string;
  // 辅助调用（解析路径、读写文件、列清单、重启容器）的超时，缺省 60 秒
  helperTimeoutMs?: number;
}

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;
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

  // 在工作区根执行一个辅助命令，失败即抛环境错误；返回标准输出
  // 执行端自己的命令（取起点、还原受保护文件）：以固定 PATH 执行，不经过 agent 能改指的链接
  const must = async (command: string[], what: string): Promise<Buffer> => {
    const result = await helper(execArgs(false, trustedCommand(command)));
    if (daemonFailure(result)) {
      throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
    }
    if (result.exitCode !== 0) {
      throw new ContainerHostError(`${what}失败：${result.stderr.trim()}`);
    }
    return result.stdout;
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
    async markStepStart() {
      const commit = (await must(["git", "rev-parse", "--verify", "HEAD"], "取起点提交"))
        .toString("utf8")
        .trim();
      // "开工时的树"：在临时索引上 add -A（不含被忽略的）写成树，挂在起点提交之下；不动真实索引与工作区
      const base = await must(["sh", "-c", START_TREE_SCRIPT, "sh", commit], "记下开工时的树");
      const baseCommit = base.toString("utf8").trim();
      if (options.stepStartRef !== undefined) {
        await must(
          [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "update-ref",
            "--no-deref",
            options.stepStartRef,
            baseCommit,
          ],
          "给开工时的树建引用"
        );
      }
      return { commit, baseCommit };
    },
    async restoreProtectedFromStepStart(mark, isProtected) {
      if (mark.baseCommit === undefined) {
        throw new StepStartLostError("这一步的起点没有开工时的树，无法还原受保护的文件");
      }
      const changed = (
        await must(
          ["sh", "-c", CHANGED_SINCE_START_SCRIPT, "sh", mark.baseCommit],
          "比对开工时的树"
        )
      )
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== "" && isProtected(p));
      // 检出开工时的版本再取消暂存
      for (let i = 0; i < changed.length; i += RESTORE_BATCH) {
        await must(
          [
            "sh",
            "-c",
            RESTORE_FROM_START_SCRIPT,
            "sh",
            mark.baseCommit,
            ...changed.slice(i, i + RESTORE_BATCH),
          ],
          "还原受保护的文件"
        );
      }
      return changed;
    },
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
  // 以哪个用户执行（缺省为镜像的用户）
  user?: string;
}): Promise<{ exitCode: number | null; stdout: string; stdoutBytes: Buffer; stderr: string }> {
  const result = await dockerOnce(
    input.docker ?? ["docker"],
    [
      "exec",
      ...(input.stdin !== undefined ? ["-i"] : []),
      ...(input.user !== undefined ? ["-u", input.user] : []),
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
