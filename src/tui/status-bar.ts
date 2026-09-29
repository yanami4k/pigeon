// 状态栏（决策 286 第 2 项）：输入框下方一行（Claude Code 惯例；之后的编排面板也放输入框下方，与之同处，决策 301），
// 显示模型、上下文用量百分比、本会话花费、后台补做复盘进度。纯 ASCII（spike 纪律：歧义宽字符不进 chrome）。
// 窄终端按优先级截断、不折行：先把各段换成短写法，再依次去掉补做进度、模型、花费，最后硬截到宽度。
// 上下文用量优先级最高——它决定什么时候该 /compact。
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { CostTally } from "../application/session-cost.ts";

export interface BackfillStatus {
  planned: number;
  // 正在补第几个（1 起）；没有在补时缺省
  current?: number;
  completed: number;
  failed: number;
  cost: CostTally;
}

export interface StatusBarState {
  model?: string;
  context?: { tokens: number; contextWindow: number } | undefined;
  cost: CostTally;
  backfill?: BackfillStatus | undefined;
}

// 1234 → 1.2k；1234567 → 1.2M
export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

// 花费：回复自带价格的部分写 $，DeepSeek 按官方人民币价目计的部分写 ¥，没有价格的写 token 数并注明；三者并存时相加写出
export function formatCost(tally: CostTally, short: boolean): string {
  const digits = short ? 2 : 4;
  const parts: string[] = [];
  if (tally.cost > 0 || tally.pricedTokens > 0) parts.push(`$${tally.cost.toFixed(digits)}`);
  if (tally.cny > 0 || tally.cnyTokens > 0) parts.push(`¥${tally.cny.toFixed(digits)}`);
  if (tally.unpricedTokens > 0) {
    const unpriced = `${compactNumber(tally.unpricedTokens)} tok`;
    parts.push(short ? `${unpriced} no price` : `${unpriced} (no price)`);
  }
  if (parts.length === 0) return "$0";
  return parts.join(short ? "+" : " + ");
}

function contextSegment(context: StatusBarState["context"], short: boolean): string | undefined {
  if (context === undefined || context.contextWindow <= 0) return undefined;
  const percent = Math.min(999, Math.round((context.tokens / context.contextWindow) * 100));
  return short
    ? `ctx ${percent}%`
    : `ctx ${percent}% (${compactNumber(context.tokens)}/${compactNumber(context.contextWindow)})`;
}

function backfillSegment(backfill: BackfillStatus | undefined, short: boolean): string | undefined {
  if (backfill === undefined || backfill.current === undefined) return undefined;
  const failed = backfill.failed > 0 ? ` ${backfill.failed} failed` : "";
  return short
    ? `backfill ${backfill.current}/${backfill.planned}`
    : `backfill ${backfill.current}/${backfill.planned} ${formatCost(backfill.cost, false)}${failed}`;
}

// 一行状态栏文本（不含左边距）；width 为可用宽度
export function statusBarText(state: StatusBarState, width: number): string {
  const build = (options: {
    short: boolean;
    model: boolean;
    cost: boolean;
    backfill: boolean;
  }): string =>
    [
      options.model ? state.model : undefined,
      contextSegment(state.context, options.short),
      options.cost ? `cost ${formatCost(state.cost, options.short)}` : undefined,
      options.backfill ? backfillSegment(state.backfill, options.short) : undefined,
    ]
      .filter((segment): segment is string => segment !== undefined && segment !== "")
      .join(" | ");
  const attempts = [
    { short: false, model: true, cost: true, backfill: true },
    { short: true, model: true, cost: true, backfill: true },
    { short: true, model: true, cost: true, backfill: false },
    { short: true, model: false, cost: true, backfill: false },
    { short: true, model: false, cost: false, backfill: false },
  ];
  for (const attempt of attempts) {
    const text = build(attempt);
    if (visibleWidth(text) <= width) return text;
  }
  return clipToWidth(build({ short: true, model: false, cost: false, backfill: false }), width);
}

// 按显示宽度硬截（不补省略号、不带任何控制序列）；编排面板与树形视图同样用它
export function clipToWidth(text: string, width: number): string {
  let out = "";
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
    if (visibleWidth(out + segment) > width) break;
    out += segment;
  }
  return out;
}

export class StatusBar implements Component {
  private state: StatusBarState;

  constructor(state: StatusBarState) {
    this.state = state;
  }

  update(patch: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...patch };
  }

  snapshot(): StatusBarState {
    return this.state;
  }

  invalidate(): void {}

  // 与 Text 同样留 1 格左边距；恰好一行
  render(width: number): string[] {
    const text = statusBarText(this.state, Math.max(0, width - 2));
    return [text === "" ? "" : ` ${text}`];
  }
}
