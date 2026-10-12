// run_command（tier: exec，M5.5 S5，决策 048 及其修订）：在工作区根运行一条模型自由提出的命令。
// 执行分三路，由只读检查 inspectCommand 判定：
//   direct   —— 命令串按引号规则切成参数数组后直接 spawn，不经 shell；
//   launcher —— Windows 下程序解析到 .cmd / .bat（npm、npx、node_modules/.bin 的垫片）时，参数逐个匹配保守字符集
//               （字母、数字与 _ . - / : = @），全部通过才经 cmd.exe /d /s /c 作启动器运行；字符集不因任何模式放宽；
//   shell    —— 需要 shell 语义的命令（管道、重定向、串联、命令替换、引号外的换行即多行命令，或 .cmd / .bat 带字符集外
//               参数）以 shell 运行，且只在人确认后：审批面板对精确命令串的批准、带 shell 标记的会话 grant 或固化规则、
//               yolo（004 批发授权）。
//               确认由治理层以 authorizeShell 按调用授予、一次一用；未获授权即拒绝并指出原因（含越界的参数）。
//               本机 Windows 上经 cmd.exe 的命令含换行即无法执行（cmd.exe 只执行第一行，决策 415）。
// 以 shell 运行的命令串与审批面板显示的字节一致，不做改写。工作目录固定为工作区根（worker 即其工作树）；环境变量只透传
// 白名单；墙钟超时终止；输出按字节截断并标记。审批语义不在本工具：exec 档永不自动放行、[a] 收窄为精确命令串，均由
// 治理层判定。执行证据（命令、实际进程参数、是否经启动器、是否经 shell、退出码、输出哈希与截断输出、执行前后工作树
// 文件清单差异）作为成功结果的 details 随工具结果消息记进会话存储。文件变化（决策 348）：git 工作区按命令前后两次
// git status 找候选、比大小与修改时间（被忽略的不报）；非 git 工作区比全量清单；报告格式不变，空报告即命令没改动工作区。
// 设置的 commands 一节的短名在此展开，角色允许清单在场时只接受清单内的短名或其展开命令；它不是 shell 授权来源。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { FILE_CHANGES_HEAD } from "../state/model-markers.ts";
import { PIGEON_DIR, VIRTUAL_PATH_HINT } from "../state/paths.ts";
import {
  DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES,
  DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES,
} from "../state/tools-config.ts";
import { type BackgroundJob, jobOutputText, type SessionJobs } from "./background-jobs.ts";
import { commandEcho, commandLabel } from "./command-echo.ts";
import {
  type CommandOutputStore,
  composeOutput,
  OUTPUTS_URI_PREFIX,
  type OutputSlot,
} from "./command-output.ts";
import { createLocalWorkspaceHost, windowsPathProgram, windowsScript } from "./local-host.ts";
import {
  type FileChanges,
  type HostExecOptions,
  type HostExecPlan,
  type HostExecResult,
  type HostFileSnapshot,
  type HostFileState,
  type MemoryLimitExceeded,
  MISSING_SIGNATURE,
  memoryLimitText,
  type WorkspaceHost,
} from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 120_000;
// 决策 409：后台作业"会话结束后保留"的参数名
export const KEEP_AFTER_SESSION_PARAM = "keep_after_session";
// 决策 365：timeout_seconds 参数的上限（设置可改）
export const DEFAULT_RUN_COMMAND_MAX_TIMEOUT_MS = 600_000;
// 决策 418：设了墙钟预算时，前台命令的超时不超过剩余时间减去这段余量（留给模型收到结果后再答一轮），至少 1 秒
export const COMMAND_BUDGET_MARGIN_MS = 30_000;
export const DEFAULT_RUN_COMMAND_OUTPUT_BYTES = 32 * 1024;
// 决策 358：命令串长度。参数 schema 的字符上限只防误传巨大参数；能否交给进程按执行端与平台另判（commandTooLong）
export const RUN_COMMAND_MAX_CHARS = 65_536;
// Linux 单个参数至多 128 KiB（命令串作为 sh -c 的一个参数，或经 docker exec 交进容器），按 UTF-8 字节计、留出余量
export const POSIX_COMMAND_MAX_BYTES = 124 * 1024;
// Windows 的进程命令行至多 32767 个 UTF-16 单位，经 cmd.exe 至多 8191 个字符（宿主为 Windows 时 docker 客户端也受前者限制）
export const WINDOWS_COMMAND_MAX_CHARS = 32_000;
export const WINDOWS_CMD_MAX_CHARS = 8_000;

// 命令串超出本执行端能执行的长度时给出原因（不等到拉进程才以 E2BIG 之类失败）；platform 为命令执行的平台，
// localPlatform 为拉起进程的宿主平台（容器执行端由宿主上的 docker 客户端拉起）
export function commandTooLong(
  command: string,
  platform: NodeJS.Platform,
  mode: CommandInspection["mode"],
  localPlatform: NodeJS.Platform = process.platform
): string | undefined {
  const bytes = Buffer.byteLength(command, "utf8");
  const limits: string[] = [];
  if (platform !== "win32" && bytes > POSIX_COMMAND_MAX_BYTES) {
    limits.push(`a single argument can be at most about ${POSIX_COMMAND_MAX_BYTES} bytes (UTF-8)`);
  }
  if (localPlatform === "win32" || platform === "win32") {
    const viaCmd = platform === "win32" && (mode === "shell" || mode === "launcher");
    const max = viaCmd ? WINDOWS_CMD_MAX_CHARS : WINDOWS_COMMAND_MAX_CHARS;
    if (command.length > max) {
      limits.push(
        `a Windows command line${viaCmd ? " run through cmd.exe" : ""} can be at most about ${max} characters`
      );
    }
  }
  if (limits.length === 0) return undefined;
  return (
    `The command is too long (${bytes} bytes, ${command.length} characters) for this execution environment: ${limits.join("; ")}. ` +
    "Write the content to a script file with write_file first, then run that script with run_command"
  );
}
// 工作树文件清单上限：超出不做完整差异比对（标记 truncated），避免大目录拖垮每次执行
export const FILE_SNAPSHOT_LIMIT = 20_000;

// cmd.exe 启动器的保守字符集（048 修订）：BatBadBut 一类参数注入依赖的字符（空白、引号、% ^ & | < > ( ) ! 等）全在其外
export const LAUNCHER_ARG_PATTERN = /^[A-Za-z0-9_.\-/:=@]+$/;

// 透传给子进程的环境变量（大小写不敏感比对）：运行所需的路径与区域设置，密钥类变量一律不透传
const ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

