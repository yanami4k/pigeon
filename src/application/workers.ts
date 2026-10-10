// worker 运行面工厂（M5.5 S2，决策 040）：装配根每 worker 调一次 buildRuntime——治理根恒为主仓库根、
// 工作区根为 worker 工作树、策略为委派子集、审批经编排器汇聚到父级；worker 会话文件首条写 session.header。
// M5.7 S4（决策 054）：治理根有 MCP 配置时，worker 以其工作树为工作区根启动自己的 MCP server（roots 即工作树）；
// 启动是异步的，运行面在 run 时就绪——订阅先于就绪时暂存、就绪后接上，就绪前取消即按中止收尾。
// 没有 MCP 配置时仍同步装配，行为与 M5.5 相同（会话头写不进在派出时即报错）。
// M6.5 S1（决策 056）：装配内核抽出为 openRuntimeSurface，worker 工厂与 headless 运行共用——
// headless 无父会话、无角色：不写 session.header，run_command 不套角色清单，无审批通道（prompt 档 fail-closed）。
// 决策 286：会话存储告警的出口可由调用方给出（storeWarn，终端界面运行期间落消息区）；不给即照旧写标准错误输出——
// pigeon run 与逐行对话都不给。
// 决策 301：运行面的流式正文与工具结果两个只读观察口一并交给编排器；编排器只在有观察者（终端界面）时订阅，
// pigeon run 与逐行对话不订。

import type { ApprovalHandler } from "../approvals/handler.ts";
import { deleteSnapshotRef, snapshotWorkdir } from "../execution/workdir-snapshot.ts";
import {
  ROLE_MODEL_OVERRIDES,
  ROLE_THINKING_LEVELS,
  type RoleModelOverride,
} from "../orchestration/roles.ts";
import type {
  WorkerRunResult,
  WorkerRuntimeFactory,
  WorkerRuntimeHandle,
  WorkerRuntimeRequest,
  WorkerStartPointProvider,
} from "../orchestration/workers.ts";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { workerStartRefFor } from "../orchestration/worktree.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import { type PruneSeed, pruneSeedFromEntries } from "../pi-runtime/context-prune.ts";
import type { AgentMessage, RunResult, StreamFn } from "../pi-runtime/index.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { AttemptBudget } from "../state/attempt-config.ts";
import type { EventEnvelope } from "../state/events.ts";
import { DEFAULT_STOP_HOOK_BLOCK_CAP } from "../state/hooks.ts";
import type { SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { OrchestrationSettings } from "../state/orchestration-config.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type {
  RepetitionGuardSettings,
  TruncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type {
  BranchHeaderInput,
  DelegatedPolicy,
  SessionHeaderInput,
  WorkerLimits,
  WorkerRole,
} from "../state/session-payloads.ts";
import { workerWorkspacePath } from "../state/session-payloads.ts";
import {
  mcpConfigOf,
  type SettingsSnapshot,
  untrackedLimitsOfSettings,
} from "../state/settings.ts";
import type { UntrackedLimits } from "../state/snapshot-config.ts";
import { structuredResultOf } from "../state/structured-result.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { settleBackgroundJobs } from "./background-jobs.ts";
import type { SessionHooks } from "./hooks.ts";
import { loopGuardWatcher } from "./loop-guard.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import {
  buildRuntime,
  disposeRuntime,
  type LearnedMemoryConfig,
  type RuntimeBundle,
  type RuntimeDeps,
} from "./runtime.ts";
import type { ScriptSlot } from "./script-tool.ts";
import { childFamilySink } from "./session-store.ts";
import { bindSpawnWorkers } from "./spawn-worker-host.ts";
import { SpawnWorkerSlot, spawnWorkerSettingsOf } from "./spawn-worker-tool.ts";
import { type StatusHashes, statusFromEntries } from "./status-block.ts";
import type { StatusFacts } from "./status-sources.ts";
import type { WarnSink } from "./warnings.ts";
import type { WebToolsConfig } from "./web-tools.ts";
import { drainWorkers } from "./worker-notices.ts";

