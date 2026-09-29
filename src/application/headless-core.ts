// headless 单次运行核心（M6.5 S1，决策 056；M7 S6 拆出：分叉续跑直接复用本核心，失败自动分叉重试叠加在 headless.ts）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 会话存储、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从会话记录算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——写档与命令档里需要人来批的调用数：
// 以 yolo 批发授权放行（有人在场时会被问）、由人批准或拒绝、因无审批通道而拒绝的；固化规则与会话放权放行的不计。
// 从会话存储现算（决策 180，state/session-judge.ts）。
// 回炉（决策 142 / 143 / 147）：开启时一次 Run 结束后，在同一会话里、释放运行面之前跑验证命令——通过即结束；
// 失败即把失败反馈作为新一轮输入开一个新 Run 接着修，最多 N 轮；无法判定不回炉、记为未知。修满 N 轮或预算耗尽仍失败，
// 这一步以失败收尾，工作区保留 agent 的改动、不做回退（决策 172 / 173）。各轮与首次共用同一个总预算（轮次、墙钟与 token；
// 验证命令的耗时也算在墙钟里）。一步的成败以最后一次验证为准，由 Run 开始条目里冻结的回炉轮数与最后一次验证记录推出
// （state/session-judge.ts），不新增记录。
// 推送记忆（决策 191、192、207、217）：开着时开局推入学到的记忆、带 update_memory；上下文压缩之前先复盘一次（期间这一步的墙钟
// 暂停，复盘不占这一步的宽上限，171），最后一次验证之后、返回之前做收尾复盘，复盘做完才算这一步结束。复盘失败或撞上限都不改变
// 这一步的结果，经去重告警写标准错误输出，并记进结果
// 派 worker（决策 264–268、297–303）：开着时给主 agent 注册 spawn_worker 与等待等积木，装一个编排器（无人值守：worker 需请示时
// 不等，作为可恢复错误交回，303）；worker 用的 token 计入本次运行的 token 上限，撞了即停掉主 agent 与在跑的 worker、拒绝再派。
// 297：每次运行结束后，等本次派出的 worker 全部结束、把完成通知当新的一轮处理完，这一步才往下走（验证、回炉、收尾复盘）；
// 释放运行面之前停掉仍在跑的 worker（撞上限、外部中止时），等其收尾记录写进本会话。执行端另一侧的工作区（容器）与分支会话不注册。
// 任务清单（294 B1）：开着时给主 agent 注册两件清单工具
import path from "node:path";
import type { ScriptLauncher } from "../execution/script-sandbox.ts";
import { assertMemoryLimit } from "../memory/pushed.ts";
import type { MemoryRoot } from "../memory/resident.ts";
import { type ReviewVerdictInput, reviewVerdictText } from "../memory/review-text.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { FailureClass } from "../state/classification.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  type OrchestrationSettings,
} from "../state/orchestration-config.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import type { EvalVerdict, ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import { storeAttemptLabel, storeRunMetrics } from "../state/session-judge.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { StepStartMark, WorkspaceHost } from "../tools/workspace-host.ts";
import { type VerifyAttemptResult, verifyAttempt } from "./attempt-verify.ts";
import { attachCheckpoints } from "./checkpoints.ts";
import { compactionWarner } from "./compaction-text.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import { attachLoopGuard, type LoopStop } from "./loop-guard.ts";
import type { McpSession } from "./mcp.ts";
import {
  assertReviewBudget,
  DEFAULT_REVIEW_BUDGET,
  type ReviewBudget,
  type ReviewModelChoice,
  type ReviewObserver,
  type ReviewOutcome,
  reviewWarner,
  runMemoryReview,
} from "./memory-review.ts";
import { buildRepairFeedback, repairFailureSummary } from "./repair-loop.ts";
import type { LearnedMemoryConfig, RuntimeBundle } from "./runtime.ts";
import { createSessionScripts, modelPricing } from "./script-host.ts";
import { ScriptGate, scriptGateSettingsOf } from "./script-naming.ts";
import type { ScriptRuns } from "./script-runner.ts";
import { ScriptSlot } from "./script-tool.ts";
import { openSessionStore, storeFaultWarner } from "./session-store.ts";
import { bindSpawnWorkers, stopAllWorkers } from "./spawn-worker-host.ts";
import {
  type SpawnWorkerBudget,
  SpawnWorkerSlot,
  spawnWorkerSettingsOf,
} from "./spawn-worker-tool.ts";
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
  // 打转叫停（决策 307）：照常验证、不再回炉，成败算失败
  | "looping";

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
};

