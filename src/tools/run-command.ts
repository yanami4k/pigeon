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
// 文件清单差异）按 toolCallId 暂存，receipt 落盘时由治理层取走。
// .pigeon/commands.json 的短名在此展开，角色允许清单在场时只接受清单内的短名或其展开命令；它不是 shell 授权来源。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { createLocalWorkspaceHost, windowsScript } from "./local-host.ts";
import type { HostExecPlan, HostFileSnapshot, WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_RUN_COMMAND_OUTPUT_BYTES = 32 * 1024;
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
  // 完整命令串，或 .pigeon/commands.json 登记的短名
  command: Type.String({ minLength: 1, maxLength: 4000 }),
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
  // 截断后的输出文本
  output: string;
  truncated: boolean;
  fileChanges: FileChanges;
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
}

// 可选能力：只读检查、按调用授予 shell、执行证据暂存（治理层使用）
export interface ExecEvidenceTool {
  inspectCommand(params: unknown): CommandInspection;
  authorizeShell(toolCallId: string): void;
  takeExecEvidence(toolCallId: string): ExecEvidence | undefined;
}

export interface RunCommandOptions {
  workspaceRoot: string;
  // 决策 098：执行端——缺省为 workspaceRoot 上的本地实现；容器工作区由装配方注入容器实现。
  // 工具只调接口：平台、工作目录、进程终止与文件清单都由实现决定
  host?: WorkspaceHost;
  // 短名 → 命令串（.pigeon/commands.json）
  commands?: Readonly<Record<string, string>>;
  // 在场 = 只允许清单内的短名或其展开命令（tester 等角色）
  allowlist?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  // 环境变量来源（缺省 process.env；只透传白名单）
  env?: NodeJS.ProcessEnv;
  // 平台（缺省 process.platform；决定 .cmd / .bat 解析与 shell 程序）；只对缺省的本地执行端生效，注入 host 时以 host 为准
  platform?: NodeJS.Platform;
  // 本会话的审批状态（只影响工具说明，审批本身由治理层判定）；缺省按有人工审批
  approval?: RunCommandApproval;
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
      "可用 .pigeon/commands.json 登记的短名。结果带退出码、输出（超长截断）与执行前后的文件变化。",
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
  ExecEvidenceTool {
  const host =
    options.host ??
    createLocalWorkspaceHost(
      options.workspaceRoot,
      options.platform !== undefined ? { platform: options.platform } : {}
    );
  const root = host.root;
  const platform = host.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_BYTES;
  const env = allowedEnv(options.env ?? process.env);
  const evidences = new Map<string, ExecEvidence>();
  // 治理层按调用授予的 shell 确认（一次一用）
  const shellAuthorized = new Set<string>();

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
    const scriptPath = host.findLauncherScript(argv[0] ?? "", env);
    if (scriptPath === undefined) {
      return { ...base, mode: "direct", needsShell: false, argv };
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
    takeExecEvidence(toolCallId) {
      const evidence = evidences.get(toolCallId);
      evidences.delete(toolCallId);
      return evidence;
    },
    async execute(toolCallId, params, signal): Promise<PigeonToolResult<ExecEvidence>> {
      const inspection = inspectParams(params);
      const { command, alias } = inspection;
      const authorized = shellAuthorized.delete(toolCallId);
      if (!permitted(inspection.input, command)) {
        const names = options.allowlist?.join("、") ?? "";
        throw new RunCommandError(
          `命令不在本角色允许清单内：${inspection.input}（只能运行 .pigeon/commands.json 为该角色登记的命令：${names === "" ? "未登记任何命令" : names}）`
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
      const plan = spawnPlan(inspection, env, platform);
      const before = await host.listFiles(FILE_SNAPSHOT_LIMIT);
      const run = await host.exec(plan, { env, timeoutMs, maxOutputBytes, signal });
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
        truncated: run.outputBytes > maxOutputBytes,
        fileChanges: diffFiles(before, after),
      };
      evidences.set(toolCallId, evidence);
      if (run.spawnError !== undefined) {
        if (run.spawnError.code === "ENOENT") {
          throw new RunCommandError(`命令不存在：${plan.program}`);
        }
        throw run.spawnError;
      }
      if (run.timedOut) {
        throw new RunCommandTimeoutError(
          `命令超时（${timeoutMs} 毫秒）已终止：${command}\n${resultText(evidence, maxOutputBytes)}`
        );
      }
      if (signal?.aborted === true) {
        throw new Error(`命令被中止：${command}`);
      }
      return {
        content: [{ type: "text", text: resultText(evidence, maxOutputBytes) }],
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
  const [program = "", ...args] = inspection.argv ?? [];
  return { program, args, verbatim: false };
}

export interface McpLaunchPlan {
  mode: "direct" | "launcher" | "shell";
  program: string;
  args: string[];
  verbatim: boolean;
}

// MCP server 启动计划（M5.7 S2，复用 048）：启动命令来自人写的 .mcp.json / .pigeon/mcp.json，参数已是数组、
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

function resultText(evidence: ExecEvidence, maxOutputBytes: number): string {
  const changes = evidence.fileChanges;
  const route = evidence.shell ? "（经 shell）" : evidence.launcher ? "（经 cmd.exe 启动器）" : "";
  const lines = [
    `$ ${evidence.command}${evidence.alias !== undefined ? `（短名 ${evidence.alias}）` : ""}${route}`,
    `退出码：${evidence.exitCode ?? "无"}${evidence.signal !== undefined ? `（信号 ${evidence.signal}）` : ""}`,
    evidence.output,
  ];
  if (evidence.truncated) {
    lines.push(`…（输出已截断：共 ${evidence.outputBytes} 字节，保留前 ${maxOutputBytes} 字节）`);
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