export interface WorkerRuntimeDeps {
  // 每个 worker 的模型接入：生产传同一个无状态 streamFn，测试按 worker 给独立剧本
  streamFnFor: (request: WorkerRuntimeRequest) => StreamFn;
  provider: string;
  modelId: string;
  homeDir?: string;
  persistThinking?: boolean;
  // M5.5 S5（决策 050）：推理档位两级来源——全局值（启动参数），角色配置覆盖（缺省取 roles.ts 角色表）
  thinkingLevel?: ThinkingLevel;
  roleThinkingLevels?: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>>;
  // M5.7 S4（决策 054）：worker 的 MCP 会话启动器——缺省在治理根有 MCP 配置时以 worker 工作树为工作区根启动；
  // 测试注入内存传输
  startMcp?: (request: WorkerRuntimeRequest) => Promise<McpSession>;
  // 决策 061 / 062：编辑模式（缺省 replace）
  editMode?: EditMode;
  // 决策 063、347：单轮输出上限（缺省不设，跟模型）
  maxOutputTokens?: number;
  // 决策 188、218：上下文压缩的配置——worker 按主会话同一配置跑（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  // 决策 367：撞上限续跑与流式重复检测——worker 按主会话实际生效的设定跑（缺省取设置快照）
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // M9：采样温度与工作方式指令——回放的验证器运行面沿用原尝试的值（087 修订、110）；其余 worker 缺省不设
  temperature?: number;
  taskDirective?: string;
  // 决策 191、331：推送记忆——父会话开着即带推送段（上限同父会话）；worker 只推送，不带记忆工具
  learnedMemory?: LearnedMemoryConfig;
  // M6（决策 064 子裁决 ③）：角色的模型接入覆盖列（缺省取 roles.ts 的角色表，第一版四个角色都留空）
  roleModelOverrides?: Readonly<Partial<Record<WorkerRole, RoleModelOverride>>>;
  // 覆盖列里 streamFnSpec 对应的已加载插件：装配层按表预加载后传入（工厂同步，不在此处做 IO）
  roleStreamFns?: Readonly<Partial<Record<WorkerRole, StreamFn>>>;
  // 决策 266：无人值守（pigeon run）——worker 不接审批通道：按放权规则或全部放行（审批模式继承父会话），否则拒绝
  unattended?: boolean;
  // 决策 287–291：联网工具的配置——worker 与主会话同样拿到（父策略里有才带）
  webTools?: WebToolsConfig;
  // 决策 299：层数放开时，还没到最底层的 worker 另拿一个本层的派出槽（与主会话共用同一个编排器与并发额度）
  nesting?: { settings: OrchestrationSettings; orchestrator: () => WorkerOrchestrator | undefined };
  // 决策 286：worker 会话存储告警的出口（终端界面运行期间落消息区）；缺省标准错误输出
  storeWarn?: WarnSink;
  // 决策 325：设置快照——worker 用派出它的会话的快照（不重读设置文件）；缺省为空快照
  settingsSnapshot?: SettingsSnapshot;
}

export interface SessionWorkersDeps extends Omit<WorkerRuntimeDeps, "streamFnFor"> {
  streamFn: StreamFn;
  // 治理根：worker 的会话、设置与工作树目录（其 .pigeon/state/worktrees）在它下面
  governanceRoot: string;
  // 主工作区根（git 仓库）：worker 从它的快照开工、工作树与分支建在它上面、explorer 就地读它。
  // 日常两者同为主仓库根；pigeon run --governance-root 时分开
  workspaceRoot: string;
  // 派出 worker 的父运行面：父策略取其冻结快照，父子两族写其会话文件
  bundle: RuntimeBundle;
  // 父运行面本身是 worker 会话时在场（深度 1：拒绝再派）
  parentSessionId?: SessionId;
  // 汇聚审批入口（Actor 注入，经审批队列）；缺省 = 无人值守，worker 没有审批通道（决策 266）
  approvals?: ApprovalHandler;
  // 决策 297–303：编排设定（同时在跑的上限、层数、每个 worker 的上限、卡住与审批时限）；缺省取产品缺省
  settings?: OrchestrationSettings;
  // 决策 268：worker 每收尾一轮回报本轮用的 token（计入本次运行的总额度）
  onWorkerTokens?: (sessionId: SessionId, tokens: number) => void;
  // 决策 308：打转检测设定（开着即给每个 worker 挂打转观察者，307：以 looping 失败交回）；缺省不挂
  loopGuard?: LoopGuardSettings;
}

// 无人值守时汇聚审批的兜底：worker 不接审批通道，不会走到这里；万一走到按拒绝处理
const UNATTENDED_APPROVAL = async () => ({
  approved: false,
  reason: "无人值守运行没有审批通道",
  reasonSource: "system-default" as const,
});

// 按会话装配编排器（M5.5 S4）：Actor 只拿动作面，不触达 orchestration 的构造细节。
// 决策 303：没有审批通道（pigeon run）即无人值守——worker 需请示时不等，作为可恢复错误交回
export function createSessionWorkers(deps: SessionWorkersDeps): WorkerOrchestrator {
  const settings = deps.settings;
  const holder: { current?: WorkerOrchestrator } = {};
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: deps.governanceRoot,
    workspaceRoot: deps.workspaceRoot,
    session: {
      sessionId: deps.bundle.adapter.sessionId,
      ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
    },
    parentPolicy: deps.bundle.adapter.snapshot().tools.policy,
    // worker 派出与收尾写进父会话的会话存储
    parentLog: childFamilySink(deps.bundle.sessionStore),
    approvals: deps.approvals ?? UNATTENDED_APPROVAL,
    ...(deps.approvals === undefined ? { unattended: true } : {}),
    createRuntime: sessionWorkerRuntimeFactory({
      ...deps,
      ...(settings !== undefined && settings.maxDepth > 1
        ? { nesting: { settings, orchestrator: () => holder.current } }
        : {}),
    }),
    // 决策 279：worker 从主工作目录连同未提交改动拍成的快照开工
    startPoint: workerStartPoint(
      deps.workspaceRoot,
      untrackedLimitsOfSettings(deps.bundle.settings)
    ),
    // 决策 381：worker 交回时也按同一组上限列出它新建却没收进来的文件
    untrackedLimits: untrackedLimitsOfSettings(deps.bundle.settings),
    ...(settings !== undefined
      ? {
          maxConcurrent: settings.maxConcurrent,
          maxDepth: settings.maxDepth,
          stallMs: settings.stallMs,
          approvalTimeoutMs: settings.approvalTimeoutMs,
          defaultLimits: {
            maxTurns: settings.workerMaxTurns,
            wallClockMs: settings.workerWallClockMs,
          },
        }
      : {}),
    ...(deps.onWorkerTokens !== undefined ? { onWorkerTokens: deps.onWorkerTokens } : {}),
    ...(deps.loopGuard?.enabled === true ? { watchers: [loopGuardWatcher(deps.loopGuard)] } : {}),
  });
  holder.current = orchestrator;
  return orchestrator;
}

