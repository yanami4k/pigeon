// 提交流实验的报告（决策 146、196、201、202、219）：
//   每步得分——各格各遍在已判的步上取每步得分（要做到的用例通过比例）的等权平均，分段（清单里按重置点切出的各段）与合并
//   各给一个；多遍时给均值与范围。要做到的为零的步不进平均，单列步数；做成步数与不许挂的失败合计照报（次要判据）；
//   同题两遍的每步得分差——同一格第 1、2 遍在同一步上的得分之差（只作描述，统计检验在另写的分析脚本里做）；
//   每步用量——轮数、墙钟、花费、上下文峰值、开工时的记忆大小与复盘消耗的分布（校准所要的量）；
//   每步明细（第一遍）与次要指标（静态检查、token、墙钟、限额暂停，以及验证工具故障——检查工具自身崩溃、不计入验证结论的步次，170 ③）。
// 196、201 之前的旧结果行（带全量测试通过率、没有 judging）照常读出，不计入以上各表，只报条数。
// 输出目录有身份头时，最前面另有设置一节：开跑时的代码版本与每一次显式放行的代码更换（269）
import { describeHarness, type HarnessRef } from "./stream-harness.ts";
import {
  isExternalCondition,
  STREAM_CONDITIONS,
  type StreamCondition,
  type StreamResultLine,
} from "./stream-results.ts";

// 设置一节只用到身份头（stream-identity 的 StoredStreamIdentity）里代码版本的部分
export interface ReportIdentity {
  info: { harness: HarnessRef };
  infoLog?: readonly {
    since: string;
    info: { harness: HarnessRef };
    acceptHarnessChange?: string;
  }[];
  allowDirtyHarness?: boolean;
}

