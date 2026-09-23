// 延续式实验的报告（第 21 条；决策 145、146）：
//   健康度曲线——每条流、每个条件的全量测试通过率（按条数）随步数的变化，给出终点值（多遍时给均值与范围）；
//   次要指标——判定通过数、撤回数、回归数、机检错误数（终点）、失败归因分布、轮数、token、墙钟、限额暂停；
//   补跑提示——任意两个条件第一遍的终点值相差小于 10 个百分点，即提示这两个条件各补跑到 3 遍（146）。
// 终点指流清单里该流的最后一步；没跑到那一步（试跑或中途停止）的记为未跑完，不参与补跑比较。
import { ATTRIBUTION_LABELS, type FailureAttribution } from "./stream-attribution.ts";
import {
  STREAM_CONDITIONS,
  type StreamCondition,
  type StreamResultLine,
} from "./stream-results.ts";

export interface ReportStream {
  id: string;
  lastSeq: number;
}

export interface EndValue {
  // 各遍的终点值（按第几遍排序）；未跑完的遍不在其中
  attempts: number[];
  mean: number | null;
  min: number | null;
  max: number | null;
}

// 146 的补跑门槛：百分点
export const RERUN_GAP_POINTS = 10;

const KIND_LABELS: Record<string, string> = {
  task: "题",
  maintenance: "维护步",
  apply: "套用",
  skip: "跳过",
  reset: "重置",
};

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function conditionsIn(lines: readonly StreamResultLine[]): StreamCondition[] {
  const present = new Set(lines.map((l) => l.condition));
  return STREAM_CONDITIONS.filter((c) => present.has(c));
}

export function endValues(
  lines: readonly StreamResultLine[],
  streams: readonly ReportStream[]
): Map<string, EndValue> {
  const out = new Map<string, EndValue>();
  for (const s of streams) {
    for (const condition of conditionsIn(lines)) {
      const finals = lines
        .filter((l) => l.stream === s.id && l.condition === condition && l.seq === s.lastSeq)
        .filter((l) => l.fullPassRate !== null)
        .sort((a, b) => a.attempt - b.attempt)
        .map((l) => l.fullPassRate?.byCount.rate ?? 0);
      const mean = finals.length === 0 ? null : finals.reduce((a, b) => a + b, 0) / finals.length;
      out.set(`${s.id}|${condition}`, {
        attempts: finals,
        mean,
        min: finals.length === 0 ? null : Math.min(...finals),
        max: finals.length === 0 ? null : Math.max(...finals),
      });
    }
  }
  return out;
}

export interface RerunHint {
  stream: string;
  a: StreamCondition;
  b: StreamCondition;
  gapPoints: number;
}

function firstAttemptEnd(
  lines: readonly StreamResultLine[],
  stream: ReportStream,
  condition: StreamCondition
): number | null {
  const final = lines.find(
    (l) =>
      l.stream === stream.id &&
      l.condition === condition &&
      l.attempt === 1 &&
      l.seq === stream.lastSeq
  );
  return final?.fullPassRate?.byCount.rate ?? null;
}

function pairGaps(
  lines: readonly StreamResultLine[],
  streams: readonly ReportStream[]
): RerunHint[] {
  const out: RerunHint[] = [];
  const conditions = conditionsIn(lines);
  for (const s of streams) {
    for (let i = 0; i < conditions.length; i++) {
      for (let j = i + 1; j < conditions.length; j++) {
        const a = conditions[i] as StreamCondition;
        const b = conditions[j] as StreamCondition;
        const ea = firstAttemptEnd(lines, s, a);
        const eb = firstAttemptEnd(lines, s, b);
        if (ea === null || eb === null) continue;
        out.push({ stream: s.id, a, b, gapPoints: Math.round(Math.abs(ea - eb) * 1000) / 10 });
      }
    }
  }
  return out;
}