// 决策 279：worker 的起点提供者——拍主工作目录的快照；快照引用只护住"拍好到建好工作树"这一段，工作树建好后由编排器调 release
// 删掉（worker 分支指向起点提交，提交不会被回收；删分支时的连带删除仍留作兜底）
// 决策 381：limits 为未跟踪文件的上限，过大而没带进来的文件随起点交回（开工时告诉 worker）
export function workerStartPoint(
  workspaceRoot: string,
  limits?: UntrackedLimits
): WorkerStartPointProvider {
  return ({ name, from }) => {
    const ref = workerStartRefFor(name);
    // 决策 299：派出方是 worker 时拍它的工作树（与主仓库同一个对象库，引用共用）
    const snap = snapshotWorkdir({
      repoRoot: from ?? workspaceRoot,
      ref,
      ...(limits !== undefined ? { limits } : {}),
    });
    return {
      commit: snap.commit,
      snapshot: snap.snapshot,
      files: snap.files,
      ...(snap.skipped.length > 0 ? { skipped: snap.skipped } : {}),
      release: () => deleteSnapshotRef(workspaceRoot, ref),
    };
  };
}

// 会话 worker 的运行面工厂（同一会话派出的 worker 共用同一份模型接入与角色覆盖）
export function sessionWorkerRuntimeFactory(
  deps: SessionWorkersDeps & Pick<WorkerRuntimeDeps, "nesting">
): WorkerRuntimeFactory {
  // 决策 063：worker 继承父运行面冻结快照里的单轮输出上限（显式传入时以传入值为准）
  const maxOutputTokens =
    deps.maxOutputTokens ?? deps.bundle.adapter.snapshot().model.maxOutputTokens;
  // 决策 188、218：worker 继承父运行面的压缩配置（显式传入时以传入值为准）；父运行面没给即产品缺省
  const compaction = deps.compaction ?? deps.bundle.adapter.compactionConfig();
  // 决策 191、217：worker 继承父运行面的推送记忆（开着才带）
  const learnedMemory = deps.learnedMemory ?? deps.bundle.learnedMemory;
  // 决策 367：worker 继承父运行面实际生效的续跑与重复检测设定（父运行面的设定可能是显式给出的，不只来自设置快照）
  const truncationContinuation = deps.truncationContinuation ?? deps.bundle.truncationContinuation;
  const repetitionGuard = deps.repetitionGuard ?? deps.bundle.repetitionGuard;
  return createWorkerRuntimeFactory({
    streamFnFor: () => deps.streamFn,
    provider: deps.provider,
    modelId: deps.modelId,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.persistThinking !== undefined ? { persistThinking: deps.persistThinking } : {}),
    ...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
    ...(deps.roleThinkingLevels !== undefined
      ? { roleThinkingLevels: deps.roleThinkingLevels }
      : {}),
    ...(deps.startMcp !== undefined ? { startMcp: deps.startMcp } : {}),
    ...(deps.editMode !== undefined ? { editMode: deps.editMode } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(learnedMemory !== undefined ? { learnedMemory } : {}),
    truncationContinuation,
    repetitionGuard,
    ...(deps.roleModelOverrides !== undefined
      ? { roleModelOverrides: deps.roleModelOverrides }
      : {}),
    ...(deps.roleStreamFns !== undefined ? { roleStreamFns: deps.roleStreamFns } : {}),
    ...(deps.webTools !== undefined ? { webTools: deps.webTools } : {}),
    ...(deps.nesting !== undefined ? { nesting: deps.nesting } : {}),
    ...(deps.storeWarn !== undefined ? { storeWarn: deps.storeWarn } : {}),
    // 决策 325：worker 沿用父运行面的设置快照（含启动时的确认结果）
    settingsSnapshot: deps.bundle.settings,
  });
}

