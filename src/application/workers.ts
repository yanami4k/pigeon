// worker 运行面工厂（M5.5 S2，决策 040）：装配根每 worker 调一次 buildRuntime——治理根恒为主仓库根、
// 工作区根为 worker 工作树、策略为委派子集、审批经编排器汇聚到父级；worker 会话文件首条写 session.header。
// M5.7 S4（决策 054）：治理根有 MCP 配置时，worker 以其工作树为工作区根启动自己的 MCP server（roots 即工作树）；
// 启动是异步的，运行面在 run 时就绪——订阅先于就绪时暂存、就绪后接上，就绪前取消即按中止收尾。
// 没有 MCP 配置时仍同步装配，行为与 M5.5 相同（会话头写不进在派出时即报错）。
// M6.5 S1（决策 056）：装配内核抽出为 openRuntimeSurface，worker 工厂与 headless 运行共用——
// headless 无父会话、无角色：不写 session.header，run_command 不套角色清单，无审批通道（prompt 档 fail-closed）。

import type { ApprovalHandler } from "../approvals/handler.ts";
import { deleteSnapshotRef, snapshotWorkdir } from "../execution/workdir-snapshot.ts";
import type { MemoryRoot } from "../memory/resident.ts";
import {
  ROLE_MODEL_OVERRIDES,
  ROLE_THINKING_LEVELS,
  type RoleModelOverride,
} from "../orchestration/roles.ts";
import type {
  WorkerRuntimeFactory,
  WorkerRuntimeHandle,
  WorkerRuntimeRequest,
  WorkerStartPointProvider,
} from "../orchestration/workers.ts";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { workerStartRefFor } from "../orchestration/worktree.ts";
import { loadMcpConfig } from "../persistence/mcp-config.ts";
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { AttemptBudget, VerifyConfig } from "../state/attempt-config.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { SessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type {
  BranchHeaderInput,
  DelegatedPolicy,
  SessionHeaderInput,
  WorkerLimits,
  WorkerRole,
} from "../state/session-payloads.ts";
import { structuredResultOf } from "../state/structured-result.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import {
  buildRuntime,
  disposeRuntime,
  type LearnedMemoryConfig,
  type ReviewSessionConfig,
  type RuntimeBundle,
  type RuntimeDeps,
} from "./runtime.ts";
import { childFamilySink } from "./session-store.ts";
import type { SpawnWorkerSlot } from "./spawn-worker-tool.ts";
import type { WebToolsConfig } from "./web-tools.ts";

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
  // 决策 063：单轮输出上限（缺省 16,384）
  maxOutputTokens?: number;
  // 决策 188、218：上下文压缩的配置——worker 按主会话同一配置跑（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  // M9：采样温度与工作方式指令——回放的验证器运行面沿用原尝试的值（087 修订、110）；其余 worker 缺省不设
  temperature?: number;
  taskDirective?: string;
  // 决策 191、217：推送记忆——worker 与常驻 Memory 同样处理：父会话开着即带推送段与记忆工具（冲突处理的填法、上限同父会话），
  // 不做压缩前复盘（压缩前回调只给无父会话的运行面）
  learnedMemory?: LearnedMemoryConfig;
  // M6（决策 064 子裁决 ③）：角色的模型接入覆盖列（缺省取 roles.ts 的角色表，第一版四个角色都留空）
  roleModelOverrides?: Readonly<Partial<Record<WorkerRole, RoleModelOverride>>>;
  // 覆盖列里 streamFnSpec 对应的已加载插件：装配层按表预加载后传入（工厂同步，不在此处做 IO）
  roleStreamFns?: Readonly<Partial<Record<WorkerRole, StreamFn>>>;
  // 决策 266：无人值守（pigeon run）——worker 不接审批通道：按放权规则或全部放行（审批模式继承父会话），否则拒绝
  unattended?: boolean;
  // 决策 287–291：联网工具的配置——worker 与主会话同样拿到（父策略里有才带）
  webTools?: WebToolsConfig;
}