export function rerunHints(
  lines: readonly StreamResultLine[],
  streams: readonly ReportStream[]
): RerunHint[] {
  return pairGaps(lines, streams).filter((h) => h.gapPoints < RERUN_GAP_POINTS);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function renderStreamReport(
  lines: readonly StreamResultLine[],
  options: { title: string; streams: readonly ReportStream[] }
): string {
  const out: string[] = [`# 延续式实验报告：${options.title}`, ""];
  const conditions = conditionsIn(lines);
  const ends = endValues(lines, options.streams);
  for (const s of options.streams) {
    const ofStream = lines.filter((l) => l.stream === s.id && l.attempt === 1);
    if (ofStream.length === 0) continue;
    out.push(
      `## 流 ${s.id}（末步 ${s.lastSeq}）`,
      "",
      "### 健康度曲线（全量测试通过率，按条数，第一遍）",
      ""
    );
    out.push(`| 步序 | 类型 | ${conditions.join(" | ")} |`);
    out.push(`|---|---|${conditions.map(() => "---").join("|")}|`);
    const seqs = [...new Set(ofStream.map((l) => l.seq))].sort((a, b) => a - b);
    for (const seq of seqs) {
      const kind = ofStream.find((l) => l.seq === seq)?.kind ?? "";
      const cells = conditions.map((c) =>
        pct(ofStream.find((l) => l.seq === seq && l.condition === c)?.fullPassRate?.byCount.rate)
      );
      out.push(`| ${seq} | ${KIND_LABELS[kind] ?? kind} | ${cells.join(" | ")} |`);
    }
    out.push("");
    const endText = conditions
      .map((c) => {
        const e = ends.get(`${s.id}|${c}`);
        if (e === undefined || e.mean === null) return `${c} 未跑完`;
        return e.attempts.length > 1
          ? `${c} ${pct(e.mean)}（${e.attempts.length} 遍，${pct(e.min)}–${pct(e.max)}）`
          : `${c} ${pct(e.mean)}`;
      })
      .join("；");
    out.push(`终点（按条数）：${endText}`, "");

    out.push("### 次要指标（第一遍）", "");
    out.push(
      "| 条件 | 判定通过 | 撤回 | 回归 | 终点按题 | 终点类型错误 | 终点格式错误 | 终点分层违规 | 轮数 | token（未命中输入 / 缓存命中 / 输出） | 墙钟（分） | 限额暂停 |"
    );
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    const attributionLines: string[] = [];
    for (const c of conditions) {
      const rows = ofStream.filter((l) => l.condition === c);
      const judged = rows.filter((l) => l.judged);
      const last = [...rows].sort((a, b) => b.seq - a.seq)[0];
      out.push(
        `| ${c} | ${judged.filter((l) => l.outcome === "passed").length}/${judged.length} | ${
          rows.filter((l) => l.reverted).length
        } | ${sum(rows.map((l) => l.regressions ?? 0))} | ${pct(last?.fullPassRate?.byTask.rate)} | ${
          last?.quality?.typeErrors ?? "—"
        } | ${last?.quality?.formatErrors ?? "—"} | ${last?.quality?.layerViolations ?? "—"} | ${sum(
          rows.map((l) => l.turns)
        )} | ${sum(rows.map((l) => l.usage.input))} / ${sum(rows.map((l) => l.usage.cacheRead))} / ${sum(
          rows.map((l) => l.usage.output)
        )} | ${(sum(rows.map((l) => l.wallMs)) / 60_000).toFixed(
          1
        )} | ${sum(rows.map((l) => l.limitPauses.length))} |`
      );
      const counts = new Map<FailureAttribution, number>();
      for (const r of rows) {
        if (r.attribution !== null) counts.set(r.attribution, (counts.get(r.attribution) ?? 0) + 1);
      }
      const text = [...counts.entries()]
        .map(([k, n]) => `${ATTRIBUTION_LABELS[k]} ${n}`)
        .join("、");
      attributionLines.push(`- ${c}：${text === "" ? "无失败" : text}`);
    }
    out.push("", "失败归因：", "", ...attributionLines, "");
  }
  const gaps = pairGaps(lines, options.streams);
  out.push("## 补跑判定（146：第一遍终点相差小于 10 个百分点即各补跑到 3 遍）", "");
  if (gaps.length === 0) out.push("没有两个条件都跑完第一遍的流，暂不比较。");
  for (const g of gaps) {
    const hint = g.gapPoints < RERUN_GAP_POINTS ? "，提示补跑：这两个条件各补跑到 3 遍" : "";
    out.push(
      `- 流 ${g.stream}，${g.a} 与 ${g.b}：终点相差 ${g.gapPoints.toFixed(1)} 个百分点${hint}`
    );
  }
  out.push("");
  return out.join("\n");
}