// 装配内核的输入：worker 与 headless 共用
interface RuntimeSurface {
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用）
  statusFacts?: StatusFacts;
  // 决策 363：续做与分叉续跑沿用的系统提示与状态变化通道的起点（取自会话记录）
  systemPrompt?: string;
  statusSent?: StatusHashes;
  // 决策 361：上下文裁剪的起点（取自会话记录）
  pruneSeed?: PruneSeed;
  sessionId: SessionId;
  governanceRoot: string;
  workspaceRoot: string;
  // 决策 098：执行端；缺省为 workspaceRoot 上的本地实现
  workspaceHost?: WorkspaceHost;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  yolo: boolean;
  // 委派策略（worker）；缺省 = 全部内置工具，审批模式按 yolo 旗标
  policy?: DelegatedPolicy;
  // worker 角色：run_command 套设置里 commands 一节的角色清单；缺省 = 不套清单
  role?: WorkerRole;
  approvalHandler?: ApprovalHandler;
  // worker 会话头；缺省 = 普通会话（headless）
  header?: SessionHeaderInput;
  thinkingLevel?: ThinkingLevel;
  homeDir?: string;
  persistThinking?: boolean;
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读
  agentsMd?: boolean;
  // 决策 061：编辑模式（缺省见 tools/edit-mode.ts 的 DEFAULT_EDIT_MODE，现为 replace）
  editMode?: EditMode;
  // 决策 063、347：单轮输出上限（缺省不设，跟模型）
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测（缺省取设置快照；worker 用主会话的快照）——目前只有跑批器显式给出
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // 决策 365：无人值守收尾等后台作业的总时限（缺省取设置快照）
  jobCloseoutMs?: number;
  // M9：采样温度（缺省不设）——目前只有无父会话的运行面（headless 与 Eval）会给；worker 不继承
  temperature?: number;
  // M9：任务源给的系统指令（追加进 system prompt 并随之冻结）；同上，只有无父会话的运行面会给
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；同上，只有无父会话的运行面会给
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）；worker 取主会话的配置
  compaction?: CompactionConfigInput;
  // 压缩前回调；只有无父会话的运行面会给
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217：推送记忆（在场即开着）
  learnedMemory?: LearnedMemoryConfig;
  // 缺省在治理根有 MCP 配置时以工作区根启动 MCP 会话
  startMcp?: () => Promise<McpSession>;
  // 决策 264–267：派 worker 的开关（headless 主会话会给；层数放开时未到最底层的 worker 也给，299）
  spawnWorker?: SpawnWorkerSlot;
  // 决策 309：提交编排脚本的工具槽（只有 headless 主会话会给）
  scriptOrchestration?: ScriptSlot;
  // 决策 294 B1：任务清单（只有 headless 主会话会给）
  taskList?: boolean;
  // 决策 302：worker 改自己工作树内的文件默认放行（只有 worker 会给）
  ownWorkspaceWrites?: boolean;
  // 决策 287–291：联网工具的配置
  webTools?: WebToolsConfig;
  // M8（决策 087）：本次尝试的预算——worker 取派出记录的上限，headless 取运行参数；冻结进注入快照
  budget?: AttemptBudget;
  // M7（决策 077）：分支会话头与分叉续跑的初始消息
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  // 运行面装起来后的回调（挂快照器）
  onBundle?: (bundle: RuntimeBundle) => void;
  // 决策 286：会话存储告警的出口；缺省标准错误输出
  storeWarn?: WarnSink;
  // 决策 325：本会话的设置快照（缺省为空快照）
  settings?: SettingsSnapshot;
}

// M8（决策 087）：派出记录的上限即该 worker 尝试的预算——两者同一组值，冻结进注入快照后回放才能沿用。
// 缺省项原样缺省：缺省 = 该项不设限，回放沿用同样的不设限，不是放宽
export function budgetOfLimits(limits: WorkerLimits): AttemptBudget {
  return {
    maxTurns: limits.maxTurns,
    wallClockMs: limits.wallClockMs,
    ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
  };
}