export interface HeadlessRunOptions {
  task: string;
  governanceRoot: string;
  workspaceRoot: string;
  // 决策 098：执行端；缺省为 workspaceRoot 上的本地实现（容器工作区由调用方注入，workspaceRoot 为宿主侧占位目录）
  workspaceHost?: WorkspaceHost;
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
  memoryRoots?: readonly MemoryRoot[];
  memoryBudgetChars?: number;
  homeDir?: string;
  persistThinking?: boolean;
  sessionId?: SessionId;
  // 决策 061：编辑模式，缺省 hashline
  editMode?: EditMode;
  // 决策 063：单轮输出上限（缺省 16,384）
  maxOutputTokens?: number;
  // M9：采样温度（缺省不设）；冻结进注入快照并随 Run 开始条目 落盘
  temperature?: number;
  // M9：任务源给的系统指令——追加进 system prompt 并随之冻结；任务说明（task）不受影响
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；关掉时两件会话检索工具不注册，系统提示不提它们
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（模型窗口、预留、保留量、触发点）；缺省为产品缺省，集成冒烟可调低触发点
  compaction?: CompactionConfigInput;
  // 决策 192、207：压缩前回调（压缩前复盘的挂点）；缺省不挂
  beforeCompaction?: BeforeCompaction;
  // 运行时告警的出口（自动压缩没压成、压缩前回调失败；缺省标准错误输出，同一类只说一次；测试注入）
  warn?: WarnSink;
  // 决策 191、193：推送记忆（开局把记忆整份推入系统提示、带 update_memory、压缩前与收尾复盘）；缺省关着
  pushedMemory?: boolean;
  // 学到的记忆的总量上限（字符，按码点计）；缺省 12,000
  memoryLimitChars?: number;
  // 复盘上限（每次复盘各自计；缺省 40 轮、15 分钟，243）
  reviewBudget?: ReviewBudget;
  // 复盘模型（决策 296）：日常入口按配置给，在场即压缩前与收尾复盘都用它；跑批器不给（复盘用这一步本身的模型）
  reviewModel?: ReviewModelChoice;
  // 每次复盘开始与结束时调用（跑批器据此在复盘前后读网关计量）
  onReview?: ReviewObserver;
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
  // 决策 305–308：打转检测设定——主 agent、worker 与复盘都挂；缺省不挂（pigeon run 按项目配置缺省打开，跑批器各条件明确关掉）
  loopGuard?: LoopGuardSettings;
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
  // M7（决策 071）：会话级验证命令——冻结进注入快照；尝试收尾后在工作区独立执行并落本会话的通用验证记录
  verify?: VerifyConfig;
  // M7（决策 079）：失败自动分叉重试次数——冻结进注入快照并随 Run 开始条目 落盘（重试本身由 headless.ts 叠加）
  retryOnFail?: number;
  // 决策 142 / 143：回炉轮数，缺省 0 即关闭；开启时冻结进注入快照并随 Run 开始条目 落盘。
  // 须配验证命令、不得与失败自动分叉重试同开；容器工作区须由执行端记下这一步的起点。
  // 本地工作区不要求是 git 工作区（决策 281）：是 git 工作区时照旧在开工时打快照，不是时照常回炉、只是不打快照
  repairRounds?: number;
  // 验证前还原的受保护文件（如人写的测试与测试辅助文件）：给了即在每次回炉验证（首轮与各轮）之前，
  // 经执行端把 agent 改动或删除过的受保护文件恢复成这一步开工时的版本，再验证。须执行端能按起点还原（容器）
  protectedFiles?: (path: string) => boolean;
  // 每次验证（首轮与各轮回炉）之前、还原受保护文件之前调用：调用方借此清掉 agent 留下的、会改变验证结果的东西
  // （后台进程、覆盖人写测试的 conftest 等）。先于还原，后台进程就来不及在还原之后再改受保护的文件
  beforeVerify?: () => Promise<void>;
  // M7（决策 077）：分叉续跑——分支会话头、由会话树还原的初始消息、不给新输入从已有消息续跑
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
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
  // M7（决策 071 / 072）：验证结论（配置了验证命令且运行面装起来时在场）与由会话现算的标签
  verification?: { verdict: EvalVerdict };
  label: OutcomeLabel;
  // 决策 142 / 143：回炉开启时在场——用了几轮、最后一次验证的结论、这一步是否收尾
  repair?: HeadlessRepairSummary;
  // 推送记忆开着时在场：这一步的各次复盘（压缩前的按发生先后，收尾的在最后）
  reviews?: ReviewOutcome[];
  // 打转叫停时在场（307）：计数与重复的调用（收尾说明用）
  looping?: LoopStop;
}

