// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078 / 079）。
// 分叉顺序（077）：a. 账本先记分叉记录（来源会话文件，写不进就不分叉）→ b. 从账本与内容文件把历史导入 .pigeon/trees/ 的会话树
// （树不存在时整棵导入，已存在时在分叉条目上加分支通道）→ c. 分支续跑时实时写穿。
// 续跑（078 / 077）：从分叉点之前最近的快照开独立工作树（沿用工作树管理），以 buildSessionContext 还原的分支消息作为
// Agent 初始状态；分支是新的 Pigeon 会话，会话头指向来源会话与分叉点。分叉点末条是用户消息或工具结果时不给新输入直接续跑，
// 末条是助手消息时必须给新输入。非 git 工作区发起分叉明确报错，不降级，也不留任何记录。
// 失败自动分叉重试（079）：尝试标为失败时从本次任务开始处（该 Run 第 1 条）分叉重试，最多 K 次，不注入任何提示；
// 叶子验证完成后自动提炼这组分叉（来源侧与各分支共享同一前缀，只喂一次）。

import { contrastTarget } from "../distillation/target.ts";
import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
  NotGitWorkspaceError,
} from "../orchestration/checkpoint.ts";
import type { WorkerRuntimeFactory } from "../orchestration/workers.ts";
import { addWorktree, mainRepoRoot } from "../orchestration/worktree.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import type { SessionTree } from "../pi-runtime/session-tree.ts";
import type { ReviewGate } from "../review/scheduler.ts";
import { resolveCheckpointBefore } from "../state/checkpoint-ref.ts";
import { buildForkGroup, selectContrast } from "../state/episode.ts";
import type {
  CheckpointRef,
  ForkPoint,
  ForkTrigger,
  GitWorktreeWorkspace,
} from "../state/event-log.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { type AutoVerifyWiring, autoVerifyCandidates } from "./auto-verify.ts";
import { createDistillDispatcher, type DistillOutcome } from "./distill-runtime.ts";
import { type HeadlessRunOptions, runHeadlessOnce } from "./headless-core.ts";
import {
  acquireSessionTree,
  attachTreeWriteThrough,
  importSessionIntoTree,
  treeRootOf,
} from "./session-tree.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { sessionsDirOf } from "./workspace.ts";

export class ForkError extends Error {}

// 分叉点之前最近的快照：判据是纯函数，随 M8 回放共用下沉到 state/checkpoint-ref.ts；
// 此处保留原名转出，调用方与测试不变
export const resolveForkCheckpoint = resolveCheckpointBefore;

export interface ForkRequest {
  governanceRoot: string;
  sourceSessionId: SessionId;
  // 来源会话正由本进程的运行面持有时传入其日志（主会话）；缺省打开会话文件（冷会话，另一进程持有时按会话锁失败）
  sourceLog?: JsonlEventLog;
  forkPoint: ForkPoint;
  trigger: ForkTrigger;
  // 来源会话的运行面已持有的快照器：必须传入，同一会话在运行时只能存在一个实例——
  // 序号计数在实例的内存里，两个实例会从 refs 读到同一个起点并写同一个序号。
  // 只有拿不到实例时（冷会话上的分叉）才缺省，由这里新建。
  checkpointer?: Checkpointer;
  // 分叉点末条是助手消息时必须给新输入
  input?: string;
}

export interface PreparedFork {
  branchSessionId: SessionId;
  checkpoint: CheckpointRef;
  workspace: GitWorktreeWorkspace;
  initialMessages: AgentMessage[];
  tree: SessionTree;
  // 不给新输入，从已有消息续跑
  continueFromHistory: boolean;
}