// 不带引号时出现即视为 shell 语法
const SHELL_CHARS = new Set(["|", ";", "&", "<", ">", "`"]);

export const RunCommandParamsSchema = Type.Object({
  // 完整命令串，或设置的 commands 一节登记的短名
  command: Type.String({ minLength: 1, maxLength: RUN_COMMAND_MAX_CHARS }),
  // 决策 365：单次超时（秒）；缺省与上限见工具说明
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
  // 决策 365：在后台运行，立即返回作业号
  background: Type.Optional(Type.Boolean()),
  // 决策 409：后台作业在会话结束后保留（会话结束时不等、不停）；只与 background 同用
  keep_after_session: Type.Optional(Type.Boolean()),
});
export type RunCommandParams = Static<typeof RunCommandParamsSchema>;

// 域错误（清单外命令、不存在的程序、未经确认的 shell 命令）——带归类标记（决策 050）
export class RunCommandError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 命令串含 shell 语法（切分器据此判定"需 shell"）；reason 为需 shell 的原因（供只读检查与审批面板）
export class ShellSyntaxError extends RunCommandError {
  readonly reason: string;
  constructor(reason: string, command: string) {
    super(`The command ${reason} (${command}), so it needs a shell`);
    this.reason = reason;
  }
}

// 需 shell 的两类原因：符号类 shell 语法；决策 413：引号外的换行（多行命令，与 ; 同等）。
// 决策 428：原因同时进审批面板与给模型的报错，用英文
const SHELL_SYNTAX_REASON =
  "contains a pipe, redirection, command chaining, or command substitution";
const MULTILINE_REASON = "contains a line break outside quotes (a multi-line command)";

// 决策 415：本机 Windows 经 cmd.exe 运行的命令不能含换行——cmd.exe /c 只执行第一个换行之前的部分（引号内的换行也一样），
// 其余各行不执行也不报错。这类命令在只读检查即判为无法执行，说明与报错共用写法建议
const WINDOWS_MULTILINE_ADVICE =
  "join the commands into one line with &&, or write them to a script file with write_file and run that script";
const WINDOWS_MULTILINE_ERROR =
  "The command contains a line break. On Windows it would run through cmd.exe, which only runs the first line, " +
  `so it was refused and nothing was run. Instead, ${WINDOWS_MULTILINE_ADVICE}.`;

// 超时终止——环境类
export class RunCommandTimeoutError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

// 文件变化报告（定义在执行端接口旁，后台作业的期间变化同用；这里照旧导出）
export type { FileChanges } from "./workspace-host.ts";

export interface ExecEvidence {
  command: string;
  // 经短名展开时的短名
  alias?: string;
  // 实际进程参数（程序在首位；经启动器或 shell 时是 cmd.exe / sh 的参数）
  argv: string[];
  // 是否经 cmd.exe 启动器运行 .cmd / .bat
  launcher: boolean;
  // 是否以 shell 运行
  shell: boolean;
  // 进程是否已启动（启动后出错或超时，副作用都可能已经发生）
  spawned: boolean;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  outputBytes: number;
  // 全量输出（stdout 与 stderr 按到达顺序）的 sha256
  outputHash: string;
  // 截断后的输出文本（保留头尾时为开头一段）
  output: string;
  truncated: boolean;
  // 决策 356：保留头尾且截断时的末尾一段与输出总行数
  outputTail?: string;
  outputLines?: number;
  // 决策 356：完整输出的落盘位置（虚拟路径）；partial 为超过落盘上限只存了前面部分
  savedOutput?: { uri: string; bytes: number; partial: boolean };
  // 决策 356：截断了但全文未能保存的原因（磁盘满、落盘目录被换成链接等）
  savedOutputError?: string;
  fileChanges: FileChanges;
  // 决策 333：超出沙箱内存上限
  memoryLimitExceeded?: MemoryLimitExceeded;
  // 决策 365：命令执行期间在跑的后台作业（作业号与命令）
  backgroundJobs?: Array<{ id: string; command: string }>;
  // 决策 411：timeout_seconds 超过上限，按上限执行（秒）
  timeoutClamped?: { requestedSeconds: number; appliedSeconds: number };
  // 决策 418：超时超过本次运行的剩余时间，按剩余时间缩短（fromMs 为原本要用的超时）；与上一项只出其一
  timeoutShortened?: { fromMs: number; appliedSeconds: number };
  // 决策 365：以后台作业启动（其余字段为启动时的占位：没有退出码与输出）；决策 409：keep 为会话结束后保留
  background?: { jobId: string; output: string; keep?: true };
}

// 只读检查结果：实际执行的命令串与执行路径
export interface CommandInspection {
  input: string;
  command: string;
  alias?: string;
  mode: "direct" | "launcher" | "shell" | "invalid";
  needsShell: boolean;
  // 需 shell 的原因（含越界的参数）
  shellReason?: string;
  // 无法执行的原因（引号未闭合、命令为空）
  error?: string;
  argv?: string[];
  // 启动器路径下解析到的 .cmd / .bat
  scriptPath?: string;
  // 决策 360：只按 PATH 解析出的程序绝对路径（直接执行时启动它，参数数组仍是原样）
  program?: string;
}

// 可选能力：只读检查、按调用授予 shell（治理层使用）
export interface ExecCommandTool {
  inspectCommand(params: unknown): CommandInspection;
  authorizeShell(toolCallId: string): void;
}

export interface RunCommandOptions {
  workspaceRoot: string;
  // 决策 098：执行端——缺省为 workspaceRoot 上的本地实现；容器工作区由装配方注入容器实现。
  // 工具只调接口：平台、工作目录、进程终止与文件清单都由实现决定
  host?: WorkspaceHost;
  // 短名 → 命令串（设置的 commands 一节）
  commands?: Readonly<Record<string, string>>;
  // 在场 = 只允许清单内的短名或其展开命令（tester 等角色）
  allowlist?: readonly string[];
  // 不给 timeout_seconds 时的超时（缺省 120 秒）与 timeout_seconds 的上限（缺省 600 秒）
  timeoutMs?: number;
  maxTimeoutMs?: number;
  // 旧口径：只留开头这么多字节、不留末尾（给了它且没给 output 即按旧口径）
  maxOutputBytes?: number;
  // 决策 356：输出超长时保留的开头与末尾（缺省 8 KiB 与 24 KiB），与存完整输出的会话落盘目录（不给即不落盘）
  output?: { headBytes?: number; tailBytes?: number; store?: CommandOutputStore };
  // 环境变量来源（缺省 process.env；只透传白名单）
  env?: NodeJS.ProcessEnv;
  // 平台（缺省 process.platform；决定 .cmd / .bat 解析与 shell 程序）；只对缺省的本地执行端生效，注入 host 时以 host 为准
  platform?: NodeJS.Platform;
  // 本会话的审批状态（只影响工具说明，审批本身由治理层判定）；缺省按有人工审批
  approval?: RunCommandApproval;
  // 决策 360：带命令前缀范围的 worker——Windows 上程序只按 PATH 解析（不查工作树根与当前目录），显式写出路径的照旧
  pathOnly?: boolean;
  // 决策 365：本会话的后台作业（不给即不能用 background）
  jobs?: SessionJobs;
  // 决策 418：本次运行剩余的墙钟时间（毫秒）；设了墙钟预算的运行才给。前台命令的超时按它夹取，后台作业不受影响
  budgetRemainingMs?: () => number;
}

