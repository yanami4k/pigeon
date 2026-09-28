// 验证命令执行核心（M7 S3，决策 071；从 M6.5 Eval 验证器下沉，决策 058 口径）：作为独立子进程在给定工作区执行，
// 带超时（超时终止整棵进程树）；stdout 与 stderr 按到达顺序计字节数与哈希，只留尾部截断文本；stdout 尾行是 JSON 时原样收入。
// 三值判决：退出码 0 通过、非 0 失败，超时、被信号终止、拉不起来为未判定。
// Eval 验证器（参数数组不经 shell）与会话级验证命令（人配置的一行命令，经系统 shell）共用本模块；
// 记录的参数数组即实际交给子进程的参数，不做美化。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EvalVerdict } from "../state/runtime-events.ts";
import {
  killProcessTree,
  processGroupSpawnOptions,
  trackChild,
  untrackChild,
} from "../tools/process-tree.ts";

// 截断输出只留尾部（测试日志的结论在末尾）
export const CHECK_OUTPUT_LIMIT_BYTES = 16 * 1024;
// 超时终止后等待 close 的宽限（毫秒）
const KILL_GRACE_MS = 5000;

export interface CheckCommandSpec {
  // 实际交给子进程的参数数组（首项为可执行文件）
  command: string[];
  // Windows 上 cmd.exe 的命令行不做二次转义（系统 shell 执行一行命令时需要）
  verbatimArguments?: boolean;
}

export interface CheckCommandInput extends CheckCommandSpec {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CheckOutcome {
  command: string[];
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  error?: string;
  durationMs: number;
  outputBytes: number;
  outputHash: string;
  output: string;
  truncated: boolean;
  verdict: EvalVerdict;
  details?: unknown;
}

export function judgeVerdict(outcome: {
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}): EvalVerdict {
  if (outcome.timedOut || outcome.error !== undefined || outcome.exitCode === null) {
    return "undetermined";
  }
  return outcome.exitCode === 0 ? "pass" : "fail";
}

// 一行命令经系统 shell：Windows 为 cmd.exe /d /s /c "<命令>"（与 Node shell 选项同一形态），其余为 /bin/sh -c
export function shellCommand(line: string): CheckCommandSpec {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { command: [comspec, "/d", "/s", "/c", line], verbatimArguments: true };
  }
  return { command: ["/bin/sh", "-c", line] };
}

export async function runCheckCommand(input: CheckCommandInput): Promise<CheckOutcome> {
  const startedAt = Date.now();
  const collected = collector();
  const [file, ...rawArgs] = input.command;
  // cmd.exe 的 /c 参数要整体加引号交给 /s 剥除（verbatim 时 Node 不再转义）
  const args =
    input.verbatimArguments === true && rawArgs.length > 0
      ? [...rawArgs.slice(0, -1), `"${rawArgs.at(-1) ?? ""}"`]
      : rawArgs;
  const result = await new Promise<{
    exitCode: number | null;
    signal?: string;
    timedOut: boolean;
    error?: string;
  }>((resolve) => {
    let timedOut = false;
    let spawnError: string | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file ?? "", args, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // 以独立进程组拉起：超时终止时对整组发信号，覆盖 /bin/sh -c 里再起的 node 等孙进程
        ...processGroupSpawnOptions(),
        ...(input.verbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      });
      trackChild(child);
    } catch (error) {
      resolve({
        exitCode: null,
        timedOut: false,
        error: `命令拉不起来：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: {
      exitCode: number | null;
      signal?: string;
      timedOut: boolean;
      error?: string;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      untrackChild(child);
      resolve(value);
    };
    child.stdout?.on("data", (chunk: Buffer) => collected.push(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collected.push(chunk, false));
    const timer = setTimeout(() => {
      timedOut = true;
      // 超时直接 SIGKILL 整组：验证脚本已判超时，无需给孙进程善后机会，决胜要快
      killProcessTree(child, "SIGKILL");
      // 终止后给宽限：孙进程可能仍占着输出管道，close 迟迟不来时销毁管道、按超时收尾，判决不无限等待
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ exitCode: null, timedOut: true });
      }, KILL_GRACE_MS);
    }, input.timeoutMs);
    child.on("error", (error) => {
      spawnError = error.message;
      // 拉不起来的进程可能只有 error 没有 close：直接收尾
      if (child.pid === undefined) {
        finish({ exitCode: null, timedOut, error: `命令拉不起来：${spawnError}` });
      }
    });
    child.on("close", (code, signal) => {
      finish({
        exitCode: code,
        ...(signal !== null ? { signal } : {}),
        timedOut,
        ...(spawnError !== undefined ? { error: `命令拉不起来：${spawnError}` } : {}),
      });
    });
  });
  return finishCheck({ command: input.command, startedAt, collected, ...result });
}

export interface CheckCollector {
  push(chunk: Buffer, stdout: boolean): void;
  bytes(): number;
  hash(): string;
  tail(): Buffer;
  stdoutTail(): Buffer;
}

export function collector(): CheckCollector {
  const hash = createHash("sha256");
  let bytes = 0;
  let tail: Buffer = Buffer.alloc(0);
  let stdoutTail: Buffer = Buffer.alloc(0);
  const keepTail = (buffer: Buffer, chunk: Buffer): Buffer => {
    const joined = Buffer.concat([buffer, chunk]);
    return joined.length > CHECK_OUTPUT_LIMIT_BYTES
      ? joined.subarray(joined.length - CHECK_OUTPUT_LIMIT_BYTES)
      : joined;
  };
  return {
    push(chunk, stdout) {
      hash.update(chunk);
      bytes += chunk.length;
      tail = keepTail(tail, chunk);
      if (stdout) {
        stdoutTail = keepTail(stdoutTail, chunk);
      }
    },
    bytes: () => bytes,
    hash: () => hash.copy().digest("hex"),
    tail: () => tail,
    stdoutTail: () => stdoutTail,
  };
}

export function finishCheck(input: {
  command: string[];
  startedAt: number;
  collected: CheckCollector;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  error?: string;
}): CheckOutcome {
  const { collected } = input;
  const truncated = collected.bytes() > CHECK_OUTPUT_LIMIT_BYTES;
  // 尾部截断可能劈开开头的 UTF-8 字符：去掉解码出的替换符
  const output = collected.tail().toString("utf8").replace(/^�+/, "");
  const details = parseTailJson(collected.stdoutTail().toString("utf8"));
  return {
    command: input.command,
    exitCode: input.exitCode,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    timedOut: input.timedOut,
    ...(input.error !== undefined ? { error: input.error } : {}),
    durationMs: Date.now() - input.startedAt,
    outputBytes: collected.bytes(),
    outputHash: collected.hash(),
    output,
    truncated,
    verdict: judgeVerdict(input),
    ...(details !== undefined ? { details } : {}),
  };
}

function parseTailJson(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(last);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
