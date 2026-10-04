// run_command（tier: exec，M5.5 S5，决策 048 及其修订）：在工作区根运行一条模型自由提出的命令。
// 执行分三路，由只读检查 inspectCommand 判定：
//   direct   —— 命令串按引号规则切成参数数组后直接 spawn，不经 shell；
//   launcher —— Windows 下程序解析到 .cmd / .bat（npm、npx、node_modules/.bin 的垫片）时，参数逐个匹配保守字符集
//               （字母、数字与 _ . - / : = @），全部通过才经 cmd.exe /d /s /c 作启动器运行；字符集不因任何模式放宽；
//   shell    —— 需要 shell 语义的命令（管道、重定向、串联、命令替换，或 .cmd / .bat 带字符集外参数）以 shell 运行，
//               且只在人确认后：审批面板对精确命令串的批准、带 shell 标记的会话 grant 或固化规则、yolo（004 批发授权）。
//               确认由治理层以 authorizeShell 按调用授予、一次一用；未获授权即拒绝并指出原因（含越界的参数）。
// 以 shell 运行的命令串与审批面板显示的字节一致，不做改写。工作目录固定为工作区根（worker 即其工作树）；环境变量只透传
// 白名单；墙钟超时终止；输出按字节截断并标记。审批语义不在本工具：exec 档永不自动放行、[a] 收窄为精确命令串，均由
// 治理层判定。执行证据（命令、实际进程参数、是否经启动器、是否经 shell、退出码、输出哈希与截断输出、执行前后工作树
// 文件清单差异）作为成功结果的 details 随工具结果消息记进会话存储。
// 设置的 commands 一节的短名在此展开，角色允许清单在场时只接受清单内的短名或其展开命令；它不是 shell 授权来源。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { PIGEON_DIR } from "../state/paths.ts";
import {
  DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES,
  DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES,
} from "../state/tools-config.ts";
import {
  type CommandOutputStore,
  composeOutput,
  OUTPUTS_URI_PREFIX,
  type OutputSlot,
} from "./command-output.ts";
import { createLocalWorkspaceHost, windowsPathProgram, windowsScript } from "./local-host.ts";
import {
  type HostExecPlan,
  type HostFileSnapshot,
  type MemoryLimitExceeded,
  memoryLimitText,
  type WorkspaceHost,
} from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 120_000;
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
    limits.push(`单个参数至多约 ${POSIX_COMMAND_MAX_BYTES} 字节（UTF-8）`);
  }
  if (localPlatform === "win32" || platform === "win32") {
    const viaCmd = platform === "win32" && (mode === "shell" || mode === "launcher");
    const max = viaCmd ? WINDOWS_CMD_MAX_CHARS : WINDOWS_COMMAND_MAX_CHARS;
    if (command.length > max) {
      limits.push(`Windows ${viaCmd ? "经 cmd.exe 的命令行" : "命令行"}至多约 ${max} 字符`);
    }
  }
  if (limits.length === 0) return undefined;
  return (
    `命令过长（${bytes} 字节、${command.length} 字符），超过本执行端能执行的上限：${limits.join("；")}。` +
    "请先用 write_file 把内容写成脚本文件，再用 run_command 运行该脚本"
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
});
export type RunCommandParams = Static<typeof RunCommandParamsSchema>;

// 域错误（清单外命令、不存在的程序、未经确认的 shell 命令）——带归类标记（决策 050）
export class RunCommandError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 命令串含 shell 语法（切分器据此判定"需 shell"）
export class ShellSyntaxError extends RunCommandError {}

// 超时终止——环境类
export class RunCommandTimeoutError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

export interface FileChanges {
  added: string[];
  removed: string[];
  modified: string[];
  // 清单超过上限，差异不完整
  truncated: boolean;
}

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
  timeoutMs?: number;
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
}

// 审批状态（170 ④）：yolo 为命令自动批准；prompt 为有人工审批通道；none 为没有审批通道（无人值守又未放权），
// 需要批准的一律被拒绝，只有放权规则放行的能执行
export type RunCommandApproval = "yolo" | "prompt" | "none";

export interface RunCommandTexts {
  // 工具登记里的描述
  registry: string;
  // 系统提示里介绍 run_command 的一句
  prompt: string;
  // 发给模型的工具说明
  tool: string;
}

