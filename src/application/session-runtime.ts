// 会话运行面装配（决策 067）：新建与 resume 走同一条路——作用域解析（worker 会话回到它自己的
// 工作树与委派策略）、会话 grant 种子还原、MCP 会话启动与启动提示、运行面构建。
// 续跑（决策 183）：运行面打开会话文件之后，用 pi 的 buildSessionContext 还原对话上下文交给 Agent；末条助手消息里
// 悬空的工具调用各补一条"进程中断、结果未知、请自行核实"的工具结果并写进会话，由 agent 自行核对。
// cli 与 tui 此前各写一份 buildWithMcp 与 resume 配方，缺省与提示口径不一；此处收成一份。
// 先建后换语义不变：装配失败（如 grants.json 畸形）时先关掉已启动的 MCP server 再上抛，
// 调用方的旧运行面不受影响。
// 决策 286：运行期告警（会话存储、工作区快照）的出口可由调用方给出——终端界面运行期间落消息区；
// 不给即照旧写标准错误输出（逐行对话与其余调用方不变）。

import { loadStoreSessionFile } from "../persistence/session-view.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { emptySettingsSnapshot, mcpConfigOf, type SettingsSnapshot } from "../state/settings.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { attachCheckpoints, type CheckpointAttachment } from "./checkpoints.ts";
import { describeMcpStartup, type McpSession, noMcpSession, startMcpSession } from "./mcp.ts";
import {
  buildRuntime,
  disposeRuntime,
  type LearnedMemoryConfig,
  type MemoryWriteConfig,
  type RuntimeBundle,
  type RuntimeDeps,
} from "./runtime.ts";
import type { ScriptSlot } from "./script-tool.ts";
import type { SpawnWorkerSlot } from "./spawn-worker-tool.ts";
import type { WarnSink } from "./warnings.ts";
import type { WebToolsConfig } from "./web-tools.ts";
import { type SessionRuntimeScope, sessionRuntimeScope } from "./worker-scope.ts";
import { restoreGrantSeed } from "./workspace.ts";

// 装配需要的运行参数（launch-flags.ts 的子集：解析出来直接传进来）
export interface SessionRuntimeFlags {
  yolo: boolean;
  provider: string;
  modelId: string;
  persistThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  // 决策 191、244：推送记忆（日常入口的启动参数缺省开着；这里没给即关着）
  pushedMemory?: boolean;
}

// 交互会话的推送记忆配置（决策 331）：有人对话，给写入配置（注册 update_memory、推送段带写入说明）；两层上限取设置快照
function interactiveLearnedMemory(
  flags: SessionRuntimeFlags,
  write: MemoryWriteConfig | undefined
): LearnedMemoryConfig | undefined {
  return flags.pushedMemory === true ? (write !== undefined ? { write } : {}) : undefined;
}

// 从交互会话派生的无人值守运行（/fork 分支）的推送记忆参数：沿用开关，只推送（复盘与记忆上限已随 331/332 移走）
export function pushedMemoryRunOptions(flags: SessionRuntimeFlags): { pushedMemory?: boolean } {
  return flags.pushedMemory === true ? { pushedMemory: true } : {};
}

