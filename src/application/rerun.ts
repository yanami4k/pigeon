// 回放执行体（M8 S3，决策 082 / 083 / 085 / 087）：复用 worker 编排，新增验证器角色，在独立工作树中真执行。
//
// 命名守决策 014：M4 的 `pigeon replay` 与 state/replay.ts 是只读重建，永不执行副作用；本轮的重执行
// 一律叫 rerun（命令是 `pigeon verify`），不复用 replay 一词。
//
// 一次回放的完整步骤：
//   1. 从被验证那次尝试的起点提交开一棵独立工作树（回到任务开始处）；
//   2. 在这棵工作树里造临时治理根：固化命令规则与放权规则随行，经验按正常格式放入（085）；
//   3. 派一个验证器 worker，治理根即那棵工作树——经验因此走与真激活完全相同的装载路径；
//      预算与模型沿用被验证那次尝试，放宽一律拒绝（087，effectiveLimits 钉死）；
//   4. 尝试收尾后在同一工作树里独立执行验证命令，判决与记录落进这次回放自己的会话文件；
//   5. 把这次回放的会话文件收回宿主的会话目录（证据要留得住），再移走工作树与分支。
//
// 权限形态（083）：验证器的 run_command 另受 .pigeon/commands.json 的 verifier 角色清单限定——
// 只有登记在册的命令能跑，没登记就一条也跑不了。这不是隔离：放行一条脚本命令即等于放行该脚本能做的一切，
// 网络也不受限。真正的断网与文件白名单只有沙箱能给，已排入 M9 前置。
//
// 后台没有审批通道：任何审批请求一律拒绝（同 006 / headless 口径），不新增审批语义。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROLE_TOOLS } from "../orchestration/roles.ts";
import {
  type ChildFamilySink,
  DEFAULT_WORKER_LIMITS,
  WorkerOrchestrator,
  type WorkerRuntimeFactory,
  type WorkspaceProvider,
} from "../orchestration/workers.ts";
import { addWorktree, deleteBranch, removeWorktree } from "../orchestration/worktree.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { seedRerunRoot } from "../replay/materials.ts";
import type { AttemptPlan } from "../replay/plan.ts";
import type { RerunArm } from "../replay/verdict.ts";
import { createReviewGate, type ReviewGate } from "../review/scheduler.ts";
import type { AttemptBudget, VerifyConfig } from "../state/attempt-config.ts";
import type { CandidateKind } from "../state/candidate.ts";
import type {
  GitWorktreeWorkspace,
  LoadedExperience,
  RerunRun,
  WorkerLimits,
} from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import { isThinkingLevel, type ThinkingLevel } from "../state/runtime-events.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { acquireGate } from "./distill-runtime.ts";
import { createWorkerRuntimeFactory, type WorkerRuntimeDeps } from "./workers.ts";
import { sessionsDirOf } from "./workspace.ts";

// 回放单设一道闸（087）：与 Reviewer / 提炼器共用的那道分开——回放一跑就是四组 N 次，
// 挤在同一道闸上会让后台审阅与提炼在整轮验证期间一次都排不上
export const DEFAULT_RERUN_CONCURRENCY = 1;

export function createRerunGate(limit: number = DEFAULT_RERUN_CONCURRENCY): ReviewGate {
  return createReviewGate(limit);
}

export const sharedRerunGate: ReviewGate = createRerunGate();

export class BudgetWidenedError extends Error {}

// 验证的前置不满足（模型、预算、推理档位、候选形态等）：定义在这一层，
// verify-command 转出同名导出，避免两层互相引用
export class VerifyPreconditionError extends Error {}

