// headless 运行入口（M6.5 S1，决策 056；M7 S6，决策 079）：单次运行核心在 headless-core.ts，本入口叠加失败自动分叉重试——
// 尝试标为失败（由账本现算）且 retryOnFail 大于 0 时，从本次任务开始处分叉重试（不注入任何提示），最多 K 次，
// 共用同一组上限；叶子验证完成后自动提炼（配置了提炼器运行面时）。Eval 不走重试（runner 不传 retryOnFail）。

import type { WorkerRuntimeFactory } from "../orchestration/workers.ts";
import type { ReviewGate } from "../review/scheduler.ts";
import { type RetryOutcome, runRetryOnFail } from "./fork.ts";
import {
  type HeadlessRunOptions,
  type HeadlessRunResult,
  runHeadlessOnce,
} from "./headless-core.ts";

export * from "./headless-core.ts";

export interface HeadlessRetryOptions extends HeadlessRunOptions {
  // 叶子验证完成后的自动提炼：提炼器运行面工厂与全局并发闸；缺省不提炼
  distill?: { createRuntime: WorkerRuntimeFactory; gate?: ReviewGate };
}

export interface HeadlessRetryResult extends HeadlessRunResult {
  retries?: RetryOutcome["retries"];
  distill?: RetryOutcome["distill"];
  distillSkip?: RetryOutcome["skip"];
  // M8 收口补遗：重试路径上提炼与自动验证的内部故障，不吞掉
  retryErrors?: RetryOutcome["errors"];
}

export async function runHeadless(options: HeadlessRetryOptions): Promise<HeadlessRetryResult> {
  const { distill, ...once } = options;
  const result = await runHeadlessOnce(once);
  const retries = options.retryOnFail ?? 0;
  if (retries <= 0 || result.label !== "Failed" || result.runId === undefined) {
    return result;
  }
  const outcome = await runRetryOnFail({
    governanceRoot: options.governanceRoot,
    sourceSessionId: result.sessionId,
    runId: result.runId,
    retries,
    run: {
      streamFn: options.streamFn,
      yolo: options.yolo,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.persistThinking !== undefined
        ? { persistThinking: options.persistThinking }
        : {}),
      ...(options.editMode !== undefined ? { editMode: options.editMode } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      // 重试沿用来源尝试的采样温度与工作方式指令（087 修订、110）：换了就不是同一把尺子
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.taskDirective !== undefined ? { taskDirective: options.taskDirective } : {}),
      ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
      ...(options.verify !== undefined ? { verify: options.verify } : {}),
      ...(options.skillRoots !== undefined ? { skillRoots: options.skillRoots } : {}),
      ...(options.memoryRoots !== undefined ? { memoryRoots: options.memoryRoots } : {}),
    },
    ...(distill !== undefined ? { distill } : {}),
  });
  return {
    ...result,
    retries: outcome.retries,
    ...(outcome.distill !== undefined ? { distill: outcome.distill } : {}),
    ...(outcome.skip !== undefined ? { distillSkip: outcome.skip } : {}),
    // M8 收口补遗：提炼与自动验证的内部故障不吞掉
    ...(outcome.errors.length > 0 ? { retryErrors: outcome.errors } : {}),
  };
}
