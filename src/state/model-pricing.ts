// 模型花费的计价（决策 235、203）：按 DeepSeek 官方人民币价目逐请求计，经网关的请求一律按此计入花费与上限。
//   价目（deepseek-flash，每百万 token）：输入缓存命中 ¥0.02、缓存未命中 ¥1、输出 ¥4；高峰时段翻倍。
//   高峰：北京时间周一至周五 9–12 时、14–18 时；其余时段、周末与法定节假日全天为空闲；调休上班的周末按工作日。
//   一条请求的开始或结束时刻任一落在高峰，整条按高峰价计（官方未说明按哪一时刻，取宁多勿少）。
//   计量口径（探针实测）：Anthropic 兼容端点的 input_tokens 只含未命中部分，命中在 cache_read_input_tokens；
//   cache_creation_input_tokens 实测恒为 0、价目里没有单列，出现时按未命中价计（宁多勿少）。
// 价目只定义在这一处（决策 286 起由 src/eval 移到 state，数字不变）：跑批网关逐请求计价；终端界面在 DeepSeek 回复自带价格为 0 时
// 按同一价目与该条回复的开始、结束时刻计会话花费。

export const PRICE_CNY_PER_MTOK = { cacheHit: 0.02, cacheMiss: 1, output: 4 } as const;
export const PEAK_MULTIPLIER = 2;

// 北京时间与 UTC 的差（无夏令时）
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
// 高峰时段（北京时间，按当天的分钟数，左闭右开）
const PEAK_WINDOWS_MIN: readonly [number, number][] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

// 法定节假日与调休上班日：按《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）录入全年。
// 表只覆盖 HOLIDAY_TABLE_YEARS 里的年份；表外年份只按周一至周五判，节假日不减（宁多勿少），跨年使用前须补表
export const HOLIDAY_TABLE_YEARS: readonly number[] = [2026];
export const CN_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
  ...days("2026-01-01", "2026-01-03"), // 元旦
  ...days("2026-02-15", "2026-02-23"), // 春节
  ...days("2026-04-04", "2026-04-06"), // 清明节
  ...days("2026-05-01", "2026-05-05"), // 劳动节
  ...days("2026-06-19", "2026-06-21"), // 端午节
  ...days("2026-09-25", "2026-09-27"), // 中秋节
  ...days("2026-10-01", "2026-10-07"), // 国庆节
]);
export const CN_ADJUSTED_WORKDAYS: ReadonlySet<string> = new Set([
  "2026-01-04",
  "2026-02-14",
  "2026-02-28",
  "2026-05-09",
  "2026-09-20",
  "2026-10-10",
]);

// 这一时刻是否落在高峰时段
export function isPeakAt(ms: number): boolean {
  const local = new Date(ms + BEIJING_OFFSET_MS);
  const date = local.toISOString().slice(0, 10);
  const weekday = local.getUTCDay();
  const workday = CN_ADJUSTED_WORKDAYS.has(date)
    ? true
    : CN_PUBLIC_HOLIDAYS.has(date)
      ? false
      : weekday >= 1 && weekday <= 5;
  if (!workday) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return PEAK_WINDOWS_MIN.some(([from, to]) => minute >= from && minute < to);
}

export interface PricedUsage {
  // 缓存未命中的输入
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

// 一条请求的花费（人民币元）与是否按高峰价
export function requestCostCny(
  usage: PricedUsage,
  startMs: number,
  endMs: number
): { cny: number; peak: boolean } {
  const peak = isPeakAt(startMs) || isPeakAt(endMs);
  const base =
    (usage.input + usage.cacheWrite) * PRICE_CNY_PER_MTOK.cacheMiss +
    usage.cacheRead * PRICE_CNY_PER_MTOK.cacheHit +
    usage.output * PRICE_CNY_PER_MTOK.output;
  return { cny: (base / 1_000_000) * (peak ? PEAK_MULTIPLIER : 1), peak };
}