// 审批状态（170 ④）：yolo 为命令自动批准；prompt 为有人工审批通道；none 为没有审批通道（无人值守又未放权），
// 需要批准的一律被拒绝，只有放权规则放行的能执行
export type RunCommandApproval = "yolo" | "prompt" | "none";

export interface RunCommandTexts {
  // 工具登记里的描述（只留在注册表里、不发给模型，故仍为中文）
  registry: string;
  // 系统提示里介绍 run_command 的一句（决策 363：与审批无关，续跑与 /reload 后不变；决策 428 起为英文）
  prompt: string;
  // 开工状态块「审批」一节里命令的说法（随本会话的审批状态；决策 428 起为英文）
  approval: string;
  // 发给模型的工具说明（决策 428 起为英文）
  tool: string;
}

// 三处说明按实际执行端与审批状态生成（170 ④）：需要 shell 的命令在 Windows 上经 cmd.exe、其余平台（含容器）经 /bin/sh -c；
// 是否要人工批准取审批状态。文字只陈述事实，与 spawnPlan 与治理层的实际行为一致
export function runCommandTexts(input: {
  platform: NodeJS.Platform;
  approval: RunCommandApproval;
  // 决策 365：单次超时的缺省与上限（毫秒，缺省 120 秒与 600 秒）
  timeoutMs?: number;
  maxTimeoutMs?: number;
  // 决策 365：能开后台作业时为每会话同时在跑的上限
  backgroundJobs?: number;
}): RunCommandTexts {
  const timeoutSeconds = Math.floor((input.timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS) / 1000);
  const maxTimeoutSeconds = Math.floor(
    (input.maxTimeoutMs ?? DEFAULT_RUN_COMMAND_MAX_TIMEOUT_MS) / 1000
  );
  const timeoutText =
    `The default timeout is ${timeoutSeconds} seconds; set timeout_seconds to change it, up to ${maxTimeoutSeconds} seconds ` +
    "(larger values run with the maximum). On timeout, the whole process group (the command and the processes it started) is killed.";
  const backgroundText =
    input.backgroundJobs === undefined
      ? ""
      : "Long-running commands such as dev servers, watchers, and long builds can run in the background with background: true: " +
        "you get a job ID right away, the output is written to a file as it arrives, and you are notified when the job ends. " +
        "Use job_output to check its status and new output (with wait_seconds to wait for it to end) and job_kill to stop it. " +
        `Background jobs are not subject to the timeout; at most ${input.backgroundJobs} can run at once in this session, and more are refused. ` +
        "Background jobs run alongside later commands and can interfere with them (changing the same files, using the same port), " +
        "which also makes the file changes reported meanwhile imprecise. " +
        "When the user presses Esc to interrupt the current turn, background jobs keep running; they stop when the session ends. " +
        "For servers, daemons, or other long-running processes that grading or the user still needs after the session ends, " +
        `also pass ${KEEP_AFTER_SESSION_PARAM}: true: when the session ends, the job is neither waited for nor stopped, the process ` +
        "keeps running, and its output still goes to the same file; during the session, job_output and job_kill work as usual.";
  // 决策 410：命令以输出全部关闭为结束——放到后台又没把输出重定向走的进程会让命令一直等到超时
  const heldText =
    "A command ends only when all of its output is closed: a process put in the background with " +
    `${input.platform === "win32" ? "start /b" : "&"} inside the command, without redirecting its output, keeps the output open, ` +
    "so the command runs until the timeout and is killed along with that process. " +
    heldOutputAdvice(input.platform, input.backgroundJobs !== undefined);
  const shell = input.platform === "win32" ? "cmd.exe" : "/bin/sh -c";
  // 决策 413：多行命令经 /bin/sh -c 逐行执行；决策 415：cmd.exe /c 只执行第一行，Windows 上写明不支持与改法
  const multiline = input.platform !== "win32";
  const windowsMultiline = multiline
    ? ""
    : "Multi-line commands are not supported (cmd.exe only runs the first line, so commands containing line breaks are refused): " +
      `${WINDOWS_MULTILINE_ADVICE}.`;
  const shellKinds = multiline
    ? "pipes, redirection, && chaining, and multi-line commands (run line by line)"
    : "pipes, redirection, and && chaining";
  const shellContains = multiline
    ? "commands with pipes, redirection, && chaining, or multiple lines"
    : "commands with pipes, redirection, or && chaining";
  const toolShell = {
    yolo: `Commands that need a shell, such as ${shellKinds}, run through ${shell}.`,
    prompt:
      `Commands that need a shell, such as ${shellKinds}, run through ${shell} only after the user confirms them; ` +
      "split them into single commands where possible.",
    none: `Commands that need a shell, such as ${shellKinds}, run through ${shell} only if a permission rule allows them.`,
  }[input.approval];
  const toolApproval = {
    yolo: "Commands are approved automatically in this session.",
    prompt:
      "Every command needs the user's approval, unless this exact command has already been allowed in this session.",
    none: "This session has no human approval channel: commands not allowed by a permission rule are refused.",
  }[input.approval];
  const promptShell = {
    yolo: `run through ${shell}`,
    prompt: `run through ${shell} only after the user confirms them; split them into single commands where possible`,
    none: `run through ${shell} only if a permission rule allows them`,
  }[input.approval];
  const promptApproval = {
    yolo: "commands are approved automatically",
    prompt: "every command needs the user's approval",
    none: "this session has no human approval channel, so commands not allowed by a permission rule are refused",
  }[input.approval];
  return {
    registry: `在工作区根运行一条命令（普通命令直接执行，需要 shell 语义的经 ${shell} 执行）`,
    prompt: `run_command runs plain commands directly; ${shellContains} run through ${shell}.`,
    approval: `run_command: ${promptApproval}; ${shellContains} ${promptShell}.`,
    tool: [
      "Runs a command at the workspace root. Plain commands run directly, without a shell.",
      toolShell,
      windowsMultiline,
      toolApproval,
      "You can also use the short names registered in the commands section of the settings.",
      "The result reports the exit code, the output, and the file changes the command made " +
        `(excluding Pigeon's own governance directory ${PIGEON_DIR}).`,
      "When the output is too long, the start and end are kept, the number of omitted lines is noted in between, " +
        `and the full output is saved as ${OUTPUTS_URI_PREFIX}<session-id>/<number>, which you can read with read_file as needed; ` +
        "there is no need to cut it down yourself with tail or head.",
      timeoutText,
      backgroundText,
      heldText,
    ]
      .filter((part) => part !== "")
      .join(" "),
  };
}

