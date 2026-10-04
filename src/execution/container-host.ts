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
// 决策 349：每次工具调用尽量一次进容器——读文件 1 次（检视：解析、是否文件、原文与 cksum 一次拿到），改文件 2 次（检视
// 供审批预览与预检，写入脚本在同一次执行里复核路径、符号链接与 cksum 后写入），跑命令 1 次（命令前后的取证、命令本身与
// 内存计数合在一个脚本里，输出以每次随机的分隔标记分段）。

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createHeadCollector, HOST_SEPARATE_STREAM_CAP } from "../tools/local-host.ts";
import {
  pathChanged,
  symlinkRefused,
  WorkspaceContentChangedError,
  WorkspacePathError,
  WorkspacePathNotFoundError,
} from "../tools/paths.ts";
import {
  gitFileState,
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  type HostFileState,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
  type MemoryLimitExceeded,
  MISSING_SIGNATURE,
  memoryLimitText,
  type ObservedExec,
  parseGitStatus,
  type WorkspaceHost,
} from "../tools/workspace-host.ts";

// 环境错误：docker 自身或容器出了问题（区别于命令的非零退出）
export class ContainerHostError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

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
// 决策 349：写入时原文已不是检视时那份（cksum 不同）：不写，标准输出为就地重做的检视
const EXIT_STALE = 7;
// 检视（决策 349）：$1 为按工作区根写成绝对路径的输入。输出以 NUL 分隔：输入本身是否符号链接（1/0）、链接内容、解析结果、
// 类型（F 文件、R 读不了的文件、D 目录、O 其他、M 不存在）、cksum，其后是原文（F 才有）。原文先拷进临时文件，
// cksum 与交回的原文出自同一份字节
const INSPECT_FUNCTION = [
  "inspect() {",
  '  l=0; lt=""',
  '  if [ -L "$1" ]; then l=1; lt="$(readlink -- "$1")"; fi',
  '  if [ ! -e "$1" ]; then printf \'%s\\0%s\\0\\0M\\0\\0\' "$l" "$lt"; return 0; fi',
  '  r="$(readlink -f -- "$1")"',
  '  if [ -f "$r" ]; then',
  '    t="$(mktemp)" || return 1',
  '    if ! cat -- "$r" > "$t" 2>/dev/null; then rm -f "$t"; printf \'%s\\0%s\\0%s\\0R\\0\\0\' "$l" "$lt" "$r"; return 0; fi',
  '    printf \'%s\\0%s\\0%s\\0F\\0%s\\0\' "$l" "$lt" "$r" "$(cksum < "$t")"',
  '    cat "$t"; rm -f "$t"; return 0',
  "  fi",
  '  if [ -d "$r" ]; then k=D; else k=O; fi',
  '  printf \'%s\\0%s\\0%s\\0%s\\0\\0\' "$l" "$lt" "$r" "$k"',
  "}",
].join("\n");
const INSPECT_SCRIPT = `${INSPECT_FUNCTION}\ninspect "$1"`;
// 写入前复核后截断重写（同一次 exec 里复核与写入）：目标不得是符号链接、须仍在、重新解析须得到它自己；给了 cksum（$2）时
// 原文须仍是检视时那份，否则不写、就地重做检视交回
const WRITE_SCRIPT = [
  INSPECT_FUNCTION,
  `[ -L "$1" ] && { readlink -- "$1"; exit ${EXIT_SYMLINK}; }`,
  `[ -e "$1" ] || exit ${EXIT_MISSING}`,
  `t="$(readlink -f -- "$1")"; [ "$t" = "$1" ] || { printf '%s\\n' "$t"; exit ${EXIT_CHANGED}; }`,
  `if [ -n "$2" ] && [ "$(cksum < "$1")" != "$2" ]; then inspect "$1"; exit ${EXIT_STALE}; fi`,
  'cat > "$1"',
].join("\n");

// 一次检视的结果（决策 349）：key 为检视时用的绝对路径
interface Inspection {
  key: string;
  // 输入本身是符号链接时的链接内容
  symlink?: string;
  // 解析结果；不存在时缺省
  resolved?: string;
  kind: "F" | "R" | "D" | "O" | "M";
  cksum?: string;
  content?: Buffer;
}