export interface SessionWorkersDeps extends Omit<WorkerRuntimeDeps, "streamFnFor"> {
  streamFn: StreamFn;
  // 治理根（主仓库根）
  governanceRoot: string;
  // 派出 worker 的父运行面：父策略取其冻结快照，父子两族写其会话文件
  bundle: RuntimeBundle;
  // 父运行面本身是 worker 会话时在场（深度 1：拒绝再派）
  parentSessionId?: SessionId;
  // 汇聚审批入口（Actor 注入，经审批队列）；缺省 = 无人值守，worker 没有审批通道（决策 266）
  approvals?: ApprovalHandler;
  // 决策 268：同时在跑的 worker 上限（人派的与 agent 派的一并计算；缺省不限）
  maxConcurrent?: number;
  // 决策 268：worker 每收尾一轮回报本轮用的 token（计入本次运行的总额度）
  onWorkerTokens?: (sessionId: SessionId, tokens: number) => void;
}

// 无人值守时汇聚审批的兜底：worker 不接审批通道，不会走到这里；万一走到按拒绝处理
const UNATTENDED_APPROVAL = async () => ({
  approved: false,
  reason: "无人值守运行没有审批通道",
  reasonSource: "system-default" as const,
});

// 按会话装配编排器（M5.5 S4）：Actor 只拿四动作面，不触达 orchestration 的构造细节
export function createSessionWorkers(deps: SessionWorkersDeps): WorkerOrchestrator {
  return new WorkerOrchestrator({
    governanceRoot: deps.governanceRoot,
    session: {
      sessionId: deps.bundle.adapter.sessionId,
      ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
    },
    parentPolicy: deps.bundle.adapter.snapshot().tools.policy,
    // worker 派出与收尾写进父会话的会话存储
    parentLog: childFamilySink(deps.bundle.sessionStore),
    approvals: deps.approvals ?? UNATTENDED_APPROVAL,
    createRuntime: sessionWorkerRuntimeFactory(deps),
    // 决策 279：worker 从主工作目录连同未提交改动拍成的快照开工
    startPoint: workerStartPoint(deps.governanceRoot),
    ...(deps.maxConcurrent !== undefined ? { maxConcurrent: deps.maxConcurrent } : {}),
    ...(deps.onWorkerTokens !== undefined ? { onWorkerTokens: deps.onWorkerTokens } : {}),
  });
}

// 决策 279：worker 的起点提供者——拍主工作目录的快照；快照引用只护住"拍好到建好工作树"这一段，工作树建好后由编排器调 release
// 删掉（worker 分支指向起点提交，提交不会被回收；删分支时的连带删除仍留作兜底）
export function workerStartPoint(governanceRoot: string): WorkerStartPointProvider {
  return ({ name }) => {
    const ref = workerStartRefFor(name);
    const snap = snapshotWorkdir({ repoRoot: governanceRoot, ref });
    return {
      commit: snap.commit,
      snapshot: snap.snapshot,
      files: snap.files,
      release: () => deleteSnapshotRef(governanceRoot, ref),
    };
  };
}

// 会话 worker 的运行面工厂（同一会话派出的 worker 共用同一份模型接入与角色覆盖）
export function sessionWorkerRuntimeFactory(deps: SessionWorkersDeps): WorkerRuntimeFactory {
  // 决策 063：worker 继承父运行面冻结快照里的单轮输出上限（显式传入时以传入值为准）
  const maxOutputTokens =
    deps.maxOutputTokens ?? deps.bundle.adapter.snapshot().model.maxOutputTokens;
  // 决策 188、218：worker 继承父运行面的压缩配置（显式传入时以传入值为准）；父运行面没给即产品缺省
  const compaction = deps.compaction ?? deps.bundle.adapter.compactionConfig();
  // 决策 191、217：worker 继承父运行面的推送记忆（开着才带），不做压缩前复盘
  const parentLearned = deps.learnedMemory ?? deps.bundle.learnedMemory;
  const learnedMemory =
    parentLearned !== undefined ? { ...parentLearned, review: false as const } : undefined;
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
    ...(deps.roleModelOverrides !== undefined
      ? { roleModelOverrides: deps.roleModelOverrides }
      : {}),
    ...(deps.roleStreamFns !== undefined ? { roleStreamFns: deps.roleStreamFns } : {}),
    ...(deps.approvals === undefined ? { unattended: true } : {}),
    ...(deps.webTools !== undefined ? { webTools: deps.webTools } : {}),
  });
}

