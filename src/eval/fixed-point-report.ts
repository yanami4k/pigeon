// 定点对照的汇总（决策 139、164）：主判据按记忆给出的时机拆开、分开报，不合并成一个数——
// - 开局事件（开局挑到记忆）：首轮验证是否在题面以外的检查上变红；
// - 回炉事件（回炉时挑到记忆）：只取首轮未过、进入回炉的遍次，看给出记忆那一轮回炉之后的下一次验证是否仍在题面以外变红；
//   某组在某事件里没有任何一遍进入回炉，该事件在回炉判据上记为缺失，不补值。
// 两个时机都挑到记忆的事件两类都计入。每类各算按事件配对的"带记忆组减不带组"的变红比例差、帮倒忙的事件数（带记忆组
// 变红比例高于不带组）与带无关记忆组对照；回炉轮数、最终结论与"记忆被用上"（三组同一口径并列）为辅助指标。
// 结果行按"事件 × 组 × 遍次"去重（留先写的），只计遍次号不超过本次遍数的；组别取结果文件里出现的全部组。
// 实际给出的条目与该组指定的不一致的遍次不进任何配对，单列计数。判不清的遍次不进比例的分母，单列计数。
// 只做描述与配对差，不下显著性结论。
import {
  FIXED_POINT_GROUPS,
  type FixedPointEventList,
  type FixedPointGroup,
} from "./fixed-point-events.ts";
import { type FixedPointRow, fixedPointKey, type OffTaskVerdict } from "./fixed-point-results.ts";

export type Criterion = "opening" | "repair";

export interface GroupStats {
  // 这一判据下可用的遍数（开局：全部遍次；回炉：进入回炉的遍次）
  eligible: number;
  red: number;
  undetermined: number;
  // 变红比例：变红遍数 / 判得清的遍数；没有判得清的遍次为 null
  redRate: number | null;
}

export interface EventStats {
  eventId: string;
  seq: number;
  groups: Partial<Record<FixedPointGroup, GroupStats>>;
  // 带记忆组减不带组、无关组减不带组；任一组没有判得清的遍次（回炉判据下含没有进入回炉的遍次）为 null
  pairedDiff: number | null;
  irrelevantDiff: number | null;
}

