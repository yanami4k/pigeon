// 会话级验证命令（M7 S3，决策 071）：尝试收尾后由程序作为独立子进程在该尝试的工作区执行配置的验证命令，
// 模型看不到（结果不进消息，只落通用验证记录）；三值口径同 058。未配置即不跑，标签由账本现算为未知。
// - verifyAttempt：跑一次并落一条 attempt.verified（落在哪个会话文件由调用方的单写者约束决定）；
// - attachAttemptVerification：主会话挂载——订阅 run.ended，Run 结束后在工作区根执行；验证在后台跑，
//   失败只进内部错误清单，不改变 Run 结果；释放运行面前等在跑的验证收尾（其记录写进本会话文件）。
import { type CheckOutcome, runCheckCommand, shellCommand } from "../execution/check-command.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { AttemptVerifiedInput, AttemptVerifiedRecord } from "../state/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";
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
  // 落盘成功时在场
  record?: AttemptVerifiedRecord;
  recordError?: unknown;
}

export async function verifyAttempt(input: VerifyAttemptInput): Promise<VerifyAttemptResult> {
  const outcome = await runCheckCommand({
    ...shellCommand(input.config.command),
    cwd: input.workspace,
    timeoutMs: input.config.timeoutMs,
  });
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
    });
    return { outcome, record };
  } catch (recordError) {
    return { outcome, recordError };
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