// 三处说明按实际执行端与审批状态生成（170 ④）：需要 shell 的命令在 Windows 上经 cmd.exe、其余平台（含容器）经 /bin/sh -c；
// 是否要人工批准取审批状态。文字只陈述事实，与 spawnPlan 与治理层的实际行为一致
export function runCommandTexts(input: {
  platform: NodeJS.Platform;
  approval: RunCommandApproval;
}): RunCommandTexts {
  const shell = input.platform === "win32" ? "cmd.exe" : "/bin/sh -c";
  const toolShell = {
    yolo: `管道、重定向、&& 串联等需要 shell 的命令经 ${shell} 运行。`,
    prompt: `管道、重定向、&& 串联等需要 shell 的命令只在人确认后经 ${shell} 运行，尽量拆成单条命令。`,
    none: `管道、重定向、&& 串联等需要 shell 的命令须有放权规则允许才经 ${shell} 运行。`,
  }[input.approval];
  const toolApproval = {
    yolo: "本会话的命令自动批准。",
    prompt: "每条命令都需要人工批准，除非本会话已放行这条一模一样的命令。",
    none: "本会话没有人工审批通道：未被放权规则放行的命令会被拒绝。",
  }[input.approval];
  const promptShell = {
    yolo: `经 ${shell} 执行`,
    prompt: `须经人确认后经 ${shell} 执行，尽量拆成单条命令`,
    none: `须有放权规则允许才经 ${shell} 执行`,
  }[input.approval];
  const promptApproval = {
    yolo: "命令自动批准",
    prompt: "每条命令都要人工批准",
    none: "本会话没有人工审批通道，未被放权规则放行的命令会被拒绝",
  }[input.approval];
  return {
    registry: `在工作区根运行一条命令（普通命令直接执行，需要 shell 语义的经 ${shell} 执行）`,
    prompt: `用 run_command 运行命令：普通命令直接执行，含管道、重定向或 && 串联的命令${promptShell}；${promptApproval}。`,
    tool:
      `在工作区根运行一条命令。普通命令不经 shell 直接执行；${toolShell}${toolApproval}` +
      `可用设置 commands 一节登记的短名。结果带退出码、输出与执行前后的文件变化（不含 Pigeon 自己的治理目录 ${PIGEON_DIR}）。` +
      `输出过长时自动保留开头与结尾，中间注明省略的行数，并把全文存为 ${OUTPUTS_URI_PREFIX}<会话号>/<编号>，可用 read_file 按需读取，` +
      "不必自己用 tail、head 截取。",
  };
}

// 命令串 → 参数数组：空白切分；单引号内原样；双引号内只认 \" 与 \\ 两种转义；
// 不带引号的 shell 语法（| ; & < > ` 与 $(）抛 ShellSyntaxError
export function parseCommandLine(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
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
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        argv.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if (SHELL_CHARS.has(ch) || (ch === "$" && next === "(")) {
      throw new ShellSyntaxError(
        `命令含管道、重定向、命令串联或命令替换（${command}），需要经 shell 运行`
      );
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) {
    throw new RunCommandError(`引号未闭合：${command}`);
  }
  if (inToken) {
    argv.push(current);
  }
  if (argv.length === 0) {
    throw new RunCommandError("命令为空");
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS;
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

  const inspect = (input: string): CommandInspection => {
    const { command, alias } = resolve(input);
    const base = { input: input.trim(), command, ...(alias !== undefined ? { alias } : {}) };
    let argv: string[];
    try {
      argv = parseCommandLine(command);
    } catch (error) {
      if (error instanceof ShellSyntaxError) {
        return {
          ...base,
          mode: "shell",
          needsShell: true,
          shellReason: "含管道、重定向、命令串联或命令替换",
        };
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
          error: `在 PATH 里找不到程序 ${first}（带命令前缀范围时不从工作树里找程序）`,
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
          ? `参数「${offending}」含保守字符集（字母、数字与 _ . - / : = @）之外的字符`
          : `脚本路径含 cmd 特殊字符：${scriptPath}`,
    };
  };

  const inspectParams = (params: unknown): CommandInspection =>
    inspect(Value.Parse(RunCommandParamsSchema, params).command);

  return {
    name: RUN_COMMAND_TOOL,
    label: RUN_COMMAND_TOOL,
    description: runCommandTexts({ platform, approval: options.approval ?? "prompt" }).tool,
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
      const inspection = inspectParams(params);
      const { command, alias } = inspection;
      const authorized = shellAuthorized.delete(toolCallId);
      if (!permitted(inspection.input, command)) {
        const names = options.allowlist?.join("、") ?? "";
        throw new RunCommandError(
          `命令不在本角色允许清单内：${inspection.input}（只能运行设置 commands 一节为该角色登记的命令：${names === "" ? "未登记任何命令" : names}）`
        );
      }
      if (inspection.mode === "invalid") {
        throw new RunCommandError(inspection.error ?? `无法执行：${command}`);
      }
      if (inspection.mode === "shell" && !authorized) {
        throw new RunCommandError(
          `需要经 shell 运行（${inspection.shellReason}），未经人确认 shell，拒绝执行：${command}`
        );
      }
      const tooLong = commandTooLong(command, platform, inspection.mode);
      if (tooLong !== undefined) {
        throw new RunCommandError(tooLong);
      }
      const plan = spawnPlan(inspection, env, platform);
      const before = await host.listFiles(FILE_SNAPSHOT_LIMIT);
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
      const run = await host.exec(plan, {
        env,
        timeoutMs,
        maxOutputBytes: headBytes,
        ...(tailBytes > 0 ? { tailBytes } : {}),
        ...(slot !== undefined && store !== undefined
          ? { fullOutput: { path: slot.file, maxBytes: store.maxBytes } }
          : {}),
        signal,
      });
      const saved =
        slot !== undefined && run.fullOutputSaved !== undefined
          ? { uri: slot.uri, ...run.fullOutputSaved }
          : undefined;
      if (slot !== undefined && saved !== undefined) store?.commit(slot);
      const savedOutputError =
        run.tail !== undefined && saved === undefined && store !== undefined
          ? (slotError ?? run.fullOutputError)
          : undefined;
      const after = await host.listFiles(FILE_SNAPSHOT_LIMIT);
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
        fileChanges: diffFiles(before, after),
        ...(run.memoryLimitExceeded !== undefined
          ? { memoryLimitExceeded: run.memoryLimitExceeded }
          : {}),
      };
      if (run.spawnError !== undefined) {
        if (run.spawnError.code === "ENOENT") {
          throw new RunCommandError(`命令不存在：${plan.program}`);
        }
        throw run.spawnError;
      }
      if (run.timedOut) {
        throw new RunCommandTimeoutError(
          `命令超时（${timeoutMs} 毫秒）已终止：${command}\n${resultText(evidence, headBytes)}`
        );
      }
      if (signal?.aborted === true) {
        throw new Error(`命令被中止：${command}`);
      }
      return {
        content: [{ type: "text", text: resultText(evidence, headBytes) }],
        details: evidence,
      };
    },
  };
}

