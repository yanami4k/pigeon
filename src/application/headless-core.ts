// headless 运行入口（M6.5 S1，决策 056）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 会话存储、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从会话记录算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——写档与命令档里需要人来批的调用数：
// 以 yolo 批发授权放行（有人在场时会被问）、由人批准或拒绝、因无审批通道而拒绝的；固化规则与会话放权放行的不计。
// 从会话存储现算（决策 180，state/session-judge.ts）。
// 决策 322：验证门、回炉与失败自动分叉重试已删除——本核心只跑一个 Run 到收尾；收尾检查由使用者自配的
// 收尾钩子承担（323），成败不再由程序贴"通过"标签
// 推送记忆（决策 191、193、331、363）：开着时把两层记忆整份放进开工状态块；无人值守，只推送、不注册 update_memory；
// 收尾复盘与压缩前复盘已随决策 331 删除
// 派 worker（决策 264–268、297–303）：开着时给主 agent 注册 spawn_worker 与等待等积木，装一个编排器（无人值守：worker 需请示时
// 不等，作为可恢复错误交回，303）；worker 用的 token 计入本次运行的 token 上限，撞了即停掉主 agent 与在跑的 worker、拒绝再派。
// 297：每次运行结束后，等本次派出的 worker 全部结束、把完成通知当新的一轮处理完，这一步才往下走；
// 释放运行面之前停掉仍在跑的 worker（撞上限、外部中止时），等其收尾记录写进本会话。执行端另一侧的工作区（容器）与分支会话不注册。
// 任务清单（294 B1）：开着时给主 agent 注册两件清单工具
import type { ScriptLauncher } from "../execution/script-sandbox.ts";
import type { MemoryLayer } from "../memory/learned.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { FailureClass } from "../state/classification.ts";
import { DEFAULT_STOP_HOOK_BLOCK_CAP } from "../state/hooks.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  type OrchestrationSettings,
} from "../state/orchestration-config.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type {
  RepetitionGuardSettings,
  TruncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import { storeAttemptLabel, storeRunMetrics } from "../state/session-judge.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { attachCheckpoints } from "./checkpoints.ts";
import { compactionWarner } from "./compaction-text.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import { attachLoopGuard, type LoopStop } from "./loop-guard.ts";
import type { McpSession } from "./mcp.ts";
import type { LearnedMemoryConfig, RuntimeBundle } from "./runtime.ts";
import { createSessionScripts, modelPricing } from "./script-host.ts";
import { ScriptGate, scriptGateSettingsOf } from "./script-naming.ts";
import type { ScriptRuns } from "./script-runner.ts";
import { ScriptSlot } from "./script-tool.ts";
import { bindSpawnWorkers, stopAllWorkers } from "./spawn-worker-host.ts";
import {
  type SpawnWorkerBudget,
  SpawnWorkerSlot,
  spawnWorkerSettingsOf,
} from "./spawn-worker-tool.ts";
import type { StatusHashes } from "./status-block.ts";
import type { StatusFacts } from "./status-sources.ts";
import type { WarnSink } from "./warnings.ts";
import type { WebToolsConfig } from "./web-tools.ts";
import { drainWorkers, type WorkerNotices } from "./worker-notices.ts";
import {
  createDetachedRuntime,
  createSessionWorkers,
  type DetachedRuntimeRequest,
} from "./workers.ts";

export type HeadlessStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "unknown"
  | "turn-limit"
  | "wall-clock-limit"
  | "token-limit"
  // 空回复异常结束（决策 170 ②）：模型的回复既无文字也无工具调用，重试一次仍是如此。不算模型服务故障
  | "empty-reply"
  // 打转叫停（决策 307）：成败算失败
  | "looping"
  // 收尾钩子连续拦截到上限（决策 322 / 323）：照常结束，不贴失败标签
  | "stop-hook-limit";

// 退出码按终态映射；1 留给参数与装配错误（cli 入口的异常出口）
export const HEADLESS_EXIT_CODES: Readonly<Record<HeadlessStatus, number>> = {
  completed: 0,
  failed: 2,
  aborted: 3,
  unknown: 4,
  "turn-limit": 5,
  "wall-clock-limit": 6,
  "token-limit": 7,
  "empty-reply": 8,
  looping: 9,
  "stop-hook-limit": 10,
};