function parseInspection(key: string, stdout: Buffer): Inspection | undefined {
  const fields: string[] = [];
  let position = 0;
  for (let index = 0; index < 5; index += 1) {
    const end = stdout.indexOf(0, position);
    if (end < 0) {
      return undefined;
    }
    fields.push(stdout.subarray(position, end).toString("utf8"));
    position = end + 1;
  }
  const [link, linkText = "", resolved = "", kind = "", cksum = ""] = fields;
  if (kind !== "F" && kind !== "R" && kind !== "D" && kind !== "O" && kind !== "M") {
    return undefined;
  }
  return {
    key,
    ...(link === "1" ? { symlink: linkText } : {}),
    ...(resolved !== "" ? { resolved } : {}),
    kind,
    ...(kind === "F" ? { cksum, content: stdout.subarray(position) } : {}),
  };
}

// 决策 348、349：取证与命令合成一次执行的脚本。参数：模式（run 跑命令 / state 只取证）与命令。标准输入第一行是本次的随机串
// （不在命令行与环境里，命令读不到），其余行是调用方给出的、要一并补查签名的路径（相对工作区根）。输出以"换行 + 随机串 +
// 标记"分段：state（取证：git 为工作区前缀、git status 原始输出与 stat 段；否则为全量清单）、oom（内存计数）、cmd（其后是
// 命令输出）、end（退出码；程序不存在为 missing、不可执行为 denied）、done。命令以原来的 PATH 在标准输入为空时执行；
// Pigeon 自己用的工具从系统目录解析，git 屏蔽全局与系统配置、关掉 fsmonitor，这些都不进命令的环境
function observeScript(limit: number, oomFiles: readonly string[] | undefined): string {
  const pruned = [
    ...LISTING_SKIPPED_DIRS.map((name) => `-name ${name}`),
    ...LISTING_SKIPPED_ROOT_DIRS.map((name) => `\\( -path ./${name} -type d \\)`),
  ].join(" -o ");
  const oom =
    oomFiles === undefined
      ? "oom() { :; }"
      : [
          "oom() {",
          `  for f in ${oomFiles.map((file) => `'${file}'`).join(" ")}; do`,
          '    [ -r "$f" ] || continue',
          `    n="$(sed -n 's/^oom_kill //p' "$f")"`,
          '    [ -n "$n" ] && { printf \'\\n%s oom %s\\n\' "$M" "$n"; return; }',
          "  done",
          "}",
        ].join("\n");
  return [
    "IFS= read -r M || exit 90",
    'mode="$1"; shift',
    'P0="$PATH"',
    `H="${SYSTEM_PATH}:$P0"`,
    'PATH="$H"',
    'g() { env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c core.fsmonitor= "$@"; }',
    'T="$(mktemp -d 2>/dev/null)" || { T="/tmp/pigeon-observe.$$"; mkdir -p "$T"; } || exit 91',
    "trap 'rm -rf \"$T\"' EXIT",
    'cat > "$T/given"',
    "K=scan",
    'if pre="$(g rev-parse --show-prefix 2>/dev/null)" && top="$(g rev-parse --show-toplevel 2>/dev/null)"; then K=git; fi',
    "state() {",
    '  printf \'\\n%s state %s\\n\' "$M" "$K"',
    '  if [ "$K" = git ]; then',
    "    printf '%s\\n' \"$pre\"",
    '    g status --porcelain=v1 -z --untracked-files=all --no-renames -- . 2>/dev/null > "$T/s"',
    '    cat "$T/s"',
    "    printf '\\n%s stat\\n' \"$M\"",
    "    tr '\\0' '\\n' < \"$T/s\" | cut -c4- > \"$T/p\"",
    '    [ -f "$T/before" ] && cat "$T/before" >> "$T/p"',
    '    awk -v p="$pre" \'length($0) > 0 { print p $0 }\' "$T/given" >> "$T/p"',
    '    cp "$T/p" "$T/before"',
    `    (cd "$top" && sort -u "$T/p" | tr '\\n' '\\0' | xargs -0 -r stat -c '%n\t%s:%y' -- 2>/dev/null)`,
    "  else",
    `    find . \\( ${pruned} \\) -prune -o -type f -exec stat -c '%n\t%s:%y' {} + 2>/dev/null | head -n ${limit + 1}`,
    "  fi",
    "}",
    oom,
    "state",
    'rc=""',
    'if [ "$mode" = run ]; then',
    "  oom",
    "  printf '\\n%s cmd\\n' \"$M\"",
    '  PATH="$P0"',
    '  case "$1" in',
    '    */*) if [ ! -e "$1" ]; then rc=missing; elif [ ! -x "$1" ]; then rc=denied; fi ;;',
    '    *) command -v -- "$1" >/dev/null 2>&1 || rc=missing ;;',
    "  esac",
    '  if [ -z "$rc" ]; then "$@" </dev/null; rc=$?; fi',
    '  PATH="$H"',
    '  printf \'\\n%s end %s\\n\' "$M" "$rc"',
    "  state",
    "  oom",
    "fi",
    "printf '\\n%s done\\n' \"$M\"",
    'case "$rc" in missing) exit 127 ;; denied) exit 126 ;; "") exit 0 ;; *) exit "$rc" ;; esac',
  ].join("\n");
}