// 装配内核的输入：worker 与 headless 共用
interface RuntimeSurface {
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
  // worker 角色：run_command 套 .pigeon/commands.json 的角色清单；缺省 = 不套清单
  role?: WorkerRole;
  approvalHandler?: ApprovalHandler;
  // worker 会话头；缺省 = 普通会话（headless）
  header?: SessionHeaderInput;
  thinkingLevel?: ThinkingLevel;
  homeDir?: string;
  persistThinking?: boolean;
  memoryBudgetChars?: number;
  skillRoots?: readonly SkillRoot[];
  memoryRoots?: readonly MemoryRoot[];
  // 决策 061：编辑模式（缺省 hashline）
  editMode?: EditMode;
  // 决策 063：单轮输出上限（缺省 16,384）
  maxOutputTokens?: number;
  // M9：采样温度（缺省不设）——目前只有无父会话的运行面（headless 与 Eval）会给；worker 不继承
  temperature?: number;
  // M9：任务源给的系统指令（追加进 system prompt 并随之冻结）；同上，只有无父会话的运行面会给
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；同上，只有无父会话的运行面会给
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）；worker 取主会话的配置
  compaction?: CompactionConfigInput;
  // 决策 192、207：压缩前回调；只有无父会话的运行面会给
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217：推送记忆（在场即开着）；复盘运行面另带复盘设定
  learnedMemory?: LearnedMemoryConfig;
  reviewSession?: ReviewSessionConfig;
  // 缺省在治理根有 MCP 配置时以工作区根启动 MCP 会话
  startMcp?: () => Promise<McpSession>;
  // M7（决策 071）：会话级验证命令（headless 与分支续跑冻结进注入快照）
  verify?: VerifyConfig;
  // M7（决策 079）：失败自动分叉重试次数（冻结进注入快照）
  retryOnFail?: number;
  // 决策 264–267：派 worker 的开关（只有 headless 主会话会给）
  spawnWorker?: SpawnWorkerSlot;
  // 决策 287–291：联网工具的配置
  webTools?: WebToolsConfig;
  // M8（决策 087）：本次尝试的预算——worker 取派出记录的上限，headless 取运行参数；冻结进注入快照
  budget?: AttemptBudget;
  // 决策 142 / 143：回炉轮数（只有 headless 在开启时给）
  repairRounds?: number;
  // M7（决策 077）：分支会话头与分叉续跑的初始消息
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  // 运行面装起来后的回调（挂快照器）
  onBundle?: (bundle: RuntimeBundle) => void;
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
    // 无工作区形状只属于已退役的只读角色（决策 137）；万一出现即以治理根为工作区根
    const workspaceRoot =
      request.workspace.kind === "git-worktree" ? request.workspace.path : request.governanceRoot;
    // M6（决策 064 子裁决 ③）：角色的模型接入覆盖——缺省继承主会话
    const override = (deps.roleModelOverrides ?? ROLE_MODEL_OVERRIDES)[request.role];
    const roleStreamFn = deps.roleStreamFns?.[request.role];
    return openRuntimeSurface({
      sessionId: request.sessionId,
      governanceRoot: request.governanceRoot,
      workspaceRoot,
      streamFn: roleStreamFn ?? deps.streamFnFor(request),
      provider: override?.provider ?? deps.provider,
      modelId: override?.modelId ?? deps.modelId,
      yolo: request.policy.approvalMode === "yolo",
      policy: request.policy,
      // M5.5 S5（决策 048）：run_command 按角色套 .pigeon/commands.json 的允许清单
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
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...(deps.taskDirective !== undefined ? { taskDirective: deps.taskDirective } : {}),
      ...(deps.learnedMemory !== undefined ? { learnedMemory: deps.learnedMemory } : {}),
      ...(request.limits !== undefined ? { budget: budgetOfLimits(request.limits) } : {}),
    });
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
  memoryBudgetChars?: number;
  skillRoots?: readonly SkillRoot[];
  memoryRoots?: readonly MemoryRoot[];
  editMode?: EditMode;
  maxOutputTokens?: number;
  temperature?: number;
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217：推送记忆（在场即开着）；复盘运行面另带复盘设定
  learnedMemory?: LearnedMemoryConfig;
  reviewSession?: ReviewSessionConfig;
  startMcp?: () => Promise<McpSession>;
  // M7（决策 071）：会话级验证命令冻结进注入快照
  verify?: VerifyConfig;
  retryOnFail?: number;
  // 决策 264–267：派 worker 的开关
  spawnWorker?: SpawnWorkerSlot;
  // 决策 287–291：联网工具的配置
  webTools?: WebToolsConfig;
  // M8（决策 087）：本次尝试的预算冻结进注入快照
  budget?: AttemptBudget;
  // 决策 142 / 143：回炉轮数冻结进注入快照（只有 headless 在开启时给）
  repairRounds?: number;
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  onBundle?: (bundle: RuntimeBundle) => void;
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
    ...(surface.memoryBudgetChars !== undefined
      ? { memoryBudgetChars: surface.memoryBudgetChars }
      : {}),
    ...(surface.skillRoots !== undefined ? { skillRoots: surface.skillRoots } : {}),
    ...(surface.memoryRoots !== undefined ? { memoryRoots: surface.memoryRoots } : {}),
    ...(surface.editMode !== undefined ? { editMode: surface.editMode } : {}),
    ...(surface.maxOutputTokens !== undefined ? { maxOutputTokens: surface.maxOutputTokens } : {}),
    ...(surface.temperature !== undefined ? { temperature: surface.temperature } : {}),
    ...(surface.taskDirective !== undefined ? { taskDirective: surface.taskDirective } : {}),
    ...(surface.sessionSearch !== undefined ? { sessionSearch: surface.sessionSearch } : {}),
    ...(surface.compaction !== undefined ? { compaction: surface.compaction } : {}),
    ...(surface.beforeCompaction !== undefined
      ? { beforeCompaction: surface.beforeCompaction }
      : {}),
    ...(surface.learnedMemory !== undefined ? { learnedMemory: surface.learnedMemory } : {}),
    ...(surface.reviewSession !== undefined ? { reviewSession: surface.reviewSession } : {}),
    ...(surface.verify !== undefined ? { verify: surface.verify } : {}),
    ...(surface.retryOnFail !== undefined ? { retryOnFail: surface.retryOnFail } : {}),
    ...(surface.spawnWorker !== undefined ? { spawnWorker: surface.spawnWorker } : {}),
    ...(surface.webTools !== undefined ? { webTools: surface.webTools } : {}),
    ...(surface.budget !== undefined ? { budget: surface.budget } : {}),
    ...(surface.repairRounds !== undefined ? { repairRounds: surface.repairRounds } : {}),
    ...(surface.initialMessages !== undefined ? { initialMessages: surface.initialMessages } : {}),
  };
  // MCP 配置畸形在此响亮失败（派出失败）
  const startMcp =
    surface.startMcp ??
    (loadMcpConfig(surface.governanceRoot).servers.length > 0
      ? () =>
          startMcpSession({
            governanceRoot: surface.governanceRoot,
            workspaceRoot: surface.workspaceRoot,
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

function readyHandle(bundle: RuntimeBundle): WorkerRuntimeHandle {
  const { adapter } = bundle;
  return {
    run: (task) => adapter.run(task),
    interrupt: (cause) => adapter.interrupt(cause),
    subscribe: (listener) => adapter.subscribe(listener),
    summary: () => summaryOf(bundle),
    structured: () => structuredResultOf(summaryOf(bundle)),
    continueRun: () => adapter.continueRun(),
    dispose: () => disposeRuntime(bundle),
  };
}

// 运行面异步就绪（M5.7 S4）：装配失败经 run 上抛（编排器按失败收尾）；dispose 等就绪后释放
function pendingHandle(ready: Promise<RuntimeBundle>): WorkerRuntimeHandle {
  let bundle: RuntimeBundle | undefined;
  let interruptedEarly = false;
  // 就绪前订阅的监听器 → 就绪后的退订函数
  const early = new Map<(event: EventEnvelope) => void, () => void>();
  const settled = ready.then((value) => {
    bundle = value;
    for (const listener of early.keys()) {
      early.set(listener, value.adapter.subscribe(listener));
    }
    return value;
  });
  // 拒绝由 run / dispose 观察；此处只防未处理拒绝
  settled.catch(() => {});
  return {
    run: async (task) => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      return current.adapter.run(task);
    },
    interrupt: async (cause) => {
      if (bundle === undefined) {
        interruptedEarly = true;
        return;
      }
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
    summary: () => (bundle !== undefined ? summaryOf(bundle) : ""),
    structured: () => (bundle !== undefined ? structuredResultOf(summaryOf(bundle)) : undefined),
    continueRun: async () => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      return current.adapter.continueRun();
    },
    dispose: async () => {
      const current = await settled.catch(() => undefined);
      if (current !== undefined) {
        await disposeRuntime(current);
      }
    },
  };
}