export interface HeadlessRepairSummary {
  // 用了几轮回炉（首个 Run 不算）
  rounds: number;
  // 这一步最后一次验证门的结论；没验证过（运行面没装起来、回炉途中出错）时缺省
  verdict?: EvalVerdict;
  // 这一步是否收尾：通过、无法判定、修满或预算耗尽仍失败为收尾；回炉途中出现异常或没有 Run 可验证为未收尾（续跑时整步重做）。
  // 修满或预算耗尽仍失败时这一步以失败收尾，工作区保留 agent 的改动、不做回退（决策 172 / 173），失败由验证记录体现
  closed: boolean;
  // 给了受保护文件时：有几次验证之前发现 agent 改过受保护文件并将其还原（每次验证至多计 1）
  protectedRestores?: number;
  // 这一步各次验证里标了工具故障（检查工具自身崩溃，重跑一次仍崩溃，决策 170 ③）的步数合计；没有即缺省
  toolFaults?: number;
}

// 回炉的启动前检查（决策 142 / 143）：设定不成立即启动报错，不装配运行面
function assertRepairSetup(options: HeadlessRunOptions): number {
  const rounds = options.repairRounds ?? 0;
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new Error(`回炉轮数需要非负整数：${rounds}`);
  }
  if (rounds === 0) {
    return 0;
  }
  if (options.verify === undefined) {
    throw new Error(
      `设了回炉轮数（${rounds}）却没有验证命令：回炉靠验证结论决定修不修，` +
        "请用 --verify-command 或项目验证配置（.pigeon/verify.json）给出验证命令"
    );
  }
  if ((options.retryOnFail ?? 0) > 0) {
    throw new Error(
      "回炉与失败自动分叉重试不能同时开启：回炉在同一会话里接着修，" +
        "失败重试从任务起点另开分支重做，两者对同一次失败各有一套处理，叠加后这一步的成败无法判定"
    );
  }
  // 这一步的起点：执行端另一侧的工作区（容器）要执行端能记下这一步起点（154②），供验证前还原受保护的文件。
  // 本地工作区不作要求（决策 281）：回炉循环本身不读快照，快照只为 /fork 回到回炉中间某一轮取准确基线而打，
  // 而 /fork 本就只在 git 工作区可用——是 git 工作区时照旧在开工时打快照，不是时照常回炉、不打快照、不报错
  const host = options.workspaceHost;
  if (host !== undefined && host.markStepStart === undefined) {
    throw new Error(
      "开启回炉却无法记下这一步的起点：这个执行端不提供记下起点的能力，验证前无从还原受保护的文件"
    );
  }
  if (options.protectedFiles !== undefined && host?.restoreProtectedFromStepStart === undefined) {
    throw new Error(
      "给了受保护文件却无法在验证前还原：这个执行端不提供按这一步起点还原文件的能力（目前只有容器执行端提供）"
    );
  }
  return rounds;
}