// 被验证那次尝试的预算 → 这次回放实际用的上限。
// 原尝试没设的项按 worker 编排的缺省收紧（收紧只会让结论偏保守，放宽则会让成功率的提升来自预算而非经验）。
// 传入 requested 时逐项核对：任何一项比原尝试宽即拒绝。
export function effectiveLimits(budget: AttemptBudget, requested?: WorkerLimits): WorkerLimits {
  const limits: WorkerLimits = requested ?? {
    maxTurns: budget.maxTurns ?? DEFAULT_WORKER_LIMITS.maxTurns,
    wallClockMs: budget.wallClockMs ?? DEFAULT_WORKER_LIMITS.wallClockMs,
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  };
  const widened: string[] = [];
  if (budget.maxTurns !== undefined && limits.maxTurns > budget.maxTurns) {
    widened.push(`轮次上限 ${limits.maxTurns} > ${budget.maxTurns}`);
  }
  if (budget.wallClockMs !== undefined && limits.wallClockMs > budget.wallClockMs) {
    widened.push(`墙钟上限 ${limits.wallClockMs} > ${budget.wallClockMs}`);
  }
  if (budget.maxTokens !== undefined && (limits.maxTokens ?? Infinity) > budget.maxTokens) {
    widened.push(`token 上限 ${limits.maxTokens ?? "不设限"} > ${budget.maxTokens}`);
  }
  if (widened.length > 0) {
    throw new BudgetWidenedError(
      `回放预算比被验证那次尝试宽：${widened.join("、")}。` +
        "预算放宽后成功率的提升将来自预算而非经验，且这种失效隐蔽，故一律拒绝"
    );
  }
  return limits;
}

// 验证器的父策略（083 / 087）：审批模式与工具集都沿用被验证那次尝试。
// 角色表给的是验证器的工具上限（读、写、命令三件）；attemptTools 在场时再与它取交集——
// 原尝试没有的工具，回放也不给，否则成功率的变化会来自多出来的那件工具而不是经验。
// run_command 是否放行另由 .pigeon/commands.json 的 verifier 角色清单收口，与本策略无关。
export function verifierParentPolicy(
  approvalMode: "prompt" | "yolo",
  attemptTools?: readonly string[]
): ToolPolicyLike {
  const ceiling = [...ROLE_TOOLS.verifier];
  return {
    allow:
      attemptTools === undefined ? ceiling : ceiling.filter((tool) => attemptTools.includes(tool)),
    deny: [],
    approvalMode,
  };
}

// 验证器运行面的依赖（M8 收口补遗）：cli 的 pigeon verify 与无人值守自动验证共用这一份。
// 此前两处各写一份、都漏了推理档位——档位解出来了却没传下去，实际落回角色表或全局缺省。
// 同一个模型换推理档位就是换了尺子，而档位在失效判据的封闭四项清单里属于"只记录不判定"，
// 两头落空就成了没人管的变量。
export function verifierRuntimeDeps(input: {
  model: AttemptPlan["model"];
  streamFn: StreamFn;
  persistThinking: boolean;
}): WorkerRuntimeDeps {
  const { model } = input;
  assertThinkingLevelReproducible(model);
  return {
    streamFnFor: () => input.streamFn,
    provider: model.provider,
    modelId: model.id,
    persistThinking: input.persistThinking,
    // 档位已由 assertThinkingLevelReproducible 收窄到已知取值
    thinkingLevel: model.thinkingLevel as ThinkingLevel,
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
  };
}

export function verifierRuntimeFactory(input: {
  model: AttemptPlan["model"];
  streamFn: StreamFn;
  persistThinking: boolean;
}): WorkerRuntimeFactory {
  return createWorkerRuntimeFactory(verifierRuntimeDeps(input));
}

// 推理档位必须能原样重放：认不出或没记下来的一律拒绝验证，不按缺省算。
// M5.5 之后的每条 run.started 都会写下档位（缺省写成 off），故这条只会在数据损坏或更早的记录上触发
export function assertThinkingLevelReproducible(model: AttemptPlan["model"]): void {
  const level = model.thinkingLevel;
  if (level === undefined || !isThinkingLevel(level)) {
    throw new VerifyPreconditionError(
      `被验证那次尝试的推理档位${level === undefined ? "没有记下来" : `认不出来（${level}）`}：` +
        "回放必须沿用它，按缺省算等于换了一把尺子，故拒绝验证"
    );
  }
}

const ARM_SHORT: Readonly<Record<RerunArm, string>> = {
  "failed-baseline": "fb",
  "failed-with": "fw",
  "successful-baseline": "sb",
  "successful-with": "sw",
};

