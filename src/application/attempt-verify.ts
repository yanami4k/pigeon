// 会话级验证命令（M7 S3，决策 071）：尝试收尾后由程序作为独立子进程在该尝试的工作区执行配置的验证命令，
// 模型看不到（结果不进消息，只落通用验证记录）；三值口径同 058。未配置即不跑，标签由会话现算为未知。
// - verifyAttempt：跑一次并写一条验证记录条目（写进哪个会话文件由调用方的单写者约束决定）；
// - attachAttemptVerification：主会话挂载——订阅 run.ended，Run 结束后在工作区根执行；验证在后台跑，
//   失败只进内部错误清单，不改变 Run 结果；释放运行面前等在跑的验证收尾（其记录写进本会话文件）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CHECK_OUTPUT_LIMIT_BYTES,
  type CheckOutcome,
  collector,
  finishCheck,
  runCheckCommand,
  shellCommand,
} from "../execution/check-command.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { SessionEntrySink } from "../state/session-entries.ts";
import type { AttemptVerifiedInput } from "../state/session-payloads.ts";
import {
  isToolCrash,
  type VerifyStepOutcome,
  verdictOfSteps,
  verifyStepsOf,
} from "../state/verify-steps.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { verificationEntry } from "./session-store.ts";

// 经执行端验证时取回的输出上限：取全量再按本地同一口径留尾部、计字节数与哈希（执行端只留开头）
const HOST_VERIFY_OUTPUT_BYTES = 64 * 1024 * 1024;

// 执行一行验证命令：给了执行端即经它在其工作区根执行（容器工作区），cwd 为相对工作区根的子目录；否则在本地子进程执行。
// 经执行端时超时与拉不起来按未判定，与本地同一口径
async function runVerifyCommand(
  command: string,
  workspace: string,
  cwd: string | undefined,
  timeoutMs: number,
  host: WorkspaceHost | undefined
): Promise<CheckOutcome> {
  if (host === undefined) {
    return runCheckCommand({
      ...shellCommand(command),
      cwd: cwd !== undefined ? join(workspace, cwd) : workspace,
      timeoutMs,
    });
  }
  const startedAt = Date.now();
  const line = cwd !== undefined ? `cd '${cwd.replace(/'/g, "'\\''")}' && ${command}` : command;
  const argv = ["sh", "-c", line];
  const result = await host.exec(
    { program: "sh", args: ["-c", line], verbatim: false },
    { env: {}, timeoutMs, maxOutputBytes: HOST_VERIFY_OUTPUT_BYTES, signal: undefined }
  );
  const collected = collector();
  collected.push(Buffer.from(result.output, "utf8"), true);
  return finishCheck({
    command: argv,
    startedAt,
    collected,
    exitCode: result.spawned ? result.exitCode : null,
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    timedOut: result.timedOut,
    ...(result.spawnError !== undefined
      ? { error: `命令拉不起来：${result.spawnError.message}` }
      : {}),
  });
}

export interface VerifyAttemptInput {
  config: VerifyConfig;
  // 执行验证的工作区（尝试所在的工作树或工作区根）
  workspace: string;
  target: { sessionId: SessionId; runId: RunId };
  // 验证记录写进哪个会话（单写者约束：worker 尝试落父会话，普通会话落自身）
  store: SessionEntrySink;
  // 写记录时所属的 Run（写进尝试自己的会话文件时即该 Run；父会话无活动 Run 时缺省）
  envelopeRunId?: RunId;
  // 工作区在执行端另一侧（容器）时经它执行；workspace 此时记执行端的工作区根
  host?: WorkspaceHost;
}

export interface VerifyAttemptResult {
  outcome: CheckOutcome;
  // 决策 159：分步配置下的各步结论（单条命令配置缺省）；检查工具自身崩溃的步带工具故障标记（决策 170 ③）
  steps?: VerifyStepOutcome[];
  // 交给会话存储的验证记录（写入面自身不抛，失败按内部故障告警）
  record: AttemptVerifiedInput;
}

// 分步配置（决策 159）：各步依次执行、各出结论，前一步失败不跳过后续；超时按每步各自计时。
// 检查工具自身崩溃（决策 170 ③）：声明了检查工具的步以该工具的崩溃退出码收尾即重跑一次，按重跑的结果记；仍崩溃即标工具故障。
// 整体结论为不是工具故障的各步的合取；整体退出码取第一个失败步骤的（通过为 0，无法判定为空）；整体输出为各步输出按步分段后的末尾
async function runVerifySteps(
  config: VerifyConfig,
  workspace: string,
  host: WorkspaceHost | undefined
): Promise<{ outcome: CheckOutcome; steps: VerifyStepOutcome[] }> {
  const startedAt = Date.now();
  const outcomes: Array<{
    name: string;
    command: string;
    cwd?: string;
    outcome: CheckOutcome;
    toolFault: boolean;
  }> = [];
  for (const step of verifyStepsOf(config)) {
    const run = () => runVerifyCommand(step.command, workspace, step.cwd, config.timeoutMs, host);
    let outcome = await run();
    let toolFault = false;
    if (isToolCrash(step.tool, outcome.exitCode)) {
      outcome = await run();
      toolFault = isToolCrash(step.tool, outcome.exitCode);
    }
    outcomes.push({
      name: step.name,
      command: step.command,
      ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
      outcome,
      toolFault,
    });
  }
  const steps: VerifyStepOutcome[] = outcomes.map(({ name, cwd, outcome, toolFault }) => ({
    name,
    exitCode: outcome.exitCode,
    verdict: outcome.verdict,
    output: outcome.output,
    truncated: outcome.truncated,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(toolFault ? { toolFault: true as const } : {}),
  }));
  const verdict = verdictOfSteps(steps);
  const firstFailed = steps.find((step) => step.verdict === "fail" && step.toolFault !== true);
  const sections = outcomes
    .map(
      ({ name, outcome, toolFault }) =>
        `== [${name}] ${outcome.verdict}（退出码 ${outcome.exitCode ?? "无"}${
          toolFault ? "；工具故障：检查工具自身崩溃，重跑一次仍崩溃，不计入结论" : ""
        }）==\n${outcome.output.trimEnd()}`
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
      ? await runVerifySteps(input.config, input.workspace, input.host)
      : undefined;
  const outcome =
    stepped?.outcome ??
    (await runVerifyCommand(
      input.config.command,
      input.workspace,
      undefined,
      input.config.timeoutMs,
      input.host
    ));
  const steps = stepped?.steps;
  const recordInput: AttemptVerifiedInput = {
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
  };
  input.store.append(verificationEntry(recordInput));
  return { outcome, ...(steps !== undefined ? { steps } : {}), record: recordInput };
}

export interface AttachAttemptVerificationOptions {
  bundle: RuntimeBundle;
  config: VerifyConfig;
  workspaceRoot: string;
  // 工作区在执行端另一侧（日常沙箱的容器）时经它执行验证命令；缺省在本地 workspaceRoot 执行
  host?: WorkspaceHost;
  // 一次尝试验证完成（记录已交给会话存储）后的附加处理——失败自动分叉重试的挂点；抛错只进错误清单
  onVerified?: (record: AttemptVerifiedInput) => void | Promise<void>;
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
        workspace: options.host?.root ?? options.workspaceRoot,
        ...(options.host !== undefined ? { host: options.host } : {}),
        target: { sessionId, runId },
        store: bundle.sessionStore,
        envelopeRunId: runId,
      });
      await options.onVerified?.(result.record);
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