// 决策 410：一直运行的进程怎么起——有后台作业时用后台作业（服务标保留）；非放到后台不可时先把输出重定向到文件
export function heldOutputAdvice(platform: NodeJS.Platform, backgroundJobs: boolean): string {
  const redirect =
    platform === "win32" ? "start /b <command> > <file> 2>&1" : "<command> > <file> 2>&1 &";
  return backgroundJobs
    ? "Start processes that keep running as background jobs with background: true " +
        `(add ${KEEP_AFTER_SESSION_PARAM}: true for servers and processes still needed after the session ends); ` +
        `if one must be put in the background inside the command, redirect its output to a file first (${redirect}).`
    : "If a process that keeps running must be put in the background inside the command, " +
        `redirect its output to a file first (${redirect}).`;
}

// 命令串 → 参数数组：空白切分；单引号内原样；双引号内只认 \" 与 \\ 两种转义；
// 不带引号的 shell 语法（| ; & < > ` 与 $(）抛 ShellSyntaxError。决策 413：引号外的换行（\n，\r\n 的 \r 照旧算空白）
// 前后都有命令内容时同样抛 ShellSyntaxError（多行命令整条交给 shell）；首尾的空白与换行只是分隔，不因此需 shell；
// 引号内的换行是参数的一部分
export function parseCommandLine(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  // 已有命令内容之后遇到引号外的换行；其后再出现内容即为多行命令
  let lineBreak = false;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command.charAt(index);
    const next = command.charAt(index + 1);
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && (next === '"' || next === "\\")) {
        current += next;
        index += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === "\n" && (inToken || argv.length > 0)) {
        lineBreak = true;
      }
      if (inToken) {
        argv.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if (lineBreak) {
      throw new ShellSyntaxError(MULTILINE_REASON, command);
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (SHELL_CHARS.has(ch) || (ch === "$" && next === "(")) {
      throw new ShellSyntaxError(SHELL_SYNTAX_REASON, command);
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) {
    throw new RunCommandError(`Unclosed quote: ${command}`);
  }
  if (inToken) {
    argv.push(current);
  }
  if (argv.length === 0) {
    throw new RunCommandError("The command is empty");
  }
  return argv;
}

export function createRunCommandTool(
  options: RunCommandOptions
): PigeonAgentTool<typeof RunCommandParamsSchema, ExecEvidence> &
  PreviewableTool &
  ExecCommandTool {
  const host =
    options.host ??
    createLocalWorkspaceHost(
      options.workspaceRoot,
      options.platform !== undefined ? { platform: options.platform } : {}
    );
  const root = host.root;
  const platform = host.platform;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_RUN_COMMAND_MAX_TIMEOUT_MS;
  const defaultTimeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS,
    maxTimeoutMs
  );
  // 决策 356：缺省保留开头与末尾；只给了旧口径的 maxOutputBytes 时只留开头
  const legacyHeadOnly = options.output === undefined && options.maxOutputBytes !== undefined;
  const headBytes = legacyHeadOnly
    ? (options.maxOutputBytes as number)
    : (options.output?.headBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES);
  const tailBytes = legacyHeadOnly
    ? 0
    : (options.output?.tailBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES);
  const store = options.output?.store;
  const env = allowedEnv(options.env ?? process.env);
  // 治理层按调用授予的 shell 确认（一次一用）
  const shellAuthorized = new Set<string>();
  const pathOnly = options.pathOnly === true && platform === "win32";

  const resolve = (input: string): { command: string; alias?: string } => {
    const trimmed = input.trim();
    const commands = options.commands;
    return commands !== undefined && Object.hasOwn(commands, trimmed)
      ? { command: commands[trimmed] as string, alias: trimmed }
      : { command: trimmed };
  };

  const permitted = (input: string, command: string): boolean => {
    const allowlist = options.allowlist;
    if (allowlist === undefined) {
      return true;
    }
    const commands = options.commands ?? {};
    return allowlist.some(
      (name) =>
        name === input.trim() || (Object.hasOwn(commands, name) && commands[name] === command)
    );
  };

  const classify = (input: string): CommandInspection => {
    const { command, alias } = resolve(input);
    const base = { input: input.trim(), command, ...(alias !== undefined ? { alias } : {}) };
    let argv: string[];
    try {
      argv = parseCommandLine(command);
    } catch (error) {
      if (error instanceof ShellSyntaxError) {
        return { ...base, mode: "shell", needsShell: true, shellReason: error.reason };
      }
      return {
        ...base,
        mode: "invalid",
        needsShell: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const first = argv[0] ?? "";
    let program: string | undefined;
    if (pathOnly && !first.includes("/") && !first.includes("\\")) {
      program = windowsPathProgram(first, env);
      if (program === undefined) {
        return {
          ...base,
          mode: "invalid",
          needsShell: false,
          argv,
          error: `Program ${first} not found on PATH (with a command prefix scope, programs are not looked up in the worktree)`,
        };
      }
    }
    const scriptPath =
      program === undefined
        ? host.findLauncherScript(first, env)
        : /\.(cmd|bat)$/i.test(program)
          ? program
          : undefined;
    if (scriptPath === undefined) {
      return {
        ...base,
        mode: "direct",
        needsShell: false,
        argv,
        ...(program !== undefined ? { program } : {}),
      };
    }
    const offending = argv.find((arg) => !LAUNCHER_ARG_PATTERN.test(arg));
    if (offending === undefined && !/["%]/.test(scriptPath)) {
      return { ...base, mode: "launcher", needsShell: false, argv, scriptPath };
    }
    return {
      ...base,
      mode: "shell",
      needsShell: true,
      argv,
      scriptPath,
      shellReason:
        offending !== undefined
          ? `argument "${offending}" contains characters outside the safe set (letters, digits, and _ . - / : = @)`
          : `the script path contains characters that are special to cmd: ${scriptPath}`,
    };
  };

  // 决策 415：本机 Windows 上要经 cmd.exe（shell 路径）运行的命令，去掉首尾空白后含换行即无法执行（短名展开的命令串不修剪，
  // 首尾的换行不算）。容器执行端的平台是 linux，即使宿主是 Windows 也不受此限
  const inspect = (input: string): CommandInspection => {
    const inspection = classify(input);
    if (
      platform !== "win32" ||
      inspection.mode !== "shell" ||
      !inspection.command.trim().includes("\n")
    ) {
      return inspection;
    }
    const { alias } = inspection;
    return {
      input: inspection.input,
      command: inspection.command,
      ...(alias !== undefined ? { alias } : {}),
      mode: "invalid",
      needsShell: false,
      error: WINDOWS_MULTILINE_ERROR,
    };
  };

  const inspectParams = (params: unknown): CommandInspection =>
    inspect(Value.Parse(RunCommandParamsSchema, params).command);

  // 决策 365：以后台作业启动——开始前取一次证（结束时比出期间变化），交回作业号；审批与钩子同前台命令（已在治理层过完）
  const startBackground = async (
    toolCallId: string,
    timeoutSeconds: number | undefined,
    inspection: CommandInspection,
    plan: HostExecPlan,
    keep: boolean
  ): Promise<PigeonToolResult<ExecEvidence>> => {
    const { command, alias } = inspection;
    const jobs = options.jobs;
    if (jobs === undefined || !jobs.available) {
      throw new RunCommandError(
        "Background jobs are not available in this session; run the command in the foreground, without background"
      );
    }
    if (timeoutSeconds !== undefined) {
      throw new RunCommandError(
        "Background jobs are not subject to the timeout, so do not pass timeout_seconds together with background; " +
          "use job_kill to stop a job"
      );
    }
    const periodChanges = await periodObserver(host);
    const job = await jobs.start({
      command,
      plan,
      env,
      toolCallId,
      periodChanges,
      ...(keep ? { keep: true } : {}),
    });
    const evidence: ExecEvidence = {
      command,
      ...(alias !== undefined ? { alias } : {}),
      argv: [plan.program, ...plan.args],
      launcher: inspection.mode === "launcher",
      shell: inspection.mode === "shell",
      spawned: true,
      exitCode: null,
      timedOut: false,
      outputBytes: 0,
      outputHash: "",
      output: "",
      truncated: false,
      fileChanges: { added: [], removed: [], modified: [], truncated: false },
      background: {
        jobId: job.id,
        output: job.outputUri,
        ...(keep ? { keep: true as const } : {}),
      },
    };
    return {
      content: [
        {
          type: "text",
          text: [
            `Started background job ${job.id}${keep ? " (kept after the session ends)" : ""}: $ ${echoOf(command, alias)}${alias !== undefined ? ` (short name ${alias})` : ""}`,
            jobOutputText(job),
            "Use job_output to check its status and new output (with wait_seconds to wait for it to end) and job_kill to stop it; " +
              "you will be notified when the job ends.",
          ].join("\n"),
        },
      ],
      details: evidence,
    };
  };

  return {
    name: RUN_COMMAND_TOOL,
    label: RUN_COMMAND_TOOL,
    description: runCommandTexts({
      platform,
      approval: options.approval ?? "prompt",
      timeoutMs: defaultTimeoutMs,
      maxTimeoutMs,
      ...(options.jobs?.available === true ? { backgroundJobs: options.jobs.perSession } : {}),
    }).tool,
    parameters: RunCommandParamsSchema,
    executionMode: "sequential",
    inspectCommand: inspectParams,
    authorizeShell(toolCallId) {
      shellAuthorized.add(toolCallId);
    },
    async preview(params) {
      const inspection = inspectParams(params);
      const lines = [
        `命令${inspection.needsShell ? "（经 shell）" : ""}：${inspection.command}` +
          (inspection.alias !== undefined ? `（短名 ${inspection.alias}）` : ""),
      ];
      if (inspection.mode === "direct") {
        lines.push(`参数数组：${JSON.stringify(inspection.argv)}（不经 shell）`);
      } else if (inspection.mode === "launcher") {
        lines.push(`经 cmd.exe 启动器运行：${inspection.scriptPath}`);
      } else if (inspection.mode === "shell") {
        lines.push(`需要经 shell 运行：${inspection.shellReason}`);
      } else {
        lines.push(`无法执行：${inspection.error}`);
      }
      lines.push(`工作目录：${root}`);
      if (!permitted(inspection.input, inspection.command)) {
        lines.push("注意：该命令不在本角色允许清单内，批准后仍会被拒绝");
      }
      return lines.join("\n");
    },
    async execute(toolCallId, params, signal): Promise<PigeonToolResult<ExecEvidence>> {
      const parsed = Value.Parse(RunCommandParamsSchema, params);
      const inspection = inspect(parsed.command);
      const { command, alias } = inspection;
      const authorized = shellAuthorized.delete(toolCallId);
      const { timeoutMs, clamped, shortened } = commandTimeout(
        parsed.timeout_seconds,
        defaultTimeoutMs,
        maxTimeoutMs,
        options.budgetRemainingMs?.()
      );
      if (!permitted(inspection.input, command)) {
        const names = options.allowlist?.join(", ") ?? "";
        throw new RunCommandError(
          `The command is not on this role's allowlist: ${inspection.input} (only the commands registered for this role ` +
            `in the commands section of the settings can run: ${names === "" ? "none are registered" : names})`
        );
      }
      if (inspection.mode === "invalid") {
        throw new RunCommandError(inspection.error ?? `Cannot run: ${echoOf(command, alias)}`);
      }
      if (inspection.mode === "shell" && !authorized) {
        throw new RunCommandError(
          `Refused to run: the command needs a shell (${inspection.shellReason}), and running it through a shell ` +
            `was not confirmed by a person: ${echoOf(command, alias)}`
        );
      }
      const tooLong = commandTooLong(command, platform, inspection.mode);
      if (tooLong !== undefined) {
        throw new RunCommandError(tooLong);
      }
      const plan = spawnPlan(inspection, env, platform);
      if (parsed.keep_after_session === true && parsed.background !== true) {
        throw new RunCommandError(
          `${KEEP_AFTER_SESSION_PARAM} only applies to background jobs; pass background: true as well`
        );
      }
      if (parsed.background === true) {
        return startBackground(
          toolCallId,
          parsed.timeout_seconds,
          inspection,
          plan,
          parsed.keep_after_session === true
        );
      }
      // 决策 356：截断时完整输出写进本会话落盘目录的下一个编号（没截断不建文件）；落盘目录不可用时照常执行、只是不落盘
      let slot: OutputSlot | undefined;
      let slotError: string | undefined;
      if (tailBytes > 0 && store !== undefined) {
        try {
          slot = store.next();
        } catch (error) {
          slotError = error instanceof Error ? error.message : String(error);
        }
      }
      // 决策 365：命令执行期间在跑的后台作业（开始时与结束时在跑的都算）
      const jobsDuring = new Map<string, BackgroundJob>(
        (options.jobs?.running() ?? []).map((job) => [job.id, job])
      );
      // 决策 348、349：命令与命令前后的文件变化取证经 observedRun（执行端能合成一次的合成一次）
      const { run, fileChanges: observedChanges } = await observedRun(host, plan, {
        env,
        timeoutMs,
        maxOutputBytes: headBytes,
        ...(tailBytes > 0 ? { tailBytes } : {}),
        ...(slot !== undefined && store !== undefined
          ? { fullOutput: { path: slot.temp, maxBytes: store.maxBytes } }
          : {}),
        signal,
      });
      for (const job of options.jobs?.running() ?? []) jobsDuring.set(job.id, job);
      // 决策 365：前台命令的改动记给在跑的作业（结束时从期间变化里扣除）；有作业在跑时变化报告加提示
      options.jobs?.noteForegroundChanges([
        ...observedChanges.added,
        ...observedChanges.removed,
        ...observedChanges.modified,
      ]);
      const backgroundJobs = [...jobsDuring.values()].map((job) => ({
        id: job.id,
        command: job.command,
      }));
      const fileChanges: FileChanges =
        backgroundJobs.length > 0
          ? {
              ...observedChanges,
              note: [
                observedChanges.note,
                `background jobs were running (${backgroundJobs.map((job) => job.id).join(", ")}), so these changes may include theirs`,
              ]
                .filter((part) => part !== undefined)
                .join("; "),
            }
          : observedChanges;
      // 写成即改名并记进索引；写到一半出错的删掉临时文件、编号照常前进
      let saved: ExecEvidence["savedOutput"];
      let saveError = slotError ?? run.fullOutputError;
      if (slot !== undefined && store !== undefined) {
        if (run.fullOutputSaved !== undefined && run.fullOutputFile !== undefined) {
          try {
            store.commit(slot, { bytes: run.fullOutputSaved.bytes, ...run.fullOutputFile });
            saved = { uri: slot.uri, ...run.fullOutputSaved };
          } catch (error) {
            saveError = error instanceof Error ? error.message : String(error);
          }
        } else if (run.fullOutputError !== undefined) {
          store.discard(slot);
        } else {
          store.release(slot);
        }
      }
      const savedOutputError =
        run.tail !== undefined && saved === undefined && store !== undefined
          ? saveError
          : undefined;
      const evidence: ExecEvidence = {
        command,
        ...(alias !== undefined ? { alias } : {}),
        argv: [plan.program, ...plan.args],
        launcher: inspection.mode === "launcher",
        shell: inspection.mode === "shell",
        spawned: run.spawned,
        exitCode: run.exitCode,
        ...(run.signal !== undefined ? { signal: run.signal } : {}),
        timedOut: run.timedOut,
        outputBytes: run.outputBytes,
        outputHash: run.outputHash,
        output: run.output,
        truncated: run.outputBytes > headBytes + tailBytes,
        ...(run.tail !== undefined ? { outputTail: run.tail } : {}),
        ...(run.outputLines !== undefined ? { outputLines: run.outputLines } : {}),
        ...(saved !== undefined ? { savedOutput: saved } : {}),
        ...(savedOutputError !== undefined ? { savedOutputError } : {}),
        fileChanges,
        ...(run.memoryLimitExceeded !== undefined
          ? { memoryLimitExceeded: run.memoryLimitExceeded }
          : {}),
        ...(backgroundJobs.length > 0 ? { backgroundJobs } : {}),
        ...(clamped !== undefined ? { timeoutClamped: clamped } : {}),
        ...(shortened !== undefined ? { timeoutShortened: shortened } : {}),
      };
      if (run.spawnError !== undefined) {
        if (run.spawnError.code === "ENOENT") {
          host.forgetLauncherScript?.(inspection.argv?.[0] ?? plan.program);
          throw new RunCommandError(`Command not found: ${plan.program}`);
        }
        throw run.spawnError;
      }
      if (run.timedOut) {
        // 决策 410：命令本身已退出、是它放到后台的进程占着输出才没结束的，点明原因并给出两种做法
        const held =
          run.outputHeldAfterExit === true
            ? "The command itself had already exited, but a process it put in the background still held its output open, " +
              `so the command did not end. ${heldOutputAdvice(platform, options.jobs?.available === true)}\n`
            : "";
        throw new RunCommandTimeoutError(
          `The command timed out after ${durationText(timeoutMs)}, and its whole process group was killed: ${command}\n` +
            `${held}${resultText(evidence, headBytes)}`
        );
      }
      if (signal?.aborted === true) {
        throw new Error(`The command was aborted: ${echoOf(command, alias)}`);
      }
      return {
        content: [{ type: "text", text: resultText(evidence, headBytes) }],
        details: evidence,
      };
    },
  };
}

type SpawnPlan = HostExecPlan;

// 毫秒 → 说法：整秒说秒，否则说毫秒
export function durationText(ms: number): string {
  if (ms % 1000 !== 0) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// 本次命令的超时：给了 timeout_seconds 用它，否则用缺省。决策 411：超过上限按上限执行，交回夹取的情形（结果里注明，
// 免得模型以为设上了）。决策 418：给了剩余时间时，超时再不超过剩余时间减去余量（整秒，至少 1 秒）；两者叠加取更小者，
// 只交回起作用的那一种
function commandTimeout(
  seconds: number | undefined,
  defaultMs: number,
  maxMs: number,
  remainingMs: number | undefined
): {
  timeoutMs: number;
  clamped?: NonNullable<ExecEvidence["timeoutClamped"]>;
  shortened?: NonNullable<ExecEvidence["timeoutShortened"]>;
} {
  const base =
    seconds === undefined
      ? { timeoutMs: defaultMs }
      : seconds * 1000 > maxMs
        ? {
            timeoutMs: maxMs,
            clamped: { requestedSeconds: seconds, appliedSeconds: Math.floor(maxMs / 1000) },
          }
        : { timeoutMs: seconds * 1000 };
  if (remainingMs === undefined) return base;
  const budgetMs = Math.max(
    1000,
    Math.floor((remainingMs - COMMAND_BUDGET_MARGIN_MS) / 1000) * 1000
  );
  if (base.timeoutMs <= budgetMs) return base;
  return {
    timeoutMs: budgetMs,
    shortened: {
      fromMs: seconds !== undefined ? seconds * 1000 : defaultMs,
      appliedSeconds: budgetMs / 1000,
    },
  };
}

// 决策 411：夹取的说明一句
function timeoutClampedText(clamped: NonNullable<ExecEvidence["timeoutClamped"]>): string {
  return (
    `timeout_seconds was ${clamped.requestedSeconds}, above the maximum, so the command ran with the maximum of ` +
    `${durationText(clamped.appliedSeconds * 1000)}; run longer commands in the background with background`
  );
}

// 决策 418：按剩余时间缩短的说明一句
export function timeoutShortenedText(
  shortened: NonNullable<ExecEvidence["timeoutShortened"]>
): string {
  return (
    "Not enough time is left in this run, so the timeout was shortened to " +
    `${durationText(shortened.appliedSeconds * 1000)} (from ${durationText(shortened.fromMs)}), ` +
    `keeping ${durationText(COMMAND_BUDGET_MARGIN_MS)} of the remaining time to wrap up`
  );
}

function comspecOf(env: NodeJS.ProcessEnv): string {
  return Object.entries(env).find(([key]) => key.toUpperCase() === "COMSPEC")?.[1] ?? "cmd.exe";
}

// 三路执行计划：direct 直接 spawn；launcher 经 cmd.exe /d /s /c 调 .cmd / .bat（参数已过字符集，无需再引）；
// shell 把命令串原样交给 cmd.exe /d /s /c（/s 去掉首尾一对引号后逐字执行）或 /bin/sh -c
function spawnPlan(
  inspection: CommandInspection,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): SpawnPlan {
  if (inspection.mode === "launcher") {
    const args = inspection.argv?.slice(1) ?? [];
    return {
      program: comspecOf(env),
      args: [
        "/d",
        "/s",
        "/c",
        `""${inspection.scriptPath}"${args.length > 0 ? ` ${args.join(" ")}` : ""}"`,
      ],
      verbatim: true,
    };
  }
  if (inspection.mode === "shell") {
    return platform === "win32"
      ? {
          program: comspecOf(env),
          args: ["/d", "/s", "/c", `"${inspection.command}"`],
          verbatim: true,
        }
      : { program: "/bin/sh", args: ["-c", inspection.command], verbatim: false };
  }
  const [first = "", ...args] = inspection.argv ?? [];
  return { program: inspection.program ?? first, args, verbatim: false };
}

export interface McpLaunchPlan {
  mode: "direct" | "launcher" | "shell";
  program: string;
  args: string[];
  verbatim: boolean;
}

// MCP server 启动计划（M5.7 S2，复用 048）：启动命令来自人写的 .mcp.json / 设置的 mcp 一节，参数已是数组、
// 不经切分。非 Windows 或解析到可执行文件 = 直接 spawn；Windows 上解析到 .cmd / .bat 且参数全在保守字符集内 =
// cmd.exe 启动器；否则以 shell 运行——配置由人写即人确认，字符集外参数加双引号，引号、百分号与换行
// 在 cmd 里无法安全表达，直接拒绝（改用包装脚本）
export function planMcpLaunch(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): McpLaunchPlan {
  const platform = input.platform ?? process.platform;
  const args = [...input.args];
  const scriptPath = windowsScript(input.command, input.cwd, input.env, platform);
  if (scriptPath === undefined) {
    return { mode: "direct", program: input.command, args, verbatim: false };
  }
  if (/["%]/.test(scriptPath)) {
    throw new RunCommandError(`MCP 启动脚本路径含 cmd 无法安全表达的字符：${scriptPath}`);
  }
  if (args.every((arg) => LAUNCHER_ARG_PATTERN.test(arg))) {
    return {
      mode: "launcher",
      program: comspecOf(input.env),
      args: ["/d", "/s", "/c", `""${scriptPath}"${args.length > 0 ? ` ${args.join(" ")}` : ""}"`],
      verbatim: true,
    };
  }
  const quoted = args.map((arg) => {
    if (/["%\r\n]/.test(arg)) {
      throw new RunCommandError(
        `MCP 启动参数含 cmd 无法安全表达的字符（引号、百分号或换行）：${arg}`
      );
    }
    return LAUNCHER_ARG_PATTERN.test(arg) ? arg : `"${arg}"`;
  });
  return {
    mode: "shell",
    program: comspecOf(input.env),
    args: ["/d", "/s", "/c", `""${scriptPath}" ${quoted.join(" ")}"`],
    verbatim: true,
  };
}

// 决策 421：结果里只回显命令开头（完整命令在模型自己的调用参数里）；用了短名时模型只发了短名，展开后的完整命令照旧整段给出
function echoOf(command: string, alias: string | undefined): string {
  return alias !== undefined ? command : commandEcho(command);
}

function resultText(evidence: ExecEvidence, headBytes: number): string {
  const changes = evidence.fileChanges;
  const route = evidence.shell
    ? " (via shell)"
    : evidence.launcher
      ? " (via the cmd.exe launcher)"
      : "";
  const lines = [
    `$ ${echoOf(evidence.command, evidence.alias)}${evidence.alias !== undefined ? ` (short name ${evidence.alias})` : ""}${route}`,
    `Exit code: ${evidence.exitCode ?? "none"}${evidence.signal !== undefined ? ` (signal ${evidence.signal})` : ""}`,
    ...(evidence.timeoutClamped !== undefined ? [timeoutClampedText(evidence.timeoutClamped)] : []),
    ...(evidence.timeoutShortened !== undefined
      ? [timeoutShortenedText(evidence.timeoutShortened)]
      : []),
    ...(evidence.memoryLimitExceeded !== undefined
      ? [memoryLimitText(evidence.memoryLimitExceeded)]
      : []),
    // 决策 365：内存超限时注明期间在跑的后台作业（内存可能是它们占的）
    ...(evidence.memoryLimitExceeded !== undefined && evidence.backgroundJobs !== undefined
      ? [
          `Background jobs running meanwhile: ${evidence.backgroundJobs.map((job) => `${job.id} (${commandLabel(job.command)})`).join(", ")}; they may also account for the memory use`,
        ]
      : []),
  ];
  if (evidence.outputTail !== undefined) {
    // 决策 356：开头、省略标注、末尾；存下了全文即给出虚拟路径与总行数
    lines.push(
      composeOutput({
        head: evidence.output,
        tail: evidence.outputTail,
        totalBytes: evidence.outputBytes,
        totalLines: evidence.outputLines ?? 0,
      }).text
    );
    const saved = evidence.savedOutput;
    if (saved !== undefined) {
      lines.push(
        `Full output (${evidence.outputLines ?? 0} lines) saved as ${saved.uri}` +
          (saved.partial
            ? ` (it exceeded the storage limit, so only the first ${saved.bytes} bytes were saved)`
            : "") +
          `; read the part you need with read_file using offset; ${VIRTUAL_PATH_HINT}`
      );
    } else if (evidence.savedOutputError !== undefined) {
      lines.push(
        `The full output could not be saved (${evidence.savedOutputError}); only the start and end above are available`
      );
    }
  } else {
    lines.push(evidence.output);
    if (evidence.truncated) {
      lines.push(
        `… [output truncated: ${evidence.outputBytes} bytes in total, only the first ${headBytes} bytes kept]`
      );
    }
  }
  const listed = (label: string, files: string[]) =>
    files.length > 0
      ? `${label}: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", ..." : ""}`
      : "";
  // 决策 428：这一段的开头由上下文裁剪认回（state/model-markers.ts）
  lines.push(
    `${FILE_CHANGES_HEAD} added ${changes.added.length} / removed ${changes.removed.length} / modified ${changes.modified.length}` +
      (changes.note !== undefined
        ? ` (${changes.note})`
        : changes.truncated
          ? " (too many files; the diff is incomplete)"
          : "")
  );
  for (const line of [
    listed("Added", changes.added),
    listed("Removed", changes.removed),
    listed("Modified", changes.modified),
  ]) {
    if (line !== "") {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export function allowedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

// 执行并取命令前后的文件变化：执行端能合成一次的合成一次（容器），否则前后各取一次证；
// 只有文件清单的执行端（测试替身）按清单比对
async function observedRun(
  host: WorkspaceHost,
  plan: HostExecPlan,
  options: HostExecOptions
): Promise<{ run: HostExecResult; fileChanges: FileChanges }> {
  if (host.execObserved !== undefined) {
    const observed = await host.execObserved(plan, options, FILE_SNAPSHOT_LIMIT);
    // 超时、中止重启了容器，命令后的取证另取一次
    const after = observed.after ?? (await host.fileState?.(FILE_SNAPSHOT_LIMIT, observed.before));
    return {
      run: observed.result,
      fileChanges:
        after !== undefined
          ? diffStates(observed.before, after)
          : incompleteChanges(
              "the file state after the command could not be captured, so the diff is incomplete"
            ),
    };
  }
  if (host.fileState !== undefined) {
    const before = await host.fileState(FILE_SNAPSHOT_LIMIT);
    const run = await host.exec(plan, options);
    const after = await host.fileState(FILE_SNAPSHOT_LIMIT, before);
    return { run, fileChanges: diffStates(before, after) };
  }
  const before = await host.listFiles(FILE_SNAPSHOT_LIMIT);
  const run = await host.exec(plan, options);
  const after = await host.listFiles(FILE_SNAPSHOT_LIMIT);
  return { run, fileChanges: diffFiles(before, after) };
}

// 决策 365：后台作业的期间变化——现在取一次证，返回结束时再取一次、比出变化的函数（同 observedRun 的取法）
async function periodObserver(host: WorkspaceHost): Promise<() => Promise<FileChanges>> {
  if (host.fileState !== undefined) {
    const before = await host.fileState(FILE_SNAPSHOT_LIMIT);
    return async () =>
      diffStates(
        before,
        await (host.fileState as NonNullable<typeof host.fileState>)(FILE_SNAPSHOT_LIMIT, before)
      );
  }
  const before = await host.listFiles(FILE_SNAPSHOT_LIMIT);
  return async () => diffFiles(before, await host.listFiles(FILE_SNAPSHOT_LIMIT));
}

const SCAN_FALLBACK_NOTE = "git status failed, so a full scan was used";
// 取法前后不一时差异说法的后半句
const STATES_MISMATCH =
  "which cannot be compared with the state captured before the command, so the diff is incomplete";

function incompleteChanges(note: string): FileChanges {
  return { added: [], removed: [], modified: [], truncated: true, note };
}

// 两次取证 → 文件变化。git 取证：签名变了即有变化；命令前没报出的路径在命令前是干净的——未跟踪即原本不存在，
// 跟踪的原本存在；命令后不再报出的路径按补查的签名判断。取证不完整时，命令前后有一边缺的路径可能只是落在上限之外，
// 只报两边都在、签名变了的。取法前后不一（命令中途建了、删了或弄坏了版本库）时报不完整并注明
export function diffStates(before: HostFileState, after: HostFileState): FileChanges {
  if (before.kind === "scan" && after.kind === "scan") {
    const changes = diffFiles(before, after);
    return before.fallback === true || after.fallback === true
      ? { ...changes, note: SCAN_FALLBACK_NOTE }
      : changes;
  }
  if (before.kind !== "git" || after.kind !== "git") {
    return incompleteChanges(
      after.kind === "scan" && after.fallback === true
        ? `${SCAN_FALLBACK_NOTE} after the command, ${STATES_MISMATCH}`
        : `a repository was created while the command ran, ${STATES_MISMATCH}`
    );
  }
  const truncated = before.truncated || after.truncated;
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [file, now] of after.entries) {
    const was = before.entries.get(file);
    if (was !== undefined && was.signature === now.signature) {
      continue;
    }
    if (truncated && was === undefined) {
      continue;
    }
    const existedBefore =
      was !== undefined ? was.signature !== MISSING_SIGNATURE : now.status !== "untracked";
    const existsAfter = now.signature !== MISSING_SIGNATURE;
    if (existedBefore && existsAfter) {
      modified.push(file);
    } else if (truncated) {
    } else if (existsAfter) {
      added.push(file);
    } else if (existedBefore) {
      removed.push(file);
    }
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), truncated };
}

// 全量清单比对；清单不完整时只报两边都在、签名变了的（缺的一边可能只是落在上限之外）
function diffFiles(before: HostFileSnapshot, after: HostFileSnapshot): FileChanges {
  const truncated = before.truncated || after.truncated;
  return {
    added: truncated
      ? []
      : [...after.files.keys()].filter((file) => !before.files.has(file)).sort(),
    removed: truncated
      ? []
      : [...before.files.keys()].filter((file) => !after.files.has(file)).sort(),
    modified: [...after.files]
      .filter(([file, signature]) => before.files.has(file) && before.files.get(file) !== signature)
      .map(([file]) => file)
      .sort(),
    truncated,
  };
}
