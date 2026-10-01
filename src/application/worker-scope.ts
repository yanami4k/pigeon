// 会话运行面范围（M5.5 S4，决策 040）：worker 会话的冷恢复与续跑必须回到它自己的工作树与委派策略——
// 工作区根取会话头记的工作树，策略取父会话派出记录里的委派策略，父会话 id 用于深度 1 判定；
// 主会话即治理根与缺省策略。父会话记录缺失、派出记录缺失或工作树已被移除时响亮失败（授权范围不猜，
// fail-closed）。只读。
// 从会话存储读（决策 177 / 180）：worker 与分支会话的来历在会话文件头（metadata），委派策略在父会话的
// worker 派出条目里；会话存储里没有这个会话的文件即按主会话处理（新会话尚未写出文件）。
import { existsSync } from "node:fs";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { SessionId } from "../state/ids.ts";
import { mapLegacyWorktreePath } from "../state/paths.ts";
import { storeWorkerSpawned } from "../state/session-judge.ts";
import type { DelegatedPolicy, WorkerRole, WorkerWorkspace } from "../state/session-payloads.ts";
import { sessionsDirOf } from "./workspace.ts";

export interface SessionRuntimeScope {
  workspaceRoot: string;
  toolPolicy?: DelegatedPolicy;
  parentSessionId?: SessionId;
  worker?: { name: string; role: WorkerRole };
}

export function sessionRuntimeScope(
  governanceRoot: string,
  sessionId: SessionId
): SessionRuntimeScope {
  const dir = sessionsDirOf(governanceRoot);
  const loaded = loadStoreSession(dir, sessionId);
  if (loaded === undefined) {
    return { workspaceRoot: governanceRoot };
  }
  const { view } = loaded;
  // M7（决策 077）：分支会话回到它自己的工作树（主会话形态，不是委派）
  const branch = view.metadata?.branch;
  if (branch !== undefined) {
    return { workspaceRoot: existingWorktree(governanceRoot, "分支", branch.workspace) };
  }
  const worker = view.metadata?.worker;
  const parentSessionId = view.parentSessionId;
  if (worker === undefined || parentSessionId === undefined) {
    return { workspaceRoot: governanceRoot };
  }
  const parent = loadStoreSession(dir, parentSessionId);
  if (parent === undefined) {
    throw new Error(
      `worker 会话 ${sessionId} 的父会话记录不存在：${parentSessionId}（无法还原委派策略，拒绝恢复）`
    );
  }
  const spawned = storeWorkerSpawned(parent.view, sessionId);
  if (spawned === undefined) {
    throw new Error(
      `父会话 ${parentSessionId} 没有派出 ${sessionId} 的记录（无法还原委派策略，拒绝恢复）`
    );
  }
  return scopeOf(governanceRoot, worker.workspace, {
    toolPolicy: spawned.policy,
    parentSessionId,
    worker: { name: worker.name, role: worker.role },
  });
}

// 决策 325：工作树移入 .pigeon/state/worktrees 之前的会话记着旧位置的绝对路径，按旧前缀到新前缀映射后再找
function existingWorktree(
  governanceRoot: string,
  kind: string,
  workspace: { path: string; branch: string }
): string {
  const located = mapLegacyWorktreePath(governanceRoot, workspace.path);
  if (!existsSync(located)) {
    throw new Error(
      `${kind}工作树已不存在：${located}（分支 ${workspace.branch} 仍可用 git 查看）`
    );
  }
  return located;
}

function scopeOf(
  governanceRoot: string,
  workspace: WorkerWorkspace,
  delegated: Required<Omit<SessionRuntimeScope, "workspaceRoot">>
): SessionRuntimeScope {
  // M6（决策 064）：无工作区的 worker（已退役的 Reviewer，决策 137；只剩旧会话）作用域根即治理根，没有工作树可检查
  if (workspace.kind === "none") {
    return { workspaceRoot: governanceRoot, ...delegated };
  }
  return { workspaceRoot: existingWorktree(governanceRoot, "worker ", workspace), ...delegated };
}
