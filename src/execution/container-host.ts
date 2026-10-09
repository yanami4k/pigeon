// 执行端接口的容器实现（决策 098）：工作区是一个运行中容器里的目录，读写与执行都经 docker CLI 的 exec 进入容器。
// 跨边界的四件事各自在这里保证：
//   ① 超时与中止（决策 365）：只杀 docker exec 客户端会把容器内的进程留成孤儿。命令进程带一个每次随机的标记环境变量
//      （RUN_MARKER_VAR，子孙进程随之继承），经观测脚本跑的命令另以 setsid 起独立进程组；到时宿主另发一次辅助调用，
//      按标记在容器里找进程——组长带标记的整组杀，再逐个杀带标记的进程（KILL_MARKED_SCRIPT）。观测脚本照常收尾、
//      命令后的取证照取；客户端在宽限内没有结束才强行断开。不再重启容器；
//   ② 退出码保真：docker exec 原样带回命令退出码（被信号终止为 128+N）；程序不存在（OCI 运行时报 126/127）
//      还原为 ENOENT，与本地实现同一口径；守护进程层面的失败（容器不在、守护进程不可达）按环境错误上抛，
//      不冒充命令的退出码；
//   ③ 输出截断：与本地实现共用同一个收集器——全量计字节数与哈希，只留开头；
//   ④ 路径映射：模型给的路径在容器内按工作区根解析（符号链接解析后）再判包含，宿主路径不参与。
// 宿主环境变量不进容器：容器内环境由镜像与本实现的 env 选项决定。
// 决策 349：每次工具调用尽量一次进容器——读文件 1 次（检视：解析、是否文件、原文与 cksum 一次拿到；读档时连同禁读名单的
// 真实路径，决策 355），改文件 2 次（检视
// 供审批预览与预检，写入脚本在同一次执行里复核路径、符号链接与 cksum 后写入），跑命令 1 次（命令前后的取证、命令本身与
// 内存计数合在一个脚本里，输出以每次随机的分隔标记分段）。

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { GIT_HARDENING_CONFIG } from "../tools/git-hardening.ts";
import {
  collectorExtras,
  createHeadCollector,
  HOST_SEPARATE_STREAM_CAP,
} from "../tools/local-host.ts";
import {
  controlCharsRefused,
  gitMetadataRefused,
  hasControlChars,
  insideGitMetadata,
  pathChanged,
  symlinkRefused,
  WorkspaceContentChangedError,
  WorkspacePathError,
  WorkspacePathNotFoundError,
  WorkspaceWriteRefusedError,
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
  gitFileState,
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  type HostFileState,
  type HostJob,
  type HostJobExit,
  type HostJobOptions,
  LISTING_SKIPPED_DIRS,
  LISTING_SKIPPED_ROOT_DIRS,
  type MemoryLimitExceeded,
  MISSING_SIGNATURE,
  memoryLimitText,
  type ObservedExec,
  parseGitStatus,
  RUN_MARKER_VAR,
  SYSTEM_PATH,
  type WorkspaceHost,
} from "../tools/workspace-host.ts";

// 环境错误：docker 自身或容器出了问题（区别于命令的非零退出）
export class ContainerHostError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

// 执行端自己在容器里执行的内部命令用的 shell：/bin/sh 取绝对路径（docker exec 按镜像的 PATH 找 sh，而镜像的
// PATH 可能以 agent 能改指的链接开头，例如 /opt/venv/bin），脚本开头把系统目录放到 PATH 最前（sh、find、git、chmod、
// timeout、rm 等都从 root 所有的系统目录解析）。只放到最前、不整个替换：本机测试的假 docker 在本机执行，本机的 git 在
// 系统目录之外；执行端用到的工具在镜像里都位于系统目录，两种做法等效。系统目录 SYSTEM_PATH 见 tools/workspace-host.ts
// 同时屏蔽全局与系统 git 配置（agent 能写 ~/.gitconfig，其中的 filter 驱动会在执行端的 git add 里被执行），并让 python
// 不加载用户目录下的 site（~/.local 下的 .pth、usercustomize 与同名包）
function trustedShell(script: string, ...args: readonly string[]): string[] {
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
  // 决策 365：直接执行的命令超时或中止、按标记杀过之后等客户端自己结束的宽限（缺省 5 秒；测试注入）
  killGraceMs?: number;
  // 决策 333：容器设了内存上限时在场——每条命令前后读容器 cgroup 的 oom_kill 计数，计数增加即判超出上限；
  // 读不到计数时，退出码 137 判"可能超出"。label 为上限的可读写法；counterFiles 为计数所在文件（缺省 cgroup v2 的
  // memory.events 与 v1 的 memory.oom_control，依次取第一个读得到的；测试注入）
  memoryLimit?: { label: string; counterFiles?: readonly string[] };
  // 运行中给人看的一行（超出内存上限等）
  onNotice?: (line: string) => void;
}

