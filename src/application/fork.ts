// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078 / 079；账本重构 177 / 206）。
// 分叉顺序：a. 从新会话存储读来源会话（本进程写者先落盘），核对分叉点、找分叉点之前最近的快照 → b. 旧账本记分叉记录
// （写不进就不分叉，双写期间照旧）→ c. 新存储在来源会话文件里记分叉条目 → d. 从快照开独立工作树 → e. 用 pi 的 fork 把分叉点
// （含）之前的历史复制进分支会话的新文件，文件头记来源会话与分支来历；分支运行面随后打开这个文件续写。
// 续跑（078 / 077）：以 buildSessionContext 从分支文件还原的消息作为 Agent 初始状态；分支是新的 Pigeon 会话。
// 分叉点末条是用户消息或工具结果时不给新输入直接续跑，末条是助手消息时必须给新输入。非 git 工作区发起分叉明确报错，
// 不降级，也不留任何记录。来源会话在新存储里没有文件（双写之前的旧会话）时明确报错，不回退旧账本（187）。
// 失败自动分叉重试（079）：尝试标为失败时从本次任务开始处（该 Run 第 1 条）分叉重试，最多 K 次，不注入任何提示。

import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
  NotGitWorkspaceError,
} from "../orchestration/checkpoint.ts";
import { addWorktree, mainRepoRoot } from "../orchestration/worktree.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { loadStoreSession, loadStoreSessionFile } from "../persistence/session-view.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { resolveCheckpointBefore } from "../state/checkpoint-ref.ts";
import type {
  CheckpointRef,
  ForkPoint,
  ForkTrigger,
  GitWorktreeWorkspace,
} from "../state/event-log.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { storeCheckpointBefore, storeMessageAt } from "../state/session-judge.ts";
import { type HeadlessRunOptions, runHeadlessOnce } from "./headless-core.ts";
import {
  beginStoreFork,
  hasLegacyRecords,
  type SessionStoreWriter,
  type StoreFork,
  storeFaultWarner,
} from "./session-store.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { sessionsDirOf } from "./workspace.ts";

export class ForkError extends Error {}

// 分叉点之前最近的快照（旧账本读法）：判据是纯函数，随 M8 回放共用下沉到 state/checkpoint-ref.ts；
// 分叉本身已改读新存储（storeCheckpointBefore），此处原名转出只供双写对照，停写旧账本时删除
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
  // a. 读来源会话：本进程写者先落盘
  await request.sourceStore?.flush();
  const source = loadStoreSession(dir, sourceSessionId);
  if (source === undefined) {
    throw new ForkError(
      hasLegacyRecords(dir, sourceSessionId)
        ? `来源会话 ${sourceSessionId} 在新会话存储里没有文件（创建于新存储启用之前，或新存储打开失败），不能分叉；` +
            "旧会话用只读的旧版代码查看"
        : `来源会话不存在：${sourceSessionId}`
    );
  }
  const forkMessage = storeMessageAt(source.view, forkPoint);
  if (forkMessage === undefined) {
    throw new ForkError(`来源会话里没有分叉点：${forkPoint.runId} 第 ${forkPoint.runSeq} 条`);
  }
  const continueFromHistory = forkMessage.message.role !== "assistant";
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
  const resolved = storeCheckpointBefore(source.view, forkPoint);
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
  // b. 旧账本先记分叉记录（写不进就不分叉）
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
  // c. 来源会话的新存储记分叉条目
  const storeFork: StoreFork | undefined = await beginStoreFork({
    sessionsDir: dir,
    sourceSessionId,
    ...(request.sourceStore !== undefined ? { sourceStore: request.sourceStore } : {}),
    cwd: sourceWorkspace,
    forked,
    onFault: storeFaultWarner(),
  });
  try {
    // d. 独立工作树：从分叉点之前最近的快照开出
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
    // e. 分支会话的新文件由 pi 的 fork 从来源复制出来（分支运行面随后打开它续写），初始消息从它还原
    const branchPath = await storeFork?.forkBranch({
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
    const branch = branchPath !== undefined ? loadStoreSessionFile(branchPath) : undefined;
    if (branch === undefined) {
      throw new ForkError(
        `分支会话文件没有建成（新会话存储告警已给出原因），分叉续跑无从还原消息；工作树 ${worktree.path} 已建，可手动清理`
      );
    }
    return {
      branchSessionId,
      checkpoint,
      workspace,
      initialMessages: sessionContextMessages(branch.main),
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