export async function runHeadlessOnce(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const repairRounds = assertRepairSetup(options);
  const pushed = options.pushedMemory === true;
  assertMemoryLimit(options.memoryLimitChars);
  const reviewBudget = options.reviewBudget ?? DEFAULT_REVIEW_BUDGET;
  assertReviewBudget(reviewBudget);
  // 护栏（112 的延伸）：注入了执行端时 workspaceRoot 在宿主一侧、不是 agent 干活的工作区。分叉（失败自动重试、分支会话）
  // 要在它上面打 git 快照、到独立工作树里续跑——对容器里的工作区只会得到假结果，装配前一律拒绝。
  // 会话验证命令与回炉的验证一样经执行端在容器里执行（日常沙箱，决策 237），不在此列
  if (options.workspaceHost !== undefined) {
    const unsupported = [
      (options.retryOnFail ?? 0) > 0 ? "失败自动分叉重试" : undefined,
      options.branchHeader !== undefined ? "分支会话" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    if (unsupported.length > 0) {
      throw new Error(
        `容器工作区暂不支持${unsupported.join("、")}：分叉要在宿主的 git 工作区上打快照、到独立工作树里续跑，` +
          "而容器工作区在执行端另一侧"
      );
    }
  }
  const sessionId = options.sessionId ?? newSessionId();
  const startedAt = Date.now();
  // 这一步的墙钟：压缩前复盘期间暂停（复盘不占这一步的宽上限，171），复盘结束后顺延
  let deadline = options.wallClockMs !== undefined ? startedAt + options.wallClockMs : undefined;
  let timer: NodeJS.Timeout | undefined;
  let pausedAt: number | undefined;
  let armClock = (): void => {};
  const pauseClock = (): void => {
    clearTimeout(timer);
    timer = undefined;
    pausedAt = Date.now();
  };
  const resumeClock = (): void => {
    if (pausedAt !== undefined && deadline !== undefined) {
      deadline += Date.now() - pausedAt;
    }
    pausedAt = undefined;
    armClock();
  };
  const reviews: ReviewOutcome[] = [];
  const warnReview = reviewWarner(options.warn);
  // 推送记忆（191）：无人值守——{冲突处理} 填无人值守版；压缩前复盘由运行面在压缩前回调里做
  const learnedMemory: LearnedMemoryConfig | undefined = pushed
    ? {
        conflict: "unattended",
        ...(options.memoryLimitChars !== undefined ? { limitChars: options.memoryLimitChars } : {}),
        ...(options.reviewModel !== undefined ? { reviewModel: options.reviewModel } : {}),
        review: {
          budget: reviewBudget,
          observer: {
            started: (kind) => {
              pauseClock();
              options.onReview?.started?.(kind);
            },
            ended: (outcome) => {
              reviews.push(outcome);
              options.onReview?.ended?.(outcome);
              resumeClock();
            },
          },
          ...(options.warn !== undefined ? { warn: options.warn } : {}),
          ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          ...(options.loopGuard !== undefined ? { loopGuard: options.loopGuard } : {}),
        },
      }
    : undefined;
  // 开局冻结的系统提示原文：收尾复盘沿用它
  let frozenSystemPrompt: string | undefined;
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
  // 本次运行与收尾复盘共用的装配参数（工具定义因此相同）
  const surface: Omit<DetachedRuntimeRequest, "sessionId"> = {
    governanceRoot: options.governanceRoot,
    workspaceRoot: options.workspaceRoot,
    ...(options.workspaceHost !== undefined ? { workspaceHost: options.workspaceHost } : {}),
    streamFn: options.streamFn,
    // 决策 067：三个入口的模型占位缺省统一为同一常量（真实模型元数据由 streamFn 插件提供）
    provider: options.provider ?? DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: options.modelId ?? DEFAULT_MODEL_PLACEHOLDER.modelId,
    yolo: options.yolo,
    ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.persistThinking !== undefined ? { persistThinking: options.persistThinking } : {}),
    ...(options.memoryBudgetChars !== undefined
      ? { memoryBudgetChars: options.memoryBudgetChars }
      : {}),
    ...(options.skillRoots !== undefined ? { skillRoots: options.skillRoots } : {}),
    ...(options.memoryRoots !== undefined ? { memoryRoots: options.memoryRoots } : {}),
    ...(options.editMode !== undefined ? { editMode: options.editMode } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.taskDirective !== undefined ? { taskDirective: options.taskDirective } : {}),
    ...(options.sessionSearch !== undefined ? { sessionSearch: options.sessionSearch } : {}),
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
    ...(learnedMemory !== undefined ? { learnedMemory } : {}),
    // 收尾复盘与本次运行同一份工具定义；复盘的执行闸不放行 spawn_worker
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
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
    ...(options.retryOnFail !== undefined ? { retryOnFail: options.retryOnFail } : {}),
    ...(repairRounds > 0 ? { repairRounds } : {}),
    // M8（决策 087）：本次运行的预算冻结进注入快照——回放据此沿用同一预算，不得放宽
    budget: {
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    },
    ...(options.branchHeader !== undefined ? { branchHeader: options.branchHeader } : {}),
    ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
    onBundle: (bundle) => {
      liveBundle = bundle;
      // 决策 305–307：打转检测挂在主 agent 上——提醒进下一轮；计到叫停轮数即以打转中止，照常验证、不再回炉
      const detachLoopGuard = attachLoopGuard(bundle.adapter, options.loopGuard, (found) => {
        if (limitHit === undefined) {
          looping = found;
        }
        stop("looping");
      });
      bundle.disposers = [...(bundle.disposers ?? []), async () => detachLoopGuard()];
      frozenSystemPrompt = bundle.adapter.snapshot().context.systemPrompt;
      // 决策 189：无头运行没人看压缩提示——自动压缩没压成与压缩前回调失败写标准错误输出，同一类只说一次
      bundle.adapter.subscribeCompaction(compactionWarner(options.warn));
      toolTiers = bundle.toolTiers;
      // M7（决策 078）：会分叉的会话（开了失败自动重试的尝试、分支会话）在 git 工作区里打快照；
      // 决策 142 / 281：开启回炉时在 git 工作区照旧打快照——首个快照的改前基线就是这一步的起点，
      // /fork 回到回炉中间某一轮据此取准确基线；非 git 工作区不挂快照（attachCheckpoints 返回 undefined）、照常回炉。
      // 执行端另一侧的工作区不在宿主上打快照：回炉的起点由执行端记下（见下）
      if (
        options.workspaceHost === undefined &&
        ((options.retryOnFail ?? 0) > 0 || options.branchHeader !== undefined || repairRounds > 0)
      ) {
        const checkpoints = attachCheckpoints({ bundle, workspaceRoot: options.workspaceRoot });
        if (checkpoints !== undefined) {
          bundle.disposers = [...(bundle.disposers ?? []), async () => checkpoints.stop()];
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
          hostStore: bundle.sessionStore,
          ...(options.verify !== undefined ? { verify: options.verify } : {}),
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
  armClock = () => {
    if (deadline !== undefined) {
      timer = setTimeout(() => stop("wall-clock-limit"), Math.max(0, deadline - Date.now()));
    }
  };
  armClock();
  let externallyAborted = false;
  const onAbort = () => {
    externallyAborted = true;
    handle.interrupt().catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted === true) onAbort();
  let status: HeadlessStatus = "unknown";
  let errorMessage: string | undefined;
  let verification: HeadlessRunResult["verification"];
  let repair: HeadlessRepairSummary | undefined;
  // 回炉进度：途中出现异常时据此给出未收尾的回炉结果
  let rounds = 0;
  let lastVerdict: EvalVerdict | undefined;
  // 执行端另一侧的工作区：这一步的起点在第一个 Run 之前由执行端记下
  let stepStart: StepStartMark | undefined;
  // 验证前发现 agent 改过受保护文件并还原的次数
  let protectedRestores = 0;
  // 各次验证里的工具故障步数合计
  let toolFaults = 0;
  // 最后一次验证（收尾复盘的验证结论按它填）
  let lastVerified: VerifyAttemptResult | undefined;
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
    if (repairRounds > 0 && options.workspaceHost?.markStepStart !== undefined) {
      stepStart = await options.workspaceHost.markStepStart();
    }
    // 开工前已被外部中止（记起点的空档里到达）：一轮都不跑
    let run = externallyAborted
      ? undefined
      : await settleWorkers(
          options.continueFromHistory === true && handle.continueRun !== undefined
            ? await handle.continueRun()
            : await handle.run(options.task)
        );
    if (run === undefined) status = "aborted";
    while (run !== undefined) {
      status =
        run.emptyReply === true
          ? "empty-reply"
          : run.status === "aborted" || drainInterrupted
            ? (limitHit ?? "aborted")
            : run.status;
      errorMessage = run.errorMessage;
      // 外部中止：这一步由调用方作废，不验证、不回炉
      if (externallyAborted) {
        status = "aborted";
        break;
      }
      if (repairRounds === 0 || options.verify === undefined) {
        break;
      }
      // 回炉：在同一会话里、释放之前验证（运行面没装起来、没有 Run 时不验证，这一步结束）
      // 没有 Run 可验证：这一步未收尾（会话里最后一个 Run 也没有验证记录）
      if (liveBundle === undefined || run.runId === undefined) {
        repair = { rounds, closed: false };
        break;
      }
      await options.beforeVerify?.();
      // 受保护文件（人写的测试等）在验证前恢复成开工时的版本：agent 对它们的改动不进验证
      if (options.protectedFiles !== undefined) {
        const host = options.workspaceHost;
        if (stepStart === undefined || host?.restoreProtectedFromStepStart === undefined) {
          throw new Error("没有记下这一步的起点，无法在验证前还原受保护的文件");
        }
        const restored = await host.restoreProtectedFromStepStart(
          stepStart,
          options.protectedFiles
        );
        if (restored.length > 0) {
          protectedRestores += 1;
        }
      }
      // 验证前的清理与还原受保护文件期间来了外部中止：不跑验证
      if (externallyAborted) {
        status = "aborted";
        break;
      }
      const verified = await verifyAttempt({
        config: options.verify,
        workspace: options.workspaceHost?.root ?? options.workspaceRoot,
        ...(options.workspaceHost !== undefined ? { host: options.workspaceHost } : {}),
        target: { sessionId, runId: run.runId },
        store: liveBundle.sessionStore,
        envelopeRunId: run.runId,
      });
      const { verdict } = verified.outcome;
      lastVerdict = verdict;
      lastVerified = verified;
      toolFaults += (verified.steps ?? []).filter((step) => step.toolFault === true).length;
      verification = { verdict };
      // 验证进行中来了外部中止：验证一结束即停，不回炉
      if (externallyAborted) {
        status = "aborted";
        break;
      }
      // 通过即结束；无法判定不回炉，按现有口径记为未知
      if (verdict !== "fail") {
        repair = { rounds, verdict, closed: true };
        break;
      }
      // 修满 N 轮或预算耗尽仍失败：这一步以失败收尾，工作区保留 agent 的改动（决策 172 / 173）。
      // 空回复异常结束（决策 170 ②）同样收尾、不再回炉：这一步的结论仍以刚做的这次验证为准
      if (rounds >= repairRounds || limitHit !== undefined || run.emptyReply === true) {
        repair = { rounds, verdict, closed: true };
        break;
      }
      rounds += 1;
      run = await settleWorkers(
        await handle.run(
          buildRepairFeedback({
            command: options.verify.command,
            outcome: verified.outcome,
            ...(verified.steps !== undefined ? { steps: verified.steps } : {}),
            round: rounds,
            maxRounds: repairRounds,
          })
        )
      );
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    // 回炉途中出现异常：仍给回炉结果，标明这一步未收尾，调用方不致误以为回炉关闭
    if (repairRounds > 0 && repair === undefined) {
      repair = {
        rounds,
        ...(lastVerdict !== undefined ? { verdict: lastVerdict } : {}),
        closed: false,
      };
    }
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
    await handle.dispose();
  }
  const sessionsDir = path.join(options.governanceRoot, ".pigeon", "sessions");
  const metricsBefore = readRunOutcome(sessionsDir, sessionId, toolTiers).metrics;
  // M7（决策 071）：尝试收尾后在工作区独立执行验证命令（运行面没装起来、没有 Run 时不跑）；
  // 回炉开启时验证已在释放之前做过，不再跑
  if (
    repairRounds === 0 &&
    options.verify !== undefined &&
    metricsBefore.runId !== undefined &&
    !externallyAborted
  ) {
    // 运行面已释放，按会话号重新打开会话文件补写这条验证记录
    const store = openSessionStore({
      sessionsDir,
      sessionId,
      cwd: options.workspaceRoot,
      onFault: storeFaultWarner(),
    });
    try {
      // 容器工作区经执行端在容器里验证
      const verified = await verifyAttempt({
        config: options.verify,
        workspace: options.workspaceHost?.root ?? options.workspaceRoot,
        ...(options.workspaceHost !== undefined ? { host: options.workspaceHost } : {}),
        target: { sessionId, runId: metricsBefore.runId },
        store,
        envelopeRunId: metricsBefore.runId,
      });
      verification = { verdict: verified.outcome.verdict };
      lastVerified = verified;
    } finally {
      await store.close();
    }
  }
  // 收尾复盘（192）：最后一次验证之后、返回之前；这一步有 Run、没被外部中止时才做。复盘做完才算这一步结束
  if (
    learnedMemory !== undefined &&
    frozenSystemPrompt !== undefined &&
    metricsBefore.runId !== undefined &&
    !externallyAborted
  ) {
    const systemPrompt = frozenSystemPrompt;
    options.onReview?.started?.("closing");
    const outcome = await runMemoryReview({
      kind: "closing",
      governanceRoot: options.governanceRoot,
      sourceSessionId: sessionId,
      verdict: reviewVerdictText(verdictInputOf(lastVerified, options.verify?.command ?? "")),
      budget: reviewBudget,
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      ...(options.loopGuard !== undefined ? { loopGuard: options.loopGuard } : {}),
      open: (review) =>
        createDetachedRuntime({
          ...surface,
          ...(options.reviewModel !== undefined
            ? { provider: options.reviewModel.provider, modelId: options.reviewModel.modelId }
            : {}),
          sessionId: review.sessionId,
          initialMessages: review.initialMessages,
          reviewSession: {
            kind: "closing",
            systemPrompt,
            sourceSessionId: sessionId,
            covers: review.covers,
          },
          learnedMemory: { ...learnedMemory, review: false },
          budget: { maxTurns: reviewBudget.maxTurns, wallClockMs: reviewBudget.wallClockMs },
        }),
    });
    reviews.push(outcome);
    warnReview(outcome);
    options.onReview?.ended?.(outcome);
  }
  const outcome = readRunOutcome(sessionsDir, sessionId, toolTiers);
  const metrics = outcome.metrics;
  // 未收尾时轮数按会话记录的推法取（Run 数减 1）：回炉那一轮若没开起来，不算用了一轮
  if (repair !== undefined && !repair.closed) {
    repair = { ...repair, rounds: Math.max(0, outcome.runCount - 1) };
  }
  if (repair !== undefined && options.protectedFiles !== undefined) {
    repair = { ...repair, protectedRestores };
  }
  if (repair !== undefined && toolFaults > 0) {
    repair = { ...repair, toolFaults };
  }
  return {
    sessionId,
    status,
    ...metrics,
    ...(verification !== undefined ? { verification } : {}),
    ...(repair !== undefined ? { repair } : {}),
    ...(pushed ? { reviews } : {}),
    label: outcome.label,
    ...(status === "looping" && looping !== undefined ? { looping } : {}),
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

// 收尾复盘的验证结论的输入：没验证过即"没有运行验证门"；验证过按最后一次的结论、工具故障的步与回炉反馈的同一份失败摘要
function verdictInputOf(
  verified: VerifyAttemptResult | undefined,
  command: string
): ReviewVerdictInput {
  if (verified === undefined) {
    return { ran: false };
  }
  const steps = verified.steps ?? [];
  const faulted = steps.filter((step) => step.toolFault === true);
  return {
    ran: true,
    verdict: verified.outcome.verdict,
    faultedSteps: faulted.map((step) => step.name),
    allFaulted: steps.length > 0 && faulted.length === steps.length,
    failureSummary: repairFailureSummary({
      command,
      outcome: verified.outcome,
      ...(verified.steps !== undefined ? { steps: verified.steps } : {}),
    }),
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