export function createWorkerRuntimeFactory(deps: WorkerRuntimeDeps): WorkerRuntimeFactory {
  return (request): WorkerRuntimeHandle => {
    const thinkingLevel =
      (deps.roleThinkingLevels ?? ROLE_THINKING_LEVELS)[request.role] ?? deps.thinkingLevel;
    const startMcp = deps.startMcp;
    // 决策 377：只读的 explorer 以派出方的工作区为工作区根（读的是正在变的内容）；无工作区形状只属于已退役的只读角色
    // （决策 137），万一出现即以治理根为工作区根
    const shared = request.workspace.kind === "shared";
    const workspaceRoot = workerWorkspacePath(request.workspace) ?? request.governanceRoot;
    // M6（决策 064 子裁决 ③）：角色的模型接入覆盖——缺省继承主会话
    const override = (deps.roleModelOverrides ?? ROLE_MODEL_OVERRIDES)[request.role];
    const roleStreamFn = deps.roleStreamFns?.[request.role];
    // 决策 303：补批续做——从会话文件还原对话（悬空的工具调用补"结果未知"），同一个会话号接着写
    const restored = request.resume === true ? restoreWorkerSession(request) : undefined;
    // 决策 299：层数放开且本 worker 没到最底层——另拿一个本层的派出槽，运行面装起来后绑到同一个编排器
    const depth = request.depth ?? 1;
    const nesting = deps.nesting;
    const nestedOrchestrator =
      nesting !== undefined && depth < nesting.settings.maxDepth
        ? nesting.orchestrator()
        : undefined;
    const nestedSlot =
      nesting !== undefined && nestedOrchestrator !== undefined
        ? new SpawnWorkerSlot(
            spawnWorkerSettingsOf({ ...nesting.settings, taskList: false }, depth)
          )
        : undefined;
    let nestedBundle: RuntimeBundle | undefined;
    let nestedNotices: ReturnType<typeof bindSpawnWorkers>["notices"];
    const handle = openRuntimeSurface({
      sessionId: request.sessionId,
      governanceRoot: request.governanceRoot,
      workspaceRoot,
      streamFn: roleStreamFn ?? deps.streamFnFor(request),
      provider: override?.provider ?? deps.provider,
      modelId: override?.modelId ?? deps.modelId,
      yolo: request.policy.approvalMode === "yolo",
      policy: request.policy,
      // M5.5 S5（决策 048）：run_command 按角色套设置里 commands 一节的允许清单
      role: request.role,
      // 决策 266：无人值守时不接审批通道（prompt 档 fail-closed，与 headless 主会话同一口径）
      ...(deps.unattended === true ? {} : { approvalHandler: request.approvalHandler }),
      ...(deps.webTools !== undefined ? { webTools: deps.webTools } : {}),
      header: {
        parentSessionId: request.lineage.parentSessionId,
        ...(request.lineage.parentRunId !== undefined
          ? { parentRunId: request.lineage.parentRunId }
          : {}),
        worker: { name: request.name, role: request.role },
        workspace: request.workspace,
        startedAt: Date.now(),
      },
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.persistThinking !== undefined ? { persistThinking: deps.persistThinking } : {}),
      ...(startMcp !== undefined ? { startMcp: () => startMcp(request) } : {}),
      ...(deps.editMode !== undefined ? { editMode: deps.editMode } : {}),
      ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
      ...(deps.compaction !== undefined ? { compaction: deps.compaction } : {}),
      ...(deps.truncationContinuation !== undefined
        ? { truncationContinuation: deps.truncationContinuation }
        : {}),
      ...(deps.repetitionGuard !== undefined ? { repetitionGuard: deps.repetitionGuard } : {}),
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...(deps.taskDirective !== undefined ? { taskDirective: deps.taskDirective } : {}),
      ...(deps.learnedMemory !== undefined ? { learnedMemory: deps.learnedMemory } : {}),
      ...(request.limits !== undefined ? { budget: budgetOfLimits(request.limits) } : {}),
      // 决策 302：worker 改自己工作树内的文件默认放行；与派出方共用工作区的 explorer 不是自己的工作树，不放行
      ownWorkspaceWrites: !shared,
      // 决策 381：起点快照没带进来的文件写进开工状态块
      ...(request.skippedAtStart !== undefined && request.skippedAtStart.length > 0
        ? { statusFacts: { skipped: request.skippedAtStart } }
        : {}),
      // 决策 363：续做沿用会话记录里的系统提示，状态变化通道接着记录里最后发出的一份
      ...(restored !== undefined ? { initialMessages: restored.messages } : {}),
      ...(restored?.systemPrompt !== undefined ? { systemPrompt: restored.systemPrompt } : {}),
      ...(restored?.statusSent !== undefined ? { statusSent: restored.statusSent } : {}),
      ...(restored !== undefined ? { pruneSeed: restored.pruneSeed } : {}),
      ...(nestedSlot !== undefined ? { spawnWorker: nestedSlot } : {}),
      ...(nestedSlot !== undefined && nestedOrchestrator !== undefined
        ? {
            onBundle: (bundle: RuntimeBundle) => {
              nestedBundle = bundle;
              nestedNotices = bindSpawnWorkers({
                slot: nestedSlot,
                orchestrator: nestedOrchestrator,
                workspaceRoot,
                hostSessionId: request.sessionId,
                target: bundle.adapter,
                from: request.sessionId,
              }).notices;
            },
          }
        : {}),
      ...(deps.storeWarn !== undefined ? { storeWarn: deps.storeWarn } : {}),
      ...(deps.settingsSnapshot !== undefined ? { settings: deps.settingsSnapshot } : {}),
    });
    // 决策 323 / 324：SubagentStart（派出/续做前，可补上下文）与 SubagentStop（worker 收尾，可拦住接着干；
    // 连续拦截到上限后照常结束）。钩子取本 worker 运行面自己的（随设置快照冻结）
    const hooksOf = async (): Promise<SessionHooks | undefined> => {
      // 端口返回 unknown（编排层不依赖 application），此处收窄到 RuntimeBundle（生产者唯一：本层装配）
      const bundle = (await handle.ready?.()) as RuntimeBundle | undefined;
      return bundle?.hooks ?? nestedBundle?.hooks;
    };
    const runWithSubagentHooks = async (
      task: string,
      runOnce: (input: string) => Promise<WorkerRunResult>
    ): Promise<WorkerRunResult> => {
      const hooks = await hooksOf();
      let input = task;
      let stopActive = false;
      let blockedCount = 0;
      const cap = deps.settingsSnapshot?.merged.stopHookBlockCap ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
      // 决策 322：收尾钩子的输出（拦截理由与补充上下文）随结果交回——多份尝试的汇总各带各的
      const hookOutputs: string[] = [];
      const withOutputs = (result: WorkerRunResult): WorkerRunResult =>
        hookOutputs.length > 0 ? { ...result, hookOutputs } : result;
      if (hooks !== undefined) {
        const start = await hooks.runEvent("SubagentStart", request.role, {
          agent_id: request.sessionId,
          agent_type: request.role,
        });
        if (start.continueFalse !== undefined) {
          return withOutputs({ status: "aborted" });
        }
        if (start.additionalContext.length > 0) {
          input = `${start.additionalContext.join("\n\n")}\n\n${task}`;
        }
      }
      for (;;) {
        const result = await runOnce(input);
        if (hooks === undefined) {
          return result;
        }
        const stop = await hooks.runEvent("SubagentStop", request.role, {
          agent_id: request.sessionId,
          agent_type: request.role,
          stop_hook_active: stopActive,
          last_assistant_message: handle.summary(),
        });
        hookOutputs.push(
          ...stop.additionalContext,
          ...(stop.blocked !== undefined ? [stop.blocked.reason] : [])
        );
        // continue:false 压过拦截：worker 停止处理，不再续跑
        if (stop.continueFalse !== undefined) return withOutputs(result);
        const wantsContinue = stop.blocked !== undefined || stop.additionalContext.length > 0;
        if (!wantsContinue || blockedCount >= cap) {
          return withOutputs(result);
        }
        blockedCount += 1;
        stopActive = true;
        input = [
          ...stop.additionalContext,
          ...(stop.blocked !== undefined ? [stop.blocked.reason] : []),
        ].join("\n\n");
      }
    };
    if (nestedOrchestrator === undefined) {
      return {
        ...handle,
        run: (task) => runWithSubagentHooks(task, (input) => handle.run(input)),
      };
    }
    // 能再派的 worker：自己的运行结束后等它派出的 worker 全部结束、把通知处理完才算结束；被中止时一并停掉它派出的
    let halted = false;
    const children = () =>
      nestedOrchestrator
        .status()
        .filter(
          (worker) =>
            worker.parentSessionId === request.sessionId &&
            (worker.state === "running" || worker.state === "queued")
        );
    const settleChildren = async (first: WorkerRunResult): Promise<WorkerRunResult> => {
      const bundle = nestedBundle;
      const notices = nestedNotices;
      if (bundle === undefined || notices === undefined) {
        return first;
      }
      const { last } = await drainWorkers<WorkerRunResult>({
        orchestrator: nestedOrchestrator,
        parentSessionId: request.sessionId,
        notices,
        target: {
          pendingNotices: () => bundle.adapter.pendingNotices(),
          runNotices: () => bundle.adapter.runNotices(),
        },
        stopped: () => halted,
      });
      return last ?? first;
    };
    return {
      ...handle,
      run: (task) => runWithSubagentHooks(task, (input) => handle.run(input).then(settleChildren)),
      interrupt: async (cause) => {
        halted = true;
        await Promise.allSettled(
          children().map((worker) => nestedOrchestrator.cancel(worker.sessionId))
        );
        await handle.interrupt(cause);
      },
    };
  };
}