// 设置一节（269）：开跑时的代码提交号（经 --allow-dirty-harness 放行的照写），以及 infoLog 里每一次经
// --accept-harness-change 显式放行的时刻、新的代码版本与原因；只改路数、账号的记录不列
function renderSettings(identity: ReportIdentity): string[] {
  const out = [
    "## 设置",
    "",
    `- 开跑时的代码：${describeHarness(identity.info.harness).replace(
      /）$/,
      identity.allowDirtyHarness === true ? "；经 --allow-dirty-harness 放行）" : "）"
    )}`,
  ];
  const accepted = (identity.infoLog ?? []).filter((c) => c.acceptHarnessChange !== undefined);
  if (accepted.length === 0) {
    out.push("- 显式放行的代码更换：无", "");
    return out;
  }
  out.push(
    "- 显式放行的代码更换（--accept-harness-change）：",
    "",
    "| 时刻 | 新的代码 | 原因 |",
    "|---|---|---|"
  );
  for (const c of accepted) {
    const reason = (c.acceptHarnessChange ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    out.push(`| ${c.since} | ${describeHarness(c.info.harness)} | ${reason} |`);
  }
  out.push("");
  return out;
}

export interface ReportSegment {
  id: string;
  firstSeq: number;
  lastSeq: number;
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// 报告里的条件顺序：内置条件按 STREAM_CONDITIONS 的顺序在前，外部 agent 条件（ext-<名字>）按名字排在后面
function conditionsIn(lines: readonly StreamResultLine[]): StreamCondition[] {
  const present = new Set(lines.map((l) => l.condition));
  const external = [...present].filter((c) => isExternalCondition(c)).sort();
  return [...STREAM_CONDITIONS.filter((c) => present.has(c)), ...external];
}

// 已按两类用例判过的行
function judgedLines(lines: readonly StreamResultLine[]): StreamResultLine[] {
  return lines.filter((l) => l.judging !== null && l.judging !== undefined);
}

export interface CellScore {
  // 每步得分的等权平均：只算要做到的不为零的步；没有这样的步为 null
  mean: number | null;
  // 进平均的步数
  scored: number;
  // 做成的步数（要做到的不为零且做成）
  solved: number;
  // 不许挂的一类里失败的用例合计
  passToPassFailed: number;
  // 要做到的为零的步数
  zeroFailToPass: number;
  // 已判的步数
  judged: number;
}

export function cellScore(
  lines: readonly StreamResultLine[],
  condition: StreamCondition,
  attempt: number,
  segment?: ReportSegment
): CellScore {
  const rows = judgedLines(lines).filter(
    (l) =>
      l.condition === condition &&
      l.attempt === attempt &&
      (segment === undefined || (l.seq >= segment.firstSeq && l.seq <= segment.lastSeq))
  );
  const scores = rows
    .map((l) => l.judging?.score)
    .filter((s): s is number => typeof s === "number");
  return {
    mean: scores.length === 0 ? null : sum(scores) / scores.length,
    scored: scores.length,
    solved: rows.filter((l) => l.judging?.solved === true).length,
    passToPassFailed: sum(rows.map((l) => l.judging?.passToPass.failed ?? 0)),
    zeroFailToPass: rows.filter((l) => l.judging?.failToPass.total === 0).length,
    judged: rows.length,
  };
}

// 无法建立两类用例基线的步数（agent 照跑、不判分，不进主判据）
export function unbuildableSteps(
  lines: readonly StreamResultLine[],
  condition: StreamCondition,
  attempt: number
): number {
  return lines.filter(
    (l) =>
      l.condition === condition &&
      l.attempt === attempt &&
      typeof l.baselineUnavailable === "string"
  ).length;
}

export interface PairedDiff {
  condition: StreamCondition;
  // 两遍都有得分的步数
  pairs: number;
  // 第 1 遍减第 2 遍的平均、平均绝对差与样本方差（步数不足 2 时为 null）
  meanDiff: number | null;
  meanAbsDiff: number | null;
  variance: number | null;
}

// 同题两遍的每步得分差（202、219）：同一格第 1、2 遍在同一步上都有得分的，逐步相减
export function pairedDiffs(lines: readonly StreamResultLine[]): PairedDiff[] {
  const out: PairedDiff[] = [];
  const judged = judgedLines(lines);
  for (const condition of conditionsIn(judged)) {
    const scoreOf = (attempt: number) =>
      new Map(
        judged
          .filter((l) => l.condition === condition && l.attempt === attempt)
          .filter((l) => typeof l.judging?.score === "number")
          .map((l) => [l.seq, l.judging?.score as number])
      );
    const first = scoreOf(1);
    const second = scoreOf(2);
    if (second.size === 0) continue;
    const diffs = [...first]
      .filter(([seq]) => second.has(seq))
      .map(([seq, s]) => s - (second.get(seq) as number));
    const n = diffs.length;
    const mean = n === 0 ? null : sum(diffs) / n;
    out.push({
      condition,
      pairs: n,
      meanDiff: mean,
      meanAbsDiff: n === 0 ? null : sum(diffs.map(Math.abs)) / n,
      variance: n < 2 || mean === null ? null : sum(diffs.map((d) => (d - mean) ** 2)) / (n - 1),
    });
  }
  return out;
}

export interface Distribution {
  n: number;
  median: number | null;
  p90: number | null;
  max: number | null;
}

// 分布：中位数（偶数个取中间两个的平均）、90 分位（最近秩）与最大值；忽略 null
export function distribution(values: readonly (number | null | undefined)[]): Distribution {
  const xs = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n, median: null, p90: null, max: null };
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
  return { n, median, p90: xs[Math.ceil(0.9 * n) - 1] as number, max: xs[n - 1] as number };
}

function fmt(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toFixed(digits);
}

function distText(d: Distribution, digits = 0): string {
  return d.n === 0
    ? "—"
    : `${fmt(d.median, digits)} / ${fmt(d.p90, digits)} / ${fmt(d.max, digits)}`;
}

function attemptsOf(lines: readonly StreamResultLine[], condition: StreamCondition): number[] {
  return [...new Set(lines.filter((l) => l.condition === condition).map((l) => l.attempt))].sort(
    (a, b) => a - b
  );
}

// 多遍的均值与范围（各遍等权，只取有得分的遍）
function acrossAttempts(means: readonly (number | null)[]): string {
  const xs = means.filter((m): m is number => m !== null);
  if (xs.length === 0) return "—";
  if (xs.length === 1) return pct(xs[0]);
  return `${pct(sum(xs) / xs.length)}（${xs.length} 遍，${pct(Math.min(...xs))}–${pct(Math.max(...xs))}）`;
}

export function renderStreamReport(
  lines: readonly StreamResultLine[],
  options: { title: string; segments: readonly ReportSegment[]; identity?: ReportIdentity }
): string {
  const out: string[] = [`# 提交流实验报告：${options.title}`, ""];
  if (options.identity !== undefined) out.push(...renderSettings(options.identity));
  const judged = judgedLines(lines);
  const legacy = lines.length - judged.length - lines.filter((l) => !l.judged).length;
  const conditions = conditionsIn(lines);
  // 只列有已判步的分段
  const segments = options.segments.filter((s) =>
    judged.some((l) => l.seq >= s.firstSeq && l.seq <= s.lastSeq)
  );
  const segHead = segments.map((s) => `${s.id}（第 ${s.firstSeq}–${s.lastSeq} 步）`);

  out.push(
    "## 每步得分（要做到的用例通过比例，各步等权；要做到的为零的步与无法建立基线的步不计）",
    "",
    `| 条件 | 遍 | 合并 | ${segHead.map((h) => `${h} | `).join("")}做成步数 | 不许挂的失败合计 | 要做到的为零的步 | 已判步数 | 无法建立基线的步 |`,
    `|---|---|---|${segments.map(() => "---|").join("")}---|---|---|---|---|`
  );
  for (const c of conditions) {
    for (const a of attemptsOf(judged, c)) {
      const all = cellScore(lines, c, a);
      const bySeg = segments.map((s) => cellScore(lines, c, a, s));
      out.push(
        `| ${c} | ${a} | ${pct(all.mean)}（${all.scored} 步） | ${bySeg.map((s) => `${pct(s.mean)}（${s.scored} 步） | `).join("")}${all.solved}/${all.scored} | ${all.passToPassFailed} | ${all.zeroFailToPass} | ${all.judged} | ${unbuildableSteps(lines, c, a)} |`
      );
    }
  }
  out.push("");
  const multi = conditions.filter((c) => attemptsOf(judged, c).length > 1);
  if (multi.length > 0) {
    out.push(
      "多遍合并（各遍等权的均值与范围）：",
      "",
      `| 条件 | 合并 | ${segHead.join(" | ")}${segHead.length > 0 ? " |" : ""}`,
      `|---|---|${segments.map(() => "---|").join("")}`
    );
    for (const c of multi) {
      const attempts = attemptsOf(judged, c);
      const cell = (s?: ReportSegment) =>
        acrossAttempts(attempts.map((a) => cellScore(lines, c, a, s).mean));
      out.push(`| ${c} | ${cell()} | ${segments.map((s) => `${cell(s)} | `).join("")}`);
    }
    out.push("");
  }

  const diffs = pairedDiffs(lines);
  if (diffs.length > 0) {
    out.push(
      "## 同题两遍的每步得分差（第 1 遍减第 2 遍；只作描述）",
      "",
      "| 条件 | 两遍都有得分的步 | 平均差 | 平均绝对差 | 差的样本方差 |",
      "|---|---|---|---|---|"
    );
    for (const d of diffs) {
      out.push(
        `| ${d.condition} | ${d.pairs} | ${d.meanDiff === null ? "—" : `${(d.meanDiff * 100).toFixed(1)} 点`} | ${
          d.meanAbsDiff === null ? "—" : `${(d.meanAbsDiff * 100).toFixed(1)} 点`
        } | ${d.variance === null ? "—" : d.variance.toFixed(4)} |`
      );
    }
    out.push("");
  }

  out.push(
    "## 每步用量（各遍合计；中位 / 90 分位 / 最大）",
    "",
    "| 条件 | 步数 | 轮数 | agent 墙钟（分，含验证门与回炉） | 花费（元） | 花费合计（元） | 上下文峰值（token） | 开工时记忆条目字符 | 开工时记忆条目数 | 复盘轮数 | 复盘墙钟（分） | 复盘花费合计（元） | 撞宽上限的步 | 撞复盘上限的次数 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const c of conditions) {
    const rows = judged.filter((l) => l.condition === c);
    const costs = rows.map((l) => l.gateway?.costCny ?? null);
    const reviewCosts = rows.map((l) => l.gateway?.reviewCostCny ?? null);
    const known = (xs: readonly (number | null)[]) => xs.filter((x): x is number => x !== null);
    out.push(
      `| ${c} | ${rows.length} | ${distText(distribution(rows.map((l) => l.turns)))} | ${distText(
        distribution(rows.map((l) => l.agentWallMs / 60_000)),
        1
      )} | ${distText(distribution(costs), 3)} | ${known(costs).length === 0 ? "—" : sum(known(costs)).toFixed(2)} | ${distText(
        distribution(rows.map((l) => l.gateway?.peakInputTokens ?? null))
      )} | ${distText(distribution(rows.map((l) => l.memoryAtStart?.entryChars ?? null)))} | ${distText(
        distribution(rows.map((l) => l.memoryAtStart?.entries ?? null))
      )} | ${distText(distribution(rows.map((l) => l.review?.turns ?? null)))} | ${distText(
        distribution(
          rows.map((l) =>
            l.review === null || l.review === undefined ? null : l.review.wallMs / 60_000
          )
        ),
        1
      )} | ${known(reviewCosts).length === 0 ? "—" : sum(known(reviewCosts)).toFixed(2)} | ${
        rows.filter((l) => l.hitStepBudget === true).length
      } | ${rows.filter((l) => l.hitReviewBudget === true).length} |`
    );
  }
  out.push("");

  const first = judged.filter((l) => l.attempt === 1);
  if (first.length > 0) {
    out.push(
      "## 每步明细（第一遍；要做到的通过数/总数，「成」为做成，「挂 n」为不许挂的失败条数）",
      "",
      `| 步序 | ${conditions.join(" | ")} |`,
      `|---|${conditions.map(() => "---").join("|")}|`
    );
    const seqs = [...new Set(first.map((l) => l.seq))].sort((a, b) => a - b);
    for (const seq of seqs) {
      const cells = conditions.map((c) => {
        const j = first.find((l) => l.seq === seq && l.condition === c)?.judging;
        if (j === null || j === undefined) return "—";
        return `${j.failToPass.passed}/${j.failToPass.total}${j.solved === true ? " 成" : ""}${
          j.passToPass.failed > 0 ? ` 挂 ${j.passToPass.failed}` : ""
        }`;
      });
      out.push(`| ${seq} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }

  const firstAll = lines.filter((l) => l.attempt === 1);
  out.push(
    "## 次要指标（第一遍）",
    "",
    "| 条件 | 类型错误（各步合计） | 格式错误（各步合计） | 轮数 | token（未命中输入 / 缓存命中 / 输出） | 墙钟（分） | 限额暂停 | 依赖环境选不出而作废的步 |",
    "|---|---|---|---|---|---|---|---|"
  );
  for (const c of conditions) {
    const rows = firstAll.filter((l) => l.condition === c);
    const q = (pick: (l: StreamResultLine) => number | null | undefined) => {
      const xs = rows.map(pick).filter((x): x is number => typeof x === "number");
      return xs.length === 0 ? "—" : String(sum(xs));
    };
    out.push(
      `| ${c} | ${q((l) => l.quality?.typeErrors)} | ${q((l) => l.quality?.formatErrors)} | ${sum(
        rows.map((l) => l.turns)
      )} | ${sum(rows.map((l) => l.usage.input))} / ${sum(rows.map((l) => l.usage.cacheRead))} / ${sum(
        rows.map((l) => l.usage.output)
      )} | ${(sum(rows.map((l) => l.wallMs)) / 60_000).toFixed(1)} | ${sum(
        rows.map((l) => l.limitPauses.length)
      )} | ${rows.filter((l) => l.outcome === "skipped").length} |`
    );
  }
  out.push("");
  if (legacy > 0) {
    out.push(
      `旧口径的结果行 ${legacy} 条（两类用例计分之前的全量测试通过率口径）：照常读出，不计入以上各表。`,
      ""
    );
  }
  return out.join("\n");
}