const DEFAULT_HELPER_TIMEOUT_MS = 60_000;
// 按标记杀的函数 km：$1 为标记值。逐个看 /proc 下的进程，环境里带这个标记的，若是进程组组长（setsid 起的命令）即杀整组，
// 再杀它本身；$2 非空时另杀命令行里"run"之后紧跟这个标记的进程（观测脚本本身：中止落在命令开始之前时，杀掉它，命令就
// 不会再被起来）。扫两遍（第一遍杀的过程中新起的进程）；跳过本脚本自己，它的命令行里标记前面不是"run"。
// 读 environ 与 cmdline 的输入重定向包在 { …; } 2>/dev/null 里：进程恰好退出或读不了时 shell 自己报的打开失败
// 先于命令上的 2>/dev/null 生效，不包住就混进作业输出
const KILL_MARKED_FUNCTION = [
  "km() {",
  `  m="${RUN_MARKER_VAR}=$1"`,
  "  for pass in 1 2; do",
  "    for p in /proc/[0-9]*; do",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  '      pid="${p#/proc/}"',
  '      [ "$pid" = "$$" ] && continue',
  '      if { tr "\\0" "\\n" < "$p/environ"; } 2>/dev/null | grep -qxF -- "$m"; then :',
  `      elif [ -n "$2" ] && { tr "\\0" "\\n" < "$p/cmdline"; } 2>/dev/null | awk -v m="$1" 'q == "run" && $0 == m { f = 1 } { q = $0 } END { exit !f }'; then :`,
  "      else continue; fi",
  '      g="$(sed "s/.*) //" "$p/stat" 2>/dev/null | cut -d " " -f 3)"',
  '      [ "$g" = "$pid" ] && kill -s KILL -- "-$pid" 2>/dev/null',
  '      kill -s KILL "$pid" 2>/dev/null',
  "    done",
  "  done",
  "}",
].join("\n");
// 按标记杀（经 trustedShell 执行）：$1 为标记值，$2 非空时连观测脚本一起杀
export const KILL_MARKED_SCRIPT = [KILL_MARKED_FUNCTION, 'km "$1" "$2"', "exit 0"].join("\n");
// 决策 365：后台作业的包装（agent 命令的执行通道，不经 trustedShell）：$1 为标记，其后为程序与参数。setsid 与 env 从系统
// 目录解析，命令以原来的 PATH、空标准输入、带标记的环境另起进程组（没有 setsid 时不另起组，仍按标记查杀），等它结束；
// 它放到后台还占着输出的子孙（x &、nohup）随即按组与标记杀掉，作业结束时不留进程。以它的退出码结束
const JOB_SCRIPT = [
  KILL_MARKED_FUNCTION,
  'R="$1"; shift',
  `S="$(PATH="${SYSTEM_PATH}:$PATH"; command -v setsid 2>/dev/null)"`,
  `E="$(PATH="${SYSTEM_PATH}:$PATH"; command -v env 2>/dev/null)" || E=env`,
  `if [ -n "$S" ]; then "$S" "$E" -- "${RUN_MARKER_VAR}=$R" "$@" </dev/null & else "$E" -- "${RUN_MARKER_VAR}=$R" "$@" </dev/null & fi`,
  'c=$!; wait "$c"; rc=$?',
  'kill -s KILL -- "-$c" 2>/dev/null',
  `( PATH="${SYSTEM_PATH}:$PATH"; km "$R" )`,
  'exit "$rc"',
].join("\n");
// 决策 365：超时或中止按标记杀过之后，等客户端自己结束的宽限（观测脚本还要做命令后的取证，另按辅助调用的限时）
const KILL_GRACE_MS = 5000;
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
// 决策 349：写入时原文已不是检视时那份（内容哈希不同）：不写，标准输出为就地重做的检视
const EXIT_STALE = 7;
// 容器内脚本共用的小函数：命令替换会吞掉结尾的换行，readlink 的结果先补一个哨兵字符再去掉，得到原样的路径（含换行与控制
// 字符的路径交回后由执行端拒绝）；内容哈希有 sha256sum 即用它，没有退回 cksum（CRC32，能被有意造出碰撞）
const SHELL_HELPERS = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  'NL="$(printf \'\\nx\')"; NL="${NL%x}"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  'rl() { r="$(readlink -f -- "$1"; printf x)"; r="${r%x}"; r="${r%"$NL"}"; }',
  'hs() { if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d " " -f 1; else cksum < "$1"; fi; }',
].join("\n");
// 检视（决策 349）：$1 为按工作区根写成绝对路径的输入。输出以 NUL 分隔：输入本身是否符号链接（1/0）、链接内容、解析结果、
// 类型（F 文件、R 读不了的文件、D 目录、O 其他、M 不存在）、内容哈希，其后是原文（F 才有）。原文先拷进临时文件，
// 哈希与交回的原文出自同一份字节
const INSPECT_FUNCTION = [
  SHELL_HELPERS,
  "inspect() {",
  '  l=0; lt=""',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  '  if [ -L "$1" ]; then l=1; lt="$(readlink -- "$1"; printf x)"; lt="${lt%x}"; lt="${lt%"$NL"}"; fi',
  '  if [ ! -e "$1" ]; then printf \'%s\\0%s\\0\\0M\\0\\0\' "$l" "$lt"; return 0; fi',
  '  rl "$1"',
  '  if [ -f "$r" ]; then',
  '    t="$(mktemp)" || return 1',
  '    if ! cat -- "$r" > "$t" 2>/dev/null; then rm -f "$t"; printf \'%s\\0%s\\0%s\\0R\\0\\0\' "$l" "$lt" "$r"; return 0; fi',
  '    printf \'%s\\0%s\\0%s\\0F\\0%s\\0\' "$l" "$lt" "$r" "$(hs "$t")"',
  '    cat "$t"; rm -f "$t"; return 0',
  "  fi",
  '  if [ -d "$r" ]; then k=D; else k=O; fi',
  '  printf \'%s\\0%s\\0%s\\0%s\\0\\0\' "$l" "$lt" "$r" "$k"',
  "}",
].join("\n");
const INSPECT_SCRIPT = `${INSPECT_FUNCTION}\ninspect "$1"`;
// 决策 355：禁读名单在容器里的真实路径。参数为名单各项；输出以 NUL 分隔，按项各两段——展开 ~（容器内的家目录）后的
// 字面路径、它存在时的真实路径（不存在为空串）。经 trustedShell 执行：readlink 从系统目录解析，agent 改不了
const DENY_ENTRIES_SCRIPT = [
  'for p in "$@"; do',
  `  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/\${p#"~/"}" ;; esac`,
  `  printf '%s\\0' "$p"`,
  `  if [ -e "$p" ]; then printf '%s\\0' "$(readlink -f -- "$p")"; else printf '\\0'; fi`,
  "done",
].join("\n");
// 决策 355：读档的目标落在禁读名单内（标准输出为命中的那一项在名单里的序号）：不检视、不读出原文
const EXIT_DENIED = 12;
// 决策 355 合 349：读档解析（不限工作区）、禁读判定与检视一次进容器——第一个参数为目标（按工作区根写成的绝对路径，同
// 检视），其后为名单各项。先输出名单各项（格式同 DENY_ENTRIES_SCRIPT：展开 ~ 后的字面路径、存在时的真实路径）；目标的
// 真实路径等于某一项的这两者之一或落在其下（按路径段比：/root/.sshx 不算落在 /root/.ssh 之下）即输出该项序号、以
// EXIT_DENIED 结束，不碰原文；都不中才检视（同 INSPECT_SCRIPT：解析结果、类型、内容哈希与原文）。工作区内外由执行端判定
const READ_INSPECT_SCRIPT = [
  INSPECT_FUNCTION,
  'target="$1"; shift',
  'tr=""; if [ -e "$target" ]; then rl "$target"; tr="$r"; fi',
  'hit=""; i=0',
  'for p in "$@"; do',
  `  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/\${p#"~/"}" ;; esac`,
  '  q=""; if [ -e "$p" ]; then rl "$p"; q="$r"; fi',
  `  printf '%s\\0%s\\0' "$p" "$q"`,
  '  if [ -z "$hit" ] && [ -n "$tr" ]; then',
  '    for d in "$p" "$q"; do',
  '      [ -n "$d" ] || continue',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  '      while [ "$d" != / ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done',
  '      if [ "$d" = / ]; then hit=$i; else case "$tr" in "$d" | "$d"/*) hit=$i ;; esac; fi',
  "    done",
  "  fi",
  "  i=$((i + 1))",
  "done",
  `if [ -n "$hit" ]; then printf '%s' "$hit"; exit ${EXIT_DENIED}; fi`,
  'inspect "$target"',
].join("\n");
// 决策 355 / 368：grep、glob 的结果逐个取真实路径——参数为名单各项（输出同上）；标准输入给出 NUL 分隔的相对路径，
// 每 500 个一批。GNU 的 realpath（-z -m）整批解析全部成功（退出码 0：每个输入恰好一个输出）时，先输出
// "B NUL 个数 NUL" 与这批输入，再输出各自的真实路径；有一项失败或没有这种 realpath（busybox）时，整批改为逐个
// readlink -f、成对输出 "P NUL 输入 NUL 真实路径 NUL"（取不到为空串），不会错位
const CLASSIFY_SCRIPT = [
  DENY_ENTRIES_SCRIPT,
  `xargs -0 -n 500 /bin/sh -c 'o=""; if realpath -z -m -- / >/dev/null 2>&1 && o="$(mktemp)" && realpath -z -m -- "$@" > "$o" 2>/dev/null; then printf "B\\0%s\\0" "$#"; printf "%s\\0" "$@"; cat "$o"; else for f do r="$(readlink -f -- "$f")" || r=""; printf "P\\0%s\\0%s\\0" "$f" "$r"; done; fi; [ -n "$o" ] && rm -f "$o"; exit 0' sh`,
].join("\n");
// git-hardening.ts 的加固参数写成 shell 词（各项都不含单引号）
const GIT_HARDENING_WORDS = GIT_HARDENING_CONFIG.map((arg) => `'${arg}'`).join(" ");
// 决策 368：Pigeon 自己的辅助程序（搜索后端）——经 trustedShell 执行，程序按系统目录优先解析，不带 ripgrep 配置。
// git 另加 git-hardening.ts 同一张表的加固参数，并照取证脚本的做法按当前目录所在仓库算空树作属性来源（git 不认
// --attr-source 或不在仓库里时不加）
const HELPER_EXEC_SCRIPT = [
  "unset RIPGREP_CONFIG_PATH",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
  'case "${1##*/}" in git) ;; *) exec "$@" ;; esac',
  'g="$1"; shift',
  `e="$("$g" ${GIT_HARDENING_WORDS} hash-object -t tree --stdin </dev/null 2>/dev/null)"`,
  `if [ -n "$e" ] && "$g" "--attr-source=$e" version >/dev/null 2>&1; then exec "$g" "--attr-source=$e" ${GIT_HARDENING_WORDS} "$@"; fi`,
  `exec "$g" ${GIT_HARDENING_WORDS} "$@"`,
].join("\n");
// 决策 368：glob 按修改时间排序——标准输入给出 NUL 分隔的相对路径，每行输出"秒数 路径"；取不到的文件不输出
const MTIMES_SCRIPT = "xargs -0 stat -c '%Y %n' -- 2>/dev/null; exit 0";
// 写入前复核后截断重写（同一次 exec 里复核与写入，空隙尽量小）：目标不得是符号链接、须仍在、重新解析须得到它自己；
// 给了内容哈希（$2）时原文须仍是检视时那份，否则不写、就地重做检视交回
const WRITE_SCRIPT = [
  INSPECT_FUNCTION,
  `[ -L "$1" ] && { readlink -- "$1"; exit ${EXIT_SYMLINK}; }`,
  `[ -e "$1" ] || exit ${EXIT_MISSING}`,
  `rl "$1"; [ "$r" = "$1" ] || { printf '%s' "$r"; exit ${EXIT_CHANGED}; }`,
  `if [ -n "$2" ] && [ "$(hs "$1")" != "$2" ]; then inspect "$1"; exit ${EXIT_STALE}; fi`,
  'cat > "$1"',
].join("\n");
// 决策 358（write_file）：$1 为模型给的路径（原样，不做词法折叠），$2 为工作区根。路径按字节原样使用：拆分只用参数展开、
// 不用命令替换（命令替换会吃掉结尾的换行）；真实路径用 readlink -f 按内核顺序解析（l/.. 走链接目标的上级，与受保护路径
// 的容器判定同一口径），取值时补一个点再去掉，保住结尾换行，输出以 NUL 分隔。
// 目标已存在：本身是链接即拒写（EXIT_SYMLINK），否则输出真实路径、退出码 0；不存在：找路径上最深的已存在一层（须是目录，
// 否则 EXIT_NOT_DIR），尚不存在的各段不得是空段、. 或 ..（EXIT_BAD_PART），输出那一层的真实路径与其余各段，退出码 EXIT_NEW。
// 退出码接在 EXIT_STALE 之后，与其他脚本的不重叠
const EXIT_NEW = 8;
const EXIT_NOT_DIR = 9;
const EXIT_EXISTS = 10;
const EXIT_BAD_PART = 11;
const RESOLVE_FOR_CREATE_SCRIPT = [
  'case "$1" in /*) p="$1" ;; *) p="$2/$1" ;; esac',
  `[ -L "$p" ] && { readlink -- "$p"; exit ${EXIT_SYMLINK}; }`,
  `if [ -e "$p" ]; then r="$(readlink -f -- "$p"; echo .)"; printf '%s\\0' "\${r%??}"; exit 0; fi`,
  'd="$p"; rest=""',
  'while [ ! -e "$d" ] && [ ! -L "$d" ]; do',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的参数展开
  '  b="${d##*/}"',
  `  case "$b" in "" | . | ..) exit ${EXIT_BAD_PART} ;; esac`,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的参数展开
  '  rest="/$b$rest"; d="${d%/*}"; [ -n "$d" ] || d=/',
  "done",
  `[ -d "$d" ] || exit ${EXIT_NOT_DIR}`,
  'r="$(readlink -f -- "$d"; echo .)"',
  `printf '%s\\0%s\\0' "\${r%??}" "$rest"; exit ${EXIT_NEW}`,
].join("\n");
// 新建（照 334 复核）：$1 为 resolveForCreate 给出的规范路径。目标已存在即不写；路径上最深的已存在一层重新解析须得到它自己；
// 补建中间目录后以 noclobber 写入。同样只用参数展开拆路径
const CREATE_SCRIPT = [
  `if [ -e "$1" ] || [ -L "$1" ]; then exit ${EXIT_EXISTS}; fi`,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的参数展开
  'parent="${1%/*}"; [ -n "$parent" ] || parent=/',
  'd="$parent"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的参数展开
  'while [ ! -e "$d" ] && [ ! -L "$d" ]; do d="${d%/*}"; [ -n "$d" ] || d=/; done',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的参数展开
  'r="$(readlink -f -- "$d"; echo .)"; r="${r%??}"',
  `[ "$r" = "$d" ] || { printf '%s' "$r"; exit ${EXIT_CHANGED}; }`,
  'mkdir -p -- "$parent" || exit 1',
  `set -C; cat > "$1" || { [ -e "$1" ] && exit ${EXIT_EXISTS}; exit 1; }`,
].join("\n");
// 工作区根的解析（每个执行端一次）：根的规范路径，NUL 之后是根下 .git 实际所在的目录（.git 是符号链接时为它的指向，
// 是 gitfile 时为其中 gitdir 的指向；都不是为空）——写工具一律不写这里（版本库元数据）
const ROOT_SCRIPT = [
  SHELL_HELPERS,
  `[ -e "$1" ] || exit ${EXIT_MISSING}`,
  'rl "$1"; w="$r"; printf "%s\\0" "$w"',
  'g="$w/.git"',
  'if [ -L "$g" ]; then rl "$g"; printf "%s" "$r"; elif [ -f "$g" ]; then',
  '  d="$(sed -n "s/^gitdir:[[:space:]]*//p" "$g" | head -n 1)"',
  '  if [ -n "$d" ]; then case "$d" in /*) ;; *) d="$w/$d" ;; esac; rl "$d"; printf "%s" "$r"; fi',
  "fi",
].join("\n");