// 补批续做（303）：worker 会话文件里的主分支还原成对话；悬空的工具调用补"结果未知"
function restoreWorkerSession(request: WorkerRuntimeRequest): {
  messages: AgentMessage[];
  systemPrompt: string | undefined;
  statusSent: StatusHashes | undefined;
  pruneSeed: PruneSeed;
} {
  const sessionsDir = sessionsDirOf(request.governanceRoot);
  const loaded = loadStoreSession(sessionsDir, request.sessionId);
  if (loaded === undefined) {
    throw new Error(`找不到 worker 会话 ${request.sessionId} 的会话文件，无法续做`);
  }
  const { messages, interrupted } = restoreSessionContext(loaded.main);
  return {
    messages: [...messages, ...interrupted],
    systemPrompt: loaded.view.runs.at(-1)?.start.systemPrompt,
    statusSent: statusFromEntries(loaded.main),
    pruneSeed: pruneSeedFromEntries(loaded.main),
  };
}

export interface DetachedRuntimeRequest {
  sessionId: SessionId;
  governanceRoot: string;
  workspaceRoot: string;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  yolo: boolean;
  thinkingLevel?: ThinkingLevel;
  homeDir?: string;
  persistThinking?: boolean;
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读
  agentsMd?: boolean;
  editMode?: EditMode;
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测（缺省取设置快照）
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // 决策 365：无人值守收尾等后台作业的总时限（缺省取设置快照；跑批器显式给出）
  jobCloseoutMs?: number;
  temperature?: number;
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217：推送记忆（在场即开着）
  learnedMemory?: LearnedMemoryConfig;
  startMcp?: () => Promise<McpSession>;
  // 决策 264–267：派 worker 的开关
  spawnWorker?: SpawnWorkerSlot;
  // 决策 309：提交编排脚本的工具槽（只有 headless 主会话会给）
  scriptOrchestration?: ScriptSlot;
  // 决策 294 B1：任务清单
  taskList?: boolean;
  // 决策 287–291：联网工具的配置
  webTools?: WebToolsConfig;
  // M8（决策 087）：本次尝试的预算冻结进注入快照
  budget?: AttemptBudget;
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  onBundle?: (bundle: RuntimeBundle) => void;
  // 决策 286：会话存储告警的出口；缺省标准错误输出
  storeWarn?: WarnSink;
  // 决策 325：本会话的设置快照（pigeon run 由入口读好给出；缺省为空快照）
  settings?: SettingsSnapshot;
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用），写进开工状态块的环境一节
  statusFacts?: StatusFacts;
  // 决策 363：分叉续跑时状态变化通道的起点（分支会话记录里最后发出的一份）
  statusSent?: StatusHashes;
  // 决策 361：分叉续跑时上下文裁剪的起点（取自分支会话记录）
  pruneSeed?: PruneSeed;
}

// M6.5 S1（决策 056）：无父会话的运行面——与 worker 同一装配内核，普通会话、无角色、无审批通道
export function createDetachedRuntime(request: DetachedRuntimeRequest): WorkerRuntimeHandle {
  return openRuntimeSurface(request);
}