// 输出里以"换行 + 随机串 + 空格"开头的标记行把内容切成段：words 为标记行的词，body 为到下一个标记之前的字节。
// 随机串每次不同、命令不知道，命令输出里仿造不出标记
function markedSections(output: Buffer, nonce: string): Array<{ words: string[]; body: Buffer }> {
  const head = Buffer.from(`\n${nonce} `);
  const starts: number[] = [];
  for (let at = output.indexOf(head); at >= 0; at = output.indexOf(head, at + head.length)) {
    starts.push(at);
  }
  return starts.map((start, index) => {
    const lineEnd = output.indexOf(10, start + head.length);
    const bodyStart = lineEnd < 0 ? output.length : lineEnd + 1;
    const bodyEnd = starts[index + 1] ?? output.length;
    return {
      words: output
        .subarray(start + head.length, lineEnd < 0 ? output.length : lineEnd)
        .toString("utf8")
        .split(" "),
      body: output.subarray(bodyStart, Math.max(bodyStart, bodyEnd)),
    };
  });
}

// 取证段 → HostFileState；没有取证段为 undefined
function stateOfSections(
  sections: ReadonlyArray<{ words: string[]; body: Buffer }>,
  limit: number,
  before?: HostFileState
): HostFileState | undefined {
  const state = sections.find((section) => section.words[0] === "state");
  if (state === undefined) {
    return undefined;
  }
  const statLines = (body: Buffer | undefined) =>
    (body?.toString("utf8") ?? "").split("\n").flatMap((line) => {
      const tab = line.lastIndexOf("\t");
      return tab > 0 ? [[line.slice(0, tab), line.slice(tab + 1)] as const] : [];
    });
  if (state.words[1] !== "git") {
    const files = new Map<string, string>();
    let truncated = false;
    for (const [name, signature] of statLines(state.body)) {
      if (files.size >= limit) {
        truncated = true;
        break;
      }
      files.set(name.replace(/^\.\//, ""), signature);
    }
    return { kind: "scan", files, truncated };
  }
  const newline = state.body.indexOf(10);
  const prefix = state.body.subarray(0, Math.max(newline, 0)).toString("utf8");
  const statuses = parseGitStatus(state.body.subarray(newline + 1).toString("utf8"), prefix);
  const stat = sections.find((section) => section.words[0] === "stat");
  const signatures = new Map(
    statLines(stat?.body)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, signature]) => [name.slice(prefix.length), signature] as const)
  );
  return gitFileState(statuses, (file) => signatures.get(file) ?? MISSING_SIGNATURE, limit, before);
}