export async function prepareFork(request: ForkRequest): Promise<PreparedFork> {
  const { governanceRoot, sourceSessionId, forkPoint } = request;
  const dir = sessionsDirOf(governanceRoot);
  const sourceWorkspace = sessionRuntimeScope(governanceRoot, sourceSessionId).workspaceRoot;
  if (!isGitWorkspace(sourceWorkspace)) {
    throw new NotGitWorkspaceError(
      `来源会话的工作区不是 git 工作区，不能分叉（不降级为只退对话）：${sourceWorkspace}`
    );
  }
  const source = materializeSession(dir, sourceSessionId, { content: false });
  const forkEntry = source.entries.find(
    (entry) => entry.runId === forkPoint.runId && entry.runSeq === forkPoint.runSeq
  );
  if (forkEntry === undefined) {
    throw new ForkError(`来源会话里没有分叉点：${forkPoint.runId} 第 ${forkPoint.runSeq} 条`);
  }
  const continueFromHistory = forkEntry.role !== "assistant";
  if (!continueFromHistory && (request.input === undefined || request.input.trim() === "")) {
    throw new ForkError("分叉点是助手消息：续跑需要给出新的输入");
  }
  const branchSessionId = newSessionId();
  const checkpointer =
    request.checkpointer ??
    createCheckpointer({
      workspaceRoot: sourceWorkspace,
      sessionId: sourceSessionId,
    });
  const resolved = resolveForkCheckpoint(source, forkPoint);
  let checkpoint: CheckpointRef;
  if (resolved?.ref !== undefined) {
    checkpoint = { ref: resolved.ref, commit: resolved.commit };
  } else if (resolved !== undefined) {
    // 改前基线没有挂 ref：挂一个，防止被 git 回收
    const pinned = checkpointer.pin(resolved.commit);
    checkpoint = { ref: pinned, commit: resolved.commit };
  } else {
    const now = checkpointer.snapshotNow();
    checkpoint = { ref: now.ref, commit: now.commit };
  }
  // a. 账本先记分叉记录（写不进就不分叉）
  const ownsLog = request.sourceLog === undefined;
  const log = request.sourceLog ?? new JsonlEventLog(dir, sourceSessionId);
  try {
    log.appendSessionForked({
      runId: forkPoint.runId,
      forkPoint,
      branchSessionId,
      checkpoint,
      trigger: request.trigger,
      forkedAt: Date.now(),
    });
  } finally {
    if (ownsLog) {
      log.close();
    }
  }
  // b. 导入树：树不存在时整棵导入（含刚记下的分叉通道），已存在时在分叉条目上加分支通道
  const rootSessionId = treeRootOf(governanceRoot, sourceSessionId);
  const tree = await acquireSessionTree({ governanceRoot, rootSessionId });
  if ((await tree.laneLeaf("main")) === null) {
    await importSessionIntoTree(tree, governanceRoot, rootSessionId, "main");
  }
  if (!(await tree.hasLane(branchSessionId))) {
    await tree.createLane(branchSessionId, forkEntry.id);
  }
  // 独立工作树：从分叉点之前最近的快照开出
  const name = `fork-${branchSessionId.slice(-8).toLowerCase()}`;
  const worktree = addWorktree({
    repoRoot: mainRepoRoot(sourceWorkspace),
    governanceRoot,
    sessionId: branchSessionId,
    name,
    baseRef: checkpoint.commit,
  });
  return {
    branchSessionId,
    checkpoint,
    workspace: { kind: "git-worktree", path: worktree.path, branch: worktree.branch },
    initialMessages: await tree.messagesUpTo(forkEntry.id),
    tree,
    continueFromHistory,
  };
}

// 分支续跑用的运行参数（与 headless 同一组；任务描述由分叉点决定）
export type ForkRunOptions = Omit<
  HeadlessRunOptions,
  | "task"
  | "governanceRoot"
  | "workspaceRoot"
  | "sessionId"
  | "branchHeader"
  | "initialMessages"
  | "continueFromHistory"
  | "onBundle"
  | "retryOnFail"
>;

export interface ForkBranchRequest extends Omit<ForkRequest, "input"> {
  run: ForkRunOptions & { input?: string };
}

export interface ForkBranchResult {
  branchSessionId: SessionId;
  checkpoint: CheckpointRef;
  workspace: GitWorktreeWorkspace;
  status: string;
  label: OutcomeLabel;
  verified: boolean;
}

export async function runForkBranch(request: ForkBranchRequest): Promise<ForkBranchResult> {
  const { input, ...run } = request.run;
  const prepared = await prepareFork({
    governanceRoot: request.governanceRoot,
    sourceSessionId: request.sourceSessionId,
    ...(request.sourceLog !== undefined ? { sourceLog: request.sourceLog } : {}),
    forkPoint: request.forkPoint,
    trigger: request.trigger,
    ...(request.checkpointer !== undefined ? { checkpointer: request.checkpointer } : {}),
    ...(input !== undefined ? { input } : {}),
  });
  const result = await runHeadlessOnce({
    ...run,
    task: input ?? "",
    governanceRoot: request.governanceRoot,
    workspaceRoot: prepared.workspace.path,
    sessionId: prepared.branchSessionId,
    initialMessages: prepared.initialMessages,
    continueFromHistory: prepared.continueFromHistory,
    branchHeader: {
      sourceSessionId: request.sourceSessionId,
      forkPoint: request.forkPoint,
      checkpoint: prepared.checkpoint,
      workspace: prepared.workspace,
      trigger: request.trigger,
      startedAt: Date.now(),
    },
    // c. 此后分支实时写穿（释放运行面前等队列落完）
    onBundle: (bundle) => {
      const writer = attachTreeWriteThrough({
        bundle,
        tree: prepared.tree,
        lane: prepared.branchSessionId,
      });
      bundle.disposers = [
        ...(bundle.disposers ?? []),
        async () => {
          await writer.idle();
          writer.stop();
        },
      ];
    },
  });
  return {
    branchSessionId: prepared.branchSessionId,
    checkpoint: prepared.checkpoint,
    workspace: prepared.workspace,
    status: result.status,
    label: result.label,
    verified: result.verification !== undefined,
  };
}

export interface DistillWiring {
  createRuntime: WorkerRuntimeFactory;
  gate?: ReviewGate;
  // M8（决策 086）：提炼落库后自动验证新候选；缺省关（开关由 Actor 显式拨）
  autoVerify?: AutoVerifyWiring;
}

