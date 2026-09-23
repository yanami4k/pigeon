// 任务源上的回放（M9 第二阶段；M8 回放验证在容器执行端上的形态）：被验证的尝试来自 Eval 跑批，工作区在任务源
// 准备的容器里，没有宿主 git 工作树可开。回放照同一把尺子重跑同一道题：
//   - 起点：任务源对同一实例重新准备环境（评测镜像即基准提交上的初始状态），计划里记作"任务源起点"；
//   - 尺子：模型参数（含推理档位、输出上限、采样温度）、工作方式指令、预算、工具名单、编辑模式都沿用原尝试；
//   - 经验：每次回放一个临时治理根，按 085 播种（宿主已激活的经验照搬，带经验组再放入候选），显式作为经验根装载，
//     不读用户级目录——与 Eval 各条件显式给根同一口径；
//   - 判决：任务源的判据命令（与原尝试同一条判分路径），落该次回放会话的 eval.verified。
// 模型服务故障的回放不判分、记未判定（不算通过也不算失败，照样计入该组次数，与 084 固定 N 同口径）。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runHeadlessOnce } from "../application/headless.ts";
import {
  assertThinkingLevelReproducible,
  effectiveLimits,
  type RerunDispatcher,
  type RerunOutcome,
  type RerunRequest,
  VerifyPreconditionError,
} from "../application/rerun.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import { materializeSession } from "../persistence/event-log.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { seedRerunRoot } from "../replay/materials.ts";
import { type AttemptPlan, resolveAttemptPlan } from "../replay/plan.ts";
import type { AttemptRef } from "../state/attempt-ref.ts";
import { newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import { deterministicErrorOf, isContentRefusal } from "./runner.ts";
import type { EvalInstance, TaskSource } from "./task-source.ts";
import { verifyTaskRun } from "./verify.ts";

// 计划里的起点写法：任务源名与实例号（容器起点没有提交号可记）
const START_PREFIX = "task-source:";

export function taskSourceStart(sourceName: string, taskId: string): string {
  return `${START_PREFIX}${sourceName}:${taskId}`;
}

function taskIdOfStart(startCommit: string, sourceName: string): string {
  const prefix = `${START_PREFIX}${sourceName}:`;
  if (!startCommit.startsWith(prefix)) {
    throw new VerifyPreconditionError(
      `回放起点 ${startCommit} 不是任务源 ${sourceName} 的实例：只能在同一任务源上重跑`
    );
  }
  return startCommit.slice(prefix.length);
}

// 原尝试是哪道题：取它会话里与该 Run 对应的 eval.verified
export function evalTaskIdOf(
  ref: Pick<AttemptRef, "governanceRoot" | "sessionId" | "runId">
): string {
  const session = materializeSession(sessionsDirOf(ref.governanceRoot), ref.sessionId, {
    content: false,
  });
  const verified = session.evalVerifieds.filter((record) => record.runId === ref.runId).at(-1);
  if (verified === undefined) {
    throw new VerifyPreconditionError(
      `${ref.sessionId} 的 ${ref.runId} 没有 eval.verified：不是 Eval 跑批里判过分的尝试，无从确定是哪道题`
    );
  }
  return verified.payload.taskId;
}

// 容器尝试的回放计划：起点记为任务源的实例，其余照 run.started 解
export function taskSourcePlanFor(sourceName: string): (ref: AttemptRef) => AttemptPlan {
  return (ref) =>
    resolveAttemptPlan({
      sessionsDir: sessionsDirOf(ref.governanceRoot),
      sessionId: ref.sessionId,
      runId: ref.runId,
      startCommit: taskSourceStart(sourceName, evalTaskIdOf(ref)),
    });
}

export interface TaskSourceRerunOptions {
  // 宿主治理根：候选与已激活经验所在；回放的临时根建在它的 .pigeon/reruns 下，会话文件收回它的会话目录
  hostGovernanceRoot: string;
  source: TaskSource;
  streamFn: StreamFn;
  // 原尝试的编辑模式（run.started 不记，取自结果行；由调用方给出）
  editMode: EditMode;
  // 本次验证的种子（候选内容哈希）：临时根目录名用它区分
  nameSeed: string;
  homeDir?: string;
  now?: () => number;
}

export function createTaskSourceRerunDispatcher(options: TaskSourceRerunOptions): RerunDispatcher {
  const now = options.now ?? Date.now;
  const errors: unknown[] = [];
  const instances = new Map<string, EvalInstance>(
    options.source.instances().map((instance) => [instance.id, instance])
  );
  const hostSessionsDir = sessionsDirOf(options.hostGovernanceRoot);
  const rerun = async (request: RerunRequest): Promise<RerunOutcome> => {
    const { plan, arm, index } = request;
    assertThinkingLevelReproducible(plan.model);
    const taskId = taskIdOfStart(plan.startCommit, options.source.name);
    const instance = instances.get(taskId);
    if (instance === undefined) {
      throw new VerifyPreconditionError(`任务源 ${options.source.name} 里没有实例 ${taskId}`);
    }
    const limits = effectiveLimits(plan.budget);
    const startedAt = now();
    const sessionId = newSessionId();
    const tempRoot = path.join(
      options.hostGovernanceRoot,
      ".pigeon",
      "reruns",
      `${options.nameSeed.slice(0, 12)}-${arm}-${index}-${sessionId}`
    );
    mkdirSync(tempRoot, { recursive: true });
    const seeded = seedRerunRoot({
      hostGovernanceRoot: options.hostGovernanceRoot,
      tempGovernanceRoot: tempRoot,
      ...(request.candidate !== undefined
        ? {
            candidate: {
              kind: request.candidate.kind,
              name: request.candidate.name,
              content: request.candidate.content,
            },
          }
        : {}),
    });
    const prepared = await options.source.prepare(instance, {
      governanceRoot: tempRoot,
      sessionId,
      condition: request.candidate !== undefined ? "candidate" : "none",
      attempt: index,
    });
    try {
      const run = await runHeadlessOnce({
        task: plan.task,
        governanceRoot: tempRoot,
        workspaceRoot: prepared.workspaceRoot,
        ...(prepared.host !== undefined ? { workspaceHost: prepared.host } : {}),
        streamFn: options.streamFn,
        yolo: plan.approvalMode === "yolo",
        sessionId,
        provider: plan.model.provider,
        modelId: plan.model.id,
        thinking: plan.model.thinkingLevel as ThinkingLevel,
        ...(plan.model.maxOutputTokens !== undefined
          ? { maxOutputTokens: plan.model.maxOutputTokens }
          : {}),
        ...(plan.model.temperature !== undefined ? { temperature: plan.model.temperature } : {}),
        ...(plan.taskDirective !== undefined ? { taskDirective: plan.taskDirective } : {}),
        maxTurns: limits.maxTurns,
        wallClockMs: limits.wallClockMs,
        ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
        skillRoots: [{ path: path.join(tempRoot, ".pigeon", "skills"), label: ".pigeon/skills" }],
        memoryRoots: [{ path: path.join(tempRoot, ".pigeon", "memory"), label: ".pigeon/memory" }],
        editMode: options.editMode,
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      });
      // 与 Eval runner 同口径：拒答与服务故障不判分（确定性错误照常判分）
      const refused = run.status === "failed" && isContentRefusal(run.errorMessage);
      const providerFailed =
        !refused &&
        deterministicErrorOf(run.errorMessage) === undefined &&
        (run.failure?.category === "infrastructure" || run.status === "failed");
      const verified =
        refused || providerFailed || run.runId === undefined
          ? undefined
          : await verifyTaskRun({
              taskId,
              judge: () => prepared.judge(),
              commandHint: prepared.judgeCommandHint,
              governanceRoot: tempRoot,
              sessionId,
              runId: run.runId,
            });
      const error = [
        run.errorMessage,
        verified?.error,
        providerFailed ? "模型服务故障：不判分，记未判定" : undefined,
        refused ? "内容审核拒答：不判分，记未判定" : undefined,
      ].filter((entry): entry is string => entry !== undefined);
      return {
        run: {
          arm,
          index,
          sessionId,
          governanceRoot: tempRoot,
          verdict: verified?.verdict ?? "undetermined",
          status: run.status,
          turns: run.turns,
          totalTokens: run.usage.totalTokens,
          durationMs: now() - startedAt,
          ...(error.length > 0 ? { error: error.join("；") } : {}),
        },
        experiences: seeded.experiences,
        experienceSetHash: seeded.experienceSetHash,
        limits,
      };
    } finally {
      try {
        await prepared.release();
      } catch (error) {
        errors.push(error);
      }
      harvestSession(tempRoot, hostSessionsDir, sessionId, errors);
    }
  };
  return { rerun, errors: () => [...errors] };
}

// 回放的会话文件收回宿主的会话目录（与宿主回放同口径：证据集中在一处）
function harvestSession(
  tempRoot: string,
  hostSessionsDir: string,
  sessionId: string,
  errors: unknown[]
): void {
  try {
    const from = sessionsDirOf(tempRoot);
    mkdirSync(hostSessionsDir, { recursive: true });
    for (const suffix of [".jsonl", ".messages.jsonl"]) {
      const source = path.join(from, `${sessionId}${suffix}`);
      if (existsSync(source)) {
        cpSync(source, path.join(hostSessionsDir, `${sessionId}${suffix}`));
      }
    }
  } catch (error) {
    errors.push(error);
  }
}
