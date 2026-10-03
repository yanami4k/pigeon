// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078；账本重构 177；失败自动分叉重试随决策 322 删除）。
// 分叉顺序：a. 从会话存储读来源会话（本进程写者先落盘），核对分叉点、找分叉点之前最近的快照 → b. 在来源会话文件里记分叉条目
// （写不成就不分叉：冷会话被另一进程持有时按会话锁失败）→ c. 从快照开独立工作树 → d. 用 pi 的 fork 把分叉点（含）之前的
// 历史复制进分支会话的新文件，文件头记来源会话与分支来历；分支运行面随后打开这个文件续写。
// 续跑（078 / 077）：以 buildSessionContext 从分支文件还原的消息作为 Agent 初始状态；分支是新的 Pigeon 会话。
// 分叉点末条是用户消息或工具结果时不给新输入直接续跑，末条是助手消息时必须给新输入。非 git 工作区发起分叉明确报错，
// 不降级，也不留任何记录。来源会话在会话存储里没有文件时明确报错（旧格式会话不读，187）。
// 决策 350：读来源会话之前先等它未完成的快照拍完；分叉点之前最近的那一次快照没拍成（拍摄中断或失败）时明确报错，
// 不退回更早的快照，也不留任何记录。
// ForkTrigger 的 "retry-on-fail" 保留在 schema 里供读旧会话，新会话不再产生

import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
  NotGitWorkspaceError,
} from "../orchestration/checkpoint.ts";
import { addWorktree, mainRepoRoot } from "../orchestration/worktree.ts";
import { loadStoreSession, loadStoreSessionFile } from "../persistence/session-view.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { storeCheckpointBefore, storeMessageAt } from "../state/session-judge.ts";
import type {
  CheckpointRef,
  ForkPoint,
  ForkTrigger,
  GitWorktreeWorkspace,
} from "../state/session-payloads.ts";
import { type HeadlessRunOptions, runHeadless } from "./headless-core.ts";
import { beginStoreFork, type SessionStoreWriter, storeFaultWarner } from "./session-store.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { sessionsDirOf } from "./workspace.ts";

export class ForkError extends Error {}

export interface ForkRequest {
  governanceRoot: string;
  sourceSessionId: SessionId;
  // 来源会话正由本进程的运行面持有时传入其会话存储写者（主会话）；缺省按会话号打开来源的会话文件
  // （冷会话，另一进程持有时按会话锁失败）
  sourceStore?: SessionStoreWriter;
  forkPoint: ForkPoint;
  trigger: ForkTrigger;
  // 来源会话的运行面已持有的快照器：必须传入，同一会话在运行时只能存在一个实例——
  // 序号计数在实例的内存里，两个实例会从 refs 读到同一个起点并写同一个序号。
  // 只有拿不到实例时（冷会话上的分叉）才缺省，由这里新建。
  checkpointer?: Checkpointer;
  // 决策 350：来源会话的运行面在场时传入，读来源会话之前先等它未完成的快照拍完
  settleCheckpoints?: () => Promise<void>;
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
  // a. 读来源会话：未完成的快照先拍完，本进程写者再落盘
  await request.settleCheckpoints?.();
  await request.sourceStore?.flush();
  const source = loadStoreSession(dir, sourceSessionId);
  if (source === undefined) {
    throw new ForkError(`来源会话不存在：${sourceSessionId}`);
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
  const resolved = storeCheckpointBefore(source.view, forkPoint);
  if (resolved?.unfinished !== undefined) {
    const mark = resolved.unfinished;
    throw new ForkError(
      `分叉点 ${forkPoint.runId} 第 ${forkPoint.runSeq} 条对应的代码快照没有拍成（第 ${mark.runSeq} 条工具结果，` +
        `${mark.state === "failed" ? `拍摄失败：${mark.reason ?? "原因未记"}` : "拍摄中断：进程在拍完之前退出"}），` +
        "不能从这里分叉；不退回更早的快照"
    );
  }
  const checkpointer =
    request.checkpointer ??
    createCheckpointer({
      workspaceRoot: sourceWorkspace,
      sessionId: sourceSessionId,
    });
  let checkpoint: CheckpointRef;
  try {
    if (resolved?.ref !== undefined) {
      checkpoint = { ref: resolved.ref, commit: resolved.commit };
    } else if (resolved !== undefined) {
      // 改前基线没有挂 ref：挂一个，防止被 git 回收
      const pinned = await checkpointer.pin(resolved.commit);
      checkpoint = { ref: pinned, commit: resolved.commit };
    } else {
      const now = await checkpointer.snapshotNow();
      checkpoint = { ref: now.ref, commit: now.commit };
    }
  } finally {
    // 这里新建的快照器（冷会话）用完即关，删掉它的临时索引
    if (request.checkpointer === undefined) {
      await checkpointer.close();
    }
  }
  // b. 来源会话记分叉条目（写不成就不分叉）
  const forked = {
    runId: forkPoint.runId,
    forkPoint,
    branchSessionId,
    checkpoint,
    trigger: request.trigger,
    forkedAt: Date.now(),
  };
  const storeFork = await beginStoreFork({
    sessionsDir: dir,
    sourceSessionId,
    ...(request.sourceStore !== undefined ? { sourceStore: request.sourceStore } : {}),
    cwd: sourceWorkspace,
    forked,
    onFault: storeFaultWarner(),
  });
  if (storeFork === undefined) {
    throw new ForkError(
      `来源会话 ${sourceSessionId} 的分叉条目没有写成（会话存储告警已给出原因），不分叉`
    );
  }
  try {
    // c. 独立工作树：从分叉点之前最近的快照开出
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
    // d. 分支会话的新文件由 pi 的 fork 从来源复制出来（分支运行面随后打开它续写），初始消息从它还原
    const branchPath = await storeFork.forkBranch({
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
        `分支会话文件没有建成（会话存储告警已给出原因），分叉续跑无从还原消息；工作树 ${worktree.path} 已建，可手动清理`
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
    await storeFork.release();
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
}

export async function runForkBranch(request: ForkBranchRequest): Promise<ForkBranchResult> {
  const { input, ...run } = request.run;
  const prepared = await prepareFork({
    governanceRoot: request.governanceRoot,
    sourceSessionId: request.sourceSessionId,
    ...(request.sourceStore !== undefined ? { sourceStore: request.sourceStore } : {}),
    forkPoint: request.forkPoint,
    trigger: request.trigger,
    ...(request.checkpointer !== undefined ? { checkpointer: request.checkpointer } : {}),
    ...(request.settleCheckpoints !== undefined
      ? { settleCheckpoints: request.settleCheckpoints }
      : {}),
    ...(input !== undefined ? { input } : {}),
  });
  const result = await runHeadless({
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
  };
}
