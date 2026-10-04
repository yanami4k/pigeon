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
import { createHeadCollector, HOST_SEPARATE_STREAM_CAP } from "../tools/local-host.ts";
import {
  pathChanged,
  symlinkRefused,
  WorkspacePathError,
  WorkspacePathNotFoundError,
} from "../tools/paths.ts";
import {
  classifyRealPath,
  deniedEntry,
  POSIX_PATH_RULES,
  ReadDeniedError,
  type ReadPathClass,
  type ResolvedDenyEntry,
  readDeniedMessage,
} from "../tools/read-deny.ts";
import {
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
  type MemoryLimitExceeded,
  memoryLimitText,
  SYSTEM_PATH,
  type WorkspaceHost,
} from "../tools/workspace-host.ts";

// 环境错误：docker 自身或容器出了问题（区别于命令的非零退出）
export class ContainerHostError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

// 跑批器与执行端自己在容器里执行的内部命令用的 shell：/bin/sh 取绝对路径（docker exec 按镜像的 PATH 找 sh，而镜像的
// PATH 可能以 agent 能改指的链接开头，例如 /opt/venv/bin），脚本开头把系统目录放到 PATH 最前（sh、find、git、chmod、
// timeout、rm 等都从 root 所有的系统目录解析）。只放到最前、不整个替换：本机测试的假 docker 在本机执行，本机的 git 在
// 系统目录之外；跑批器用到的工具在镜像里都位于系统目录，两种做法等效。系统目录 SYSTEM_PATH 见 tools/workspace-host.ts
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
  // 决策 333：容器设了内存上限时在场——每条命令前后读容器 cgroup 的 oom_kill 计数，计数增加即判超出上限；
  // 读不到计数时，退出码 137 判"可能超出"。label 为上限的可读写法；counterFiles 为计数所在文件（缺省 cgroup v2 的
  // memory.events 与 v1 的 memory.oom_control，依次取第一个读得到的；测试注入）
  memoryLimit?: { label: string; counterFiles?: readonly string[] };
  // 运行中给人看的一行（超出内存上限等）
  onNotice?: (line: string) => void;
}

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;
// 路径不存在时辅助脚本用的退出码
const EXIT_MISSING = 3;
// 决策 334：要写的文件是符号链接（标准输出为其指向）、写入前重新解析得到别的路径（标准输出为新的解析结果）
const EXIT_SYMLINK = 5;
const EXIT_CHANGED = 6;
// 决策 333：容器 cgroup 里 oom_kill 计数所在的文件（cgroup v2、v1）；依次取第一个读得到且有该行的，都没有即退出码 4
export const OOM_COUNTER_FILES: readonly string[] = [
  "/sys/fs/cgroup/memory.events",
  "/sys/fs/cgroup/memory/memory.oom_control",
];
const OOM_COUNT_SCRIPT = [
  'for f in "$@"; do',
  '  [ -r "$f" ] || continue',
  `  n="$(sed -n 's/^oom_kill //p' "$f")"`,
  '  [ -n "$n" ] && { echo "$n"; exit 0; }',
  "done",
  "exit 4",
].join("\n");
// 写工具的解析：模型给的路径本身是符号链接即报出指向，否则同 RESOLVE_SCRIPT
const RESOLVE_FOR_WRITE_SCRIPT = `[ -L "$1" ] && { readlink -- "$1"; exit ${EXIT_SYMLINK}; }; [ -e "$1" ] || exit ${EXIT_MISSING}; readlink -f -- "$1"`;
// 决策 355：读档解析（不限工作区）与禁读名单在容器里的真实路径。第一个参数为目标（空串即只解析名单），其后为名单各项；
// 输出以 NUL 分隔：给了目标时先是目标的真实路径，再按项各两段——展开 ~（容器内的家目录）后的字面路径、它存在时的真实路径
//（不存在为空串）。经 trustedShell 执行：readlink 从系统目录解析，agent 改不了
const DENY_ENTRIES_SCRIPT = [
  'for p in "$@"; do',
  `  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/\${p#"~/"}" ;; esac`,
  `  printf '%s\\0' "$p"`,
  `  if [ -e "$p" ]; then printf '%s\\0' "$(readlink -f -- "$p")"; else printf '\\0'; fi`,
  "done",
].join("\n");
const READ_RESOLVE_SCRIPT = [
  't="$1"; shift',
  `if [ -n "$t" ]; then [ -e "$t" ] || exit ${EXIT_MISSING}; r="$(readlink -f -- "$t")" && [ -n "$r" ] || exit 1; printf '%s\\0' "$r"; fi`,
  DENY_ENTRIES_SCRIPT,
].join("\n");
// 决策 355 / 368：grep、glob 的结果逐个取真实路径——参数为名单各项（输出同上）；标准输入给出 NUL 分隔的相对路径，
// 每 500 个一批。有 GNU 的 realpath（-z -m：每个输入恰好一个输出）时整批一次：先输出 "B NUL 个数 NUL" 与这批输入，再输出
// 各自的真实路径；没有的（busybox）逐个 readlink -f，每个输出 "P NUL 输入 NUL 真实路径 NUL"（取不到为空串）
const CLASSIFY_SCRIPT = [
  DENY_ENTRIES_SCRIPT,
  `xargs -0 -n 500 /bin/sh -c 'if realpath -z -m -- / >/dev/null 2>&1; then printf "B\\0%s\\0" "$#"; printf "%s\\0" "$@"; realpath -z -m -- "$@"; else for f do r="$(readlink -f -- "$f")" || r=""; printf "P\\0%s\\0%s\\0" "$f" "$r"; done; fi' sh`,
].join("\n");
// 决策 368：Pigeon 自己的辅助程序（搜索后端）——经 trustedShell 执行，程序按系统目录优先解析，不带 ripgrep 配置
const HELPER_EXEC_SCRIPT = 'unset RIPGREP_CONFIG_PATH; exec "$@"';
// 决策 368：glob 按修改时间排序——标准输入给出 NUL 分隔的相对路径，每行输出"秒数 路径"；取不到的文件不输出
const MTIMES_SCRIPT = "xargs -0 stat -c '%Y %n' -- 2>/dev/null; exit 0";
// 写入前复核后截断重写（同一次 exec 里复核与写入，空隙尽量小）：目标不得是符号链接、须仍在、重新解析须得到它自己
const WRITE_SCRIPT = [
  `[ -L "$1" ] && { readlink -- "$1"; exit ${EXIT_SYMLINK}; }`,
  `[ -e "$1" ] || exit ${EXIT_MISSING}`,
  `t="$(readlink -f -- "$1")"; [ "$t" = "$1" ] || { printf '%s\\n' "$t"; exit ${EXIT_CHANGED}; }`,
  'cat > "$1"',
].join("\n");

