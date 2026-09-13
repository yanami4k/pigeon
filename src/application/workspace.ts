// 工作区准备与恢复种子（M2 审计 note-1，决策 034；025 装配根抽取的收尾）：
// 两个 Actor 入口（cli/index.ts、tui/main.ts）此前各写一份的启动装配归位本层——
//   prepareWorkspace：工作区根 realpath 规范化（工具路径围栏以它为准，paths.ts）+ D8 旧账本
//     一次性迁移（不存在即 no-op；损坏响亮失败，启动中止）；
//   restoreGrantSeed：物化目标会话的生效 grant（created − revoked，决策 3b）作 buildRuntime 的
//     restoredGrants 种子，崩溃恢复后会话 grant 静默继续有效。
// Actor 不再直接触碰 persistence 的写侧（migrateLegacyLedger 会改名并写会话文件）；
// 巡航规则 actors-no-persistence-writes 守住这条边。
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { materializeSession } from "../persistence/event-log.ts";
import { migrateLegacyLedger } from "../persistence/legacy-migration.ts";
import type { SessionId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";

// 会话文件目录（D1：<workspaceRoot>/.pigeon/sessions/）——唯一约定，Actor 不自拼
export function sessionsDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, ".pigeon", "sessions");
}

export function prepareWorkspace(root: string): string {
  const workspaceRoot = realpathSync(root);
  migrateLegacyLedger(join(workspaceRoot, ".pigeon", "ledger.jsonl"), sessionsDirOf(workspaceRoot));
  return workspaceRoot;
}

export function restoreGrantSeed(workspaceRoot: string, sessionId: SessionId): ActiveGrant[] {
  return materializeSession(sessionsDirOf(workspaceRoot), sessionId).grants;
}
