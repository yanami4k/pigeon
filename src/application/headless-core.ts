// headless 单次运行核心（M6.5 S1，决策 056；M7 S6 拆出：分叉续跑直接复用本核心，失败自动分叉重试叠加在 headless.ts）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 账本、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝并落 decision（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从 Event Log 算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——从回执反推：
// write 与 exec 档且 approvedBy 为 policy:yolo 的调用数（只有 write / exec 档落 receipt，read 档不计），
// 即"有人在场时会被问几次"。
// 回炉（决策 142 / 143 / 147）：开启时一次 Run 结束后，在同一会话里、释放运行面之前跑验证命令——通过即结束；
// 失败即把失败反馈作为新一轮输入开一个新 Run 接着修，最多 N 轮；无法判定不回炉、记为未知。修满 N 轮或预算耗尽仍失败，
// 按快照把工作区恢复到这一步第一个 Run 之前的状态，这一步记为失败。各轮与首次共用同一个总预算（轮次、墙钟与 token；
// 验证命令的耗时也算在墙钟里）。一步的成败以最后一次验证为准；账本不新增记录，撤回由 run.started 里冻结的回炉轮数
// 与最后一次验证记录推出（state/repair-step.ts）。
import path from "node:path";
import type { MemoryRoot } from "../memory/resident.ts";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
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
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { attachCheckpoints, type CheckpointAttachment } from "./checkpoints.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { buildRepairFeedback, type RepairAppendix, restoreStepStart } from "./repair-loop.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { dedupedWarner, failureDetail } from "./warnings.ts";
import { createDetachedRuntime } from "./workers.ts";

export type HeadlessStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "unknown"
  | "turn-limit"
  | "wall-clock-limit"
  | "token-limit";

// 退出码按终态映射；1 留给参数与装配错误（cli 入口的异常出口）
export const HEADLESS_EXIT_CODES: Readonly<Record<HeadlessStatus, number>> = {
  completed: 0,
  failed: 2,
  aborted: 3,
  unknown: 4,
  "turn-limit": 5,
  "wall-clock-limit": 6,
  "token-limit": 7,
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
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
  // M7（决策 071）：会话级验证命令——冻结进注入快照；尝试收尾后在工作区独立执行并落本会话的通用验证记录
  verify?: VerifyConfig;
  // M7（决策 079）：失败自动分叉重试次数——冻结进注入快照并随 run.started 落盘（重试本身由 headless.ts 叠加）
  retryOnFail?: number;
  // 决策 142 / 143：回炉轮数，缺省 0 即关闭；开启时冻结进注入快照并随 run.started 落盘。
  // 须配验证命令、不得与失败自动分叉重试同开、须在本地 git 工作区（要按快照撤回）
  repairRounds?: number;
  // 回炉反馈的附加内容注入点（缺省为空；结构化记忆将来从这里附加）
  repairAppendix?: RepairAppendix;
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
  // 决策 142 / 143：回炉开启时在场——用了几轮、最后一次验证的结论、是否撤回、撤回是否因预算耗尽而提前
  repair?: HeadlessRepairSummary;
}

export interface HeadlessRepairSummary {
  // 用了几轮回炉（首个 Run 不算）
  rounds: number;
  // 这一步最后一次验证门的结论；没验证过（运行面没装起来、回炉途中出错）时缺省
  verdict?: EvalVerdict;
  // 这一步是否收尾：通过、无法判定、撤回为收尾；回炉途中出现异常或没有 Run 可验证为未收尾（续跑时整步重做）
  closed: boolean;
  reverted: boolean;
  // 撤回是否因预算先于轮数用尽而提前；轮数与预算同时用满记为轮数用满
  budgetExhausted: boolean;
  // 撤回时工作区是否真的恢复了；一次文件都没改过（没有快照起点）时为 false 且不带 restoreError
  restored: boolean;
  // 恢复没做成的原因：恢复抛错，或快照出过故障而没有撤回起点
  restoreError?: string;
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
      `设了回炉轮数（${rounds}）却没有验证命令：回炉靠验证结论决定修不修、撤不撤，` +
        "请用 --verify-command 或项目验证配置（.pigeon/verify.json）给出验证命令"
    );
  }
  if ((options.retryOnFail ?? 0) > 0) {
    throw new Error(
      "回炉与失败自动分叉重试不能同时开启：回炉在同一会话里接着修、到上限撤回，" +
        "失败重试从任务起点另开分支重做，两者对同一次失败各有一套处理，叠加后这一步的成败与撤回无法判定"
    );
  }
  if (options.workspaceHost !== undefined || !isGitWorkspace(options.workspaceRoot)) {
    throw new Error(
      "开启回炉却没有可用快照：回炉修不好时要按快照把工作区恢复到这一步起点，" +
        "目前只支持本地 git 工作区（容器执行端的恢复能力尚未提供）"
    );
  }
  return rounds;
}

