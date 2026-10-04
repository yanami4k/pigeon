// 终端界面主会话的 /reload 重建（决策 340）：按新快照在同一会话上重开运行面。编排设定、打转检测与联网工具按新快照重算，
// 有人对话入口的记忆写入照常带上（决策 331，重建后 update_memory 仍注册），/memory 的上限随新快照更新。
// 先建后换：重建失败时抛出，调用方的快照、编排设定与旧运行面都不变（/memory 的上限也只在重建成功后才更新）。
// 从 main.ts 抽出，使 /reload 的实际装配路径可测。
import { type LaunchFlags, orchestrationSettingsOf } from "../application/launch-flags.ts";
import type { MemoryWriteConfig, RuntimeBundle } from "../application/runtime.ts";
import { ScriptGate, scriptGateSettingsOf } from "../application/script-naming.ts";
import { ScriptSlot } from "../application/script-tool.ts";
import {
  type OpenedSessionRuntime,
  type OpenSessionRuntimeRequest,
  openSessionRuntime,
} from "../application/session-runtime.ts";
import { SpawnWorkerSlot, spawnWorkerSettingsOf } from "../application/spawn-worker-tool.ts";
import type { StatusFacts } from "../application/status-sources.ts";
import type { WebToolsConfig } from "../application/web-tools.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import type { OrchestrationSettings } from "../state/orchestration-config.ts";
import { loopGuardSettingsOf, memoryLimitsOf, type SettingsSnapshot } from "../state/settings.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";

// 决策 264–267：派 worker 开着时每个打开的会话一个工具槽（只给主会话注册，沙箱与 worker 会话由装配层略过）
// 决策 309：脚本编排随派 worker 一并给（每个打开的会话一个槽与点名状态）
export function spawnWorkerOption(
  flags: LaunchFlags,
  orchestration: OrchestrationSettings
): { spawnWorker?: SpawnWorkerSlot; scriptOrchestration?: ScriptSlot } {
  return flags.spawnWorkers
    ? {
        spawnWorker: new SpawnWorkerSlot(spawnWorkerSettingsOf(orchestration)),
        scriptOrchestration: new ScriptSlot(new ScriptGate(scriptGateSettingsOf(orchestration))),
      }
    : {};
}

// 重建所需的、跨快照不变的部分（入口在开局时备好）
export interface MainReloadContext {
  governanceRoot: string;
  streamFn: StreamFn;
  flags: LaunchFlags;
  workspaceHost?: WorkspaceHost;
  // 决策 354：沙箱会话的确知事实（开工状态块环境一节）
  statusFacts?: StatusFacts;
  warn: (line: string) => void;
  createApprovalHandler: NonNullable<OpenSessionRuntimeRequest["createApprovalHandler"]>;
  // 决策 331：有人对话的入口带记忆写入
  memoryWrite: MemoryWriteConfig;
  // 决策 331、332：/memory 的上下文（上限随新快照更新）
  memoryContext: { limits: MemoryLimits };
  // 决策 287–291：联网工具按快照取
  webToolsFor: (snapshot: SettingsSnapshot) => { webTools?: WebToolsConfig };
  hooksNotice: (line: string) => void;
  onMcpNote: (note: string) => void;
  // 测试注入：用户级目录与 MCP 启动
  homeDir?: string;
  startMcp?: OpenSessionRuntimeRequest["startMcp"];
}

export interface MainReloaded {
  opened: OpenedSessionRuntime;
  orchestration: OrchestrationSettings;
  loopGuard: LoopGuardSettings;
  webTools: { webTools?: WebToolsConfig };
}

export async function reopenMainSessionForReload(
  context: MainReloadContext,
  snapshot: SettingsSnapshot,
  current: { sessionId: SessionId; bundle: RuntimeBundle }
): Promise<MainReloaded> {
  const orchestration = orchestrationSettingsOf(context.flags, snapshot);
  const loopGuard = loopGuardSettingsOf(snapshot);
  const webTools = context.webToolsFor(snapshot);
  await current.bundle.sessionStore.flush();
  const opened = await openSessionRuntime({
    governanceRoot: context.governanceRoot,
    settings: snapshot,
    sessionId: current.sessionId,
    streamFn: context.streamFn,
    flags: context.flags,
    ...(context.workspaceHost !== undefined ? { workspaceHost: context.workspaceHost } : {}),
    ...(context.statusFacts !== undefined ? { statusFacts: context.statusFacts } : {}),
    ...spawnWorkerOption(context.flags, orchestration),
    taskList: orchestration.taskList,
    ...webTools,
    warn: context.warn,
    loopGuard,
    createApprovalHandler: context.createApprovalHandler,
    // 决策 331：/reload 重建的运行面照常注册 update_memory
    memoryWrite: context.memoryWrite,
    resume: true,
    reloadFrom: current.bundle,
    hooksNotice: context.hooksNotice,
    onMcpNote: context.onMcpNote,
    ...(context.homeDir !== undefined ? { homeDir: context.homeDir } : {}),
    ...(context.startMcp !== undefined ? { startMcp: context.startMcp } : {}),
  });
  // /memory 的上限按新快照更新（重建成功之后）
  context.memoryContext.limits = memoryLimitsOf(snapshot);
  return { opened, orchestration, loopGuard, webTools };
}