export interface HeadlessRunOptions {
  task: string;
  governanceRoot: string;
  // 决策 325：本次运行的设置快照（pigeon run 由入口读好并确认过会执行命令的条目；缺省为空快照，跑批器如此）
  settings?: SettingsSnapshot;
  workspaceRoot: string;
  // 决策 098：执行端；缺省为 workspaceRoot 上的本地实现（容器工作区由调用方注入，workspaceRoot 为宿主侧占位目录）
  workspaceHost?: WorkspaceHost;
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用），写进开工状态块的环境一节
  statusFacts?: StatusFacts;
  streamFn: StreamFn;
  yolo: boolean;
  provider?: string;
  modelId?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  wallClockMs?: number;
  // 累计 totalTokens 达到即中止（usage 取自 turn.completed）
  maxTokens?: number;
  // 外部中止（调用方的限额看守等）：在途的运行立即中止、不再回炉，终态记 aborted，不写撞上限记录
  abortSignal?: AbortSignal;
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读，跑批器关掉
  agentsMd?: boolean;
  homeDir?: string;
  persistThinking?: boolean;
  sessionId?: SessionId;
  // 决策 061：编辑模式，缺省见 tools/edit-mode.ts 的 DEFAULT_EDIT_MODE（现为 replace）
  editMode?: EditMode;
  // 决策 063、347：单轮输出上限（缺省不设，跟模型）
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测（缺省取设置快照；跑批器显式给出）
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // M9：采样温度（缺省不设）；冻结进注入快照并随 Run 开始条目 落盘
  temperature?: number;
  // M9：任务源给的系统指令——追加进 system prompt 并随之冻结；任务说明（task）不受影响
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；关掉时三件会话检索工具（339 加 list_sessions）不注册，系统提示不提它们
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（模型窗口、预留、保留量、触发点）；缺省为产品缺省，集成冒烟可调低触发点
  compaction?: CompactionConfigInput;
  // 决策 192、207：压缩前回调（通用挂点，尚无生产入口设置它）；缺省不挂
  beforeCompaction?: BeforeCompaction;
  // 运行时告警的出口（自动压缩没压成、压缩前回调失败；缺省标准错误输出，同一类只说一次；测试注入）
  warn?: WarnSink;
  // 决策 191、193、331、363：推送记忆（两层记忆整份放进开工状态块）；无人值守，只推送、不注册 update_memory。缺省关着
  pushedMemory?: boolean;
  // 学到的记忆的两层上限（字符，按码点计）；缺省取设置快照的 memory 一节
  memoryLimits?: MemoryLimits;
  // 推送哪几层；缺省两层（跑批器只推项目级）
  memoryLayers?: readonly MemoryLayer[];
  // 决策 264–267：派 worker（给主 agent 注册 spawn_worker）；缺省关着——pigeon run 由启动参数缺省打开，跑批器各条件明确关掉。
  // 注入了执行端（容器工作区）或是分支会话时不注册
  spawnWorkers?: boolean;
  // 决策 294 D、309：脚本编排（注册 orchestrate，任务描述算作点名）；缺省关着——pigeon run 随派 worker 打开，跑批器各条件不给。
  // 派 worker 关着时不给
  scriptOrchestration?: boolean;
  // 测试注入脚本的执行容器（缺省为 Docker 容器）
  scriptLauncher?: () => Promise<ScriptLauncher>;
  // 决策 297–303：编排设定（同时在跑的上限缺省 8、不设总数上限、层数、每个 worker 的上限、卡住与审批时限）
  orchestration?: OrchestrationSettings;
  // 决策 294 B1：任务清单工具；缺省关着——pigeon run 按编排配置缺省打开，跑批器各条件不给
  taskList?: boolean;
  // 决策 287–291：联网工具的配置——在场即给主会话与 worker 注册两件工具；缺省不注册（pigeon run 由启动参数缺省给出，
  // --sandbox-network off 不给；跑批器各条件不给）
  webTools?: WebToolsConfig;
  // 决策 305–308：打转检测设定——主 agent 与 worker 都挂；缺省不挂（pigeon run 按项目配置缺省打开，跑批器各条件明确关掉）
  loopGuard?: LoopGuardSettings;
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
  // M7（决策 077）：分叉续跑——分支会话头、由会话树还原的初始消息、不给新输入从已有消息续跑
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  // 决策 363：分叉续跑时状态变化通道的起点（分支会话记录里最后发出的一份）
  statusSent?: StatusHashes;
  continueFromHistory?: boolean;
  // 运行面装起来后的回调（挂会话树写穿）
  onBundle?: (bundle: RuntimeBundle) => void;
}