function openRuntimeSurface(surface: RuntimeSurface): WorkerRuntimeHandle {
  const runtimeDeps: Omit<RuntimeDeps, "mcp"> = {
    ...(surface.thinkingLevel !== undefined ? { thinkingLevel: surface.thinkingLevel } : {}),
    streamFn: surface.streamFn,
    workspaceRoot: surface.workspaceRoot,
    ...(surface.workspaceHost !== undefined ? { workspaceHost: surface.workspaceHost } : {}),
    governanceRoot: surface.governanceRoot,
    ...(surface.policy !== undefined ? { toolPolicy: surface.policy } : {}),
    ...(surface.role !== undefined ? { commandRole: surface.role } : {}),
    sessionId: surface.sessionId,
    yolo: surface.yolo,
    provider: surface.provider,
    modelId: surface.modelId,
    // M5.5 S3（决策 040）：审批经编排器汇聚到父级；放权落点挂 worker 自己的 grant 存储——
    // [a]/[d] 创建的会话 grant 写进 worker 会话文件，只在该 worker 内生效，随其结束作废
    ...(surface.approvalHandler !== undefined
      ? {
          createApprovalHandler: (workerGrants) => {
            const handler = surface.approvalHandler as ApprovalHandler;
            return (approval) => handler({ ...approval, grants: workerGrants });
          },
        }
      : {}),
    ...(surface.homeDir !== undefined ? { homeDir: surface.homeDir } : {}),
    ...(surface.persistThinking !== undefined ? { persistThinking: surface.persistThinking } : {}),
    ...(surface.skillRoots !== undefined ? { skillRoots: surface.skillRoots } : {}),
    ...(surface.agentsMd !== undefined ? { agentsMd: surface.agentsMd } : {}),
    ...(surface.editMode !== undefined ? { editMode: surface.editMode } : {}),
    ...(surface.maxOutputTokens !== undefined ? { maxOutputTokens: surface.maxOutputTokens } : {}),
    ...(surface.truncationContinuation !== undefined
      ? { truncationContinuation: surface.truncationContinuation }
      : {}),
    ...(surface.repetitionGuard !== undefined ? { repetitionGuard: surface.repetitionGuard } : {}),
    ...(surface.jobCloseoutMs !== undefined ? { jobCloseoutMs: surface.jobCloseoutMs } : {}),
    ...(surface.temperature !== undefined ? { temperature: surface.temperature } : {}),
    ...(surface.taskDirective !== undefined ? { taskDirective: surface.taskDirective } : {}),
    ...(surface.sessionSearch !== undefined ? { sessionSearch: surface.sessionSearch } : {}),
    ...(surface.compaction !== undefined ? { compaction: surface.compaction } : {}),
    ...(surface.beforeCompaction !== undefined
      ? { beforeCompaction: surface.beforeCompaction }
      : {}),
    ...(surface.learnedMemory !== undefined ? { learnedMemory: surface.learnedMemory } : {}),

    ...(surface.spawnWorker !== undefined ? { spawnWorker: surface.spawnWorker } : {}),
    ...(surface.scriptOrchestration !== undefined
      ? { scriptOrchestration: surface.scriptOrchestration }
      : {}),
    ...(surface.taskList === true ? { taskList: true } : {}),
    ...(surface.ownWorkspaceWrites === true ? { ownWorkspaceWrites: true } : {}),
    ...(surface.webTools !== undefined ? { webTools: surface.webTools } : {}),
    ...(surface.budget !== undefined ? { budget: surface.budget } : {}),
    ...(surface.initialMessages !== undefined ? { initialMessages: surface.initialMessages } : {}),
    ...(surface.storeWarn !== undefined ? { storeWarn: surface.storeWarn } : {}),
    ...(surface.settings !== undefined ? { settings: surface.settings } : {}),
    ...(surface.statusFacts !== undefined ? { statusFacts: surface.statusFacts } : {}),
    ...(surface.systemPrompt !== undefined ? { systemPrompt: surface.systemPrompt } : {}),
    ...(surface.statusSent !== undefined ? { statusSent: surface.statusSent } : {}),
    ...(surface.pruneSeed !== undefined ? { pruneSeed: surface.pruneSeed } : {}),
  };
  // MCP 配置取自设置快照（会话开始时已校验；不重读文件）
  const mcpConfig =
    surface.settings !== undefined ? mcpConfigOf(surface.settings) : { servers: [] };
  const startMcp =
    surface.startMcp ??
    (mcpConfig.servers.length > 0
      ? () =>
          startMcpSession({
            governanceRoot: surface.governanceRoot,
            workspaceRoot: surface.workspaceRoot,
            config: mcpConfig,
          })
      : undefined);
  const open = (deps: RuntimeDeps): RuntimeBundle => {
    const bundle = openBundle(surface.header, deps, surface.branchHeader);
    surface.onBundle?.(bundle);
    return bundle;
  };
  if (startMcp === undefined) {
    return readyHandle(open(runtimeDeps));
  }
  return pendingHandle(
    startMcp().then(async (mcp) => {
      try {
        return open({ ...runtimeDeps, mcp });
      } catch (error) {
        await mcp.close();
        throw error;
      }
    })
  );
}

// 装配运行面；worker 与分支会话的来历只在新建会话文件时写进文件头（177），故随装配一并交给运行面
function openBundle(
  header: SessionHeaderInput | undefined,
  runtimeDeps: RuntimeDeps,
  branchHeader?: BranchHeaderInput
): RuntimeBundle {
  if (header === undefined && branchHeader === undefined) {
    return buildRuntime(runtimeDeps);
  }
  return buildRuntime({
    ...runtimeDeps,
    storeLineage: {
      ...(header !== undefined ? { worker: header } : {}),
      ...(branchHeader !== undefined ? { branch: branchHeader } : {}),
    },
  });
}