// 分叉组提炼：来源侧与从同一分叉点长出的全部分支成组，选对后提炼；记录写回来源会话文件
export async function distillForkGroup(input: {
  governanceRoot: string;
  sourceSessionId: SessionId;
  sourceLog?: JsonlEventLog;
  forkPoint: ForkPoint;
  distill: DistillWiring;
}): Promise<{ distill?: DistillOutcome; skip?: string; errors: unknown[] }> {
  const dir = sessionsDirOf(input.governanceRoot);
  const source = materializeSession(dir, input.sourceSessionId, { content: false });
  const branches = source.sessionForkeds
    .filter(
      (record) =>
        record.forkPoint.runId === input.forkPoint.runId &&
        record.forkPoint.runSeq === input.forkPoint.runSeq
    )
    .map((record) => materializeSession(dir, record.branchSessionId, { content: false }))
    .filter((branch) => branch.branchHeader !== undefined);
  if (branches.length === 0) {
    return { skip: "no-contrast", errors: [] };
  }
  const group = buildForkGroup({ governanceRoot: input.governanceRoot, source, branches });
  const selection = selectContrast(group.attempts);
  const ownsLog = input.sourceLog === undefined;
  const log = input.sourceLog ?? new JsonlEventLog(dir, input.sourceSessionId);
  try {
    if (selection.skip !== undefined) {
      log.appendDistillSkipped({
        reason: selection.skip,
        attempts: group.attempts.map((attempt) => ({
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          label: attempt.label,
        })),
      });
      return { skip: selection.skip, errors: [] };
    }
    const dispatcher = createDistillDispatcher({
      governanceRoot: input.governanceRoot,
      hostSessionId: input.sourceSessionId,
      hostLog: log,
      parentPolicy: { allow: [], deny: [], approvalMode: "prompt" },
      createRuntime: input.distill.createRuntime,
      ...(input.distill.gate !== undefined ? { gate: input.distill.gate } : {}),
    });
    const distilled = await dispatcher.distill(
      contrastTarget({
        kind: "fork",
        selection,
        sharedPrefix: { governanceRoot: input.governanceRoot, ...group.sharedPrefix },
        task: {
          governanceRoot: input.governanceRoot,
          sessionId: input.sourceSessionId,
          runId: input.forkPoint.runId,
        },
      })
    );
    // M8（决策 086）：分叉叶子验证完成后自动提炼；开着自动验证时把刚落库的候选一并验掉。
    // 自动验证的内部故障要交出去（M8 收口补遗：此前整个返回值被丢掉，错误清单无人收，
    // 与并行派发那条路径 push 进错误清单的口径也不一致）
    const auto = await autoVerifyCandidates(input.distill.autoVerify, distilled.persisted);
    return { distill: distilled, errors: auto.errors };
  } finally {
    if (ownsLog) {
      log.close();
    }
  }
}

export interface RetryOutcome {
  retries: ForkBranchResult[];
  distill?: DistillOutcome;
  skip?: string;
  // 提炼与自动验证过程里的内部故障：不吞掉，交给调用方按 080 的口径告警
  errors: unknown[];
}

// 失败自动分叉重试（079）：从本次任务开始处分叉，最多 K 次，某次不再是失败即停；叶子验证完成后自动提炼
export async function runRetryOnFail(input: {
  governanceRoot: string;
  sourceSessionId: SessionId;
  sourceLog?: JsonlEventLog;
  runId: RunId;
  retries: number;
  run: ForkRunOptions;
  // 来源会话的运行面还在时传入它的快照器实例（同一会话只能有一个实例）
  checkpointer?: Checkpointer;
  distill?: DistillWiring;
}): Promise<RetryOutcome> {
  const forkPoint: ForkPoint = { runId: input.runId, runSeq: 1 };
  const results: ForkBranchResult[] = [];
  for (let attempt = 0; attempt < input.retries; attempt++) {
    const branch = await runForkBranch({
      governanceRoot: input.governanceRoot,
      sourceSessionId: input.sourceSessionId,
      ...(input.sourceLog !== undefined ? { sourceLog: input.sourceLog } : {}),
      forkPoint,
      trigger: "retry-on-fail",
      ...(input.checkpointer !== undefined ? { checkpointer: input.checkpointer } : {}),
      run: input.run,
    });
    results.push(branch);
    if (branch.label !== "Failed") {
      break;
    }
  }
  const leaf = results.at(-1);
  if (input.distill === undefined || leaf === undefined || !leaf.verified) {
    return { retries: results, errors: [] };
  }
  const distilled = await distillForkGroup({
    governanceRoot: input.governanceRoot,
    sourceSessionId: input.sourceSessionId,
    ...(input.sourceLog !== undefined ? { sourceLog: input.sourceLog } : {}),
    forkPoint,
    distill: input.distill,
  });
  return { retries: results, ...distilled };
}
