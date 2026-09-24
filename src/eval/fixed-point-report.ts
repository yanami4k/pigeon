// 定点对照的汇总（决策 139）：主判据为按事件配对的"带记忆组与不带组的变红比例差"；次要为带无关记忆组对照、回炉轮数、
// 帮倒忙的事件数（带记忆组变红比例高于不带组）、记忆被用上的比例。只做描述与配对差，不下显著性结论。
// "变红"为首轮验证在题面以外的检查上变红（131 口径）；判不清的遍次不进比例的分母，单列计数。
import type { FixedPointEventList, FixedPointGroup } from "./fixed-point-events.ts";
import type { FixedPointRow } from "./fixed-point-results.ts";

export interface GroupStats {
  passes: number;
  red: number;
  undetermined: number;
  // 变红比例：变红遍数 / 判得清的遍数；没有判得清的遍次为 null
  redRate: number | null;
  firstFailed: number;
  meanRepairRounds: number | null;
  // 记忆被用上：用上的遍数 / 可判定的遍数（给出了红转绿条目的遍次）
  used: number;
  usedApplicable: number;
  reverted: number;
}

export interface EventStats {
  eventId: string;
  seq: number;
  timing: string;
  groups: Partial<Record<FixedPointGroup, GroupStats>>;
  // 带记忆组减不带组的变红比例；任一组没有判得清的遍次为 null
  pairedDiff: number | null;
  irrelevantDiff: number | null;
}

export function groupStats(rows: readonly FixedPointRow[]): GroupStats {
  const red = rows.filter((r) => r.firstVerify.offTaskRed === true).length;
  const undetermined = rows.filter((r) => r.firstVerify.offTaskRed === null).length;
  const determined = rows.length - undetermined;
  const rounds = rows.map((r) => r.repairRounds).filter((n): n is number => n !== null);
  return {
    passes: rows.length,
    red,
    undetermined,
    redRate: determined > 0 ? red / determined : null,
    firstFailed: rows.filter((r) => r.firstVerify.failed === true).length,
    meanRepairRounds: rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
    used: rows.filter((r) => r.memoryUsed === true).length,
    usedApplicable: rows.filter((r) => r.memoryUsed !== null).length,
    reverted: rows.filter((r) => r.reverted).length,
  };
}

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  return a === null || a === undefined || b === null || b === undefined ? null : a - b;
}

export function eventStats(
  list: FixedPointEventList,
  rows: readonly FixedPointRow[],
  groups: readonly FixedPointGroup[]
): EventStats[] {
  return list.events.map((event) => {
    const mine = rows.filter((r) => r.eventId === event.id);
    const stats: EventStats["groups"] = {};
    for (const g of groups) {
      const of = mine.filter((r) => r.group === g);
      if (of.length > 0) stats[g] = groupStats(of);
    }
    const timing = [
      ...(event.picked.opening.length > 0 ? ["开局"] : []),
      ...event.picked.repair.map((r) => `第 ${r.round} 轮回炉`),
    ].join("、");
    return {
      eventId: event.id,
      seq: event.seq,
      timing,
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

function rounds(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

export function renderFixedPointReport(
  list: FixedPointEventList,
  rows: readonly FixedPointRow[],
  options: { groups: readonly FixedPointGroup[]; passes: number }
): string {
  const stats = eventStats(list, rows, options.groups);
  const paired = stats.map((s) => s.pairedDiff).filter((d): d is number => d !== null);
  const irrelevant = stats.map((s) => s.irrelevantDiff).filter((d): d is number => d !== null);
  const memoryRows = rows.filter((r) => r.group === "memory");
  const used = memoryRows.filter((r) => r.memoryUsed === true).length;
  const usedApplicable = memoryRows.filter((r) => r.memoryUsed !== null).length;
  const missing = list.events.filter((e) => e.fixed.irrelevant === null).length;
  const undetermined = rows.filter((r) => r.firstVerify.offTaskRed === null).length;
  const expected = list.events.reduce(
    (n, e) => n + options.groups.filter((g) => e.fixed[g] !== null).length * options.passes,
    0
  );
  const lines: string[] = [
    `# 定点对照（${list.repo}）`,
    "",
    "口径：变红为首轮验证在题面以外的检查上变红（格式、类型、分层失败一律算，测试只算题面测试文件以外的用例，131）；" +
      "判不清的遍次不进比例的分母、单列计数。回炉时机的记忆在重跑中每一轮回炉都给（固定挑选的回炉组），" +
      "事件清单另记原跑中挑到它的轮次。只做描述与配对差，不下显著性结论。",
    "",
    "## 汇总",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 事件数 | ${list.events.length}（扫描 ${list.scanned.length} 步） |`,
    `| 结果行 | ${rows.length} / ${expected} |`,
    `| 可配对的事件（带记忆与不带两组都有判得清的遍次） | ${paired.length} |`,
    `| 主判据：带记忆减不带的变红比例差，按事件配对的均值（百分点） | ${points(mean(paired))} |`,
    `| 帮倒忙的事件数（带记忆组变红比例高于不带组） | ${paired.filter((d) => d > 0).length} |`,
    `| 带记忆组变红比例低于不带组的事件数 | ${paired.filter((d) => d < 0).length} |`,
    `| 两组相同的事件数 | ${paired.filter((d) => d === 0).length} |`,
    `| 对照：带无关记忆减不带的变红比例差均值（百分点，${irrelevant.length} 个事件） | ${points(mean(irrelevant))} |`,
    `| 带无关记忆组缺失的事件数（找不到候选） | ${missing} |`,
    `| 记忆被用上的比例（带记忆组，可判定的遍次） | ${usedApplicable > 0 ? `${used}/${usedApplicable}（${pct(used / usedApplicable)}）` : "—"} |`,
    `| 首轮变红判不清的遍次 | ${undetermined} |`,
    "",
    "## 逐事件",
    "",
    "| 事件 | 步 | 时机 | 带记忆变红 | 不带变红 | 无关变红 | 配对差 | 无关对照差 | 回炉轮数（带/不带/无关） | 用上 | 判不清（带/不带/无关） |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of stats) {
    const cell = (g: FixedPointGroup) => {
      const x = s.groups[g];
      return x === undefined ? "—" : `${x.red}/${x.passes - x.undetermined}（${pct(x.redRate)}）`;
    };
    const m = s.groups.memory;
    lines.push(
      `| ${s.eventId} | ${s.seq} | ${s.timing} | ${cell("memory")} | ${cell("none")} | ${cell("irrelevant")} | ` +
        `${points(s.pairedDiff)} | ${points(s.irrelevantDiff)} | ` +
        `${rounds(s.groups.memory?.meanRepairRounds)}/${rounds(s.groups.none?.meanRepairRounds)}/${rounds(s.groups.irrelevant?.meanRepairRounds)} | ` +
        `${m === undefined || m.usedApplicable === 0 ? "—" : `${m.used}/${m.usedApplicable}`} | ` +
        `${s.groups.memory?.undetermined ?? "—"}/${s.groups.none?.undetermined ?? "—"}/${s.groups.irrelevant?.undetermined ?? "—"} |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
