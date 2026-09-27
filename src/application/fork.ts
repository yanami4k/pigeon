// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078 / 079）。
// 分叉顺序（077）：a. 账本先记分叉记录（来源会话文件，写不进就不分叉）→ b. 从账本与内容文件把历史导入 .pigeon/trees/ 的会话树
// （树不存在时整棵导入，已存在时在分叉条目上加分支通道）→ c. 分支续跑时实时写穿。
// 续跑（078 / 077）：从分叉点之前最近的快照开独立工作树（沿用工作树管理），以 buildSessionContext 还原的分支消息作为
// Agent 初始状态；分支是新的 Pigeon 会话，会话头指向来源会话与分叉点。分叉点末条是用户消息或工具结果时不给新输入直接续跑，
// 末条是助手消息时必须给新输入。非 git 工作区发起分叉明确报错，不降级，也不留任何记录。
// 失败自动分叉重试（079）：尝试标为失败时从本次任务开始处（该 Run 第 1 条）分叉重试，最多 K 次，不注入任何提示。
// 账本重构双写（决策 206 / 177）：旧账本记下分叉记录之后，新存储在来源会话文件里记分叉条目；工作树建好后用 pi 的 fork
// 把分叉点（含）之前的历史复制进分支会话的新文件，文件头记来源会话与分支来历。新存储的失败只告警，不挡分叉。

import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
  NotGitWorkspaceError,
} from "../orchestration/checkpoint.ts";
import { addWorktree, mainRepoRoot } from "../orchestration/worktree.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import type { SessionTree } from "../pi-runtime/session-tree.ts";
import { resolveCheckpointBefore } from "../state/checkpoint-ref.ts";
import type {
  CheckpointRef,
  ForkPoint,
  ForkTrigger,
  GitWorktreeWorkspace,
} from "../state/event-log.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { type HeadlessRunOptions, runHeadlessOnce } from "./headless-core.ts";
import {
  beginStoreFork,
  type SessionStoreWriter,
  type StoreFork,
  storeFaultWarner,
} from "./session-store.ts";
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
  // 同上，来源会话的新存储写者（决策 206）；缺省按会话号打开来源的会话文件
  sourceStore?: SessionStoreWriter;
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
  const forked = {
    runId: forkPoint.runId,
    forkPoint,
    branchSessionId,
    checkpoint,
    trigger: request.trigger,
    forkedAt: Date.now(),
  };
  const ownsLog = request.sourceLog === undefined;
  const log = request.sourceLog ?? new JsonlEventLog(dir, sourceSessionId);
  try {
    log.appendSessionForked(forked);
  } finally {
    if (ownsLog) {
      log.close();
    }
  }
  // 决策 206 双写：来源会话的新存储记分叉条目（不抛）
  const storeFork: StoreFork | undefined = await beginStoreFork({
    sessionsDir: dir,
    sourceSessionId,
    ...(request.sourceStore !== undefined ? { sourceStore: request.sourceStore } : {}),
    cwd: sourceWorkspace,
    forked,
    onFault: storeFaultWarner(),
  });
  try {
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
    const workspace: GitWorktreeWorkspace = {
      kind: "git-worktree",
      path: worktree.path,
      branch: worktree.branch,
    };
    // 决策 206 双写：分支会话的新文件由 pi 的 fork 从来源复制出来（分支运行面随后打开它续写）
    await storeFork?.forkBranch({
      branchSessionId,
      cwd: worktree.path,
      branch: {
        sourceSessionId,
        forkPoint,
        checkpoint,
        workspace,
        trigger: request.trigger,
        startedAt: Date.now(),
      },
    });
    return {
      branchSessionId,
      checkpoint,
      workspace,
      initialMessages: await tree.messagesUpTo(forkEntry.id),
      tree,
      continueFromHistory,
    };
  } finally {
    await storeFork?.release();
  }
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
    ...(request.sourceStore !== undefined ? { sourceStore: request.sourceStore } : {}),
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

export interface RetryOutcome {
  retries: ForkBranchResult[];
}

// 失败自动分叉重试（079）：从本次任务开始处分叉，最多 K 次，某次不再是失败即停
export async function runRetryOnFail(input: {
  governanceRoot: string;
  sourceSessionId: SessionId;
  sourceLog?: JsonlEventLog;
  sourceStore?: SessionStoreWriter;
  runId: RunId;
  retries: number;
  run: ForkRunOptions;
  // 来源会话的运行面还在时传入它的快照器实例（同一会话只能有一个实例）
  checkpointer?: Checkpointer;
}): Promise<RetryOutcome> {
  const forkPoint: ForkPoint = { runId: input.runId, runSeq: 1 };
  const results: ForkBranchResult[] = [];
  for (let attempt = 0; attempt < input.retries; attempt++) {
    const branch = await runForkBranch({
      governanceRoot: input.governanceRoot,
      sourceSessionId: input.sourceSessionId,
      ...(input.sourceLog !== undefined ? { sourceLog: input.sourceLog } : {}),
      ...(input.sourceStore !== undefined ? { sourceStore: input.sourceStore } : {}),
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
  return { retries: results };
}
