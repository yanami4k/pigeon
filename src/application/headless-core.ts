// headless 单次运行核心（M6.5 S1，决策 056；M7 S6 拆出：分叉续跑直接复用本核心，失败自动分叉重试叠加在 headless.ts）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 账本、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝并落 decision（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从 Event Log 算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——从回执反推：
// write 与 exec 档且 approvedBy 为 policy:yolo 的调用数（只有 write / exec 档落 receipt，read 档不计），
// 即"有人在场时会被问几次"。
import path from "node:path";
import type { MemoryRoot } from "../memory/resident.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { FailureClass } from "../state/classification.ts";
import type { BranchHeaderInput } from "../state/event-log.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { attemptOutcomeFacts, labelAttempt, type OutcomeLabel } from "../state/outcome-label.ts";
import type { EvalVerdict, ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { attachCheckpoints } from "./checkpoints.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import type { RuntimeBundle } from "./runtime.ts";
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
}

export async function runHeadlessOnce(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
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
    // M8（决策 087）：本次运行的预算冻结进注入快照——回放据此沿用同一预算，不得放宽
    budget: {
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    },
    ...(options.branchHeader !== undefined ? { branchHeader: options.branchHeader } : {}),
    ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
    onBundle: (bundle) => {
      // M7（决策 078）：会分叉的会话（开了失败自动重试的尝试、分支会话）在 git 工作区里打快照
      if ((options.retryOnFail ?? 0) > 0 || options.branchHeader !== undefined) {
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
  try {
    const run =
      options.continueFromHistory === true && handle.continueRun !== undefined
        ? await handle.continueRun()
        : await handle.run(options.task);
    status = run.status === "aborted" ? (limitHit ?? "aborted") : run.status;
    errorMessage = run.errorMessage;
    // M7（决策 072）：撞上限写进本会话账本，标签据此判失败；072 修订：只在运行确以中止收尾时写——
    // 中止请求到达前模型已自然收尾（恰好用满最后一轮）的运行终态是完成，不写
    if (run.status === "aborted" && limitHit !== undefined) {
      handle.recordLimitHit?.(limitHit, run.runId);
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await handle.dispose();
  }
  const sessionsDir = path.join(options.governanceRoot, ".pigeon", "sessions");
  const metricsBefore = summarizeRunMetrics(
    materializeSession(sessionsDir, sessionId, { content: false })
  );
  // M7（决策 071）：尝试收尾后在工作区独立执行验证命令（运行面没装起来、没有 Run 时不跑）
  let verification: HeadlessRunResult["verification"];
  if (options.verify !== undefined && metricsBefore.runId !== undefined) {
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

// 单 Run 会话的指标（冷侧，只读 Event Log）：取首个 Run
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
  const usage = structuredClone(ZERO_USAGE);
  let turns = 0;
  let toolCalls = 0;
  for (const record of session.runtimeEvents) {
    if (record.runId !== runId) {
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
      record.runId === runId &&
      record.receipt.approvedBy === "policy:yolo"
  ).length;
  // 分类 null = 正常收尾；只有物化结果里找不到这个 Run 时才落"未知"
  const classified = session.classification.runs.find((entry) => entry.runId === runId);
  return {
    runId,
    failure: classified !== undefined ? classified.failure : { category: "unknown" },
    turns,
    toolCalls,
    approvalsNeeded,
    usage,
  };
}