// 一次检视的结果（决策 349）：key 为检视时用的绝对路径
interface Inspection {
  key: string;
  // 输入本身是符号链接时的链接内容
  symlink?: string;
  // 解析结果；不存在时缺省
  resolved?: string;
  kind: "F" | "R" | "D" | "O" | "M";
  digest?: string;
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
  const [link, linkText = "", resolved = "", kind = "", digest = ""] = fields;
  if (kind !== "F" && kind !== "R" && kind !== "D" && kind !== "O" && kind !== "M") {
    return undefined;
  }
  return {
    key,
    ...(link === "1" ? { symlink: linkText } : {}),
    ...(resolved !== "" ? { resolved } : {}),
    kind,
    ...(kind === "F" ? { digest, content: stdout.subarray(position) } : {}),
  };
}

// 嵌套仓库与子模块往下取它们自己的 git status 的层数；更深的整棵扫描（与本机实现同一口径）
const NESTED_REPO_DEPTH = 3;

// 决策 348、349：取证与命令合成一次执行的脚本。参数：模式（run 跑命令 / state 只取证）与命令。标准输入第一行是本次的随机串
// （不在命令行与环境里，命令读不到），其余行是调用方给出的、要一并补查签名的路径（相对工作区根）。输出以"换行 + 随机串 +
// 标记"分段：state（git / scan，git status 失败改扫描时另带 fallback）、repo（一个仓库的目录、去掉的前缀与 git status
// 原始输出）、scanned（整棵扫描的子树）、truncated（候选超过上限）、stat（候选的签名）、oom、cmd（其后是命令输出）、end
// （退出码；程序不存在为 missing、不可执行为 denied）、done。工作区根被外层仓库忽略时按非 git 工作区扫描；status 报出的
// 目录里有 .git 的（嵌套仓库、子模块）逐个取它们自己的 status，取不到或过深的整棵扫描。命令以原来的 PATH、空标准输入、
// 经 env 执行（只执行外部程序：内建命令与本脚本的函数一律按程序不存在处理），以 setsid 另起进程组、环境里带 run 模式的
// 第二个参数作标记（决策 365：超时与中止按组与标记杀，见 KILL_MARKED_SCRIPT）；脚本自己用的工具从系统目录解析，git 经
// git-hardening.ts 同一张表加固，这些都不进命令的环境
function observeScript(limit: number, oomFiles: readonly string[] | undefined): string {
  const pruned = [
    ...LISTING_SKIPPED_DIRS.map((name) => `-name ${name}`),
    ...LISTING_SKIPPED_ROOT_DIRS.map((name) => `\\( -path ./${name} -type d \\)`),
  ].join(" -o ");
  const prunedTree = LISTING_SKIPPED_DIRS.map((name) => `-name ${name}`).join(" -o ");
  const hardening = GIT_HARDENING_CONFIG.map((arg) => `'${arg}'`).join(" ");
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
    'R=""; if [ "$mode" = run ]; then R="$1"; shift; fi',
    'P0="$PATH"',
    `H="${SYSTEM_PATH}:$P0"`,
    'PATH="$H"',
    // setsid 与 env 从系统目录解析；没有 setsid 时命令不另起组（仍按标记查杀）
    'S="$(command -v setsid 2>/dev/null)"; E="$(command -v env 2>/dev/null)" || E=env',
    'A=""',
    // 以空树作属性来源（git-hardening.ts 同一做法）：空树的编号按当前目录所在仓库的对象格式算，git 不认 --attr-source 时不加
    "ga() {",
    `  e="$(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git ${hardening} hash-object -t tree --stdin </dev/null 2>/dev/null)"`,
    '  if [ -n "$e" ] && git "--attr-source=$e" version >/dev/null 2>&1; then A="--attr-source=$e"; else A=""; fi',
    "}",
    "ga",
    `g() { env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git $A ${hardening} --no-optional-locks "$@"; }`,
    'T="$(mktemp -d 2>/dev/null)" || { T="/tmp/pigeon-observe.$$"; mkdir -p "$T"; } || exit 91',
    "trap 'rm -rf \"$T\"' EXIT",
    'cat > "$T/given"',
    "K=scan",
    'if pre="$(g rev-parse --show-prefix 2>/dev/null)"; then K=git; fi',
    'if [ "$K" = git ] && [ -n "$pre" ] && g check-ignore -q -- . 2>/dev/null; then K=scan; fi',
    "repo() {",
    '  ( cd "./$1" && ga && g status --porcelain=v1 -z --untracked-files=all --no-renames -- . ) > "$T/raw" 2>/dev/null || return 1',
    '  printf \'\\n%s repo\\n%s\\n%s\\n\' "$M" "$1" "$2"',
    '  cat "$T/raw"',
    '  tr \'\\0\' \'\\n\' < "$T/raw" | cut -c4- | awk -v s="$2" -v d="$1" \'index($0, s) == 1 { print d substr($0, length(s) + 1) }\' > "$T/c"',
    "  while IFS= read -r c; do",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是容器里 shell 的参数展开，不是本文件的模板字符串
    '    n="${c%/}"',
    '    if [ -d "./$n" ] && [ -e "./$n/.git" ]; then printf \'%s/\\n\' "$n" >> "$T/next"; else printf \'%s\\n\' "$c" >> "$T/p"; fi',
    '  done < "$T/c"',
    "}",
    "scantree() {",
    '  printf \'\\n%s scanned\\n%s\\n\' "$M" "$1"',
    `  find "./$1" \\( ${prunedTree} \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||' >> "$T/p"`,
    "}",
    "gstate() {",
    '  : > "$T/p"; : > "$T/next"',
    '  repo "" "$pre" || return 1',
    "  i=0",
    '  while [ -s "$T/next" ]; do',
    '    mv "$T/next" "$T/q"; : > "$T/next"; i=$((i + 1))',
    `    while IFS= read -r d; do if [ "$i" -gt ${NESTED_REPO_DEPTH} ] || ! repo "$d" ""; then scantree "$d"; fi; done < "$T/q"`,
    "  done",
    '  sort -u "$T/p" > "$T/u"',
    `  [ "$(( $(wc -l < "$T/u") ))" -gt ${limit} ] && printf '\\n%s truncated\\n' "$M"`,
    `  head -n ${limit} "$T/u" > "$T/pp"`,
    "  printf '\\n%s stat\\n' \"$M\"",
    `  cat "$T/pp" "$T/before" "$T/given" 2>/dev/null | sort -u | tr '\\n' '\\0' | xargs -0 -r stat -c '%n\t%s:%y' -- 2>/dev/null`,
    '  cp "$T/pp" "$T/before"',
    "  return 0",
    "}",
    `sstate() { find . \\( ${pruned} \\) -prune -o -type f -exec stat -c '%n\t%s:%y' {} + 2>/dev/null | head -n ${limit + 1}; }`,
    "state() {",
    '  if [ "$K" = git ]; then',
    '    if gstate > "$T/out"; then printf \'\\n%s state git\\n\' "$M"; cat "$T/out"; return; fi',
    "    printf '\\n%s state scan fallback\\n' \"$M\"",
    "  else",
    "    printf '\\n%s state scan\\n' \"$M\"",
    "  fi",
    "  sstate",
    "}",
    oom,
    // 程序是否在原来的 PATH 里（与 env 的查找一致：只找可执行文件，内建命令与函数不算）
    "onpath() {",
    '  set -f; o="$IFS"; IFS=:',
    '  for d in $P0; do [ -n "$d" ] || d=.; if [ -f "$d/$1" ] && [ -x "$d/$1" ]; then IFS="$o"; set +f; return 0; fi; done',
    '  IFS="$o"; set +f; return 1',
    "}",
    "state",
    'rc=""',
    'if [ "$mode" = run ]; then',
    "  oom",
    "  printf '\\n%s cmd\\n' \"$M\"",
    '  PATH="$P0"',
    '  case "$1" in',
    '    */*) if [ ! -e "$1" ]; then rc=missing; elif [ -d "$1" ] || [ ! -x "$1" ]; then rc=denied; fi ;;',
    '    *) onpath "$1" || rc=missing ;;',
    "  esac",
    '  if [ -z "$rc" ]; then',
    `    if [ -n "$S" ]; then "$S" "$E" -- "${RUN_MARKER_VAR}=$R" "$@" </dev/null & else "$E" -- "${RUN_MARKER_VAR}=$R" "$@" </dev/null & fi`,
    '    wait "$!"; rc=$?',
    "  fi",
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

// 签名行（路径 TAB 大小:修改时间）
function statLines(body: Buffer | undefined): Array<readonly [string, string]> {
  return (body?.toString("utf8") ?? "").split("\n").flatMap((line) => {
    const tab = line.lastIndexOf("\t");
    return tab > 0 ? [[line.slice(0, tab), line.slice(tab + 1)] as const] : [];
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
    return {
      kind: "scan",
      ...(state.words[2] === "fallback" ? { fallback: true as const } : {}),
      files,
      truncated,
    };
  }
  const statuses = new Map<string, "tracked" | "untracked">();
  // 往下取了自己的 status 或整棵扫描的子树：它们在上一层里以目录出现，不按目录签名比
  const subtrees: string[] = [];
  for (const repo of sections.filter((section) => section.words[0] === "repo")) {
    const first = repo.body.indexOf(10);
    const second = repo.body.indexOf(10, first + 1);
    if (first < 0 || second < 0) {
      continue;
    }
    const dir = repo.body.subarray(0, first).toString("utf8");
    const strip = repo.body.subarray(first + 1, second).toString("utf8");
    if (dir !== "") {
      subtrees.push(dir);
    }
    for (const [file, status] of parseGitStatus(
      repo.body.subarray(second + 1).toString("utf8"),
      strip,
      dir === ""
    )) {
      statuses.set(dir + file.replace(/\/$/, ""), status);
    }
  }
  const scanned = sections
    .filter((section) => section.words[0] === "scanned")
    .map((section) => section.body.toString("utf8").split("\n")[0] ?? "")
    .filter((dir) => dir !== "");
  for (const dir of [...subtrees, ...scanned]) {
    statuses.delete(dir.replace(/\/$/, ""));
  }
  const signatures = new Map(
    statLines(sections.find((section) => section.words[0] === "stat")?.body)
  );
  for (const file of signatures.keys()) {
    if (!statuses.has(file) && scanned.some((dir) => file.startsWith(dir))) {
      statuses.set(file, "untracked");
    }
  }
  const result = gitFileState(
    statuses,
    (file) => signatures.get(file) ?? MISSING_SIGNATURE,
    limit,
    before
  );
  return sections.some((section) => section.words[0] === "truncated")
    ? { ...result, truncated: true }
    : result;
}

// 跑命令时的输出分流：命令前取证与命令后取证收下，命令输出（cmd 标记与 end 标记之间）交给收集器。各段按块收下、最后拼接一次；
// 只把一小段不足一个标记长的尾巴留着与下一块一起查找，免得把切在两块之间的标记交出去。进入命令段与离开命令段时各回调一次
// （命令的限时只计这一段）
class ObservedOutput {
  readonly #cmdMark: Buffer;
  readonly #endMark: Buffer;
  #phase: "pre" | "cmd" | "post" = "pre";
  readonly #pre: Buffer[] = [];
  readonly #post: Buffer[] = [];
  #tail: Buffer = Buffer.alloc(0);
  onCommandStart: (() => void) | undefined;
  onCommandEnd: (() => void) | undefined;

  constructor(nonce: string) {
    this.#cmdMark = Buffer.from(`\n${nonce} cmd\n`);
    this.#endMark = Buffer.from(`\n${nonce} end `);
  }

  get phase(): "pre" | "cmd" | "post" {
    return this.#phase;
  }

  push(chunk: Buffer, sink: (bytes: Buffer) => void): void {
    if (this.#phase === "post") {
      this.#post.push(chunk);
      return;
    }
    let window = this.#tail.length === 0 ? chunk : Buffer.concat([this.#tail, chunk]);
    this.#tail = Buffer.alloc(0);
    if (this.#phase === "pre") {
      const at = window.indexOf(this.#cmdMark);
      if (at < 0) {
        const keep = Math.min(window.length, this.#cmdMark.length - 1);
        this.#pre.push(window.subarray(0, window.length - keep));
        this.#tail = window.subarray(window.length - keep);
        return;
      }
      this.#pre.push(window.subarray(0, at));
      window = window.subarray(at + this.#cmdMark.length);
      this.#phase = "cmd";
      this.onCommandStart?.();
    }
    const at = window.indexOf(this.#endMark);
    if (at < 0) {
      const keep = Math.min(window.length, this.#endMark.length - 1);
      sink(window.subarray(0, window.length - keep));
      this.#tail = window.subarray(window.length - keep);
      return;
    }
    sink(window.subarray(0, at));
    this.#post.push(window.subarray(at + this.#endMark.length));
    this.#phase = "post";
    this.onCommandEnd?.();
  }

  // 收尾：命令被终止、没等到 end 标记时，剩下的都算命令输出；返回命令前、命令后两段（没有的为 undefined）
  finish(sink: (bytes: Buffer) => void): { pre: Buffer | undefined; post: Buffer | undefined } {
    if (this.#phase === "pre") {
      return { pre: undefined, post: undefined };
    }
    if (this.#phase === "cmd") {
      sink(this.#tail);
      return { pre: Buffer.concat(this.#pre), post: undefined };
    }
    return { pre: Buffer.concat(this.#pre), post: Buffer.concat(this.#post) };
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
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const root = path.posix.normalize(options.root);
  const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  const docker = [dockerProgram, ...dockerPrefix];
  const execFlags = (
    interactive: boolean,
    extraEnv?: NodeJS.ProcessEnv,
    marker?: string
  ): string[] => [
    ...(interactive ? ["-i"] : []),
    "-w",
    root,
    ...envArgs,
    // 决策 365：直接执行的命令（钩子等）经 docker exec 带上标记，超时与中止按标记查杀
    ...(marker !== undefined ? ["-e", `${RUN_MARKER_VAR}=${marker}`] : []),
    // 单次调用只放行 PIGEON_* 协议变量（钩子的 PIGEON_PROJECT_DIR）：宿主环境的其余变量不渗进容器
    ...Object.entries(extraEnv ?? {})
      .filter(([key]) => key.startsWith("PIGEON_"))
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];
  const execArgs = (
    interactive: boolean,
    command: readonly string[],
    extraEnv?: NodeJS.ProcessEnv,
    marker?: string
  ): string[] => [
    ...dockerPrefix,
    "exec",
    ...execFlags(interactive, extraEnv, marker),
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

  let rootInfo: { real: string; gitDir?: string } | undefined;
  const insideRoot = (base: string, target: string): boolean =>
    target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
  const resolveRootInfo = async (): Promise<{ real: string; gitDir?: string }> => {
    if (rootInfo === undefined) {
      const result = await helper(false, trustedShell(ROOT_SCRIPT, root));
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const nul = result.stdout.indexOf(0);
      const real = nul > 0 ? result.stdout.subarray(0, nul).toString("utf8") : "";
      if (result.exitCode !== 0 || real === "" || hasControlChars(real)) {
        throw new WorkspacePathError(`路径不存在或不可读：${root}`);
      }
      const gitDir = result.stdout.subarray(nul + 1).toString("utf8");
      rootInfo = { real, ...(gitDir !== "" ? { gitDir } : {}) };
    }
    return rootInfo;
  };
  const resolveRoot = async (): Promise<string> => (await resolveRootInfo()).real;

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

  // 决策 365：按标记杀容器里的进程（超时、中止、后台作业的停止）；容器不可用等失败不抛，调用方另有兜底
  const killMarked = async (marker: string, withScript = false): Promise<void> => {
    try {
      await helper(false, trustedShell(KILL_MARKED_SCRIPT, marker, withScript ? "script" : ""));
    } catch {
      // 交给调用方的兜底（强行断开客户端）
    }
  };

  // 最近一次检视（决策 349）：exec、改写与新建时作废；写工具的解析在同一路径、其间没有 exec 与写入时直接取用。
  // 读档解析（决策 355）通过禁读判定的检视同样留作最近一次检视
  let lastInspection: Inspection | undefined;
  // 检视用的绝对路径：与受保护路径判定（application/protected-paths.ts）同一写法——含 ".." 段的不折叠（内核先替换
  // 符号链接再处理 ".."），其余按工作区根拼成规范的绝对路径。同一个文件经两处判定与读写得到同一个键
  const inspectionKey = (inputPath: string): string => {
    if (hasControlChars(inputPath)) {
      throw controlCharsRefused(inputPath);
    }
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
    if (hasControlChars(inspection.resolved)) {
      throw controlCharsRefused(inspection.resolved);
    }
    if (!insideRoot(base, inspection.resolved)) {
      throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
    }
    return inspection.resolved;
  };
  const inspectedFile = (resolvedPath: string): Inspection | undefined =>
    lastInspection?.resolved === resolvedPath ? lastInspection : undefined;
  // 版本库元数据一律不写（edit_file 的改写、write_file 的覆盖与新建共用）：任一级名为 .git，或落在根下 .git 实际所在的目录里
  const refuseGitMetadata = async (
    inputPath: string,
    resolved: string,
    base: string
  ): Promise<void> => {
    const gitDir = (await resolveRootInfo()).gitDir;
    if (
      insideGitMetadata(path.posix.relative(base, resolved)) ||
      (gitDir !== undefined && insideRoot(gitDir, resolved))
    ) {
      throw gitMetadataRefused(inputPath);
    }
  };
  // 决策 355 合 349：禁读判定与目标的检视，一次 exec（READ_INSPECT_SCRIPT）。落在名单内的在容器里即拒、不读出原文，
  // 这里抛 ReadDeniedError；其余交回检视与名单各项的真实路径。不在这里留作最近一次检视
  const inspectForRead = async (
    key: string,
    inputPath: string,
    deny: readonly string[]
  ): Promise<{ inspection: Inspection; entries: ResolvedDenyEntry[] }> => {
    const result = await helper(false, trustedShell(READ_INSPECT_SCRIPT, key, ...deny));
    if (daemonFailure(result)) {
      throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
    }
    const fields: string[] = [];
    let position = 0;
    while (fields.length < deny.length * 2) {
      const end = result.stdout.indexOf(0, position);
      if (end < 0) {
        break;
      }
      fields.push(result.stdout.subarray(position, end).toString("utf8"));
      position = end + 1;
    }
    if (result.exitCode === EXIT_DENIED) {
      // 序号取不到时报整份名单：命中即拒，不因输出不全放行
      const index = result.stdout.subarray(position).toString("utf8");
      const hit = /^\d+$/.test(index) ? deny[Number(index)] : undefined;
      throw new ReadDeniedError(readDeniedMessage(inputPath, hit ?? deny.join("、")));
    }
    const inspection =
      result.exitCode === 0 && fields.length === deny.length * 2
        ? parseInspection(key, result.stdout.subarray(position))
        : undefined;
    if (inspection === undefined) {
      throw new WorkspacePathError(`路径不存在或不可读：${key}`);
    }
    return { inspection, entries: denyEntriesOf(fields, 0, deny) };
  };

  // agent 命令的执行（文件头 ①–③）；给了 observe 时经观测脚本运行（决策 348、349），命令前后的取证另行交回。
  // streamCap 为分开的两路输出各自保留的上限（缺省同本机；辅助程序另给）
  const runExec = (
    plan: HostExecPlan,
    execOptions: HostExecOptions,
    more: { observe?: { nonce: string; script: string }; streamCap?: number } = {}
  ): Promise<HostExecResult & { pre?: Buffer; post?: Buffer }> => {
    const { observe, streamCap = HOST_SEPARATE_STREAM_CAP } = more;
    const observed = observe !== undefined ? new ObservedOutput(observe.nonce) : undefined;
    const stdin = observe !== undefined ? `${observe.nonce}\n` : execOptions.stdin;
    // 决策 365：本次命令的标记（经观测脚本时交给脚本、只进命令的环境；直接执行时经 docker exec 带上）
    const marker = randomBytes(12).toString("hex");
    const command =
      observe !== undefined
        ? ["/bin/sh", "-c", observe.script, "sh", "run", marker, plan.program, ...plan.args]
        : [plan.program, ...plan.args];
    // 头尾保留与全文落盘（决策 356）照常作用于收集器：观测时标准输出里只有命令段进收集器，取证段另行交回
    const collected = createHeadCollector(execOptions.maxOutputBytes, collectorExtras(execOptions));
    // 分开的两路输出（钩子协议要区分 stdout 与 stderr；上限同本机，辅助程序另给）
    const stdoutOnly = createHeadCollector(streamCap);
    const stderrOnly = createHeadCollector(streamCap);
    // OCI 运行时与守护进程的报错可能落在任一输出流：两路各留一小段开头用来识别
    let stderrHead = "";
    let stdoutHead = "";
    return new Promise((resolve, reject) => {
      let timedOut = false;
      // 决策 365：按标记杀（进行中或已完成）；forced 为宽限过后强行断开了客户端
      let terminating: Promise<void> | undefined;
      let forced = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          dockerProgram,
          execArgs(
            stdin !== undefined,
            command,
            execOptions.env,
            observe !== undefined ? undefined : marker
          ),
          {
            stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
          }
        );
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
      // 终止（见文件头 ①）：先按标记杀容器里的命令，客户端随命令结束（观测脚本先做完命令后的取证）；宽限内没结束，
      // 或命令前后的取证本身卡住（标记杀不到），强行断开客户端。再次到时即强行断开
      const forceClose = (): void => {
        if (!forced) {
          forced = true;
          child.kill("SIGKILL");
        }
      };
      const terminate = (): void => {
        if (terminating !== undefined) {
          forceClose();
          return;
        }
        // 命令开始之前（观测脚本还在取证）：连观测脚本一起按标记杀，命令就不会再被起来；命令之后的取证卡住只断开客户端
        terminating = killMarked(marker, observed?.phase === "pre");
        if (observed !== undefined && observed.phase !== "cmd") {
          forceClose();
          return;
        }
        grace = setTimeout(forceClose, observed !== undefined ? helperTimeoutMs : killGraceMs);
      };
      const expire = (): void => {
        if (observed?.phase !== "post") {
          timedOut = true;
        }
        terminate();
      };
      let timer = setTimeout(
        expire,
        observed !== undefined ? execOptions.timeoutMs + 2 * helperTimeoutMs : execOptions.timeoutMs
      );
      if (observed !== undefined) {
        observed.onCommandStart = () => {
          clearTimeout(timer);
          timer = setTimeout(expire, execOptions.timeoutMs);
        };
        observed.onCommandEnd = () => {
          clearTimeout(timer);
          timer = setTimeout(expire, helperTimeoutMs);
        };
      }
      const onAbort = (): void => terminate();
      execOptions.signal?.addEventListener("abort", onAbort, { once: true });
      if (execOptions.signal?.aborted === true) {
        terminate();
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(grace);
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
            ...(sections?.post !== undefined ? { post: sections.post } : {}),
          };
          if (forced) {
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
          // 等按标记杀的辅助调用结束再交还结果：残留的进程不会和下一条命令重叠
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
    // 超时与中止按标记杀（137 不是内存所致），客户端被强行断开时没有退出码，程序没起来也无从谈起
    if (!result.spawned || result.exitCode === null || result.timedOut) {
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

  // 决策 365：后台作业——docker exec 客户端一直连着、把输出交回宿主；停止时按标记杀容器里的进程组与子孙，客户端在宽限内
  // 没结束再断开
  const startJob = (plan: HostExecPlan, jobOptions: HostJobOptions): HostJob => {
    lastInspection = undefined;
    const marker = jobOptions.marker;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        dockerProgram,
        execArgs(false, ["/bin/sh", "-c", JOB_SCRIPT, "sh", marker, plan.program, ...plan.args]),
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
    } catch (error) {
      const exit: HostJobExit = { exitCode: null, spawnError: error as NodeJS.ErrnoException };
      return { done: Promise.resolve(exit), kill: async () => {}, record: async () => undefined };
    }
    child.stdout?.on("data", (chunk: Buffer) => jobOptions.onOutput(chunk));
    child.stderr?.on("data", (chunk: Buffer) => jobOptions.onOutput(chunk));
    const done = new Promise<HostJobExit>((resolve) => {
      child.on("error", (error: NodeJS.ErrnoException) =>
        resolve({ exitCode: null, spawnError: error })
      );
      child.on("close", (code, signal) =>
        resolve({ exitCode: code, ...(signal !== null ? { signal } : {}) })
      );
    });
    return {
      done,
      async kill() {
        await killMarked(marker);
        const closed = await Promise.race([
          done.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), killGraceMs)),
        ]);
        if (!closed) child.kill("SIGKILL");
        await done;
      },
      record: async () => ({ kind: "container", container: options.container, marker }),
    };
  };

  return {
    platform: "linux",
    root,
    dockerPrefix: docker,
    startJob,
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
      const resolved = inspectedPath(inputPath, inspection, base);
      await refuseGitMetadata(inputPath, resolved, base);
      return resolved;
    },
    // 决策 355：读档解析不限工作区。禁读判定在容器里先于检视做（落在名单内的不读出原文），与目标的检视合成一次进容器
    // （决策 349：读文件 1 次）；工作区内外在这里判定。通过禁读判定的检视留作最近一次检视，随后的 isFile、readText、
    // readBytes 直接取用。执行端另按同一份名单复核一次（与 classifyReadPaths 同一口径），作兜底
    async resolveForRead(inputPath, deny) {
      const base = await resolveRoot();
      const { inspection, entries } = await inspectForRead(
        inspectionKey(inputPath),
        inputPath,
        deny
      );
      if (inspection.kind === "M") {
        throw new WorkspacePathNotFoundError(`路径不存在或不可读：${inputPath}`);
      }
      const target = inspection.resolved;
      if (target === undefined) {
        throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
      }
      if (hasControlChars(target)) {
        throw controlCharsRefused(target);
      }
      const entry = deniedEntry(target, entries, POSIX_PATH_RULES);
      if (entry !== undefined) {
        throw new ReadDeniedError(readDeniedMessage(inputPath, entry));
      }
      lastInspection = inspection;
      return { path: target, outside: !insideRoot(base, target) };
    },
    async classifyReadPaths(relPaths, deny, signal) {
      const base = await resolveRoot();
      const classes = new Map<string, ReadPathClass>();
      const realPaths = new Map<string, string>();
      if (signal?.aborted === true) {
        return { classes, realPaths, incomplete: true };
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
          realPaths.set(rel, real);
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
      return { classes, realPaths, incomplete: result.timedOut === true || !complete };
    },
    execHelper(program, args, execOptions) {
      const [shell = "/bin/sh", ...rest] = trustedShell(HELPER_EXEC_SCRIPT, program, ...args);
      return runExec({ program: shell, args: rest, verbatim: false }, execOptions, {
        streamCap: execOptions.maxOutputBytes,
      });
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
      const expected = inspected?.kind === "F" ? inspected.digest : undefined;
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
    async resolveForCreate(inputPath) {
      if (hasControlChars(inputPath)) {
        throw controlCharsRefused(inputPath);
      }
      const base = await resolveRoot();
      // 不做词法折叠：原样交给容器，按内核顺序解析（与受保护路径的容器判定同一口径）
      const result = await helper(false, trustedShell(RESOLVE_FOR_CREATE_SCRIPT, inputPath, root));
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      const stdout = result.stdout.toString("utf8");
      if (result.exitCode === EXIT_SYMLINK) {
        throw symlinkRefused(inputPath, stdout.replace(/\n$/, ""));
      }
      if (result.exitCode === EXIT_NOT_DIR) {
        throw new WorkspacePathError(`路径上有一层不是目录：${inputPath}`);
      }
      if (result.exitCode === EXIT_BAD_PART) {
        throw new WorkspacePathError(`路径里尚不存在的部分不能含空段、. 或 ..：${inputPath}`);
      }
      if (result.exitCode !== 0 && result.exitCode !== EXIT_NEW) {
        throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
      }
      const [real = "", rest = ""] = stdout.split("\0");
      const target = result.exitCode === EXIT_NEW ? `${real === "/" ? "" : real}${rest}` : real;
      if (target === "" || hasControlChars(target)) {
        throw new WorkspacePathError(
          `路径解析结果为空或含控制字符，拒绝写入：${JSON.stringify(target)}`
        );
      }
      if (!insideRoot(base, target)) {
        throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
      }
      // 覆盖与新建都不写版本库元数据
      await refuseGitMetadata(inputPath, target, base);
      return { path: target, exists: result.exitCode === 0 };
    },
    async createText(resolvedPath, content) {
      // 新建改变了工作区：最近一次检视作废
      lastInspection = undefined;
      const result = await helper(true, trustedShell(CREATE_SCRIPT, resolvedPath), content);
      if (daemonFailure(result)) {
        throw new ContainerHostError(`容器不可用：${result.stderr.trim()}`);
      }
      if (result.exitCode === EXIT_EXISTS) {
        throw new WorkspaceWriteRefusedError(`文件在检查之后已被创建，未覆盖：${resolvedPath}`);
      }
      if (result.exitCode === EXIT_CHANGED) {
        throw pathChanged(resolvedPath, result.stdout.toString("utf8"));
      }
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`写入失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
    },
    async readBytes(resolvedPath) {
      // 刚检视过这个文件（决策 349）即用检视时读出的原文，不再进容器
      const inspected = inspectedFile(resolvedPath);
      if (inspected?.content !== undefined) {
        return inspected.content;
      }
      const result = await helper(false, ["cat", "--", resolvedPath]);
      if (result.exitCode !== 0) {
        throw new ContainerHostError(`读取失败：${resolvedPath}（${result.stderr.trim()}）`);
      }
      return result.stdout;
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
        observe: {
          nonce,
          script: observeScript(limit, memoryLimit !== undefined ? counterFiles : undefined),
        },
      });
      const { pre, post, ...rest } = run;
      const beforeSections = pre !== undefined ? markedSections(pre, nonce) : [];
      const before = stateOfSections(beforeSections, limit);
      if (before === undefined) {
        throw new ContainerHostError(`容器内的取证脚本没有运行：${rest.stderr.trim()}`);
      }
      if (post === undefined) {
        // 客户端被强行断开（命令或取证卡住）：命令后的取证由调用方另取
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
      if (
        memoryLimit !== undefined &&
        result.spawned &&
        result.exitCode !== null &&
        !result.timedOut
      ) {
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

// 决策 365：崩溃后清理容器里的后台作业——按标记查杀（标记每次随机，不会碰到别的程序）；容器已不在即无事可做。
// 返回是否执行成功（容器不可用为 false）
export async function killMarkedInContainer(input: {
  docker: readonly string[];
  container: string;
  marker: string;
}): Promise<boolean> {
  try {
    const result = await containerExec({
      docker: input.docker,
      container: input.container,
      command: trustedShell(KILL_MARKED_SCRIPT, input.marker),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