type SpawnPlan = HostExecPlan;

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

function resultText(evidence: ExecEvidence, headBytes: number): string {
  const changes = evidence.fileChanges;
  const route = evidence.shell ? "（经 shell）" : evidence.launcher ? "（经 cmd.exe 启动器）" : "";
  const lines = [
    `$ ${evidence.command}${evidence.alias !== undefined ? `（短名 ${evidence.alias}）` : ""}${route}`,
    `退出码：${evidence.exitCode ?? "无"}${evidence.signal !== undefined ? `（信号 ${evidence.signal}）` : ""}`,
    ...(evidence.memoryLimitExceeded !== undefined
      ? [memoryLimitText(evidence.memoryLimitExceeded)]
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
        `全文共 ${evidence.outputLines ?? 0} 行，已存为 ${saved.uri}，可用 read_file 按 offset 读取需要的一段` +
          (saved.partial ? `（全文超过落盘上限，只存了前 ${saved.bytes} 字节）` : "")
      );
    } else if (evidence.savedOutputError !== undefined) {
      lines.push(`全文未能保存（${evidence.savedOutputError}），只有上面的开头与末尾`);
    }
  } else {
    lines.push(evidence.output);
    if (evidence.truncated) {
      lines.push(`…（输出已截断：共 ${evidence.outputBytes} 字节，保留前 ${headBytes} 字节）`);
    }
  }
  const listed = (label: string, files: string[]) =>
    files.length > 0
      ? `${label}：${files.slice(0, 20).join("、")}${files.length > 20 ? " 等" : ""}`
      : "";
  lines.push(
    `文件变化：新增 ${changes.added.length} / 删除 ${changes.removed.length} / 修改 ${changes.modified.length}` +
      (changes.truncated ? "（文件过多，差异不完整）" : "")
  );
  for (const line of [
    listed("新增", changes.added),
    listed("删除", changes.removed),
    listed("修改", changes.modified),
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

function diffFiles(before: HostFileSnapshot, after: HostFileSnapshot): FileChanges {
  return {
    added: [...after.files.keys()].filter((file) => !before.files.has(file)).sort(),
    removed: [...before.files.keys()].filter((file) => !after.files.has(file)).sort(),
    modified: [...after.files]
      .filter(([file, signature]) => before.files.has(file) && before.files.get(file) !== signature)
      .map(([file]) => file)
      .sort(),
    truncated: before.truncated || after.truncated,
  };
}