export interface OpenSessionRuntimeRequest {
  // 治理根：.pigeon/（设置、程序状态、Skill）所在
  governanceRoot: string;
  // 决策 325：本会话的设置快照（入口在会话开始时读一次并确认过会执行命令的条目；本会话内各处都从它取）。
  // 缺省为空快照（不读任何设置文件）；日常入口一律显式给出
  settings?: SettingsSnapshot;
  sessionId: SessionId;
  streamFn: StreamFn;
  flags: SessionRuntimeFlags;
  // 审批 handler 由 Actor 注入（决策 025）；缺省 = 无审批通道，prompt 档 fail-closed
  createApprovalHandler?: RuntimeDeps["createApprovalHandler"];
  // 续跑既有会话：以会话里的生效 grant 为种子（决策 3b，静默继续有效），并还原对话上下文（决策 183）
  resume?: boolean;
  // MCP 启动提示（启动问题与注解配置冲突）：cli 打 stdout、tui 打 stderr，由调用方决定
  onMcpNote?: (note: string) => void;
  // 缺省按治理根与作用域工作区根启动真实 MCP 会话；测试注入替身。reuse 为 /reload 时的旧 MCP 会话（沿用未变的连接）
  startMcp?: (scope: {
    governanceRoot: string;
    workspaceRoot: string;
    reuse?: McpSession;
  }) => Promise<McpSession>;
  // 决策 340：/reload 在同一会话上按新快照重建时给出旧运行面——内容未变的 MCP 连接沿用（只重启改过的、停掉删掉的、
  // 启动新加的），系统提示里开局冻结的部分（人写的说明、推送的记忆、本地 Skill 目录）沿用开局读到的内容、不重读文件；
  // 由设置决定的部分（工具清单与说明、MCP 一段等）按新快照装配。旧运行面由调用方在新运行面建好后释放
  reloadFrom?: RuntimeBundle;
  // M5 S3（决策 042）：用户级偏好所在的家目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  // 决策 237：日常沙箱的执行端——工具经它在容器里读写与执行；不在宿主上打快照。
  // 会话文件、放权与记忆仍在宿主的治理根
  workspaceHost?: WorkspaceHost;
  // 决策 264–267：派 worker 的工具槽（终端界面给；命令行对话不给）。只给主会话注册：worker 会话（深度 1）与沙箱会话不注册
  spawnWorker?: SpawnWorkerSlot;
  // 决策 309：提交编排脚本的工具槽（终端界面随派 worker 一并给）；只给主会话注册，worker 会话与沙箱会话不注册
  scriptOrchestration?: ScriptSlot;
  // 决策 294 B1：任务清单（终端界面按编排配置给，缺省开）；只给主会话注册，续聊时从会话还原
  taskList?: boolean;
  // 决策 287–291：联网工具的配置（在场即注册两件工具）；--sandbox-network off 时调用方不给
  webTools?: WebToolsConfig;
  // 决策 331：写记忆的入口与写入后的提示（终端界面与 --line 给；推送记忆关着时不生效）
  memoryWrite?: MemoryWriteConfig;
  // 决策 286：运行期告警的出口（会话存储、压缩前回调、工作区快照）；缺省写标准错误输出
  warn?: WarnSink;
  // 决策 324：钩子拦下或出错时的一行提示的出口（终端界面落消息区）；缺省静默
  hooksNotice?: WarnSink;
  // 决策 308：打转检测设定——此处挂到压缩与运行面内的用点；主 agent 由入口自己挂（叫停后的交代各入口不同）
  loopGuard?: LoopGuardSettings;
}

export interface OpenedSessionRuntime {
  bundle: RuntimeBundle;
  scope: SessionRuntimeScope;
  // M7（决策 078）：git 工作区的主会话在场（分叉入口据此取快照器）
  checkpoints?: CheckpointAttachment;
  // 续跑时在场：还原了几条消息、为几个悬空的工具调用补了结果
  restored?: { messages: number; interrupted: number };
  // 注册了 spawn_worker 时在场：调用方建好编排器后绑定到这个槽上
  spawnWorker?: SpawnWorkerSlot;
  // 注册了 orchestrate 时在场：调用方建好运行器后绑定到这个槽上
  scriptOrchestration?: ScriptSlot;
}

// 续跑：等写者打开会话文件，读主分支还原上下文；悬空调用补的工具结果先写进会话，再连同还原的消息交给 Agent。
// 会话文件打不开（会话存储故障）时报错：没有上下文的续跑不是续跑
async function restoreContext(bundle: RuntimeBundle): Promise<{
  messages: number;
  interrupted: number;
}> {
  const path = await bundle.sessionStore.filePath();
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (loaded === undefined) {
    throw new Error("会话文件没有打开（会话存储告警已给出原因），无法还原对话上下文，续跑中止");
  }
  const { messages, interrupted } = restoreSessionContext(loaded.main);
  for (const message of interrupted) {
    bundle.sessionStore.appendMessage(message);
  }
  await bundle.sessionStore.flush();
  bundle.adapter.restoreMessages([...messages, ...interrupted]);
  // 决策 294 B1：任务清单从会话里最后一次更新还原
  bundle.taskList?.restore([...messages, ...interrupted]);
  return { messages: messages.length, interrupted: interrupted.length };
}