export async function runHeadlessOnce(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const repairRounds = assertRepairSetup(options);
  // 护栏（112 的延伸）：注入了执行端时 workspaceRoot 只是宿主侧占位目录。分叉（失败自动重试、分支会话）要在它上面
  // 打 git 快照，会话验证命令要在它里面执行——在占位目录上做只会得到假结果，装配前一律拒绝
  if (options.workspaceHost !== undefined) {
    const unsupported = [
      (options.retryOnFail ?? 0) > 0 ? "失败自动分叉重试" : undefined,
      options.verify !== undefined ? "会话验证命令" : undefined,
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
  // 快照挂载：撤回时据它的内部错误清单区分"一次文件都没改过"与"快照出过故障、没有起点"
  let attachment: CheckpointAttachment | undefined;
  // 回炉的运行时诊断（注入点出错、撤回没做成）：标准错误、按类别去重，不进账本
  const warn = dedupedWarner();
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
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
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
      // M7（决策 078）：会分叉的会话（开了失败自动重试的尝试、分支会话）在 git 工作区里打快照；
      // 决策 142：开启回炉时强制打快照——首个快照的改前基线就是撤回的起点
      if (
        (options.retryOnFail ?? 0) > 0 ||
        options.branchHeader !== undefined ||
        repairRounds > 0
      ) {
        const checkpoints = attachCheckpoints({ bundle, workspaceRoot: options.workspaceRoot });
        if (checkpoints !== undefined) {
          attachment = checkpoints;
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
    // 只发中止请求；撞上限记录等运行确以中止收尾后再写（072 修订）。
    // 中止失败不改变结果：run 以当时的终态收尾
    handle.interrupt().catch(() => {});
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
  let status: HeadlessStatus;
  let errorMessage: string | undefined;
  let verification: HeadlessRunResult["verification"];
  let repair: HeadlessRepairSummary | undefined;
  // 回炉进度：途中出现异常时据此给出未收尾的回炉结果
  let rounds = 0;
  let lastVerdict: EvalVerdict | undefined;
  // 撤回：恢复到这一步起点，并如实给出恢复是否做成
  const restoreForRevert = (): Pick<HeadlessRepairSummary, "restored" | "restoreError"> => {
    try {
      const done = restoreStepStart({
        governanceRoot: options.governanceRoot,
        workspaceRoot: options.workspaceRoot,
        sessionId,
      });
      if (done.restored) {
        return { restored: true };
      }
      // 没有起点：快照没出过故障即这一步一次文件都没改过，无需恢复；出过故障即起点丢了，工作区未恢复
      const snapshotError = attachment?.errors()[0];
      if (snapshotError === undefined) {
        return { restored: false };
      }
      const restoreError = `快照出过故障，没有撤回起点，工作区未恢复：${failureDetail(snapshotError)}`;
      warn(
        new Error("回炉撤回没有起点"),
        `回炉告警：${restoreError}（这一步记为已撤回，但工作区仍是最后一轮修改后的样子）`
      );
      return { restored: false, restoreError };
    } catch (error) {
      // 账本已能推出撤回；恢复可重复执行，续跑时再执行一次即可
      const restoreError = `撤回时恢复工作区失败（可重复执行恢复）：${failureDetail(error)}`;
      warn(error, `回炉告警：${restoreError}`);
      return { restored: false, restoreError };
    }
  };
  try {
    let run =
      options.continueFromHistory === true && handle.continueRun !== undefined
        ? await handle.continueRun()
        : await handle.run(options.task);
    for (;;) {
      status = run.status === "aborted" ? (limitHit ?? "aborted") : run.status;
      errorMessage = run.errorMessage;
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
        repair = {
          rounds,
          closed: false,
          reverted: false,
          budgetExhausted: false,
          restored: false,
        };
        break;
      }
      const verified = await verifyAttempt({
        config: options.verify,
        workspace: options.workspaceRoot,
        target: { sessionId, runId: run.runId },
        sink: liveBundle.eventLog,
        envelopeRunId: run.runId,
      });
      const { verdict } = verified.outcome;
      lastVerdict = verdict;
      verification = { verdict, recorded: verified.record !== undefined };
      // 通过即结束；无法判定不回炉，按现有口径记为未知
      if (verdict !== "fail") {
        repair = {
          rounds,
          verdict,
          closed: true,
          reverted: false,
          budgetExhausted: false,
          restored: false,
        };
        break;
      }
      // 修满 N 轮或预算耗尽仍失败：恢复到这一步第一个 Run 之前的状态，这一步记为失败。
      // 预算只在先于轮数用尽时算提前撤回；轮数与预算同时用满记为轮数用满
      if (rounds >= repairRounds || limitHit !== undefined) {
        const restore = restoreForRevert();
        repair = {
          rounds,
          verdict,
          closed: true,
          reverted: true,
          budgetExhausted: limitHit !== undefined && rounds < repairRounds,
          ...restore,
        };
        if (restore.restoreError !== undefined) {
          errorMessage = restore.restoreError;
        }
        break;
      }
      rounds += 1;
      // 注入点出错不拖垮这一步：告警后以空附加内容照常回炉（不进账本）
      let appendix: string | undefined;
      try {
        appendix = options.repairAppendix?.({
          round: rounds,
          maxRounds: repairRounds,
          outcome: verified.outcome,
        });
      } catch (error) {
        warn(
          error,
          `回炉反馈附加内容告警：注入点出错：${failureDetail(error)}（本轮反馈不带附加内容，回炉照常进行）`
        );
      }
      run = await handle.run(
        buildRepairFeedback({
          command: options.verify.command,
          outcome: verified.outcome,
          round: rounds,
          maxRounds: repairRounds,
          ...(appendix !== undefined ? { appendix } : {}),
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
        reverted: false,
        budgetExhausted: false,
        restored: false,
      };
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await handle.dispose();
  }
  const sessionsDir = path.join(options.governanceRoot, ".pigeon", "sessions");
  const metricsBefore = summarizeRunMetrics(
    materializeSession(sessionsDir, sessionId, { content: false })
  );
  // M7（决策 071）：尝试收尾后在工作区独立执行验证命令（运行面没装起来、没有 Run 时不跑）；
  // 回炉开启时验证已在释放之前做过，不再跑
  if (repairRounds === 0 && options.verify !== undefined && metricsBefore.runId !== undefined) {
    const log = new JsonlEventLog(sessionsDir, sessionId);
    try {
      const verified = await verifyAttempt({
        config: options.verify,
        workspace: options.workspaceRoot,
        target: { sessionId, runId: metricsBefore.runId },
        sink: log,
        envelopeRunId: metricsBefore.runId,
      });
      verification = { verdict: verified.outcome.verdict, recorded: verified.record !== undefined };
    } finally {
      log.close();
    }
  }
  const session = materializeSession(sessionsDir, sessionId, { content: false });
  const metrics = summarizeRunMetrics(session);
  return {
    sessionId,
    status,
    ...metrics,
    ...(verification !== undefined ? { verification } : {}),
    ...(repair !== undefined ? { repair } : {}),
    label:
      metrics.runId !== undefined
        ? labelAttempt(attemptOutcomeFacts(session, metrics.runId))
        : "Unknown",
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
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

// 单次运行会话的指标（冷侧，只读 Event Log）：取首个 Run；回炉开启时按整步（同一会话里的全部 Run）汇总，
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
