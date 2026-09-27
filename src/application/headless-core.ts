// headless 单次运行核心（M6.5 S1，决策 056；M7 S6 拆出：分叉续跑直接复用本核心，失败自动分叉重试叠加在 headless.ts）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 账本、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝并落 decision（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从会话记录算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——写档与命令档里需要人来批的调用数：
// 以 yolo 批发授权放行（有人在场时会被问）、由人批准或拒绝、因无审批通道而拒绝的；固化规则与会话放权放行的不计。账本重构第二段（决策 180）起从新会话存储现算（state/session-judge.ts）；新存储里没有
// 这个会话（双写之前的旧会话、或新存储打不开）时，过渡期回退旧账本读法（summarizeRunMetrics）。
// 回炉（决策 142 / 143 / 147）：开启时一次 Run 结束后，在同一会话里、释放运行面之前跑验证命令——通过即结束；
// 失败即把失败反馈作为新一轮输入开一个新 Run 接着修，最多 N 轮；无法判定不回炉、记为未知。修满 N 轮或预算耗尽仍失败，
// 这一步以失败收尾，工作区保留 agent 的改动、不做回退（决策 172 / 173）。各轮与首次共用同一个总预算（轮次、墙钟与 token；
// 验证命令的耗时也算在墙钟里）。一步的成败以最后一次验证为准，由 run.started 里冻结的回炉轮数与最后一次验证记录推出
// （state/repair-step.ts），账本不新增记录。
import path from "node:path";
import type { MemoryRoot } from "../memory/resident.ts";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { FailureClass } from "../state/classification.ts";
import type { BranchHeaderInput } from "../state/event-log.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { attemptOutcomeFacts, labelAttempt, type OutcomeLabel } from "../state/outcome-label.ts";
import { lastStepRunOf, stepRunsOf } from "../state/repair-step.ts";
import type { EvalVerdict, ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import { storeAttemptLabel, storeRunMetrics } from "../state/session-judge.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { StepStartMark, WorkspaceHost } from "../tools/workspace-host.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { attachCheckpoints } from "./checkpoints.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { buildRepairFeedback } from "./repair-loop.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { openSessionStore, storeFaultWarner } from "./session-store.ts";
import { createDetachedRuntime } from "./workers.ts";

export type HeadlessStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "unknown"
  | "turn-limit"
  | "wall-clock-limit"
  | "token-limit"
  // 空回复异常结束（决策 170 ②）：模型的回复既无文字也无工具调用，重试一次仍是如此。不算模型服务故障
  | "empty-reply";

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
  // M9：采样温度（缺省不设）；冻结进注入快照并随 run.started 落盘
  temperature?: number;
  // M9：任务源给的系统指令——追加进 system prompt 并随之冻结；任务说明（task）不受影响
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；关掉时两件会话检索工具不注册，系统提示不提它们
  sessionSearch?: boolean;
  // 决策 191、193：推送记忆（开局把记忆整份推入系统提示）。尚未实现：打开即在装配前报错
  pushedMemory?: boolean;
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
  // M7（决策 071）：会话级验证命令——冻结进注入快照；尝试收尾后在工作区独立执行并落本会话的通用验证记录
  verify?: VerifyConfig;
  // M7（决策 079）：失败自动分叉重试次数——冻结进注入快照并随 run.started 落盘（重试本身由 headless.ts 叠加）
  retryOnFail?: number;
  // 决策 142 / 143：回炉轮数，缺省 0 即关闭；开启时冻结进注入快照并随 run.started 落盘。
  // 须配验证命令、不得与失败自动分叉重试同开、须能记下这一步的起点：本地 git 工作区按快照，容器工作区经执行端
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
  // M7（决策 071 / 072）：验证结论（配置了验证命令且运行面装起来时在场）与由账本现算的标签
  verification?: { verdict: EvalVerdict; recorded: boolean };
  label: OutcomeLabel;
  // 决策 142 / 143：回炉开启时在场——用了几轮、最后一次验证的结论、这一步是否收尾
  repair?: HeadlessRepairSummary;
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
  // 这一步的起点：本地 git 工作区由快照的改前基线给出；执行端另一侧的工作区（容器）要执行端能记下这一步起点（154②）。
  // 容器一侧供验证前还原受保护的文件。本地一条：结构化记忆删除后已无读者依赖本地回炉的快照（见 2026-09-27 删除与清理审计第七节），是否放宽另行裁决
  const host = options.workspaceHost;
  if (host !== undefined) {
    if (host.markStepStart === undefined) {
      throw new Error(
        "开启回炉却无法记下这一步的起点：这个执行端不提供记下起点的能力，验证前无从还原受保护的文件"
      );
    }
  } else if (!isGitWorkspace(options.workspaceRoot)) {
    throw new Error(
      "开启回炉却没有可用快照：回炉要按快照记下这一步的起点与改动，目前只支持本地 git 工作区"
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
  if (options.pushedMemory === true) {
    throw new Error("推送记忆尚未实现：打开推送记忆的条件暂时不能运行");
  }
  const repairRounds = assertRepairSetup(options);
  // 护栏（112 的延伸）：注入了执行端时 workspaceRoot 只是宿主侧占位目录。分叉（失败自动重试、分支会话）要在它上面
  // 打 git 快照，会话验证命令要在它里面执行——在占位目录上做只会得到假结果，装配前一律拒绝。
  // 回炉例外：它的验证经执行端（见 assertRepairSetup）
  if (options.workspaceHost !== undefined) {
    const unsupported = [
      (options.retryOnFail ?? 0) > 0 ? "失败自动分叉重试" : undefined,
      options.verify !== undefined && repairRounds === 0 ? "会话验证命令" : undefined,
      options.branchHeader !== undefined ? "分支会话" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    if (unsupported.length > 0) {
      throw new Error(
        `容器工作区暂不支持${unsupported.join("、")}：它们作用在宿主侧的工作区目录上，` +
          "而容器执行端下那只是占位目录；目前只支持单次无人值守运行、由任务源判分"
      );
    }
  }
  const sessionId = options.sessionId ?? newSessionId();
  const startedAt = Date.now();
  // 运行面装起来后拿到的装配结果：回炉在释放之前经它的会话文件落验证记录
  let liveBundle: RuntimeBundle | undefined;
  // 已注册工具的风险档位（需审批次数按它现算；运行面没装起来时为空）
  let toolTiers: ReadonlyMap<string, string> = new Map();
  const handle = createDetachedRuntime({
    sessionId,
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
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
    ...(options.retryOnFail !== undefined ? { retryOnFail: options.retryOnFail } : {}),
    ...(repairRounds > 0 ? { repairRounds } : {}),
    // 容器工作区的起点记进每个 Run 的 run.started（留作记录）；本地工作区由快照给出
    ...(repairRounds > 0 && options.workspaceHost?.markStepStart !== undefined
      ? {
          stepStart: () =>
            stepStart === undefined
              ? undefined
              : {
                  commit: stepStart.commit,
                  ...(stepStart.baseCommit !== undefined
                    ? { baseCommit: stepStart.baseCommit }
                    : {}),
                },
        }
      : {}),
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
      toolTiers = bundle.toolTiers;
      // M7（决策 078）：会分叉的会话（开了失败自动重试的尝试、分支会话）在 git 工作区里打快照；
      // 决策 142：开启回炉时强制打快照——首个快照的改前基线就是这一步的起点
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
      options.onBundle?.(bundle);
    },
  });
  let limitHit: "turn-limit" | "wall-clock-limit" | "token-limit" | undefined;
  const stop = (reason: NonNullable<typeof limitHit>): void => {
    if (limitHit !== undefined) {
      return;
    }
    limitHit = reason;
    // 只发中止请求；撞上限记录等运行确以中止收尾后再写（072 修订）。原因随中止请求交给运行面（新存储的 Run 收尾据此写全）。
    // 中止失败不改变结果：run 以当时的终态收尾
    handle.interrupt(reason).catch(() => {});
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
  const timer =
    options.wallClockMs !== undefined
      ? setTimeout(() => stop("wall-clock-limit"), options.wallClockMs)
      : undefined;
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
  try {
    if (repairRounds > 0 && options.workspaceHost?.markStepStart !== undefined) {
      stepStart = await options.workspaceHost.markStepStart();
    }
    // 开工前已被外部中止（记起点的空档里到达）：一轮都不跑
    let run = externallyAborted
      ? undefined
      : options.continueFromHistory === true && handle.continueRun !== undefined
        ? await handle.continueRun()
        : await handle.run(options.task);
    if (run === undefined) status = "aborted";
    while (run !== undefined) {
      status =
        run.emptyReply === true
          ? "empty-reply"
          : run.status === "aborted"
            ? (limitHit ?? "aborted")
            : run.status;
      errorMessage = run.errorMessage;
      // 外部中止：这一步由调用方作废，不验证、不回炉
      if (externallyAborted) {
        status = "aborted";
        break;
      }
      // M7（决策 072）：撞上限写进本会话账本，标签据此判失败；072 修订：只在运行确以中止收尾时写——
      // 中止请求到达前模型已自然收尾（恰好用满最后一轮）的运行终态是完成，不写
      if (run.status === "aborted" && limitHit !== undefined) {
        handle.recordLimitHit?.(limitHit, run.runId);
      }
      if (repairRounds === 0 || options.verify === undefined) {
        break;
      }
      // 回炉：在同一会话里、释放之前验证（运行面没装起来、没有 Run 时不验证，这一步结束）
      // 没有 Run 可验证：这一步未收尾（账本里最后一个 Run 也没有验证记录）
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
        sink: liveBundle.eventLog,
        store: liveBundle.sessionStore,
        envelopeRunId: run.runId,
      });
      const { verdict } = verified.outcome;
      lastVerdict = verdict;
      toolFaults += (verified.steps ?? []).filter((step) => step.toolFault === true).length;
      verification = { verdict, recorded: verified.record !== undefined };
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
      run = await handle.run(
        buildRepairFeedback({
          command: options.verify.command,
          outcome: verified.outcome,
          ...(verified.steps !== undefined ? { steps: verified.steps } : {}),
          round: rounds,
          maxRounds: repairRounds,
        })
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
    unsubscribe();
    options.abortSignal?.removeEventListener("abort", onAbort);
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
    const log = new JsonlEventLog(sessionsDir, sessionId);
    // 决策 206：运行面已释放，按会话号重新打开新存储的会话文件补写这条验证记录
    const store = openSessionStore({
      sessionsDir,
      sessionId,
      cwd: options.workspaceRoot,
      onFault: storeFaultWarner(),
    });
    try {
      const verified = await verifyAttempt({
        config: options.verify,
        workspace: options.workspaceRoot,
        target: { sessionId, runId: metricsBefore.runId },
        sink: log,
        store,
        envelopeRunId: metricsBefore.runId,
      });
      verification = { verdict: verified.outcome.verdict, recorded: verified.record !== undefined };
    } finally {
      try {
        log.close();
      } finally {
        await store.close();
      }
    }
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
    label: outcome.label,
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

// 一次运行的指标、标签与 Run 数：新存储优先，没有这个会话的文件时回退旧账本
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
  const session = materializeSession(sessionsDir, sessionId, { content: false });
  const metrics = summarizeRunMetrics(session);
  return {
    metrics,
    label:
      metrics.runId !== undefined
        ? labelAttempt(attemptOutcomeFacts(session, metrics.runId))
        : "Unknown",
    runCount: session.runStarteds.length,
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

// 单次运行会话的指标（旧账本读法，过渡期回退与双写对照用；停写旧账本时删除）：取首个 Run；回炉开启时按整步（同一会话里的全部 Run）汇总，
// runId 仍是首个 Run（一步的身份）
export function summarizeRunMetrics(session: MaterializedSession): HeadlessRunMetrics {
  const runId = session.runStarteds[0]?.runId ?? session.runtimeEvents[0]?.runId;
  if (runId === undefined) {
    return {
      failure: { category: "unknown" },
      turns: 0,
      toolCalls: 0,
      approvalsNeeded: 0,
      usage: structuredClone(ZERO_USAGE),
    };
  }
  const stepRuns = new Set(stepRunsOf(session, runId));
  const usage = structuredClone(ZERO_USAGE);
  let turns = 0;
  let toolCalls = 0;
  for (const record of session.runtimeEvents) {
    if (!stepRuns.has(record.runId)) {
      continue;
    }
    if (record.kind === "turn.completed") {
      turns += 1;
      const turnUsage = record.payload.usage;
      if (turnUsage !== undefined) {
        usage.input += turnUsage.input;
        usage.output += turnUsage.output;
        usage.cacheRead += turnUsage.cacheRead;
        usage.cacheWrite += turnUsage.cacheWrite;
        usage.totalTokens += turnUsage.totalTokens;
        usage.cost.input += turnUsage.cost.input;
        usage.cost.output += turnUsage.cost.output;
        usage.cost.cacheRead += turnUsage.cost.cacheRead;
        usage.cost.cacheWrite += turnUsage.cost.cacheWrite;
        usage.cost.total += turnUsage.cost.total;
      }
    } else if (record.kind === "tool.proposed") {
      toolCalls += 1;
    }
  }
  // 需审批次数：回执只落在 write / exec 档，yolo 批发授权的那部分就是有人在场时会被问的次数
  const approvalsNeeded = session.records.filter(
    (record) =>
      record.kind === "receipt" &&
      record.runId !== undefined &&
      stepRuns.has(record.runId) &&
      record.receipt.approvedBy === "policy:yolo"
  ).length;
  // 分类 null = 正常收尾；只有物化结果里找不到这个 Run 时才落"未知"。回炉时取整步最后一个 Run 的分类：
  // 这一步怎么收尾看最后一轮，中间轮次不决定
  const lastRun = lastStepRunOf(session, runId);
  const classified = session.classification.runs.find((entry) => entry.runId === lastRun);
  return {
    runId,
    failure: classified !== undefined ? classified.failure : { category: "unknown" },
    turns,
    toolCalls,
    approvalsNeeded,
    usage,
  };
}