export interface HeadlessRunMetrics {
  // 本会话的 Run；运行面没装起来时缺省
  runId?: RunId;
  failure: FailureClass | null;
  turns: number;
  toolCalls: number;
  approvalsNeeded: number;
  usage: TurnUsage;
}

export interface HeadlessRunResult extends HeadlessRunMetrics {
  sessionId: SessionId;
  status: HeadlessStatus;
  durationMs: number;
  errorMessage?: string;
  // 由会话现算的标签（决策 322：不再有"通过"——验证门已删除，正常做完记未知）
  label: OutcomeLabel;
  // 打转叫停时在场（307）：计数与重复的调用（收尾说明用）
  looping?: LoopStop;
}

export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const pushed = options.pushedMemory === true;
  // 护栏（112 的延伸）：注入了执行端时 workspaceRoot 在宿主一侧、不是 agent 干活的工作区。分支会话
  // 要在它上面打 git 快照、到独立工作树里续跑——对容器里的工作区只会得到假结果，装配前一律拒绝
  if (options.workspaceHost !== undefined && options.branchHeader !== undefined) {
    throw new Error(
      "容器工作区暂不支持分支会话：分叉要在宿主的 git 工作区上打快照、到独立工作树里续跑，" +
        "而容器工作区在执行端另一侧"
    );
  }
  const sessionId = options.sessionId ?? newSessionId();
  const startedAt = Date.now();
  // 这一步的墙钟
  let deadline = options.wallClockMs !== undefined ? startedAt + options.wallClockMs : undefined;
  let timer: NodeJS.Timeout | undefined;
  // 推送记忆（191、331）：无人值守——只推送，不给写入配置（冲突处理随之为无人值守版）
  const learnedMemory: LearnedMemoryConfig | undefined = pushed
    ? {
        ...(options.memoryLimits !== undefined ? { limits: options.memoryLimits } : {}),
        ...(options.memoryLayers !== undefined ? { layers: options.memoryLayers } : {}),
      }
    : undefined;
  // 运行面装起来后拿到的装配结果：回炉在释放之前经它的会话文件落验证记录
  let liveBundle: RuntimeBundle | undefined;
  // 已注册工具的风险档位（需审批次数按它现算；运行面没装起来时为空）
  let toolTiers: ReadonlyMap<string, string> = new Map();
  // 派 worker（264–268）：工具槽在装配时注册，编排器等运行面装起来后再绑定
  const spawnSlot =
    options.spawnWorkers === true &&
    options.workspaceHost === undefined &&
    options.branchHeader === undefined
      ? new SpawnWorkerSlot(
          spawnWorkerSettingsOf({
            ...(options.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS),
            taskList: options.taskList === true,
          })
        )
      : undefined;
  // 决策 309：脚本编排——任务描述算作点名，整次运行（含回炉各轮）都算
  const scriptSlot =
    spawnSlot !== undefined && options.scriptOrchestration === true
      ? new ScriptSlot(
          new ScriptGate(
            scriptGateSettingsOf(options.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS)
          )
        )
      : undefined;
  scriptSlot?.gate.runTask(options.task);
  let scripts: ScriptRuns | undefined;
  let workers: WorkerOrchestrator | undefined;
  let spawnBudget: SpawnWorkerBudget | undefined;
  let notices: WorkerNotices | undefined;
  // worker 每收尾一轮用的 token（计入本次运行的 token 上限；运行开始前接好）
  let addWorkerTokens: (tokens: number) => void = () => {};
  // 本次运行的装配参数
  const surface: Omit<DetachedRuntimeRequest, "sessionId"> = {
    governanceRoot: options.governanceRoot,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
    workspaceRoot: options.workspaceRoot,
    ...(options.workspaceHost !== undefined ? { workspaceHost: options.workspaceHost } : {}),
    ...(options.statusFacts !== undefined ? { statusFacts: options.statusFacts } : {}),
    streamFn: options.streamFn,
    // 决策 067：三个入口的模型占位缺省统一为同一常量（真实模型元数据由 streamFn 插件提供）
    provider: options.provider ?? DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: options.modelId ?? DEFAULT_MODEL_PLACEHOLDER.modelId,
    yolo: options.yolo,
    ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.persistThinking !== undefined ? { persistThinking: options.persistThinking } : {}),
    ...(options.skillRoots !== undefined ? { skillRoots: options.skillRoots } : {}),
    ...(options.agentsMd !== undefined ? { agentsMd: options.agentsMd } : {}),
    ...(options.editMode !== undefined ? { editMode: options.editMode } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.truncationContinuation !== undefined
      ? { truncationContinuation: options.truncationContinuation }
      : {}),
    ...(options.repetitionGuard !== undefined ? { repetitionGuard: options.repetitionGuard } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.taskDirective !== undefined ? { taskDirective: options.taskDirective } : {}),
    ...(options.sessionSearch !== undefined ? { sessionSearch: options.sessionSearch } : {}),
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
    ...(learnedMemory !== undefined ? { learnedMemory } : {}),
    ...(spawnSlot !== undefined ? { spawnWorker: spawnSlot } : {}),
    ...(scriptSlot !== undefined ? { scriptOrchestration: scriptSlot } : {}),
    ...(options.taskList === true ? { taskList: true } : {}),
    ...(options.webTools !== undefined ? { webTools: options.webTools } : {}),
  };
  const handle = createDetachedRuntime({
    ...surface,
    sessionId,
    ...(options.beforeCompaction !== undefined
      ? { beforeCompaction: options.beforeCompaction }
      : {}),
    // M8（决策 087）：本次运行的预算冻结进注入快照——回放据此沿用同一预算，不得放宽
    budget: {
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    },
    ...(options.branchHeader !== undefined ? { branchHeader: options.branchHeader } : {}),
    ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
    ...(options.statusSent !== undefined ? { statusSent: options.statusSent } : {}),
    onBundle: (bundle) => {
      liveBundle = bundle;
      // 决策 330：人写的说明超出上限被截断时提示一行（告警出口，缺省标准错误输出）
      // 决策 359：开局没注册 web_search 的原因同样提示一行
      for (const notice of [bundle.instructionsNotice, bundle.toolsNotice]) {
        if (notice !== undefined) (options.warn ?? ((line: string) => console.error(line)))(notice);
      }
      // 决策 305–307：打转检测挂在主 agent 上——提醒进下一轮；计到叫停轮数即以打转中止
      const detachLoopGuard = attachLoopGuard(bundle.adapter, options.loopGuard, (found) => {
        if (limitHit === undefined) {
          looping = found;
        }
        stop("looping");
      });
      bundle.disposers = [...(bundle.disposers ?? []), async () => detachLoopGuard()];
      // 决策 189：无头运行没人看压缩提示——自动压缩没压成与压缩前回调失败写标准错误输出，同一类只说一次
      bundle.adapter.subscribeCompaction(compactionWarner(options.warn));
      toolTiers = bundle.toolTiers;
      // M7（决策 077 / 078）：分支会话在 git 工作区里打快照（/fork 取准确基线）；
      // 非 git 工作区不挂快照（attachCheckpoints 返回 undefined）；执行端另一侧的工作区不在宿主上打快照
      if (options.workspaceHost === undefined && options.branchHeader !== undefined) {
        const checkpoints = attachCheckpoints({ bundle, workspaceRoot: options.workspaceRoot });
        if (checkpoints !== undefined) {
          // 决策 350：运行面停下之后、会话存储关闭之前等未完成的快照拍完（有上限）
          bundle.closers = [...(bundle.closers ?? []), () => checkpoints.close()];
        }
      }
      // 决策 264–268：派 worker 的编排器（决策 279：worker 从治理根连同未提交改动的快照开工；无人值守，不接审批通道）
      if (spawnSlot !== undefined) {
        workers = createSessionWorkers({
          governanceRoot: options.governanceRoot,
          bundle,
          streamFn: options.streamFn,
          provider: surface.provider,
          modelId: surface.modelId,
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          ...(options.persistThinking !== undefined
            ? { persistThinking: options.persistThinking }
            : {}),
          ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {}),
          ...(options.editMode !== undefined ? { editMode: options.editMode } : {}),
          settings: options.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS,
          onWorkerTokens: (_workerId, tokens) => addWorkerTokens(tokens),
          ...(options.webTools !== undefined ? { webTools: options.webTools } : {}),
          ...(options.loopGuard !== undefined ? { loopGuard: options.loopGuard } : {}),
        });
        const bound = bindSpawnWorkers({
          slot: spawnSlot,
          orchestrator: workers,
          governanceRoot: options.governanceRoot,
          hostSessionId: sessionId,
          // 决策 297：完成通知进本会话的下一轮（空闲时由 drainWorkers 接着跑）
          target: bundle.adapter,
        });
        spawnBudget = bound.budget;
        notices = bound.notices;
        // 决策 309–314：脚本编排的运行器——无人值守：收回在放手模式或已放权时才做；pigeon run 的总额度用完即不再派
        if (scriptSlot !== undefined) {
          const orchestrator = workers;
          scripts = createSessionScripts({
            orchestrator,
            governanceRoot: options.governanceRoot,
            settings: bundle.settings,
            sessionId,
            flush: () => bundle.sessionStore.flush(),
            ...(notices !== undefined ? { notices } : {}),
            approval: {
              yolo: options.yolo,
              grants: bundle.grantStore,
              configGrants: bundle.configGrants,
            },
            provider: surface.provider,
            pricing: () => modelPricing(surface.provider, bundle.adapter.transcript()),
            stallMs: (options.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS).scriptStallMs,
            hostExhausted: () => spawnBudget?.exhausted === true,
            ...(options.scriptLauncher !== undefined ? { launcher: options.scriptLauncher } : {}),
          });
          scriptSlot.bind({ runs: scripts, governanceRoot: options.governanceRoot });
        }
      }
      options.onBundle?.(bundle);
    },
  });
  let limitHit: "turn-limit" | "wall-clock-limit" | "token-limit" | "looping" | undefined;
  let looping: LoopStop | undefined;
  const stop = (reason: NonNullable<typeof limitHit>): void => {
    if (limitHit !== undefined) {
      return;
    }
    limitHit = reason;
    // 只发中止请求；原因随中止请求交给运行面，运行确以中止收尾时 Run 收尾条目据此记撞上限（072 修订）。
    // 中止失败不改变结果：run 以当时的终态收尾
    handle.interrupt(reason).catch(() => {});
    // 决策 268：撞了 token 上限即额度用完——拒绝再派、停掉在跑的 worker（主 agent 等待中的派出随中止一并取消）
    if (reason === "token-limit") {
      spawnBudget?.markExhausted();
      if (workers !== undefined) {
        void stopAllWorkers(workers);
      }
    }
  };
  let turns = 0;
  let tokens = 0;
  const unsubscribe = handle.subscribe((event) => {
    if (event.kind !== "turn.completed") {
      return;
    }
    turns += 1;
    tokens += (event.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0;
    if (options.maxTurns !== undefined && turns >= options.maxTurns) {
      stop("turn-limit");
    } else if (options.maxTokens !== undefined && tokens >= options.maxTokens) {
      stop("token-limit");
    }
  });
  // 决策 268：worker 用的 token 一并计入本次运行的 token 上限
  addWorkerTokens = (workerTokens) => {
    tokens += workerTokens;
    if (options.maxTokens !== undefined && tokens >= options.maxTokens) {
      stop("token-limit");
    }
  };
  if (deadline !== undefined) {
    timer = setTimeout(() => stop("wall-clock-limit"), Math.max(0, deadline - Date.now()));
  }
  let externallyAborted = false;
  const onAbort = () => {
    externallyAborted = true;
    handle.interrupt().catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted === true) onAbort();
  let status: HeadlessStatus = "unknown";
  let errorMessage: string | undefined;
  // 决策 297：一次运行结束后，等本次派出的 worker 全部结束、把通知处理完（撞上限或外部中止即不再等）。
  // 等的途中撞上限或被外部中止：这一步按中止收尾（终态随后按撞上限的原因或外部中止记）
  let drainInterrupted = false;
  const settleWorkers = async <R>(run: R): Promise<R> => {
    const bundle = liveBundle;
    if (workers === undefined || notices === undefined || bundle === undefined) {
      return run;
    }
    const { last, interrupted } = await drainWorkers({
      orchestrator: workers,
      parentSessionId: sessionId,
      notices,
      target: {
        pendingNotices: () => bundle.adapter.pendingNotices(),
        runNotices: () => bundle.adapter.runNotices() as Promise<unknown> as Promise<R>,
      },
      stopped: () => limitHit !== undefined || externallyAborted,
    });
    if (interrupted) {
      drainInterrupted = true;
    }
    return last ?? run;
  };
  try {
    // 决策 323 / 324：会话级钩子——运行面可能异步就绪（MCP 启动）：ready() 等它；装配失败与 run 同一出口（failed）。
    // 端口返回 unknown（编排层不依赖 application），此处收窄到 RuntimeBundle（生产者唯一：本层装配）
    const readyBundle = (await handle.ready?.()) as RuntimeBundle | undefined;
    const hooks = readyBundle?.hooks ?? liveBundle?.hooks;
    // SessionStart：开局补上下文（以一条上下文消息进入，不改开局冻结的系统提示——上下文并进第一条输入）；
    // UserPromptSubmit：可拦下、可补上下文，不能改写
    let task = options.task;
    let preRunBlocked: string | undefined;
    let preRunStopped: string | undefined;
    if (hooks !== undefined && !externallyAborted) {
      const source = options.continueFromHistory === true ? "resume" : "startup";
      const startReport = await hooks.runEvent("SessionStart", source, {
        source,
        ...(options.provider !== undefined && options.modelId !== undefined
          ? { model: `${options.provider}/${options.modelId}` }
          : {}),
      });
      const contexts = [...startReport.additionalContext];
      if (startReport.continueFalse !== undefined) {
        preRunStopped = startReport.continueFalse.stopReason ?? "钩子要求整个会话停止";
      } else {
        const promptReport = await hooks.runEvent("UserPromptSubmit", "", { prompt: options.task });
        contexts.push(...promptReport.additionalContext);
        if (promptReport.blocked !== undefined) {
          preRunBlocked = promptReport.blocked.reason;
        } else if (promptReport.continueFalse !== undefined) {
          preRunStopped = promptReport.continueFalse.stopReason ?? "钩子要求整个会话停止";
        }
      }
      if (contexts.length > 0) {
        task = `${contexts.join("\n\n")}\n\n${options.task}`;
      }
    }
    // 开工前已被外部中止、或钩子拦下/要求停止：一轮都不跑
    let run: Awaited<ReturnType<typeof handle.run>> | undefined;
    if (externallyAborted || preRunBlocked !== undefined || preRunStopped !== undefined) {
      status = "aborted";
      if (preRunBlocked !== undefined) {
        errorMessage = `输入被钩子拦下：${preRunBlocked}`;
      } else if (preRunStopped !== undefined) {
        errorMessage = preRunStopped;
      }
    } else {
      run = await settleWorkers(
        options.continueFromHistory === true && handle.continueRun !== undefined
          ? await handle.continueRun()
          : await handle.run(task)
      );
    }
    if (!(externallyAborted || preRunBlocked !== undefined || preRunStopped !== undefined)) {
      if (run === undefined) {
        status = "aborted";
      } else {
        status =
          run.emptyReply === true
            ? "empty-reply"
            : run.status === "aborted" || drainInterrupted
              ? (limitHit ?? "aborted")
              : run.status;
        errorMessage = run.errorMessage;
        // 外部中止：这一步由调用方作废
        if (externallyAborted) {
          status = "aborted";
        }
      }
    }
    // 决策 323 / 324：Stop 钩子——收尾拦住要求接着干（理由作为新一轮输入），连续拦截到上限
    // （缺省 8，设置里 stopHookBlockCap 可改）后不再理会、照常结束，结束原因记 stop-hook-limit
    // 决策 324 复审：以出错收尾（failed）的 Run 不跑 Stop——它的通知是 StopFailure（下一段）
    if (
      hooks !== undefined &&
      run !== undefined &&
      !externallyAborted &&
      limitHit === undefined &&
      status !== "aborted" &&
      status !== "failed"
    ) {
      const stopCap = options.settings?.merged.stopHookBlockCap ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
      let stopHookActive = false;
      let blockedCount = 0;
      for (;;) {
        const report = await hooks.runEvent("Stop", "", {
          stop_hook_active: stopHookActive,
          last_assistant_message: handle.summary(),
        });
        // continue:false 压过拦截：整个会话停止处理，不再开新一轮（理由由钩子提示给出）
        if (report.continueFalse !== undefined) break;
        const wantsContinue = report.blocked !== undefined || report.additionalContext.length > 0;
        if (!wantsContinue) break;
        if (blockedCount >= stopCap) {
          // 到上限：这一次拦截不再理会，照常结束
          status = "stop-hook-limit";
          break;
        }
        blockedCount += 1;
        stopHookActive = true;
        const next = [
          ...report.additionalContext,
          ...(report.blocked !== undefined ? [report.blocked.reason] : []),
        ].join("\n\n");
        run = await settleWorkers(await handle.run(next));
        status =
          run.emptyReply === true
            ? "empty-reply"
            : run.status === "aborted" || drainInterrupted
              ? (limitHit ?? "aborted")
              : run.status;
        errorMessage = run.errorMessage;
        // 续跑这一轮出错或以中断收尾（含钩子 continue:false 停下）：循环停（出错的那一轮触发 StopFailure、
        // 不再触发 Stop；终态与理由如实记，不被 stop-hook-limit 盖掉）——与终端界面同口径
        if (run.status === "failed" || run.status === "aborted") {
          break;
        }
        if (externallyAborted) {
          status = "aborted";
          break;
        }
        if (limitHit !== undefined) {
          break;
        }
      }
    }
    // 决策 324：StopFailure——本 Run 以出错收尾时通知（无决策能力，只作副作用）
    if (hooks !== undefined && run !== undefined && run.status === "failed") {
      await hooks.runEvent("StopFailure", "", {
        error: run.errorMessage ?? "unknown",
        ...(run.errorMessage !== undefined ? { last_assistant_message: run.errorMessage } : {}),
      });
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    deadline = undefined;
    unsubscribe();
    options.abortSignal?.removeEventListener("abort", onAbort);
    // 还在跑的脚本停下（在跑的 worker 随之停下，汇总照常交回），再停掉其余 worker
    if (scripts !== undefined) {
      const live = scripts.running();
      await Promise.all(live.map((runId) => scripts?.stop(runId)));
      await Promise.all(live.map((runId) => scripts?.settled(runId)));
      scripts.dispose();
    }
    // 派出的 worker 在释放之前停掉并收尾（收尾记录写进本会话）
    if (workers !== undefined) {
      await stopAllWorkers(workers);
    }
    // 决策 323 / 324：SessionEnd——会话结束（只作副作用；缺省短时限 1.5 秒、单个钩子最长 60 秒）。
    // 在释放运行面之前跑：记录要落在本会话文件里
    if (liveBundle?.hooks !== undefined) {
      await liveBundle.hooks.runEvent("SessionEnd", "exit", { reason: "exit" });
    }
    await handle.dispose();
  }
  const sessionsDir = sessionsDirOf(options.governanceRoot);
  const outcome = readRunOutcome(sessionsDir, sessionId, toolTiers);
  const metrics = outcome.metrics;
  return {
    sessionId,
    status,
    ...metrics,
    label: outcome.label,
    ...(status === "looping" && looping !== undefined ? { looping } : {}),
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

// 一次运行的指标、标签与 Run 数：从会话存储现算；会话存储里没有这个会话（运行面没装起来、写者打不开）时为空指标
function readRunOutcome(
  sessionsDir: string,
  sessionId: SessionId,
  toolTiers: ReadonlyMap<string, string>
): { metrics: HeadlessRunMetrics; label: OutcomeLabel; runCount: number } {
  const loaded = loadStoreSession(sessionsDir, sessionId);
  if (loaded !== undefined) {
    const metrics = storeRunMetrics(loaded.view, { toolTiers });
    return {
      metrics,
      label:
        metrics.runId !== undefined ? storeAttemptLabel(loaded.view, metrics.runId) : "Unknown",
      runCount: loaded.view.runs.length,
    };
  }
  return {
    metrics: {
      failure: { category: "unknown" },
      turns: 0,
      toolCalls: 0,
      approvalsNeeded: 0,
      usage: structuredClone(ZERO_USAGE),
    },
    label: "Unknown",
    runCount: 0,
  };
}

const ZERO_USAGE: TurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
