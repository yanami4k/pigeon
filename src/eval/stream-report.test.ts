import assert from "node:assert/strict";
import { test } from "node:test";
import { endValues, renderStreamReport, rerunHints } from "./stream-report.ts";
import { sampleLine } from "./stream-result-fixtures.ts";
import type { StreamResultLine } from "./stream-results.ts";

function rate(passed: number, total: number) {
  return { passed, total, rate: total === 0 ? 1 : passed / total };
}

function line(
  condition: StreamResultLine["condition"],
  seq: number,
  byCount: [number, number],
  extra: Partial<StreamResultLine> = {}
): StreamResultLine {
  return sampleLine({
    condition,
    seq,
    fullPassRate: { byCount: rate(...byCount), byTask: rate(1, 1) },
    ...extra,
  });
}

const streams = [{ id: "s1", lastSeq: 3 }];

test("终点值：取流末步的按条数通过率；没跑到末步的记未跑完；多遍给均值与范围", () => {
  const lines = [
    line("no-gate", 1, [5, 10]),
    line("no-gate", 2, [6, 10]),
    line("no-gate", 3, [7, 10]),
    line("no-gate", 3, [9, 10], { attempt: 2 }),
    line("no-gate", 1, [5, 10], { attempt: 2 }),
    line("minimal", 1, [4, 10]),
    line("minimal", 2, [3, 10]),
  ];
  const ends = endValues(lines, streams);
  assert.deepEqual(ends.get("s1|no-gate"), { attempts: [0.7, 0.9], mean: 0.8, min: 0.7, max: 0.9 });
  assert.deepEqual(ends.get("s1|minimal"), { attempts: [], mean: null, min: null, max: null });
});

test("补跑提示（146）：两个条件第一遍终点相差不足 10 个百分点才提示，没跑完的不比", () => {
  const lines = [
    line("no-gate", 3, [80, 100]),
    line("minimal", 3, [75, 100]),
    line("full", 3, [95, 100]),
    line("no-memory", 2, [80, 100]),
  ];
  assert.deepEqual(rerunHints(lines, streams), [
    { stream: "s1", a: "no-gate", b: "minimal", gapPoints: 5 },
  ]);
});

test("报告：曲线表、终点、次要指标与补跑提示", () => {
  const lines = [
    line("no-gate", 1, [5, 10], { attribution: "not-done", outcome: "failed", regressions: 1 }),
    line("no-gate", 2, [6, 10], { kind: "maintenance" }),
    line("no-gate", 3, [8, 10], { kind: "apply", outcome: "applied", judged: false }),
    line("minimal", 1, [5, 10]),
    line("minimal", 2, [5, 10], { outcome: "failed", attribution: "regression", regressions: 2 }),
    line("minimal", 3, [7, 10], { kind: "apply", outcome: "applied", judged: false }),
  ];
  const md = renderStreamReport(lines, { title: "试跑", streams });
  assert.match(md, /^# 延续式实验报告：试跑/m);
  assert.match(md, /\| 步序 \| 类型 \| no-gate \| minimal \|/);
  assert.match(md, /\| 1 \| 题 \| 50\.0% \| 50\.0% \|/);
  assert.match(md, /\| 3 \| 套用 \| 80\.0% \| 70\.0% \|/);
  assert.match(md, /终点（按条数）：no-gate 80\.0%；minimal 70\.0%/);
  assert.match(md, /\| no-gate \| 1\/2 \| 0 \| 1 \|/);
  assert.match(md, /没做出来 1/);
  assert.match(md, /回归 1/);
  assert.match(md, /no-gate 与 minimal：终点相差 10\.0 个百分点/);
  assert.doesNotMatch(md, /提示补跑/);
});
