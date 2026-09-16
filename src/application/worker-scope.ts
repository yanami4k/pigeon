// 会话运行面范围（M5.5 S4，决策 040）：worker 会话的冷恢复与续跑必须回到它自己的工作树与委派策略——
// 工作区根取会话头记的工作树，策略取父会话 child.spawned 记的委派策略，父会话 id 用于深度 1 判定；
// 主会话即治理根与缺省策略。父会话记录缺失、派出记录缺失或工作树已被移除时响亮失败（授权范围不猜，
// fail-closed）。只读：只经冷物化读会话文件。
import { existsSync } from "node:fs";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { DelegatedPolicy, WorkerRole } from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
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
  if (!existsSync(JsonlEventLog.filePathFor(dir, sessionId))) {
    return { workspaceRoot: governanceRoot };
  }
  const header = materializeSession(dir, sessionId, { content: false }).sessionHeader;
  if (header === undefined) {
    return { workspaceRoot: governanceRoot };
  }
  if (!existsSync(JsonlEventLog.filePathFor(dir, header.parentSessionId))) {
    throw new Error(
      `worker 会话 ${sessionId} 的父会话记录不存在：${header.parentSessionId}（无法还原委派策略，拒绝恢复）`
    );
  }
  const spawned = materializeSession(dir, header.parentSessionId, {
    content: false,
  }).childSpawneds.find((record) => record.childSessionId === sessionId);
  if (spawned === undefined) {
    throw new Error(
      `父会话 ${header.parentSessionId} 没有派出 ${sessionId} 的记录（无法还原委派策略，拒绝恢复）`
    );
  }
  // M6（决策 064）：无工作区的 worker（Reviewer）只读账本，作用域根即治理根，没有工作树可检查
  if (header.workspace.kind === "none") {
    return {
      workspaceRoot: governanceRoot,
      toolPolicy: spawned.policy,
      parentSessionId: header.parentSessionId,
      worker: header.worker,
    };
  }
  if (!existsSync(header.workspace.path)) {
    throw new Error(
      `worker 工作树已不存在：${header.workspace.path}（分支 ${header.workspace.branch} 仍可用 git 查看）`
    );
  }
  return {
    workspaceRoot: header.workspace.path,
    toolPolicy: spawned.policy,
    parentSessionId: header.parentSessionId,
    worker: header.worker,
  };
}
