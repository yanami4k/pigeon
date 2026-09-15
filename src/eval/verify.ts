// Eval 验证器（M6.5 S3，决策 058 含修订）：业务成败由确定性验证器判定，模型自己跑的测试只是反馈不是判决。
// runner 在 agent 收工后先把 task.json 声明的验证资产从任务目录覆盖写回工作区——agent 改动或删除的同名文件
// 不作数（yolo 下 agent 可以改掉测试骗过验证器，回填是 SWE-bench 评测时才打测试补丁的同一做法）；
// 再作为独立子进程在工作区执行验证器，参数数组不经 shell，带超时。退出码 0 通过、非 0 失败，
// 超时、被信号终止、拉不起来或回填失败为"未判定"；stdout 尾行是 JSON 时原样收入。
// 误报第一层：agent 自报完成（从账本判定：run.ended 在场、末轮 assistant 以正常 stop 收尾且非合成失败、
// 每个提议的工具调用都已落定、末个工具结果不是错误）但判决为失败；不让模型输出特殊标记。
// 第二层反向断言只留 task.json 字段，不执行。判决记观察族 eval.verified，落该次运行的会话文件。
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import type { EvalVerdict } from "../state/runtime-events.ts";
import { type LoadedEvalTask, TASK_DIR_TOKEN } from "./task.ts";

// 截断输出只留尾部（测试日志的结论在末尾）
export const VERIFIER_OUTPUT_LIMIT_BYTES = 16 * 1024;

export interface VerifierOutcome {
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
  assets: string[];
}

export interface RunVerifierOptions {
  // 先回填验证资产；缺省 true
  restoreFirst?: boolean;
}

// 验证资产覆盖写回工作区（源：<任务目录>/assets/<路径>）
export function restoreAssets(task: LoadedEvalTask, workspaceRoot: string): string[] {
  for (const asset of task.spec.assets) {
    const target = path.join(workspaceRoot, asset);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(task.dir, "assets", asset), target);
  }
  return [...task.spec.assets];
}

export function verifierCommand(task: LoadedEvalTask): string[] {
  const argv = task.spec.verifier.command.map((arg) => arg.split(TASK_DIR_TOKEN).join(task.dir));
  // node 走当前 Node 可执行文件：不依赖 PATH，也避开 Windows 上的 .cmd 垫片
  if (argv[0] === "node") {
    argv[0] = process.execPath;
  }
  return argv;
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

export async function runVerifier(
  task: LoadedEvalTask,
  workspaceRoot: string,
  options: RunVerifierOptions = {}
): Promise<VerifierOutcome> {
  const command = verifierCommand(task);
  const startedAt = Date.now();
  let assets: string[] = [];
  if (options.restoreFirst !== false) {
    try {
      assets = restoreAssets(task, workspaceRoot);
    } catch (error) {
      const message = `回填验证资产失败：${error instanceof Error ? error.message : String(error)}`;
      return finish({
        command,
        startedAt,
        assets,
        exitCode: null,
        timedOut: false,
        error: message,
        collected: collector(),
      });
    }
  }
  const collected = collector();
  const [file, ...args] = command;
  const result = await new Promise<{
    exitCode: number | null;
    signal?: string;
    timedOut: boolean;
    error?: string;
  }>((resolve) => {
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(file ?? "", args, {
      cwd: workspaceRoot,
      env: { ...process.env, PIGEON_EVAL_TASK_DIR: task.dir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk: Buffer) => collected.push(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collected.push(chunk, false));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, task.spec.verifier.timeoutMs);
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        ...(signal !== null ? { signal } : {}),
        timedOut,
        ...(spawnError !== undefined ? { error: `验证器拉不起来：${spawnError}` } : {}),
      });
    });
  });
  return finish({ command, startedAt, assets, collected, ...result });
}

interface Collector {
  push(chunk: Buffer, stdout: boolean): void;
  bytes(): number;
  hash(): string;
  tail(): Buffer;
  stdoutTail(): Buffer;
}

