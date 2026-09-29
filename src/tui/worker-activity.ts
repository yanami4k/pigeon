// worker 活动记录（决策 301）：编排器只读观察口交出的运行事件、流式正文与工具结果，在界面侧按 worker 记下——
// 实时花费（含在跑的）、最近一个工具调用（面板的"正在做什么"）、最近若干条工具调用（树形视图展开时显示）与收尾时刻（面板淡出）。
// 编排面板、树形视图与状态栏的本会话花费读同一份记录（同源）；进入 worker 会话的实时显示经 listen 拿到同一批活动。
// 状态栏的计法：worker 收尾后，本会话花费由会话记录计入（ChildSessionCosts，决策 286 的规则不变）；在那之前按这里的实时花费计，
// 计入之后这里清零、不再另算——续做（补批）之后的新花费照常在这里累计。
import {
  addUsage,
  type CostTally,
  emptyCostTally,
  mergeCostTally,
} from "../application/session-cost.ts";
import type { WorkerActivity } from "../application/workers-commands.ts";
import type { SessionId } from "../state/ids.ts";
import {
  RuntimeEventKind,
  type ToolProposedPayload,
  type ToolSettledPayload,
  type TurnCompletedPayload,
} from "../state/runtime-events.ts";
import { toolCallLine, toolSettledState } from "./message-flow.ts";

// 每个 worker 记下的最近工具调用条数上限（树形视图展开时取其末尾若干条）
export const RECENT_TOOL_LIMIT = 20;

export interface RecentToolCall {
  toolCallId: string;
  // "$ 工具名 参数摘要"
  line: string;
  // 结束后的结果状态（"-> ok"、"-> error [...]"）；还在跑时缺省
  state?: string;
}

export interface WorkerActivityRecord {
  // 本次启动里看到的全部花费（面板显示）
  cost: CostTally;
  // 还没由会话记录计入本会话花费的部分（状态栏加上它）
  uncounted: CostTally;
  // 会话记录已计入过一次（之后只累计续做的新花费）
  counted: boolean;
  recentTools: RecentToolCall[];
  turnStartedAt?: number;
  // 收尾时刻（面板按它淡出）；续做后清掉
  settledAt?: number;
}

export class WorkerActivityTracker {
  private readonly records = new Map<SessionId, WorkerActivityRecord>();
  private readonly listeners = new Set<(activity: WorkerActivity) => void>();
  private readonly provider: string | undefined;

  constructor(options: { provider?: string } = {}) {
    this.provider = options.provider;
  }

  // 换到另一个会话（/resume）：原会话的记录清掉
  clear(): void {
    this.records.clear();
  }

  get(sessionId: SessionId): WorkerActivityRecord | undefined {
    return this.records.get(sessionId);
  }

  // 进入的 worker 会话订阅同一批活动（实时显示）
  listen(listener: (activity: WorkerActivity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recordOf(sessionId: SessionId): WorkerActivityRecord {
    let record = this.records.get(sessionId);
    if (record === undefined) {
      record = {
        cost: emptyCostTally(),
        uncounted: emptyCostTally(),
        counted: false,
        recentTools: [],
      };
      this.records.set(sessionId, record);
    }
    return record;
  }

  record(activity: WorkerActivity): void {
    const record = this.recordOf(activity.worker.sessionId);
    if (activity.kind === "event") {
      const { event } = activity;
      switch (event.kind) {
        case RuntimeEventKind.TurnStarted:
          record.turnStartedAt = event.timestamp;
          break;
        case RuntimeEventKind.TurnCompleted: {
          const usage = (event.payload as TurnCompletedPayload).usage;
          if (usage !== undefined) {
            // worker 的模型接入缺省同主会话（角色覆盖时由会话记录在收尾后校正）
            const origin = {
              ...(this.provider !== undefined ? { provider: this.provider } : {}),
              ...(record.turnStartedAt !== undefined ? { startMs: record.turnStartedAt } : {}),
              endMs: event.timestamp,
            };
            addUsage(record.cost, usage, origin);
            addUsage(record.uncounted, usage, origin);
          }
          break;
        }
        case RuntimeEventKind.ToolProposed: {
          const payload = event.payload as ToolProposedPayload;
          record.recentTools.push({ toolCallId: payload.toolCallId, line: toolCallLine(payload) });
          if (record.recentTools.length > RECENT_TOOL_LIMIT) record.recentTools.shift();
          break;
        }
        case RuntimeEventKind.ToolSettled: {
          const payload = event.payload as ToolSettledPayload;
          const call = record.recentTools.find((item) => item.toolCallId === payload.toolCallId);
          if (call !== undefined) call.state = toolSettledState(payload);
          break;
        }
        default:
          break;
      }
    }
    for (const listener of this.listeners) listener(activity);
  }

  // 生命周期：收尾记下时刻（面板淡出），续做清掉
  settled(sessionId: SessionId, at: number): void {
    this.recordOf(sessionId).settledAt = at;
  }

  resumed(sessionId: SessionId): void {
    delete this.recordOf(sessionId).settledAt;
  }

  // 最近一个工具调用的一行（面板的"正在做什么"）
  lastTool(sessionId: SessionId): RecentToolCall | undefined {
    return this.records.get(sessionId)?.recentTools.at(-1);
  }

  // 状态栏加上的在跑 worker 实时花费：会话记录已计入的（isCollected）清零一次，此后只累计续做的新花费
  uncountedTotal(isCollected: (sessionId: SessionId) => boolean): CostTally {
    const total = emptyCostTally();
    for (const [sessionId, record] of this.records) {
      if (!record.counted && isCollected(sessionId)) {
        record.counted = true;
        record.uncounted = emptyCostTally();
      }
      mergeCostTally(total, record.uncounted);
    }
    return total;
  }
}