function summaryOf(bundle: RuntimeBundle): string {
  const last = bundle.adapter.transcript().findLast((message) => message.role === "assistant");
  if (last === undefined || last.role !== "assistant") {
    return "";
  }
  return last.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

// 决策 365：无人值守的运行面（headless 与 worker）——一次运行正常结束后，本会话开过后台作业的，先等在跑的作业、把结束
// 通知交给模型跑一轮，直到没有在跑的作业（收尾总时限到即停掉余下的）；运行面被中断即不再等
async function runSettlingJobs(
  bundle: RuntimeBundle,
  run: () => Promise<RunResult>,
  halted: () => boolean
): Promise<RunResult> {
  const first = await run();
  const jobs = bundle.jobs;
  if (jobs === undefined || first.status !== "completed" || jobs.list().length === 0 || halted()) {
    return first;
  }
  const { last } = await settleBackgroundJobs({
    jobs,
    target: {
      pendingNotices: () => bundle.adapter.pendingNotices(),
      runNotices: () => bundle.adapter.runNotices(),
      notify: (text) => bundle.adapter.notify(text),
    },
    stopped: halted,
    closeoutMs: bundle.jobCloseoutMs,
  });
  const result = last ?? first;
  // 等作业时被中断（墙钟、上限、外部中止、worker 被停）：按中止交回（决策 409：保留的作业不等，不算）
  return halted() && jobs.toSettle().length > 0 ? { ...result, status: "aborted" } : result;
}

function readyHandle(bundle: RuntimeBundle): WorkerRuntimeHandle {
  const { adapter } = bundle;
  let halted = false;
  return {
    run: (task) => {
      halted = false;
      bundle.jobs?.beginRun();
      return runSettlingJobs(
        bundle,
        () => adapter.run(task),
        () => halted
      );
    },
    // 决策 324：运行面就绪（同步就绪即当场给出）
    ready: () => Promise.resolve(bundle),
    interrupt: (cause) => {
      halted = true;
      return adapter.interrupt(cause);
    },
    subscribe: (listener) => adapter.subscribe(listener),
    subscribeRounds: (listener) => adapter.subscribeRounds(listener),
    summary: () => summaryOf(bundle),
    structured: () => structuredResultOf(summaryOf(bundle)),
    continueRun: () => adapter.continueRun(),
    // 决策 297：发给 worker 的话进它的下一轮
    notify: (text) => adapter.notify(text),
    noticeDelivered: (key) => adapter.noticeDelivered(key),
    withdrawNotice: (key) => adapter.withdrawNotice(key),
    transcript: () => bundle.sessionStore.filePath(),
    // 决策 299：再派出时的落盘口
    childLog: () => childFamilySink(bundle.sessionStore),
    // 决策 301：界面实时显示 worker 的对话（只读观察口，编排器有观察者时才订）
    subscribeStream: (listener) => adapter.subscribeStream(listener),
    subscribeToolResults: (listener) => adapter.subscribeToolResults(listener),
    dispose: () => disposeRuntime(bundle),
  };
}

// 运行面异步就绪（M5.7 S4）：装配失败经 run 上抛（编排器按失败收尾）；dispose 等就绪后释放
function pendingHandle(ready: Promise<RuntimeBundle>): WorkerRuntimeHandle {
  let bundle: RuntimeBundle | undefined;
  let interruptedEarly = false;
  let halted = false;
  // 就绪前订阅的监听器 → 就绪后的退订函数
  const early = new Map<(event: EventEnvelope) => void, () => void>();
  // 决策 301、305：就绪前的只读观察（流式正文、工具结果、整轮）→ 就绪后的退订函数
  const earlyObservers = new Map<(adapter: RuntimeBundle["adapter"]) => () => void, () => void>();
  const settled = ready.then((value) => {
    bundle = value;
    for (const listener of early.keys()) {
      early.set(listener, value.adapter.subscribe(listener));
    }
    for (const attach of earlyObservers.keys()) {
      earlyObservers.set(attach, attach(value.adapter));
    }
    return value;
  });
  const observeWhenReady = (attach: (adapter: RuntimeBundle["adapter"]) => () => void) => {
    if (bundle !== undefined) {
      return attach(bundle.adapter);
    }
    earlyObservers.set(attach, () => {});
    return () => {
      const unsubscribe = earlyObservers.get(attach);
      earlyObservers.delete(attach);
      unsubscribe?.();
    };
  };
  // 拒绝由 run / dispose 观察；此处只防未处理拒绝
  settled.catch(() => {});
  return {
    run: async (task) => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      halted = false;
      current.jobs?.beginRun();
      return runSettlingJobs(
        current,
        () => current.adapter.run(task),
        () => halted
      );
    },
    // 决策 324：等运行面就绪（装配失败即拒绝，与 run 同一出口）
    ready: () => settled,
    interrupt: async (cause) => {
      if (bundle === undefined) {
        interruptedEarly = true;
        return;
      }
      halted = true;
      await bundle.adapter.interrupt(cause);
    },
    subscribe: (listener) => {
      if (bundle !== undefined) {
        return bundle.adapter.subscribe(listener);
      }
      early.set(listener, () => {});
      return () => {
        const unsubscribe = early.get(listener);
        early.delete(listener);
        unsubscribe?.();
      };
    },
    subscribeRounds: (listener) => observeWhenReady((adapter) => adapter.subscribeRounds(listener)),
    summary: () => (bundle !== undefined ? summaryOf(bundle) : ""),
    structured: () => (bundle !== undefined ? structuredResultOf(summaryOf(bundle)) : undefined),
    continueRun: async () => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      return current.adapter.continueRun();
    },
    notify: (text) => bundle?.adapter.notify(text),
    noticeDelivered: (key) => bundle?.adapter.noticeDelivered(key) ?? false,
    withdrawNotice: (key) => bundle?.adapter.withdrawNotice(key) ?? false,
    transcript: async () => {
      const current = await settled.catch(() => undefined);
      return current?.sessionStore.filePath();
    },
    childLog: () => (bundle !== undefined ? childFamilySink(bundle.sessionStore) : undefined),
    subscribeStream: (listener) => observeWhenReady((adapter) => adapter.subscribeStream(listener)),
    subscribeToolResults: (listener) =>
      observeWhenReady((adapter) => adapter.subscribeToolResults(listener)),
    dispose: async () => {
      const current = await settled.catch(() => undefined);
      if (current !== undefined) {
        await disposeRuntime(current);
      }
    },
  };
}