// 工作树与分支名：候选哈希前 8 位 + 组 + 第几次；长度与字符集满足 worker 名白名单。
// 种子只接受十六进制哈希——四组必须共用同一个种子（基线组也是在验证这个候选），
// 回退到别的标识会带进下划线与大写，开工作树时才炸
export function rerunWorkerName(contentHash: string, arm: RerunArm, index: number): string {
  const seed = contentHash.toLowerCase();
  if (!/^[0-9a-f]{16,}$/.test(seed)) {
    throw new RerunNameError(
      `回放工作树名的种子不是内容哈希：${contentHash}（四组必须共用候选哈希这一个种子）`
    );
  }
  return `verify-${seed.slice(0, 8)}-${ARM_SHORT[arm]}-${index}`;
}

export class RerunNameError extends Error {}

export interface RerunCandidateBody {
  kind: CandidateKind;
  name: string;
  content: string;
  contentHash: string;
}

export interface RerunDispatcherOptions {
  // 宿主治理根：固化规则与已激活经验的来源，回放的会话文件最终收回它的会话目录
  governanceRoot: string;
  // 主仓库根：工作树与分支建在它上面
  repoRoot: string;
  // 候选来源会话：派出与收尾两族写进它的会话文件
  hostSessionId: SessionId;
  hostLog: ChildFamilySink;
  // 被验证候选的内容哈希：四组的工作树与分支名共用它作种子（基线组同样是在验证这个候选）
  nameSeed: string;
  // 按被验证那次尝试的模型标识装出验证器运行面（模型接入由 Actor 注入）
  runtimeFactoryFor: (model: AttemptPlan["model"]) => WorkerRuntimeFactory;
  verify: VerifyConfig;
  gate?: ReviewGate;
  // 收尾后是否移走工作树与分支；缺省移走（会话文件已收回宿主）
  keepWorktree?: boolean;
  // 编排器工厂（测试注入）；缺省按本次回放的临时治理根现构造一个
  orchestratorFor?: (input: {
    governanceRoot: string;
    workspace: GitWorktreeWorkspace;
    limits: WorkerLimits;
    plan: AttemptPlan;
  }) => RerunOrchestrator;
  now?: () => number;
}

export interface RerunRequest {
  arm: RerunArm;
  index: number;
  plan: AttemptPlan;
  // 带经验组传候选；基线组不传
  candidate?: RerunCandidateBody;
}

export interface RerunOutcome {
  run: RerunRun;
  experiences: LoadedExperience[];
  experienceSetHash: string;
  limits: WorkerLimits;
}

export interface RerunDispatcher {
  rerun(request: RerunRequest): Promise<RerunOutcome>;
  errors(): unknown[];
}

// 回放只用编排器的这三件；抽成窄接口便于测试注入
export type RerunOrchestrator = Pick<WorkerOrchestrator, "spawn" | "awaitResult" | "errors">;

// 已经建好的工作树直接交给编排器：工作树必须先于临时治理根存在（治理根就在它里面），
// 故不能沿用按会话号现开工作树的缺省提供者
function fixedWorkspace(workspace: GitWorktreeWorkspace): WorkspaceProvider {
  return {
    plan: () => workspace,
    create: () => {},
    changedFiles: () => [],
  };
}