export interface HelperResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  // 到了限时：容器内 timeout 终止了命令，或客户端被兜底杀掉
  timedOut?: boolean;
}

export function createContainerWorkspaceHost(options: ContainerHostOptions): WorkspaceHost {
  const [dockerProgram = "docker", ...dockerPrefix] = options.docker ?? ["docker"];
  const helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const root = path.posix.normalize(options.root);
  const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  const docker = [dockerProgram, ...dockerPrefix];
  const execFlags = (interactive: boolean, extraEnv?: NodeJS.ProcessEnv): string[] => [
    ...(interactive ? ["-i"] : []),
    "-w",
    root,
    ...envArgs,
    // 单次调用只放行 PIGEON_* 协议变量（钩子的 PIGEON_PROJECT_DIR）：宿主环境的其余变量不渗进容器
    ...Object.entries(extraEnv ?? {})
      .filter(([key]) => key.startsWith("PIGEON_"))
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];
  const execArgs = (
    interactive: boolean,
    command: readonly string[],
    extraEnv?: NodeJS.ProcessEnv
  ): string[] => [
    ...dockerPrefix,
    "exec",
    ...execFlags(interactive, extraEnv),
    options.container,
    ...command,
  ];

  // 辅助调用：输出整体收下（文件内容、解析结果）；容器内以 timeout 限时（决策 335，见 containerHelperExec）
  const helper = (interactive: boolean, command: readonly string[], input?: string) =>
    containerHelperExec({
      docker,
      container: options.container,
      flags: execFlags(interactive),
      command,
      timeoutMs: helperTimeoutMs,
      ...(input !== undefined ? { stdin: input } : {}),
    });

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
      const result = await helper(false, ["sh", "-c", RESOLVE_SCRIPT, "sh", root]);
      realRoot = checkResolved(root, result, result.stdout.toString("utf8"), undefined);
    }
    return realRoot;
  };

  // 脚本输出里从 offset 起的名单各项：每项两段（字面路径、存在时的真实路径）
  const denyEntriesOf = (
    fields: readonly string[],
    offset: number,
    deny: readonly string[]
  ): ResolvedDenyEntry[] =>
    deny.map((entry, index) => {
      const literal = fields[offset + index * 2] ?? "";
      const real = fields[offset + index * 2 + 1] ?? "";
      return { entry, paths: [...new Set([literal, real].filter((value) => value !== ""))] };
    });

  // 决策 355：目标（空串即不解析目标）与禁读名单在容器里的真实路径，一次 exec
  const resolveReadPaths = async (
    inputPath: string,
    deny: readonly string[]
  ): Promise<{ target: string; entries: ResolvedDenyEntry[] }> => {
    const result = await helper(false, trustedShell(READ_RESOLVE_SCRIPT, inputPath, ...deny));
    if (daemonFailure(result)) {
      throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
    }
    if (result.exitCode === EXIT_MISSING) {
      throw new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`);
    }
    const fields = result.stdout.toString("utf8").split("\0");
    const offset = inputPath === "" ? 0 : 1;
    const target = inputPath === "" ? "" : (fields[0] ?? "");
    if (result.exitCode !== 0 || (inputPath !== "" && target === "")) {
      throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
    }
    return { target, entries: denyEntriesOf(fields, offset, deny) };
  };

  const restart = (): Promise<void> => restartContainer(docker, options.container, helperTimeoutMs);

  // agent 命令的执行（文件头 ①–③）
  const runExec = (
    plan: HostExecPlan,
    execOptions: HostExecOptions,
    streamCap: number = HOST_SEPARATE_STREAM_CAP
  ): Promise<HostExecResult> => {
    const collected = createHeadCollector(execOptions.maxOutputBytes);
    // 分开的两路输出（钩子协议要区分 stdout 与 stderr；上限同本机，辅助程序另给）
    const stdoutOnly = createHeadCollector(streamCap);
    const stderrOnly = createHeadCollector(streamCap);
    // OCI 运行时与守护进程的报错可能落在任一输出流：两路各留一小段开头用来识别
    let stderrHead = "";
    let stdoutHead = "";
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let terminating: Promise<void> | undefined;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          dockerProgram,
          execArgs(execOptions.stdin !== undefined, [plan.program, ...plan.args], execOptions.env),
          {
            stdio: [execOptions.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
          }
        );
        // 标准输入（钩子事件 JSON）：写完即收尾，容器内命令读完自行结束
        child.stdin?.on("error", () => {});
        if (execOptions.stdin !== undefined) child.stdin?.end(execOptions.stdin, "utf8");
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
        stdoutOnly.push(chunk);
        if (stdoutHead.length < 2048) {
          stdoutHead += chunk.toString("utf8");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        collected.push(chunk);
        stderrOnly.push(chunk);
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
          const output = {
            ...collected.finish(),
            stdout: stdoutOnly.finish().output,
            stderr: stderrOnly.finish().output,
          };
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
  };

  // 容器的 oom_kill 计数；读不到为 undefined
  const counterFiles = options.memoryLimit?.counterFiles ?? OOM_COUNTER_FILES;
  const readOomKills = async (): Promise<number | undefined> => {
    try {
      const result = await helper(false, trustedShell(OOM_COUNT_SCRIPT, ...counterFiles));
      const text = result.stdout.toString("utf8").trim();
      return result.exitCode === 0 && /^\d+$/.test(text) ? Number(text) : undefined;
    } catch {
      return undefined;
    }
  };

  // 决策 333：设了内存上限时，命令前后比 oom_kill 计数；超出即在结果上标出，并给人报一行
  const execWithMemoryCheck = async (
    plan: HostExecPlan,
    execOptions: HostExecOptions,
    limit: string
  ): Promise<HostExecResult> => {
    const before = await readOomKills();
    const result = await runExec(plan, execOptions);
    // 超时与中止会重启容器（计数随之归零），程序没起来也无从谈起
    if (!result.spawned || result.exitCode === null) {
      return result;
    }
    const after = before === undefined ? undefined : await readOomKills();
    const exceeded: MemoryLimitExceeded | undefined =
      before !== undefined && after !== undefined
        ? after > before
          ? { limit, certain: true }
          : undefined
        : result.exitCode === 137
          ? { limit, certain: false }
          : undefined;
    if (exceeded === undefined) {
      return result;
    }
    options.onNotice?.(`${memoryLimitText(exceeded)}（${[plan.program, ...plan.args].join(" ")}）`);
    return { ...result, memoryLimitExceeded: exceeded };
  };

  return {
    platform: "linux",
    root,
    async resolveExisting(inputPath) {
      const base = await resolveRoot();
      const result = await helper(false, ["sh", "-c", RESOLVE_SCRIPT, "sh", inputPath]);
      return checkResolved(inputPath, result, result.stdout.toString("utf8"), base);
    },
    async resolveForWrite(inputPath) {
      const base = await resolveRoot();
      const result = await helper(false, trustedShell(RESOLVE_FOR_WRITE_SCRIPT, inputPath));
      const stdout = result.stdout.toString("utf8");
      if (result.exitCode === EXIT_SYMLINK) {
        throw symlinkRefused(inputPath, stdout.replace(/\n$/, ""));
      }
      return checkResolved(inputPath, result, stdout, base);
    },
    async resolveForRead(inputPath, deny) {
      const base = await resolveRoot();
      const { target, entries } = await resolveReadPaths(inputPath, deny);
      const entry = deniedEntry(target, entries, POSIX_PATH_RULES);
      if (entry !== undefined) {
        throw new ReadDeniedError(readDeniedMessage(inputPath, entry));
      }
      return { path: target, outside: !insideRoot(base, target) };
    },
    async classifyReadPaths(relPaths, deny, signal) {
      const base = await resolveRoot();
      const classes = new Map<string, ReadPathClass>();
      if (signal?.aborted === true) {
        return { classes, incomplete: true };
      }
      const result = await helper(
        true,
        trustedShell(CLASSIFY_SCRIPT, ...deny),
        relPaths.length > 0 ? `${relPaths.join("\0")}\0` : ""
      );
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const fields = result.stdout.toString("utf8").split("\0");
      const entries = denyEntriesOf(fields, 0, deny);
      const classify = (rel: string | undefined, real: string | undefined) => {
        if (rel !== undefined && rel !== "" && real !== undefined && real !== "") {
          classes.set(rel, classifyRealPath(base, real, entries, POSIX_PATH_RULES));
        }
      };
      // 按批对齐；输出被截断（超时）即停，标明不完整
      let complete = true;
      let index = deny.length * 2;
      while (index < fields.length - 1) {
        const tag = fields[index];
        if (tag === "B") {
          const count = Number(fields[index + 1]);
          const end = index + 2 + 2 * count;
          if (!Number.isInteger(count) || count < 0 || end > fields.length - 1) {
            complete = false;
            break;
          }
          for (let at = 0; at < count; at += 1) {
            classify(fields[index + 2 + at], fields[index + 2 + count + at]);
          }
          index = end;
        } else if (tag === "P" && index + 2 < fields.length - 1) {
          classify(fields[index + 1], fields[index + 2]);
          index += 3;
        } else {
          complete = false;
          break;
        }
      }
      return { classes, incomplete: result.timedOut === true || !complete };
    },
    execHelper(program, args, execOptions) {
      const [shell = "/bin/sh", ...rest] = trustedShell(HELPER_EXEC_SCRIPT, program, ...args);
      return runExec(
        { program: shell, args: rest, verbatim: false },
        execOptions,
        execOptions.maxOutputBytes
      );
    },
    async fileMtimes(relPaths) {
      const times = new Map<string, number>();
      if (relPaths.length === 0) {
        return times;
      }
      // 文件清单经标准输入以 NUL 分隔交给 xargs，不进命令行；stat 从系统目录解析
      const result = await helper(true, trustedShell(MTIMES_SCRIPT), `${relPaths.join("\0")}\0`);
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      for (const line of result.stdout.toString("utf8").split("\n")) {
        const space = line.indexOf(" ");
        const seconds = Number(line.slice(0, space));
        if (space > 0 && Number.isFinite(seconds)) {
          times.set(line.slice(space + 1).replace(/^\.\//, ""), seconds * 1000);
        }
      }
      return times;
    },
    async isFile(resolvedPath) {
      const result = await helper(false, ["test", "-f", resolvedPath]);
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      return result.exitCode === 0;
    },
    async readText(resolvedPath) {
      const result = await helper(false, ["cat", "--", resolvedPath]);
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`读取失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
      return result.stdout.toString("utf8");
    },
    async writeText(resolvedPath, content) {
      // 截断重写同一个文件：权限与属主不变；写入前复核路径（决策 334）
      const result = await helper(true, trustedShell(WRITE_SCRIPT, resolvedPath), content);
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const stdout = result.stdout.toString("utf8").replace(/\n$/, "");
      if (result.exitCode === EXIT_SYMLINK) {
        throw symlinkRefused(resolvedPath, stdout);
      }
      if (result.exitCode === EXIT_MISSING || result.exitCode === EXIT_CHANGED) {
        throw pathChanged(resolvedPath, result.exitCode === EXIT_CHANGED ? stdout : undefined);
      }
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`写入失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
    },
    exec(plan: HostExecPlan, execOptions: HostExecOptions): Promise<HostExecResult> {
      return options.memoryLimit === undefined
        ? runExec(plan, execOptions)
        : execWithMemoryCheck(plan, execOptions, options.memoryLimit.label);
    },
    async listFiles(limit): Promise<HostFileSnapshot> {
      // 不跟进两份名单里的目录（与本地实现同一口径：任意层级按名字，工作区根下的只认根下那一个目录）；
      // 多取一行用来判定是否超限
      const pruned = [
        ...LISTING_SKIPPED_DIRS.map((name) => `-name ${name}`),
        ...LISTING_SKIPPED_ROOT_DIRS.map((name) => `\\( -path ./${name} -type d \\)`),
      ].join(" -o ");
      const script =
        `find . \\( ${pruned} \\) -prune -o -type f ` +
        `-exec stat -c '%n\t%s:%y' {} + | head -n ${limit + 1}`;
      const result = await helper(false, ["sh", "-c", script]);
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

// 容器断网的 docker run 参数：跑批器的工作区容器恒用它，日常沙箱的断网档也用它
export const NO_NETWORK_ARGS = ["--network", "none"] as const;

export interface StartContainerOptions {
  image: string;
  name: string;
  docker?: readonly string[];
  // docker run 的附加参数（内存上限等）
  runArgs?: readonly string[];
  timeoutMs?: number;
}

// 调一次 docker CLI 并收下全部输出（沙箱的生命周期与镜像构建共用）
export function dockerOnce(
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
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
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
        ...(killed ? { timedOut: true } : {}),
      });
    });
  });
}

// 决策 335：Pigeon 自己发往容器的辅助命令（路径解析、读写文件、文件清单、快照与交回所用的 git 等）在容器内以 timeout
// 限时，到时只终止该命令（先 TERM，过 HELPER_KILL_AFTER_S 秒仍在即 KILL），不重启容器，agent 在后台起的进程不受影响；
// 客户端超时比容器内限时多出 HELPER_CLIENT_GRACE_MS，作兜底。每个容器首次使用时探测有无 timeout（结果缓存在内存里），
// 没有时退回原做法：客户端到时杀掉，并重启容器（重启终结容器内的全部进程，见文件头 ①）；兜底的客户端超时同样重启。
const HELPER_KILL_AFTER_S = 2;
const HELPER_CLIENT_GRACE_MS = 3_000;
// 探测本身的限时（探测不经 timeout）
const PROBE_TIMEOUT_MS = 30_000;
const TIMEOUT_EXIT_CODES: readonly number[] = [124, 137, 143];
// 探测脚本（测试据它认出探测调用）：找到 timeout 后再试它认不认 -k（busybox 1.35 之前的 timeout 不认）——
// 认即输出路径与 k，不认而能以"秒数 命令"的写法限时即只输出路径，两样都不行按没有 timeout 处理
export const TIMEOUT_PROBE_SCRIPT =
  "t=$(command -v timeout) || exit 1; " +
  'if "$t" -k 1 1 true >/dev/null 2>&1; then printf \'%s\\nk\\n\' "$t"; ' +
  'elif "$t" 1 true >/dev/null 2>&1; then printf \'%s\\n\' "$t"; else exit 1; fi';
// 容器里可用的 timeout：绝对路径与是否认 -k
interface ContainerTimeout {
  path: string;
  killAfter: boolean;
}
// 容器 → 可用的 timeout（没有为 undefined）；键为 docker 调用前缀与容器名，容器起停时作废
const timeoutCommands = new Map<string, ContainerTimeout | undefined>();

function probeKey(docker: readonly string[], container: string): string {
  return JSON.stringify([docker, container]);
}

export function forgetContainerProbe(docker: readonly string[], container: string): void {
  timeoutCommands.delete(probeKey(docker, container));
}

// 容器里 timeout 的绝对路径与是否认 -k：以固定 PATH 从系统目录解析（不经 agent 能改指的链接）；探测不成（容器不可用等）不缓存
async function containerTimeoutCommand(
  docker: readonly string[],
  container: string
): Promise<ContainerTimeout | undefined> {
  const key = probeKey(docker, container);
  if (timeoutCommands.has(key)) {
    return timeoutCommands.get(key);
  }
  const result = await dockerOnce(
    docker,
    ["exec", container, ...trustedShell(TIMEOUT_PROBE_SCRIPT)],
    PROBE_TIMEOUT_MS
  );
  const [path = "", mode] = result.stdout.toString("utf8").trim().split("\n");
  if (result.exitCode === 0 && path.startsWith("/")) {
    const found = { path, killAfter: mode === "k" };
    timeoutCommands.set(key, found);
    return found;
  }
  // command -v 找不到时退出码非零；守护进程层面的失败与探测超时不算"没有"，下次再探
  if (
    result.timedOut !== true &&
    !/^(Error response from daemon|Cannot connect to)/m.test(result.stderr)
  ) {
    timeoutCommands.set(key, undefined);
  }
  return undefined;
}

// 重启容器：终结容器内的全部进程，可写层保留
export async function restartContainer(
  docker: readonly string[],
  container: string,
  timeoutMs: number = DEFAULT_HELPER_TIMEOUT_MS
): Promise<void> {
  const result = await dockerOnce(docker, ["restart", "-t", "0", container], timeoutMs);
  if (result.exitCode !== 0) {
    throw new ContainerHostError(`容器重启失败：${result.stderr.trim()}`);
  }
}

// 在容器内执行一条辅助命令（flags 为 exec 与容器名之间的参数：-i、-u、-w、-e 等）
export async function containerHelperExec(input: {
  docker: readonly string[];
  container: string;
  flags: readonly string[];
  command: readonly string[];
  timeoutMs: number;
  stdin?: string | Buffer;
}): Promise<HelperResult> {
  const timeoutCommand = await containerTimeoutCommand(input.docker, input.container);
  const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  // 经 /bin/sh 起 timeout（$0 为其绝对路径）：命令自己的环境与 PATH 照旧；不认 -k 的 timeout 只限时、不补 KILL
  const command =
    timeoutCommand === undefined
      ? input.command
      : [
          "/bin/sh",
          "-c",
          timeoutCommand.killAfter
            ? `exec "$0" -k ${HELPER_KILL_AFTER_S} ${seconds} "$@"`
            : `exec "$0" ${seconds} "$@"`,
          timeoutCommand.path,
          ...input.command,
        ];
  const clientTimeoutMs =
    timeoutCommand === undefined
      ? input.timeoutMs
      : (seconds + HELPER_KILL_AFTER_S) * 1000 + HELPER_CLIENT_GRACE_MS;
  const startedAt = Date.now();
  const result = await dockerOnce(
    input.docker,
    ["exec", ...input.flags, input.container, ...command],
    clientTimeoutMs,
    input.stdin
  );
  if (result.timedOut === true) {
    // 客户端被杀：容器内的命令可能还在，重启容器杀干净
    let note = `辅助命令超过 ${Math.round(clientTimeoutMs / 1000)} 秒未结束，已重启容器`;
    try {
      await restartContainer(input.docker, input.container);
    } catch (error) {
      note = `辅助命令超过 ${Math.round(clientTimeoutMs / 1000)} 秒未结束，${error instanceof Error ? error.message : String(error)}`;
    }
    return { ...result, stderr: `${result.stderr}${result.stderr === "" ? "" : "\n"}${note}` };
  }
  // timeout 到时的退出码：GNU 为 124（TERM 后结束）或 137（KILL），busybox 为被信号终止的 143 或 137；
  // 以实际耗时佐证，免得把命令自己的同值退出码当成超时
  if (
    timeoutCommand !== undefined &&
    TIMEOUT_EXIT_CODES.includes(result.exitCode ?? -1) &&
    Date.now() - startedAt >= seconds * 1000
  ) {
    return {
      ...result,
      timedOut: true,
      stderr: `${result.stderr}${result.stderr === "" ? "" : "\n"}辅助命令超过 ${seconds} 秒，已在容器内终止`,
    };
  }
  return result;
}

// 起一个常驻容器当工作区：主进程只负责占位（--init 让 1 号进程回收孤儿），活都经 exec 进去干
export async function startWorkspaceContainer(options: StartContainerOptions): Promise<void> {
  const docker = options.docker ?? ["docker"];
  forgetContainerProbe(docker, options.name);
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
  forgetContainerProbe(docker, name);
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
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  timedOut: boolean;
}> {
  // 决策 335：容器内以 timeout 限时，到时只终止该命令
  const result = await containerHelperExec({
    docker: input.docker ?? ["docker"],
    container: input.container,
    flags: [
      ...(input.stdin !== undefined ? ["-i"] : []),
      ...(input.user !== undefined ? ["-u", input.user] : []),
      ...(input.workdir !== undefined ? ["-w", input.workdir] : []),
    ],
    command: input.command,
    timeoutMs: input.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stdoutBytes: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut === true,
  };
}
