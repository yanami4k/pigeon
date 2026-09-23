// 会话级验证命令（M7 S3，决策 071）：尝试收尾后由程序作为独立子进程在该尝试的工作区执行配置的验证命令，
// 模型看不到（结果不进消息，只落通用验证记录）；三值口径同 058。未配置即不跑，标签由账本现算为未知。
// - verifyAttempt：跑一次并落一条 attempt.verified（落在哪个会话文件由调用方的单写者约束决定）；
// - attachAttemptVerification：主会话挂载——订阅 run.ended，Run 结束后在工作区根执行；验证在后台跑，
//   失败只进内部错误清单，不改变 Run 结果；释放运行面前等在跑的验证收尾（其记录写进本会话文件）。
import { createHash } from "node:crypto";
import {
  CHECK_OUTPUT_LIMIT_BYTES,
  type CheckOutcome,
  runCheckCommand,
  shellCommand,
} from "../execution/check-command.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { AttemptVerifiedInput, AttemptVerifiedRecord } from "../state/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import {
  combineStepVerdicts,
  type VerifyStepResult,
  verifyStepsOf,
} from "../state/verify-steps.ts";
import type { RuntimeBundle } from "./runtime.ts";

export interface AttemptVerificationSink {
  appendAttemptVerified(input: AttemptVerifiedInput): AttemptVerifiedRecord;
}

export interface VerifyAttemptInput {
  config: VerifyConfig;
  // 执行验证的工作区（尝试所在的工作树或工作区根）
  workspace: string;
  target: { sessionId: SessionId; runId: RunId };
  sink: AttemptVerificationSink;
  // 写记录时的信封 Run（写进尝试自己的会话文件时即该 Run；父会话无活动 Run 时缺省）
  envelopeRunId?: RunId;
}

export interface VerifyAttemptResult {
  outcome: CheckOutcome;
  // 决策 159：分步配置下的各步结论（单条命令配置缺省）
  steps?: VerifyStepResult[];
  // 落盘成功时在场
  record?: AttemptVerifiedRecord;
  recordError?: unknown;
}

// 分步配置（决策 159）：各步依次执行、各出结论，前一步失败不跳过后续；超时按每步各自计时。
// 整体结论为各步合取；整体退出码取第一个失败步骤的（通过为 0，无法判定为空）；整体输出为各步输出按步分段后的末尾
async function runVerifySteps(
  config: VerifyConfig,
  workspace: string
): Promise<{ outcome: CheckOutcome; steps: VerifyStepResult[] }> {
  const startedAt = Date.now();
  const outcomes: Array<{ name: string; command: string; outcome: CheckOutcome }> = [];
  for (const step of verifyStepsOf(config)) {
    const outcome = await runCheckCommand({
      ...shellCommand(step.command),
      cwd: workspace,
      timeoutMs: config.timeoutMs,
    });
    outcomes.push({ name: step.name, command: step.command, outcome });
  }
  const steps: VerifyStepResult[] = outcomes.map(({ name, outcome }) => ({
    name,
    exitCode: outcome.exitCode,
    verdict: outcome.verdict,
    output: outcome.output,
    truncated: outcome.truncated,
  }));
  const verdict = combineStepVerdicts(steps.map((step) => step.verdict));
  const firstFailed = steps.find((step) => step.verdict === "fail");
  const sections = outcomes
    .map(
      ({ name, outcome }) =>
        `== [${name}] ${outcome.verdict}（退出码 ${outcome.exitCode ?? "无"}）==\n${outcome.output.trimEnd()}`
    )
    .join("\n\n");
  const encoded = Buffer.from(sections, "utf8");
  const combinedTruncated = encoded.length > CHECK_OUTPUT_LIMIT_BYTES;
  const errors = outcomes
    .filter(({ outcome }) => outcome.error !== undefined)
    .map(({ name, outcome }) => `[${name}] ${outcome.error}`);
  const hash = createHash("sha256");
  for (const { outcome } of outcomes) {
    hash.update(outcome.outputHash);
  }
  return {
    steps,
    outcome: {
      // 分步配置下记各步的命令行（按顺序），不是某一个子进程的参数数组
      command: outcomes.map(({ command }) => command),
      exitCode:
        verdict === "pass" ? 0 : verdict === "fail" ? (firstFailed?.exitCode ?? null) : null,
      timedOut: outcomes.some(({ outcome }) => outcome.timedOut),
      ...(errors.length > 0 ? { error: errors.join("；") } : {}),
      durationMs: Date.now() - startedAt,
      outputBytes: outcomes.reduce((sum, { outcome }) => sum + outcome.outputBytes, 0),
      // 各步输出哈希按顺序串起来的哈希
      outputHash: hash.digest("hex"),
      output: combinedTruncated
        ? encoded
            .subarray(encoded.length - CHECK_OUTPUT_LIMIT_BYTES)
            .toString("utf8")
            .replace(/^�+/, "")
        : sections,
      truncated: combinedTruncated || outcomes.some(({ outcome }) => outcome.truncated),
      verdict,
    },
  };
}

export async function verifyAttempt(input: VerifyAttemptInput): Promise<VerifyAttemptResult> {
  const stepped =
    input.config.steps !== undefined
      ? await runVerifySteps(input.config, input.workspace)
      : undefined;
  const outcome =
    stepped?.outcome ??
    (await runCheckCommand({
      ...shellCommand(input.config.command),
      cwd: input.workspace,
      timeoutMs: input.config.timeoutMs,
    }));
  const steps = stepped?.steps;
  try {
    const record = input.sink.appendAttemptVerified({
      ...(input.envelopeRunId !== undefined ? { runId: input.envelopeRunId } : {}),
      target: input.target,
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
      workspace: input.workspace,
      verdict: outcome.verdict,
      verifiedAt: Date.now(),
      ...(steps !== undefined ? { steps } : {}),
    });
    return { outcome, ...(steps !== undefined ? { steps } : {}), record };
  } catch (recordError) {
    return { outcome, ...(steps !== undefined ? { steps } : {}), recordError };
  }
}

export interface AttachAttemptVerificationOptions {
  bundle: RuntimeBundle;
  config: VerifyConfig;
  workspaceRoot: string;
  // 一次尝试验证完成（记录已落盘）后的附加处理——失败自动分叉重试的挂点；抛错只进错误清单
  onVerified?: (record: AttemptVerifiedRecord) => void | Promise<void>;
}

export interface AttemptVerification {
  // 等当前在跑的验证（含附加处理）全部收尾
  idle(): Promise<void>;
  // 退订并等在跑的验证收尾
  stop(): Promise<void>;
  errors(): unknown[];
}

export function attachAttemptVerification(
  options: AttachAttemptVerificationOptions
): AttemptVerification {
  const { bundle } = options;
  const sessionId = bundle.adapter.sessionId;
  const errors: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const unsubscribe = bundle.adapter.subscribe((event) => {
    if (event.kind !== "run.ended") {
      return;
    }
    const runId = event.runId;
    const task = (async () => {
      const result = await verifyAttempt({
        config: options.config,
        workspace: options.workspaceRoot,
        target: { sessionId, runId },
        sink: bundle.eventLog,
        envelopeRunId: runId,
      });
      if (result.recordError !== undefined) {
        errors.push(result.recordError);
        return;
      }
      if (result.record !== undefined) {
        await options.onVerified?.(result.record);
      }
    })().catch((error: unknown) => {
      errors.push(error);
    });
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
  });
  const idle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };
  return {
    idle,
    stop: async () => {
      unsubscribe();
      await idle();
    },
    errors: () => [...errors],
  };
}