export function createRerunDispatcher(options: RerunDispatcherOptions): RerunDispatcher {
  const gate = options.gate ?? sharedRerunGate;
  const now = options.now ?? Date.now;
  const errors: unknown[] = [];
  const hostSessionsDir = sessionsDirOf(options.governanceRoot);

  const rerun = async (request: RerunRequest): Promise<RerunOutcome> => {
    const { plan, arm, index } = request;
    const limits = effectiveLimits(plan.budget);
    const name = rerunWorkerName(options.nameSeed, arm, index);
    const startedAt = now();
    const worktree = addWorktree({
      repoRoot: options.repoRoot,
      governanceRoot: options.governanceRoot,
      sessionId: options.hostSessionId,
      name,
      baseRef: plan.startCommit,
    });
    const workspace: GitWorktreeWorkspace = {
      kind: "git-worktree",
      path: worktree.path,
      branch: worktree.branch,
      baseCommit: plan.startCommit,
    };
    let sessionId: SessionId | undefined;
    // 编排器自己攒的内部故障（收尾写盘失败、工作树清理失败等）在 finally 里收
    // （M8 收口补遗）：此前只在 awaitResult 正常返回后收集，它抛出时整批丢掉
    let orchestrator: RerunOrchestrator | undefined;
    try {
      // 临时治理根就是这棵工作树：经验放进它的 .pigeon 下，装载路径与真激活完全相同（085）
      const seeded = seedRerunRoot({
        hostGovernanceRoot: options.governanceRoot,
        tempGovernanceRoot: worktree.path,
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
      orchestrator =
        options.orchestratorFor?.({ governanceRoot: worktree.path, workspace, limits, plan }) ??
        new WorkerOrchestrator({
          governanceRoot: worktree.path,
          session: { sessionId: options.hostSessionId },
          parentPolicy: verifierParentPolicy(plan.approvalMode, plan.tools),
          parentLog: options.hostLog,
          approvals: async () => ({ approved: false, reason: "回放没有审批通道" }),
          createRuntime: options.runtimeFactoryFor(plan.model),
          workspaces: fixedWorkspace(workspace),
          defaultLimits: limits,
        });
      sessionId = orchestrator.spawn({ role: "verifier", task: plan.task, name, limits });
      const outcome = await orchestrator.awaitResult(sessionId);
      const metrics = rerunMetrics(worktree.path, sessionId);
      const verdictOf = await verifyInWorktree(worktree.path, sessionId, options.verify);
      return {
        run: {
          arm,
          index,
          sessionId,
          governanceRoot: worktree.path,
          verdict: verdictOf.verdict,
          status: outcome.status,
          turns: outcome.turns,
          totalTokens: metrics.totalTokens,
          durationMs: now() - startedAt,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        },
        experiences: seeded.experiences,
        experienceSetHash: seeded.experienceSetHash,
        limits,
      };
    } finally {
      if (orchestrator !== undefined) {
        errors.push(...orchestrator.errors());
      }
      if (sessionId !== undefined) {
        harvestSession(worktree.path, hostSessionsDir, sessionId, errors);
      }
      if (options.keepWorktree !== true) {
        releaseWorktree(options.repoRoot, worktree.path, worktree.branch, errors);
      }
    }
  };

  return {
    rerun: async (request) => {
      const release = await acquireGate(gate);
      try {
        return await rerun(request);
      } finally {
        release();
      }
    },
    errors: () => [...errors],
  };
}

// 这次回放用掉的 token（从它自己的会话文件现算，同 046：结果全部从 Event Log 算）
function rerunMetrics(governanceRoot: string, sessionId: SessionId): { totalTokens: number } {
  const session = materializeSession(sessionsDirOf(governanceRoot), sessionId, { content: false });
  const totalTokens = session.runtimeEvents.reduce(
    (sum, record) =>
      record.kind === "turn.completed" ? sum + (record.payload.usage?.totalTokens ?? 0) : sum,
    0
  );
  return { totalTokens };
}

// 验证命令在同一棵工作树里独立执行，判决与完整记录落进这次回放自己的会话文件（模型看不到）
async function verifyInWorktree(
  governanceRoot: string,
  sessionId: SessionId,
  config: VerifyConfig
): Promise<{ verdict: RerunRun["verdict"] }> {
  const sessionsDir = sessionsDirOf(governanceRoot);
  const session = materializeSession(sessionsDir, sessionId, { content: false });
  const runId = session.runStarteds[0]?.runId ?? session.runtimeEvents[0]?.runId;
  if (runId === undefined) {
    // 运行面没装起来：没有 Run 可验证，判决为未定（不算通过，也不算失败）
    return { verdict: "undetermined" };
  }
  const log = new JsonlEventLog(sessionsDir, sessionId);
  try {
    const verified = await verifyAttempt({
      config,
      workspace: governanceRoot,
      target: { sessionId, runId },
      sink: log,
      envelopeRunId: runId,
    });
    return { verdict: verified.outcome.verdict };
  } finally {
    log.close();
  }
}

// 回放的会话文件收回宿主的会话目录：工作树随后就移走，证据不能跟着一起没
function harvestSession(
  governanceRoot: string,
  hostSessionsDir: string,
  sessionId: SessionId,
  errors: unknown[]
): void {
  try {
    const from = sessionsDirOf(governanceRoot);
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

function releaseWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  errors: unknown[]
): void {
  try {
    removeWorktree({ repoRoot, path: worktreePath, force: true });
  } catch (error) {
    errors.push(error);
  }
  try {
    deleteBranch({ repoRoot, branch });
  } catch (error) {
    errors.push(error);
  }
}
