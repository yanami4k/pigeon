// 回放计划（M8 S3，决策 082 / 087）：从账本解出"被验证那次尝试"的四件事——任务、起点、预算、模型。
//
// 起点（082：起点用快照回到任务开始处）按可靠度取：
//   1. given：调用方已解出的提交（分支会话的分叉点快照即属此类）；
//   2. worker-base：worker 工作树记下的起点提交（M8 起的派出记录带，最精确）；
//   3. workspace-checkpoint：该 Run 第 1 条之前最近的工作区快照（开了失败自动重试或分支续跑的会话有）；
//   4. worker-branch-tip：worker 分支的尖端（M8 之前的派出记录没记起点提交时的回退，回执里如实标注——
//      worker 通常不提交，故分支尖端即建工作树时的起点；它提交过就不准，标注让人能看见这一点）。
// 四条都拿不到即响亮失败：不拿"现状"凑合——现状是尝试跑完之后的状态，从那里重跑测的不是同一件事。
//
// 预算与模型拿不到同样响亮失败（087：回放的预算与模型沿用被验证那次尝试，不得放宽）。
// 缺省一个"不设限"就是放宽，猜一个模型就是换了尺子，两者都会让结论失去意义。
import {
  materializeSession,
  readMessageContentFileDetailed,
  sessionContentFilePath,
} from "../persistence/session-read.ts";
import type { AttemptBudget } from "../state/attempt-config.ts";
import { resolveCheckpointBefore } from "../state/checkpoint-ref.ts";
import { isGitWorktreeWorkspace, type WorkerWorkspace } from "../state/event-log.ts";
import type { RunId, SessionId } from "../state/ids.ts";

export class AttemptPlanError extends Error {}

export type AttemptStartSource =
  | "given"
  | "worker-base"
  | "workspace-checkpoint"
  | "worker-branch-tip";

export type AttemptBudgetSource = "run-started" | "child-spawned";

export interface AttemptPlan {
  sessionId: SessionId;
  runId: RunId;
  // 任务开始处交给模型的那段文字
  task: string;
  startCommit: string;
  startSource: AttemptStartSource;
  budget: AttemptBudget;
  budgetSource: AttemptBudgetSource;
  model: { provider: string; id: string; thinkingLevel?: string; maxOutputTokens?: number };
  approvalMode: "prompt" | "yolo";
  // 被验证那次尝试实际拿到的工具名单（run.started 的冻结策略）：回放按它取交集，
  // 不给回放比原尝试多的工具——多一件工具与多一点预算是同一类失效，成功率的变化会来自工具而非经验
  tools: string[];
}

export interface ResolveAttemptPlanInput {
  // 被验证那次尝试所在的会话目录
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  // 调用方已解出的起点提交（分支会话的分叉点快照）
  startCommit?: string;
  // 分支尖端解析（git 在 orchestration 层，由 application 注入；不传即不走这条回退）
  resolveBranchTip?: (branch: string) => string | undefined;
}

export function resolveAttemptPlan(input: ResolveAttemptPlanInput): AttemptPlan {
  const session = materializeSession(input.sessionsDir, input.sessionId, { content: false });
  const started = session.runStarteds.find((record) => record.runId === input.runId);
  if (started === undefined) {
    throw new AttemptPlanError(
      `会话 ${input.sessionId} 里没有 ${input.runId} 的启动快照：模型标识与预算都无从取得，不回放`
    );
  }
  const header = session.sessionHeader;
  const spawned =
    header !== undefined
      ? materializeSession(input.sessionsDir, header.parentSessionId, {
          content: false,
        }).childSpawneds.find((record) => record.childSessionId === input.sessionId)
      : undefined;

  const budgetFromRun = started.payload.budget;
  const budget: AttemptBudget | undefined =
    budgetFromRun !== undefined
      ? { ...budgetFromRun }
      : spawned !== undefined
        ? {
            maxTurns: spawned.limits.maxTurns,
            wallClockMs: spawned.limits.wallClockMs,
            ...(spawned.limits.maxTokens !== undefined
              ? { maxTokens: spawned.limits.maxTokens }
              : {}),
          }
        : undefined;
  if (budget === undefined) {
    throw new AttemptPlanError(
      `会话 ${input.sessionId} 的 ${input.runId} 没有记下预算参数（M8 之前的非 worker 尝试）：` +
        "回放必须沿用被验证那次尝试的预算，缺省一个不设限就是放宽，故拒绝回放"
    );
  }

  const start = resolveStart(input, session, spawned?.workspace ?? header?.workspace);
  const model = started.payload.model;
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    task: taskOf(input, spawned?.task),
    startCommit: start.commit,
    startSource: start.source,
    budget,
    budgetSource: budgetFromRun !== undefined ? "run-started" : "child-spawned",
    model: {
      provider: model.provider,
      id: model.id,
      ...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    },
    approvalMode: started.payload.policy.approvalMode,
    tools: [...started.payload.policy.allow],
  };
}

function resolveStart(
  input: ResolveAttemptPlanInput,
  session: ReturnType<typeof materializeSession>,
  workspace: WorkerWorkspace | undefined
): { commit: string; source: AttemptStartSource } {
  if (input.startCommit !== undefined) {
    return { commit: input.startCommit, source: "given" };
  }
  const branch = session.branchHeader;
  if (branch !== undefined) {
    return { commit: branch.checkpoint.commit, source: "given" };
  }
  if (workspace !== undefined && isGitWorktreeWorkspace(workspace)) {
    if (workspace.baseCommit !== undefined) {
      return { commit: workspace.baseCommit, source: "worker-base" };
    }
    const tip = input.resolveBranchTip?.(workspace.branch);
    if (tip !== undefined) {
      return { commit: tip, source: "worker-branch-tip" };
    }
  }
  const checkpoint = resolveCheckpointBefore(session, { runId: input.runId, runSeq: 1 });
  if (checkpoint !== undefined) {
    return { commit: checkpoint.commit, source: "workspace-checkpoint" };
  }
  throw new AttemptPlanError(
    `拿不到 ${input.sessionId} 的 ${input.runId} 在任务开始处的起点提交：` +
      "从跑完之后的现状重跑测的不是同一件事，故拒绝回放"
  );
}

// 任务文字：worker 尝试取派出记录里的任务，其余取该 Run 第 1 条用户消息的文本块
function taskOf(input: ResolveAttemptPlanInput, spawnedTask: string | undefined): string {
  if (spawnedTask !== undefined && spawnedTask.trim() !== "") {
    return spawnedTask;
  }
  const records = readMessageContentFileDetailed(
    sessionContentFilePath(input.sessionsDir, input.sessionId)
  ).records.filter((record) => record.runId === input.runId && record.role === "user");
  const first = records.sort((left, right) => left.runSeq - right.runSeq)[0];
  const text = (first?.blocks ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (text === "") {
    throw new AttemptPlanError(
      `拿不到 ${input.sessionId} 的 ${input.runId} 在任务开始处的任务文字：正文未持久化或该 Run 没有用户消息`
    );
  }
  return text;
}
