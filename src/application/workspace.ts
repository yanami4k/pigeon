// 工作区准备与恢复种子（M2 审计 note-1，决策 034；025 装配根抽取的收尾）：
// 两个 Actor 入口（cli/index.ts、tui/main.ts）此前各写一份的启动装配归位本层——
//   prepareWorkspace：工作区根 realpath 规范化（工具路径围栏以它为准，paths.ts）；
//     M3 旧账本的一次性转换已删除（决策 128）；
//   restoreGrantSeed：目标会话的生效 grant（created − revoked，决策 3b）作 buildRuntime 的
//     restoredGrants 种子，崩溃恢复后会话 grant 静默继续有效。账本重构第二段起从新会话存储的授权条目现算；
//     新存储里没有这个会话的文件（双写之前的旧会话）时，过渡期回退旧账本物化。
// Actor 不直接触碰 persistence 的写侧，巡航规则 actors-no-persistence-writes 守住这条边。
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { materializeSession } from "../persistence/event-log.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { SessionId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";
import { storeActiveGrants } from "../state/session-judge.ts";

// 会话文件目录（D1：<workspaceRoot>/.pigeon/sessions/）——唯一约定，Actor 不自拼
export function sessionsDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, ".pigeon", "sessions");
}

export function prepareWorkspace(root: string): string {
  const workspaceRoot = realpathSync(root);
  return workspaceRoot;
}

export function restoreGrantSeed(workspaceRoot: string, sessionId: SessionId): ActiveGrant[] {
  const dir = sessionsDirOf(workspaceRoot);
  const loaded = loadStoreSession(dir, sessionId);
  return loaded !== undefined
    ? storeActiveGrants(loaded.view)
    : materializeSession(dir, sessionId, { content: false }).grants;
}
