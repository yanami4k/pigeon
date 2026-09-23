// Eval 验证器（M6.5 S3，决策 058 含修订）：业务成败由确定性验证器判定，模型自己跑的测试只是反馈不是判决。
// runner 在 agent 收工后先把 task.json 声明的验证资产从任务目录覆盖写回工作区——agent 改动或删除的同名文件
// 不作数（yolo 下 agent 可以改掉测试骗过验证器，回填是 SWE-bench 评测时才打测试补丁的同一做法）；
// 再作为独立子进程在工作区执行验证器，参数数组不经 shell，带超时。退出码 0 通过、非 0 失败，
// 超时、被信号终止、拉不起来或回填失败为"未判定"；stdout 尾行是 JSON 时原样收入。
// 误报第一层：agent 自报完成（从账本判定：run.ended 在场、末轮 assistant 以正常 stop 收尾且非合成失败、
// 每个提议的工具调用都已落定、末个工具结果不是错误）但判决为失败；不让模型输出特殊标记。
// 第二层反向断言只留 task.json 字段，不执行。判决记观察族 eval.verified，落该次运行的会话文件。
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  type CheckOutcome,
  collector,
  finishCheck,
  judgeVerdict,
  runCheckCommand,
} from "../execution/check-command.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { lastStepRunOf } from "../state/repair-step.ts";
import { type LoadedEvalTask, TASK_DIR_TOKEN } from "./task.ts";
import type { JudgeCommand } from "./task-source.ts";

// 截断输出只留尾部（测试日志的结论在末尾）；上限与执行核心同一常量
export { CHECK_OUTPUT_LIMIT_BYTES as VERIFIER_OUTPUT_LIMIT_BYTES } from "../execution/check-command.ts";

export interface VerifierOutcome extends CheckOutcome {
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

export { judgeVerdict };

// 自造题的判据命令（决策 102 的本地实现）：先回填验证资产，再给出在工作区执行的验证器命令
export function localJudge(
  task: LoadedEvalTask,
  workspaceRoot: string,
  options: RunVerifierOptions = {}
): () => Promise<JudgeCommand> {
  return async () => {
    let assets: string[] = [];
    if (options.restoreFirst !== false) {
      try {
        assets = restoreAssets(task, workspaceRoot);
      } catch (error) {
        throw new Error(
          `回填验证资产失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return {
      command: verifierCommand(task),
      cwd: workspaceRoot,
      timeoutMs: task.spec.verifier.timeoutMs,
      env: { ...process.env, PIGEON_EVAL_TASK_DIR: task.dir },
      assets,
    };
  };
}

// 执行判据命令（M7 S3，决策 071：执行核心在 execution/check-command.ts，与会话级验证命令共用）。
// 备料失败、判据自身出错的约定退出码都记未判定——缺失的结果不支撑确定性结论
export async function runJudge(
  judge: () => Promise<JudgeCommand>,
  commandHint: readonly string[]
): Promise<VerifierOutcome> {
  const startedAt = Date.now();
  let spec: JudgeCommand;
  try {
    spec = await judge();
  } catch (error) {
    return {
      ...finishCheck({
        command: [...commandHint],
        startedAt,
        collected: collector(),
        exitCode: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      assets: [],
    };
  }
  const outcome = await runCheckCommand({
    command: spec.command,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    ...(spec.env !== undefined ? { env: spec.env } : {}),
  });
  // 拉不起来的措辞沿用验证器口径
  let error = outcome.error?.replace(/^命令拉不起来：/, "验证器拉不起来：");
  if (
    error === undefined &&
    outcome.exitCode !== null &&
    spec.undeterminedExitCodes?.includes(outcome.exitCode) === true
  ) {
    error = `判据自身出错（退出码 ${outcome.exitCode}）`;
  }
  return {
    ...outcome,
    ...(error !== undefined ? { error, verdict: judgeVerdict({ ...outcome, error }) } : {}),
    assets: spec.assets,
  };
}

export function runVerifier(
  task: LoadedEvalTask,
  workspaceRoot: string,
  options: RunVerifierOptions = {}
): Promise<VerifierOutcome> {
  return runJudge(localJudge(task, workspaceRoot, options), verifierCommand(task));
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
  taskId: string;
  // 判据命令由任务源给出（决策 102）；commandHint 是备料失败时记进验证记录的命令
  judge: () => Promise<JudgeCommand>;
  commandHint: readonly string[];
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
  const outcome = await runJudge(input.judge, input.commandHint);
  const sessionsDir = path.join(input.governanceRoot, ".pigeon", "sessions");
  const session = materializeSession(sessionsDir, input.sessionId, { content: false });
  // 回炉（决策 142 / 143）：自报完成看这一步最后一个 Run——一步怎么收尾看最后一轮，eval.verified 仍挂在这一步的身份上
  const done =
    input.runId !== undefined && selfReportedDone(session, lastStepRunOf(session, input.runId));
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
            taskId: input.taskId,
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