// 跑命令时的输出分流：命令前取证与命令后取证收下，命令输出（cmd 标记与 end 标记之间）交给收集器；
// 末尾留一段不足一个标记长的尾巴，免得把切在两块之间的标记交出去
class ObservedOutput {
  readonly #cmdMark: Buffer;
  readonly #endMark: Buffer;
  #phase: "pre" | "cmd" | "post" = "pre";
  #buffer: Buffer = Buffer.alloc(0);
  pre: Buffer | undefined;

  constructor(nonce: string) {
    this.#cmdMark = Buffer.from(`\n${nonce} cmd\n`);
    this.#endMark = Buffer.from(`\n${nonce} end `);
  }

  push(chunk: Buffer, sink: (bytes: Buffer) => void): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (this.#phase === "pre") {
      const at = this.#buffer.indexOf(this.#cmdMark);
      if (at < 0) {
        return;
      }
      this.pre = this.#buffer.subarray(0, at);
      this.#buffer = this.#buffer.subarray(at + this.#cmdMark.length);
      this.#phase = "cmd";
    }
    if (this.#phase === "cmd") {
      const at = this.#buffer.indexOf(this.#endMark);
      if (at < 0) {
        const keep = this.#endMark.length - 1;
        if (this.#buffer.length > keep) {
          sink(this.#buffer.subarray(0, this.#buffer.length - keep));
          this.#buffer = this.#buffer.subarray(this.#buffer.length - keep);
        }
        return;
      }
      sink(this.#buffer.subarray(0, at));
      this.#buffer = this.#buffer.subarray(at + this.#endMark.length);
      this.#phase = "post";
    }
  }

  // 收尾：命令被终止、没等到 end 标记时，剩下的都算命令输出；返回命令前、命令后两段（没有的为 undefined）
  finish(sink: (bytes: Buffer) => void): { pre: Buffer | undefined; post: Buffer | undefined } {
    if (this.#phase === "pre") {
      return { pre: undefined, post: undefined };
    }
    if (this.#phase === "cmd") {
      sink(this.#buffer);
      return { pre: this.pre, post: undefined };
    }
    return { pre: this.pre, post: this.#buffer };
  }
}

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

  const restart = (): Promise<void> => restartContainer(docker, options.container, helperTimeoutMs);

  // 最近一次检视（决策 349）：exec 与写入时作废；写工具的解析在同一路径、其间没有 exec 与写入时直接取用
  let lastInspection: Inspection | undefined;
  // 检视用的绝对路径：与受保护路径判定（application/protected-paths.ts）同一写法——含 ".." 段的不折叠（内核先替换
  // 符号链接再处理 ".."），其余按工作区根拼成规范的绝对路径。同一个文件经两处判定与读写得到同一个键
  const inspectionKey = (inputPath: string): string => {
    const hasDots = inputPath.split("/").includes("..");
    if (path.posix.isAbsolute(inputPath)) {
      return hasDots ? inputPath : path.posix.normalize(inputPath);
    }
    return hasDots ? `${root.replace(/\/+$/, "")}/${inputPath}` : path.posix.join(root, inputPath);
  };
  const inspect = async (key: string): Promise<Inspection> => {
    const result = await helper(false, trustedShell(INSPECT_SCRIPT, key));
    if (daemonFailure(result)) {
      throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
    }
    const inspection = result.exitCode === 0 ? parseInspection(key, result.stdout) : undefined;
    if (inspection === undefined) {
      throw new WorkspacePathError(`路径不存在或不可读：${key}`);
    }
    lastInspection = inspection;
    return inspection;
  };
  const inspectedPath = (inputPath: string, inspection: Inspection, base: string): string => {
    if (inspection.kind === "M") {
      throw new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`);
    }
    if (inspection.resolved === undefined) {
      throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
    }
    if (!insideRoot(base, inspection.resolved)) {
      throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
    }
    return inspection.resolved;
  };
  const inspectedFile = (resolvedPath: string): Inspection | undefined =>
    lastInspection?.resolved === resolvedPath ? lastInspection : undefined;

  // agent 命令的执行（文件头 ①–③）；给了 observe 时经观测脚本运行（决策 348、349），命令前后的取证另行交回
  const runExec = (
    plan: HostExecPlan,
    execOptions: HostExecOptions,
    observe?: { nonce: string; script: string }
  ): Promise<HostExecResult & { pre?: Buffer; post?: Buffer }> => {
    const observed = observe !== undefined ? new ObservedOutput(observe.nonce) : undefined;
    const stdin = observe !== undefined ? `${observe.nonce}\n` : execOptions.stdin;
    const command =
      observe !== undefined
        ? ["/bin/sh", "-c", observe.script, "sh", "run", plan.program, ...plan.args]
        : [plan.program, ...plan.args];
    const collected = createHeadCollector(execOptions.maxOutputBytes);
    // 分开的两路输出（钩子协议要区分 stdout 与 stderr；上限同本机）
    const stdoutOnly = createHeadCollector(HOST_SEPARATE_STREAM_CAP);
    const stderrOnly = createHeadCollector(HOST_SEPARATE_STREAM_CAP);
    // OCI 运行时与守护进程的报错可能落在任一输出流：两路各留一小段开头用来识别
    let stderrHead = "";
    let stdoutHead = "";
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let terminating: Promise<void> | undefined;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(dockerProgram, execArgs(stdin !== undefined, command, execOptions.env), {
          stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        // 标准输入（钩子事件 JSON，或观测脚本的随机串）：写完即收尾，容器内命令读完自行结束
        child.stdin?.on("error", () => {});
        if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
      } catch (error) {
        reject(
          new ContainerHostError(
            `docker 拉不起来：${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }
      const commandStdout = (chunk: Buffer): void => {
        collected.push(chunk);
        stdoutOnly.push(chunk);
        if (stdoutHead.length < 2048) {
          stdoutHead += chunk.toString("utf8");
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (observed !== undefined) {
          observed.push(chunk, commandStdout);
        } else {
          commandStdout(chunk);
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
          const sections = observed?.finish(commandStdout);
          const output = {
            ...collected.finish(),
            stdout: stdoutOnly.finish().output,
            stderr: stderrOnly.finish().output,
            ...(sections?.pre !== undefined ? { pre: sections.pre } : {}),
            ...(sections?.post !== undefined && terminating === undefined
              ? { post: sections.post }
              : {}),
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
    // 每次现做一次检视（读文件、受保护路径判定都经这里）
    async resolveExisting(inputPath) {
      const base = await resolveRoot();
      return inspectedPath(inputPath, await inspect(inspectionKey(inputPath)), base);
    },
    // 同一路径刚检视过（其间没有 exec 与写入）即直接取用：审批预览、预检、执行之间不再重复进容器；
    // 原文在这之后被改动的，由写入脚本按检视时的 cksum 复核拦下
    async resolveForWrite(inputPath) {
      const base = await resolveRoot();
      const key = inspectionKey(inputPath);
      const inspection = lastInspection?.key === key ? lastInspection : await inspect(key);
      if (inspection.symlink !== undefined) {
        throw symlinkRefused(inputPath, inspection.symlink);
      }
      return inspectedPath(inputPath, inspection, base);
    },
    async isFile(resolvedPath) {
      const inspected = inspectedFile(resolvedPath);
      if (inspected !== undefined) {
        return inspected.kind === "F" || inspected.kind === "R";
      }
      const result = await helper(false, ["test", "-f", resolvedPath]);
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      return result.exitCode === 0;
    },
    async readText(resolvedPath) {
      const inspected = inspectedFile(resolvedPath);
      if (inspected?.content !== undefined) {
        return inspected.content.toString("utf8");
      }
      const result = await helper(false, ["cat", "--", resolvedPath]);
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`读取失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
      return result.stdout.toString("utf8");
    },
    async writeText(resolvedPath, content) {
      // 截断重写同一个文件：权限与属主不变；写入前复核路径（决策 334）。内容出自这个文件的检视时，另复核原文仍是
      // 检视时那份（决策 349）：变了即不写，就地重做的检视留作最近一次检视，抛 WorkspaceContentChangedError 让调用方重算
      const inspected = inspectedFile(resolvedPath);
      const expected = inspected?.kind === "F" ? inspected.cksum : undefined;
      lastInspection = undefined;
      const result = await helper(
        true,
        trustedShell(WRITE_SCRIPT, resolvedPath, expected ?? ""),
        content
      );
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      if (result.exitCode === EXIT_STALE && inspected !== undefined) {
        const fresh = parseInspection(inspected.key, result.stdout);
        if (fresh !== undefined) {
          lastInspection = fresh;
        }
        throw new WorkspaceContentChangedError(
          `文件在预检之后被改动：${resolvedPath}，未写入（已重新读取原文）`
        );
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
      lastInspection = undefined;
      return options.memoryLimit === undefined
        ? runExec(plan, execOptions)
        : execWithMemoryCheck(plan, execOptions, options.memoryLimit.label);
    },
    // 决策 348、349：命令与命令前后的取证、内存计数合成一次执行
    async execObserved(plan, execOptions, limit): Promise<ObservedExec> {
      lastInspection = undefined;
      const nonce = randomBytes(16).toString("hex");
      const memoryLimit = options.memoryLimit;
      const run = await runExec(plan, execOptions, {
        nonce,
        script: observeScript(limit, memoryLimit !== undefined ? counterFiles : undefined),
      });
      const { pre, post, ...rest } = run;
      const beforeSections = pre !== undefined ? markedSections(pre, nonce) : [];
      const before = stateOfSections(beforeSections, limit);
      if (before === undefined) {
        throw new ContainerHostError(`容器内的取证脚本没有运行：${rest.stderr.trim()}`);
      }
      if (post === undefined) {
        // 超时或中止：容器已重启，命令后的取证由调用方另取
        return { result: rest, before };
      }
      const newline = post.indexOf(10);
      const ended = post.subarray(0, Math.max(newline, 0)).toString("utf8");
      const afterSections = markedSections(post.subarray(Math.max(newline, 0)), nonce);
      const completed = afterSections.some((section) => section.words[0] === "done");
      const after = completed ? stateOfSections(afterSections, limit, before) : undefined;
      let result: HostExecResult = rest;
      if (ended === "missing" || ended === "denied") {
        const spawnError: NodeJS.ErrnoException = new Error(`${plan.program}：${ended}`);
        spawnError.code = ended === "missing" ? "ENOENT" : "EACCES";
        result = { ...rest, spawned: false, spawnError, exitCode: null };
      } else if (/^\d+$/.test(ended)) {
        result = { ...rest, exitCode: Number(ended) };
      }
      if (memoryLimit !== undefined && result.spawned && result.exitCode !== null) {
        const count = (sections: typeof afterSections) => {
          const text = sections.find((section) => section.words[0] === "oom")?.words[1];
          return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
        };
        const oomBefore = count(beforeSections);
        const oomAfter = count(afterSections);
        const exceeded: MemoryLimitExceeded | undefined =
          oomBefore !== undefined && oomAfter !== undefined
            ? oomAfter > oomBefore
              ? { limit: memoryLimit.label, certain: true }
              : undefined
            : result.exitCode === 137
              ? { limit: memoryLimit.label, certain: false }
              : undefined;
        if (exceeded !== undefined) {
          options.onNotice?.(
            `${memoryLimitText(exceeded)}（${[plan.program, ...plan.args].join(" ")}）`
          );
          result = { ...result, memoryLimitExceeded: exceeded };
        }
      }
      return after !== undefined ? { result, before, after } : { result, before };
    },
    // 只取证（命令后的取证没能随命令一起取到时）：经辅助调用执行同一个脚本，补查命令前报出的路径
    async fileState(limit, before): Promise<HostFileState> {
      const nonce = randomBytes(16).toString("hex");
      const given = before?.kind === "git" ? [...before.entries.keys()].join("\n") : "";
      const result = await helper(
        true,
        ["/bin/sh", "-c", observeScript(limit, undefined), "sh", "state"],
        `${nonce}\n${given}`
      );
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const state = stateOfSections(markedSections(result.stdout, nonce), limit, before);
      if (state === undefined) {
        throw new ContainerHostError(`容器内的取证脚本没有运行：${result.stderr.trim()}`);
      }
      return state;
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