function collector(): Collector {
  const hash = createHash("sha256");
  let bytes = 0;
  let tail: Buffer = Buffer.alloc(0);
  let stdoutTail: Buffer = Buffer.alloc(0);
  const keepTail = (buffer: Buffer, chunk: Buffer): Buffer => {
    const joined = Buffer.concat([buffer, chunk]);
    return joined.length > VERIFIER_OUTPUT_LIMIT_BYTES
      ? joined.subarray(joined.length - VERIFIER_OUTPUT_LIMIT_BYTES)
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

function finish(input: {
  command: string[];
  startedAt: number;
  assets: string[];
  collected: Collector;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  error?: string;
}): VerifierOutcome {
  const { collected } = input;
  const truncated = collected.bytes() > VERIFIER_OUTPUT_LIMIT_BYTES;
  // 尾部截断可能劈开开头的 UTF-8 字符：去掉解码出的替换符
  const output = collected.tail().toString("utf8").replace(/^�+/, "");
  const details = parseTailJson(collected.stdoutTail().toString("utf8"));
  const outcome: VerifierOutcome = {
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
    assets: input.assets,
  };
  return outcome;
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

// 超时终止整棵进程树（验证脚本常再起 node --test 子进程）；Windows 用 taskkill /T
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error !== null) {
        fallback();
      }
    });
    return;
  }
  fallback();
}

// 自报完成（从账本判定，不让模型输出特殊标记）
export function selfReportedDone(session: MaterializedSession, runId: RunId): boolean {
  const events = session.runtimeEvents.filter((record) => record.runId === runId);
  if (!events.some((record) => record.kind === "run.ended")) {
    return false;
  }
  const lastTurn = events.findLast((record) => record.kind === "turn.completed");
  if (
    lastTurn === undefined ||
    lastTurn.kind !== "turn.completed" ||
    lastTurn.payload.stopReason !== "stop" ||
    lastTurn.payload.syntheticFailure
  ) {
    return false;
  }
  const settled = new Map<string, boolean>();
  let lastSettledError = false;
  for (const record of events) {
    if (record.kind === "tool.settled") {
      settled.set(record.payload.toolCallId, record.payload.isError);
      lastSettledError = record.payload.isError;
    }
  }
  const unclosed = events.some(
    (record) => record.kind === "tool.proposed" && !settled.has(record.payload.toolCallId)
  );
  return !unclosed && !lastSettledError;
}

export interface VerifyTaskRunInput {
  task: LoadedEvalTask;
  workspaceRoot: string;
  // 该次运行的治理根（会话文件在其 .pigeon/sessions 下）
  governanceRoot: string;
  sessionId: SessionId;
  // 运行面没装起来时缺省：照样判决，但没有 Run 可挂 eval.verified
  runId?: RunId;
}

export interface VerificationResult extends VerifierOutcome {
  selfReportedDone: boolean;
  falsePositive: boolean;
  // eval.verified 是否已落盘
  recorded: boolean;
  recordError?: string;
}

export async function verifyTaskRun(input: VerifyTaskRunInput): Promise<VerificationResult> {
  const outcome = await runVerifier(input.task, input.workspaceRoot);
  const sessionsDir = path.join(input.governanceRoot, ".pigeon", "sessions");
  const session = materializeSession(sessionsDir, input.sessionId, { content: false });
  const done = input.runId !== undefined && selfReportedDone(session, input.runId);
  const falsePositive = done && outcome.verdict === "fail";
  let recorded = false;
  let recordError: string | undefined;
  if (input.runId !== undefined) {
    try {
      const log = new JsonlEventLog(sessionsDir, input.sessionId);
      try {
        log.appendObservation({
          kind: "eval.verified",
          runId: input.runId,
          payload: {
            taskId: input.task.spec.id,
            command: outcome.command,
            exitCode: outcome.exitCode,
            ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
            timedOut: outcome.timedOut,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            durationMs: outcome.durationMs,
            outputBytes: outcome.outputBytes,
            outputHash: outcome.outputHash,
            output: outcome.output,
            truncated: outcome.truncated,
            verdict: outcome.verdict,
            ...(outcome.details !== undefined ? { details: outcome.details } : {}),
            assets: outcome.assets,
            selfReportedDone: done,
            falsePositive,
          },
        });
        recorded = true;
      } finally {
        log.close();
      }
    } catch (error) {
      recordError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...outcome,
    selfReportedDone: done,
    falsePositive,
    recorded,
    ...(recordError !== undefined ? { recordError } : {}),
  };
}