// 结果行的口径化：按键去重（留先写的）、遍次不超过 passes
export function usableRows(rows: readonly FixedPointRow[], passes: number): FixedPointRow[] {
  const seen = new Set<string>();
  const out: FixedPointRow[] = [];
  for (const r of rows) {
    const key = fixedPointKey(r);
    if (seen.has(key) || r.pass > passes) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function verdictOf(row: FixedPointRow, criterion: Criterion): OffTaskVerdict | null {
  if (criterion === "opening") return row.firstVerify;
  return row.repairVerify.entered ? row.repairVerify : null;
}

export function groupStats(rows: readonly FixedPointRow[], criterion: Criterion): GroupStats {
  const verdicts = rows
    .map((r) => verdictOf(r, criterion))
    .filter((v): v is OffTaskVerdict => v !== null);
  const red = verdicts.filter((v) => v.offTaskRed === true).length;
  const undetermined = verdicts.filter((v) => v.offTaskRed === null).length;
  const determined = verdicts.length - undetermined;
  return {
    eligible: verdicts.length,
    red,
    undetermined,
    redRate: determined > 0 ? red / determined : null,
  };
}

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  return a === null || a === undefined || b === null || b === undefined ? null : a - b;
}

// 某一类判据下的逐事件统计：只取这一时机挑到记忆的事件，只用实际给出与指定一致的遍次
export function criterionStats(
  list: FixedPointEventList,
  rows: readonly FixedPointRow[],
  criterion: Criterion,
  passes: number
): EventStats[] {
  const usable = usableRows(rows, passes).filter((r) => r.givenMatchesFixed);
  return list.events
    .filter((e) =>
      criterion === "opening" ? e.picked.opening.length > 0 : e.picked.repair.length > 0
    )
    .map((event) => {
      const mine = usable.filter((r) => r.eventId === event.id);
      const stats: EventStats["groups"] = {};
      for (const g of FIXED_POINT_GROUPS) {
        const of = mine.filter((r) => r.group === g);
        if (of.length > 0) stats[g] = groupStats(of, criterion);
      }
      return {
        eventId: event.id,
        seq: event.seq,
        groups: stats,
        pairedDiff: diff(stats.memory?.redRate, stats.none?.redRate),
        irrelevantDiff: diff(stats.irrelevant?.redRate, stats.none?.redRate),
      };
    });
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function points(value: number | null): string {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

const CRITERION_TITLE: Record<Criterion, string> = {
  opening: "开局事件：首轮验证在题面以外变红",
  repair: "回炉事件：进入回炉的遍次里，给出记忆那一轮回炉之后的下一次验证仍在题面以外变红",
};

function criterionSection(
  stats: readonly EventStats[],
  criterion: Criterion,
  groups: readonly FixedPointGroup[]
): string[] {
  const paired = stats.map((s) => s.pairedDiff).filter((d): d is number => d !== null);
  const irrelevant = stats.map((s) => s.irrelevantDiff).filter((d): d is number => d !== null);
  const missing = stats.filter((s) => s.pairedDiff === null).length;
  const undetermined = stats.reduce(
    (n, s) => n + Object.values(s.groups).reduce((m, g) => m + (g?.undetermined ?? 0), 0),
    0
  );
  const lines = [
    `## ${CRITERION_TITLE[criterion]}`,
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 事件数 | ${stats.length} |`,
    `| 可配对的事件（带记忆与不带两组都有判得清的遍次） | ${paired.length} |`,
    `| ${criterion === "repair" ? "缺失的事件（某组没有判得清的回炉遍次，不补值）" : "不能配对的事件"} | ${missing} |`,
    `| 带记忆减不带的变红比例差，按事件配对的均值（百分点） | ${points(mean(paired))} |`,
    `| 帮倒忙的事件数（带记忆组变红比例高于不带组） | ${paired.filter((d) => d > 0).length} |`,
    `| 带记忆组变红比例低于不带组的事件数 | ${paired.filter((d) => d < 0).length} |`,
    `| 两组相同的事件数 | ${paired.filter((d) => d === 0).length} |`,
    `| 对照：带无关记忆减不带的变红比例差均值（百分点，${irrelevant.length} 个事件） | ${points(mean(irrelevant))} |`,
    `| 判不清的遍次 | ${undetermined} |`,
    "",
    `| 事件 | 步 | ${groups.map((g) => `${GROUP_NAME[g]}变红`).join(" | ")} | 配对差 | 无关对照差 | 判不清（${groups.map((g) => GROUP_NAME[g]).join("/")}） |`,
    `|---|---|${groups.map(() => "---|").join("")}---|---|---|`,
  ];
  for (const s of stats) {
    const cell = (g: FixedPointGroup) => {
      const x = s.groups[g];
      return x === undefined ? "—" : `${x.red}/${x.eligible - x.undetermined}（${pct(x.redRate)}）`;
    };
    lines.push(
      `| ${s.eventId} | ${s.seq} | ${groups.map(cell).join(" | ")} | ${points(s.pairedDiff)} | ${points(s.irrelevantDiff)} | ` +
        `${groups.map((g) => s.groups[g]?.undetermined ?? "—").join("/")} |`
    );
  }
  lines.push("");
  return lines;
}

const GROUP_NAME: Record<FixedPointGroup, string> = {
  memory: "带记忆",
  irrelevant: "带无关记忆",
  none: "不带",
};

export function renderFixedPointReport(
  list: FixedPointEventList,
  rows: readonly FixedPointRow[],
  options: { passes: number }
): string {
  const clean = usableRows(rows, options.passes);
  const groups = FIXED_POINT_GROUPS.filter((g) => clean.some((r) => r.group === g));
  const matched = clean.filter((r) => r.givenMatchesFixed);
  const mismatched = clean.length - matched.length;
  const expected = list.events.reduce(
    (n, e) => n + groups.filter((g) => e.fixed[g] !== null).length * options.passes,
    0
  );
  const opening = criterionStats(list, rows, "opening", options.passes);
  const repair = criterionStats(list, rows, "repair", options.passes);
  const both = list.events.filter(
    (e) => e.picked.opening.length > 0 && e.picked.repair.length > 0
  ).length;
  const byGroup = (g: FixedPointGroup) => matched.filter((r) => r.group === g);
  const usedRate = (g: FixedPointGroup) => {
    const of = byGroup(g).filter((r) => r.memoryUsed !== null);
    return of.length === 0 ? null : of.filter((r) => r.memoryUsed === true).length / of.length;
  };
  const usedCell = (g: FixedPointGroup) => {
    const of = byGroup(g).filter((r) => r.memoryUsed !== null);
    return of.length === 0
      ? "—"
      : `${of.filter((r) => r.memoryUsed === true).length}/${of.length}（${pct(usedRate(g))}）`;
  };
  const meanRounds = (g: FixedPointGroup) => {
    const rounds = byGroup(g)
      .map((r) => r.repairRounds)
      .filter((n): n is number => n !== null);
    return rounds.length === 0 ? "—" : mean(rounds)?.toFixed(2);
  };
  const passRate = (g: FixedPointGroup) => {
    const of = byGroup(g);
    return of.length === 0 ? "—" : pct(of.filter((r) => r.outcome === "passed").length / of.length);
  };
  const lines: string[] = [
    `# 定点对照（${list.repo}）`,
    "",
    "口径（决策 164）：主判据按记忆给出的时机分开报，不合并。变红为该次验证在题面以外的检查上变红（格式、类型、分层失败一律算，" +
      "测试只算题面测试文件以外的用例，131）；判不清的遍次不进比例的分母、单列计数。回炉时机的记忆在重跑中每一轮回炉都给" +
      '（固定挑选的回炉组），"给出记忆那一轮"即第 1 轮回炉，判第 2 次验证；事件清单另记原跑中挑到它的轮次。' +
      "实际给出的条目与该组指定的不一致的遍次不进配对、单列计数。只做描述与配对差，不下显著性结论。",
    "",
    "## 总览",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 事件数 | ${list.events.length}（开局 ${opening.length}、回炉 ${repair.length}，两个时机都有 ${both}；扫描 ${list.scanned.length} 步） |`,
    `| 结果行（去重、遍次不超过 ${options.passes}） | ${clean.length} / ${expected} |`,
    `| 实际给出与指定不一致的遍次（不进配对） | ${mismatched} |`,
    `| 带无关记忆组缺失的事件数（找不到候选） | ${list.events.filter((e) => e.fixed.irrelevant === null).length} |`,
    "",
    ...criterionSection(opening, "opening", groups),
    ...criterionSection(repair, "repair", groups),
    "## 辅助指标",
    "",
    "记忆被用上：三组同一口径——按带记忆组指定的红转绿条目、在带记忆组本会给出它们的时间窗口里，agent 是否改了条目的补改文件；" +
      "不带组与无关组即基线，主看带记忆组减不带组。",
    "",
    `| 指标 | ${groups.map((g) => GROUP_NAME[g]).join(" | ")} |`,
    `|---|${groups.map(() => "---|").join("")}`,
    `| 记忆被用上 | ${groups.map(usedCell).join(" | ")} |`,
    `| 平均回炉轮数 | ${groups.map(meanRounds).join(" | ")} |`,
    `| 最终通过比例 | ${groups.map(passRate).join(" | ")} |`,
    "",
    `带记忆减不带的"用上"比例差（百分点）：${points(diff(usedRate("memory"), usedRate("none")))}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
