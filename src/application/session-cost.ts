// 会话花费（决策 286 第 2 项，终端界面状态栏）：价格来源是会话记录里模型回复自带的用量与价格（usage.cost，显示为 $）。
// DeepSeek 接入（provider deepseek）的回复自带价格为 0，这类回复按官方人民币价目
// （state/model-pricing.ts，含高峰时段）与该条回复的开始、结束时刻计价，单列为人民币（显示为 ¥）。其余价格为零而用了 token 的
// 记作"无价格的 token"，状态栏据此注明无价格，不当作免费。
// 本会话花费 = 主会话自己的消息 + 父会话是它的 worker 会话 + 从它分叉出的复盘会话；后台补做的复盘补的是别的会话，
// 其花费记在那个会话名下（补做进度里单独显示），不并入当前会话。/fork 分支与失败自动分叉重试是独立的会话，不计入。
// 只读会话文件，不写任何记录。
import {
  listSessionRefs,
  loadSessionView,
  readSessionView,
  sessionRefTime,
} from "../persistence/session-catalog.ts";
import { DEEPSEEK_PROVIDER } from "../pi-runtime/deepseek-model.ts";
import { requestCostCny } from "../state/model-pricing.ts";
import type { SessionView } from "../state/session-view.ts";
import { toolResultModelUsage } from "../state/tool-usage.ts";

// 用量的最小形状：turn.completed 的 usage、会话记录里的助手 usage 与工具另发请求的 usage 都满足
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

export interface CostTally {
  // 回复自带价格的金额（与 usage.cost 同一币种单位，显示为 $）
  cost: number;
  // 有自带价格的 token
  pricedTokens: number;
  // DeepSeek 回复按官方人民币价目计的金额（元）与其 token
  cny: number;
  cnyTokens: number;
  // 用了 token 但没有价格可依的部分
  unpricedTokens: number;
}

// 计价需要的这条回复的来历：模型接入与请求的开始、结束时刻（Unix 毫秒；缺一取另一个）
export interface UsageOrigin {
  provider?: string;
  startMs?: number;
  endMs?: number;
}

export function emptyCostTally(): CostTally {
  return { cost: 0, pricedTokens: 0, cny: 0, cnyTokens: 0, unpricedTokens: 0 };
}

export function addUsage(tally: CostTally, usage: UsageLike, origin: UsageOrigin = {}): void {
  if (usage.cost.total > 0) {
    tally.cost += usage.cost.total;
    tally.pricedTokens += usage.totalTokens;
    return;
  }
  const at = origin.endMs ?? origin.startMs;
  if (origin.provider === DEEPSEEK_PROVIDER && at !== undefined && usage.totalTokens > 0) {
    // 开始或结束任一落在高峰即按高峰价
    tally.cny += requestCostCny(usage, origin.startMs ?? at, at).cny;
    tally.cnyTokens += usage.totalTokens;
    return;
  }
  tally.unpricedTokens += usage.totalTokens;
}

export function mergeCostTally(into: CostTally, from: CostTally): void {
  into.cost += from.cost;
  into.pricedTokens += from.pricedTokens;
  into.cny += from.cny;
  into.cnyTokens += from.cnyTokens;
  into.unpricedTokens += from.unpricedTokens;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// 一个会话视图自己的花费：助手消息的用量，加工具执行中另发的模型请求（web_fetch 的提炼等）；分叉复制段不计（视图已跳过）。
// 助手消息的模型接入取消息自带的 provider，开始时刻取消息自带的 timestamp、结束时刻取写入时刻；工具另发的请求沿用
// 其前最近一条助手消息的模型接入，时刻取工具结果的写入时刻
export function costTallyOfView(view: SessionView): CostTally {
  const tally = emptyCostTally();
  let provider: string | undefined;
  for (const message of view.messages) {
    if (message.role === "assistant" && typeof message.raw.provider === "string") {
      provider = message.raw.provider;
    }
    if (message.usage !== undefined) {
      const startMs = numberOr(message.raw.timestamp);
      addUsage(tally, message.usage, {
        ...(provider !== undefined ? { provider } : {}),
        ...(startMs !== undefined ? { startMs } : {}),
        endMs: message.timestamp,
      });
    }
    if (message.role === "toolResult") {
      const extra = toolResultModelUsage(message.raw.details);
      if (extra !== undefined) {
        addUsage(tally, extra, {
          ...(provider !== undefined ? { provider } : {}),
          endMs: message.timestamp,
        });
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

  // 决策 301：这个子会话的花费是否已由 collect 计入（界面据此不再把它在跑时的实时花费另算一遍）
  isCollected(sessionId: string): boolean {
    return this.settled.has(sessionId);
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
