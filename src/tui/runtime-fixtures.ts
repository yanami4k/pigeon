// 终端界面用例的假运行面（决策 286 的新用例共用）：记录提交、手动发事件/增量/工具结果/压缩提示，
// run 可挂起（制造运行中窗口），上下文用量可由用例设定。仅供 *.test.ts 引用。
import type {
  CompactionNotice,
  RunResult,
  StreamTextDelta,
  ToolResultNotice,
} from "../pi-runtime/adapter.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, type RunId, type SessionId } from "../state/ids.ts";
import type { RuntimeEventKind } from "../state/runtime-events.ts";
import type { TuiRuntimeFace } from "./shell.ts";

export class ScriptedRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];
  readonly runId: RunId = newRunId();
  autoResolve = true;
  interrupts = 0;
  context: { tokens: number; contextWindow: number } | undefined;
  private readonly sessionId: SessionId;
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly streamListeners = new Set<(delta: StreamTextDelta) => void>();
  private readonly toolListeners = new Set<(notice: ToolResultNotice) => void>();
  private readonly compactionListeners = new Set<(notice: CompactionNotice) => void>();
  private readonly pending: Array<() => void> = [];

  constructor(sessionId: SessionId) {
    this.sessionId = sessionId;
  }

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    const result: RunResult = {
      runId: this.runId,
      status: "completed",
      stopReason: "stop",
      syntheticFailure: false,
      failure: null,
      advertisedTools: [],
      toolExecutions: [],
    };
    if (this.autoResolve) return Promise.resolve(result);
    return new Promise((resolve) => this.pending.push(() => resolve(result)));
  }

  finishAll(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  interrupt(): Promise<void> {
    this.interrupts += 1;
    return Promise.resolve();
  }

  listenerErrors(): unknown[] {
    return [];
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  subscribeToolResults(listener: (notice: ToolResultNotice) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  subscribeCompaction(listener: (notice: CompactionNotice) => void): () => void {
    this.compactionListeners.add(listener);
    return () => this.compactionListeners.delete(listener);
  }

  contextUsage(): { tokens: number; contextWindow: number } | undefined {
    return this.context;
  }

  emit(kind: RuntimeEventKind, payload: unknown, timestamp = 1700000000000): void {
    const envelope: EventEnvelope = {
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      runId: this.runId,
      timestamp,
      kind,
      payload,
    };
    for (const listener of this.listeners) listener(envelope);
  }

  toolResult(notice: Omit<ToolResultNotice, "runId"> & { runId?: RunId }): void {
    const full: ToolResultNotice = { runId: this.runId, ...notice };
    for (const listener of this.toolListeners) listener(full);
  }

  compacted(tokensBefore: number, tokensAfter: number): void {
    const notice: CompactionNotice = {
      kind: "compacted",
      trigger: "manual",
      tokensBefore,
      tokensAfter,
      messages: [],
    };
    for (const listener of this.compactionListeners) listener(notice);
  }
}

// 用量（turn.completed 载荷里的形状）
export function usageOf(totalTokens: number, cost: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}
