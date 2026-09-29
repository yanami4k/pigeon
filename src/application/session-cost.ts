// 会话花费（决策 286 第 2 项，终端界面状态栏）：价格来源是会话记录里模型回复自带的用量与价格（usage.cost），
// 不另立价目表。有价格的计入金额；价格为零而用了 token 的记作"无价格的 token"，状态栏据此注明无价格，不当作免费。
// 本会话花费 = 主会话自己的消息 + 父会话是它的 worker 会话 + 从它分叉出的复盘会话；后台补做的复盘补的是别的会话，
// 其花费记在那个会话名下（补做进度里单独显示），不并入当前会话。/fork 分支与失败自动分叉重试是独立的会话，不计入。
// 只读会话文件，不写任何记录。
import {
  listSessionRefs,
  loadSessionView,
  readSessionView,
  sessionRefTime,
} from "../persistence/session-catalog.ts";
import type { SessionView } from "../state/session-view.ts";
import { toolResultModelUsage } from "../state/tool-usage.ts";

// 用量的最小形状：turn.completed 的 usage、会话记录里的助手 usage 与工具另发请求的 usage 都满足
export interface UsageLike {
  totalTokens: number;
  cost: { total: number };
}

export interface CostTally {
  // 有价格部分的金额（与 usage.cost 同一币种单位）
  cost: number;
  // 有价格的 token
  pricedTokens: number;
  // 用了 token 但记录里价格为零的部分
  unpricedTokens: number;
}

export function emptyCostTally(): CostTally {
  return { cost: 0, pricedTokens: 0, unpricedTokens: 0 };
}

export function addUsage(tally: CostTally, usage: UsageLike): void {
  if (usage.cost.total > 0) {
    tally.cost += usage.cost.total;
    tally.pricedTokens += usage.totalTokens;
  } else {
    tally.unpricedTokens += usage.totalTokens;
  }
}

export function mergeCostTally(into: CostTally, from: CostTally): void {
  into.cost += from.cost;
  into.pricedTokens += from.pricedTokens;
  into.unpricedTokens += from.unpricedTokens;
}

// 一个会话视图自己的花费：助手消息的用量，加工具执行中另发的模型请求（web_fetch 的提炼等）；分叉复制段不计（视图已跳过）
export function costTallyOfView(view: SessionView): CostTally {
  const tally = emptyCostTally();
  for (const message of view.messages) {
    if (message.usage !== undefined) {
      addUsage(tally, message.usage);
    }
    if (message.role === "toolResult") {
      const extra = toolResultModelUsage(message.raw.details);
      if (extra !== undefined) {
        addUsage(tally, extra);
      }
    }
  }
  return tally;
}

// 按会话号读一个会话自己的花费；会话存储里没有该会话即为零
export function sessionCostTally(sessionsRoot: string, sessionId: string): CostTally {
  const view = loadSessionView(sessionsRoot, sessionId);
  return view !== undefined ? costTallyOfView(view) : emptyCostTally();
}

// 复盘会话：Run 开始条目带复盘标记（175、192、207）
export function isReviewSession(view: SessionView): boolean {
  return view.runs.some((run) => run.start.memoryReview !== undefined);
}

// 从某会话分叉出的复盘会话：文件头记着来源会话，且带复盘标记
export function isReviewForkOf(view: SessionView, sessionId: string): boolean {
  return view.parentSessionId === sessionId && view.worker === undefined && isReviewSession(view);
}

// 续接会话时的已有花费：主会话 + 它派出的 worker + 从它分叉出的复盘
export function accumulatedSessionCost(sessionsRoot: string, sessionId: string): CostTally {
  const tally = emptyCostTally();
  for (const ref of listSessionRefs(sessionsRoot)) {
    if (ref.sessionId !== sessionId) {
      // 只有子会话才可能计入；先按文件名排除不了，读头部即读全文，这里一并投影
      const view = readSessionView(ref);
      if (view === undefined || view.parentSessionId !== sessionId) {
        continue;
      }
      if (view.worker !== undefined || isReviewForkOf(view, sessionId)) {
        mergeCostTally(tally, costTallyOfView(view));
      }
      continue;
    }
    const view = readSessionView(ref);
    if (view !== undefined) {
      mergeCostTally(tally, costTallyOfView(view));
    }
  }
  return tally;
}

// 本会话打开之后新出现的子会话（worker 与复盘）：收尾后计入一次，没收尾的下次再看。
// 只读创建时刻不早于打开时刻的会话文件；判明不是本会话子会话的（别的会话、/fork 分支）记下不再读。
export class ChildSessionCosts {
  private readonly settled = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly sessionsRoot: string;
  private readonly parentId: string;
  private readonly since: number;

  constructor(sessionsRoot: string, parentId: string, since: number) {
    this.sessionsRoot = sessionsRoot;
    this.parentId = parentId;
    this.since = since;
  }

  // 新收尾的子会话的花费合计（没有即为零）
  collect(): CostTally {
    const delta = emptyCostTally();
    for (const ref of listSessionRefs(this.sessionsRoot)) {
      const id = ref.sessionId;
      if (
        id === this.parentId ||
        this.settled.has(id) ||
        this.ignored.has(id) ||
        sessionRefTime(ref) < this.since
      ) {
        continue;
      }
      const view = readSessionView(ref);
      if (view === undefined) continue;
      const child =
        view.parentSessionId === this.parentId &&
        (view.worker !== undefined || isReviewForkOf(view, this.parentId));
      if (!child) {
        // 文件头已写全（有 Run）仍不是子会话即永久排除；还没有 Run 的复盘分叉可能尚未写入标记，下次再看
        if (view.parentSessionId !== this.parentId || view.runs.length > 0) this.ignored.add(id);
        continue;
      }
      if (view.runs.length === 0 || view.runs.some((run) => run.end === undefined)) continue;
      this.settled.add(id);
      mergeCostTally(delta, costTallyOfView(view));
    }
    return delta;
  }
}
