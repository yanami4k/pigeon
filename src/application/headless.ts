// headless 运行入口（M6.5 S1，决策 056）：进程内 API。与 worker 同一装配内核（workers.ts openRuntimeSurface），
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 账本、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝并落 decision（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从 Event Log 算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——从回执反推：
// write 与 exec 档且 approvedBy 为 policy:yolo 的调用数（只有 write / exec 档落 receipt，read 档不计），
// 即"有人在场时会被问几次"。
import path from "node:path";
import type { MemoryRoot } from "../memory/resident.ts";
import { materializeSession } from "../persistence/event-log.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { FailureClass } from "../state/classification.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import type { ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { McpSession } from "./mcp.ts";
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
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
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
}

export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const sessionId = options.sessionId ?? newSessionId();
  const startedAt = Date.now();
  const handle = createDetachedRuntime({
    sessionId,
    governanceRoot: options.governanceRoot,
    workspaceRoot: options.workspaceRoot,
    streamFn: options.streamFn,
    provider: options.provider ?? "custom",
    modelId: options.modelId ?? "headless",
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
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
  });
  let limitHit: "turn-limit" | "wall-clock-limit" | "token-limit" | undefined;
  const stop = (reason: NonNullable<typeof limitHit>): void => {
    if (limitHit !== undefined) {
      return;
    }
    limitHit = reason;
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
    const run = await handle.run(options.task);
    status = run.status === "aborted" ? (limitHit ?? "aborted") : run.status;
    errorMessage = run.errorMessage;
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await handle.dispose();
  }
  const session = materializeSession(
    path.join(options.governanceRoot, ".pigeon", "sessions"),
    sessionId,
    { content: false }
  );
  return {
    sessionId,
    status,
    ...summarizeRunMetrics(session),
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