export async function openSessionRuntime(
  request: OpenSessionRuntimeRequest
): Promise<OpenedSessionRuntime> {
  const settings = request.settings ?? emptySettingsSnapshot(request.governanceRoot);
  // M5.5 S4（决策 040）：worker 会话回到它自己的工作树与委派策略；新建会话与主会话即治理根
  const scope = sessionRuntimeScope(request.governanceRoot, request.sessionId);
  const restoredGrants =
    request.resume === true
      ? restoreGrantSeed(request.governanceRoot, request.sessionId)
      : undefined;
  // 决策 252：沙箱会话不启动 MCP 服务（它们在宿主上运行，会越出容器）
  const startMcp =
    request.workspaceHost !== undefined
      ? () => noMcpSession()
      : (request.startMcp ??
        ((target) =>
          startMcpSession({
            ...target,
            workspaceRoot: target.workspaceRoot,
            config: mcpConfigOf(settings),
          })));
  const reuseMcp = request.reloadFrom?.mcp;
  const mcp = await startMcp({
    governanceRoot: request.governanceRoot,
    workspaceRoot: scope.workspaceRoot,
    ...(reuseMcp !== undefined ? { reuse: reuseMcp } : {}),
  });
  const frozenPrompt = request.reloadFrom?.frozenPrompt;
  const learnedMemory = interactiveLearnedMemory(request.flags, request.memoryWrite);
  const spawnWorker =
    scope.parentSessionId === undefined && request.workspaceHost === undefined
      ? request.spawnWorker
      : undefined;
  const scriptOrchestration = spawnWorker !== undefined ? request.scriptOrchestration : undefined;
  for (const note of describeMcpStartup(mcp)) {
    request.onMcpNote?.(note);
  }
  try {
    const bundle = buildRuntime({
      streamFn: request.streamFn,
      workspaceRoot: scope.workspaceRoot,
      governanceRoot: request.governanceRoot,
      settings,
      ...(scope.toolPolicy !== undefined ? { toolPolicy: scope.toolPolicy } : {}),
      sessionId: request.sessionId,
      yolo: request.flags.yolo,
      provider: request.flags.provider,
      modelId: request.flags.modelId,
      persistThinking: request.flags.persistThinking,
      ...(request.flags.thinkingLevel !== undefined
        ? { thinkingLevel: request.flags.thinkingLevel }
        : {}),
      ...(request.flags.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.flags.maxOutputTokens }
        : {}),
      ...(request.flags.compaction !== undefined ? { compaction: request.flags.compaction } : {}),
      ...(learnedMemory !== undefined ? { learnedMemory } : {}),
      ...(request.createApprovalHandler !== undefined
        ? { createApprovalHandler: request.createApprovalHandler }
        : {}),
      ...(restoredGrants !== undefined ? { restoredGrants } : {}),
      ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
      // 决策 237、248：沙箱的执行端；改回逐条询问时仍接交互审批，只是不建目录限定的放权
      ...(request.workspaceHost !== undefined
        ? { workspaceHost: request.workspaceHost, pathScopedGrants: false }
        : {}),
      ...(spawnWorker !== undefined ? { spawnWorker } : {}),
      ...(scriptOrchestration !== undefined ? { scriptOrchestration } : {}),
      ...(request.taskList === true ? { taskList: true } : {}),
      ...(request.webTools !== undefined ? { webTools: request.webTools } : {}),
      ...(request.warn !== undefined ? { storeWarn: request.warn } : {}),
      ...(request.hooksNotice !== undefined ? { hooksNotice: request.hooksNotice } : {}),
      ...(frozenPrompt !== undefined ? { frozenPrompt } : {}),
      mcp,
    });
    let restored: OpenedSessionRuntime["restored"];
    if (request.resume === true) {
      try {
        restored = await restoreContext(bundle);
      } catch (error) {
        // 运行面已建好：释放它再上抛（MCP 会话由下方的装配失败出口关闭），调用方的旧运行面不受影响
        const { mcp: _mcp, ...withoutMcp } = bundle;
        await disposeRuntime(withoutMcp);
        throw error;
      }
    }
    // M7（决策 078）：主会话在 git 工作区里打快照（写或命令确实改变文件后）；worker 会话不挂
    // 执行端另一侧的工作区（沙箱）不在宿主上打快照
    const checkpoints =
      scope.parentSessionId === undefined && request.workspaceHost === undefined
        ? attachCheckpoints({
            bundle,
            workspaceRoot: scope.workspaceRoot,
            ...(request.warn !== undefined ? { warn: request.warn } : {}),
          })
        : undefined;
    if (checkpoints !== undefined) {
      bundle.disposers = [...(bundle.disposers ?? []), async () => checkpoints.stop()];
    }
    return {
      bundle,
      scope,
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      ...(restored !== undefined ? { restored } : {}),
      ...(spawnWorker !== undefined ? { spawnWorker } : {}),
      ...(scriptOrchestration !== undefined ? { scriptOrchestration } : {}),
    };
  } catch (error) {
    // 装配失败：已启动的 server 必须关掉，否则留下孤儿进程（先建后换的收口约束）
    await mcp.close();
    throw error;
  }
}
