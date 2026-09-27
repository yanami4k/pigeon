import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineFacts, endValues, renderStreamReport, rerunHints } from "./stream-report.ts";
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
    fullPassRate: {
      byCount: rate(...byCount),
      byCountCollected: rate(byCount[0], byCount[1] + 1),
      byTask: rate(1, 1),
      humanFlaky: 0,
      humanRuns: [],
      humanSlowest: null,
    },
    ...extra,
  });
}

const streams = [{ id: "tasks", lastSeq: 3 }];

test("终点值：取流末步的按条数通过率；没跑到末步的记未跑完；多遍给均值与范围", () => {
  const lines = [
    line("neither", 1, [5, 10]),
    line("neither", 2, [6, 10]),
    line("neither", 3, [7, 10]),
    line("neither", 3, [9, 10], { attempt: 2 }),
    line("neither", 1, [5, 10], { attempt: 2 }),
    line("minimal", 1, [4, 10]),
    line("minimal", 2, [3, 10]),
  ];
  const ends = endValues(lines, streams);
  assert.deepEqual(ends.get("tasks|neither"), {
    attempts: [0.7, 0.9],
    mean: 0.8,
    min: 0.7,
    max: 0.9,
  });
  assert.deepEqual(ends.get("tasks|minimal"), { attempts: [], mean: null, min: null, max: null });
});

test("补跑提示（146）：两个条件第一遍终点相差不足 10 个百分点才提示，没跑完的不比", () => {
  const lines = [
    line("neither", 3, [80, 100]),
    line("minimal", 3, [75, 100]),
    line("search-push", 3, [95, 100]),
    line("search-only", 2, [80, 100]),
  ];
  assert.deepEqual(rerunHints(lines, streams), [
    { stream: "tasks", a: "neither", b: "minimal", gapPoints: 5 },
  ]);
});

test("报告：曲线表、终点、次要指标与补跑提示；不再列回归数与失败归因", () => {
  const lines = [
    line("neither", 1, [5, 10], { outcome: "failed" }),
    line("neither", 2, [6, 10]),
    line("neither", 3, [8, 10], { outcome: "skipped", judged: false }),
    line("minimal", 1, [5, 10]),
    line("minimal", 2, [5, 10], { outcome: "failed" }),
    line("minimal", 3, [7, 10], { outcome: "skipped", judged: false }),
  ];
  const md = renderStreamReport(lines, { title: "试跑", streams });
  assert.match(md, /^# 提交流实验报告：试跑/m);
  assert.match(md, /\| 步序 \| 类型 \| neither \| minimal \|/);
  assert.match(md, /\| 1 \| 题 \| 50\.0% \| 50\.0% \|/);
  assert.match(md, /\| 3 \| 题 \| 80\.0% \| 70\.0% \|/);
  assert.match(md, /终点（按条数）：neither 80\.0%；minimal 70\.0%/);
  // 新结果行不带撤回字段：次要指标表没有"撤回"列
  assert.match(md, /\| 条件 \| 判定通过 \| 终点按题 \|/);
  assert.doesNotMatch(md, /\| 撤回 \|/);
  assert.doesNotMatch(md, /回归|失败归因/);
  assert.match(md, /\| neither \| 1\/2 \| 100\.0% \|/);
  // 用量按未命中输入、缓存命中、输出分列（额度不计缓存命中的部分）：夹具每行 10 / 0 / 5，三行合计
  assert.match(md, /\| neither \| 1\/2 \|.*\| 30 \/ 0 \/ 15 \|/);
  assert.match(md, /neither 与 minimal：终点相差 10\.0 个百分点/);
  assert.doesNotMatch(md, /提示补跑/);
});

test("人的基准：取各步各遍内存峰值的最大值与其上限，超过上限的 75% 时标出；单遍最长墙钟；最慢用例", () => {
  const MiB = 1048576;
  const withBaseline = (
    seq: number,
    runs: { peakBytes: number | null; limitBytes: number | null; wallMs: number }[],
    slowest: { id: string; seconds: number } | null
  ) =>
    sampleLine({
      seq,
      fullPassRate: {
        byCount: rate(1, 1),
        byCountCollected: rate(1, 1),
        byTask: rate(1, 1),
        humanFlaky: 0,
        humanRuns: runs,
        humanSlowest: slowest,
      },
    });
  const lines = [
    withBaseline(
      1,
      [
        { peakBytes: 900 * MiB, limitBytes: 2048 * MiB, wallMs: 240_000 },
        { peakBytes: 1600 * MiB, limitBytes: 2048 * MiB, wallMs: 300_000 },
      ],
      { id: "t.py::a", seconds: 12.5 }
    ),
    withBaseline(2, [{ peakBytes: 1000 * MiB, limitBytes: 2048 * MiB, wallMs: 200_000 }], {
      id: "t.py::b",
      seconds: 40.25,
    }),
  ];
  assert.equal(
    baselineFacts(lines),
    "内存峰值最大 1600 MiB（第 1 步，上限 2048 MiB，超过上限的 75%）；单遍最长 5.0 分；最慢用例 t.py::b（40.3 秒）"
  );
  assert.equal(
    baselineFacts([withBaseline(1, [{ peakBytes: null, limitBytes: null, wallMs: 60_000 }], null)]),
    "内存峰值未测得；单遍最长 1.0 分；最慢用例未测得"
  );
  assert.match(
    renderStreamReport(lines, { title: "t", streams: [{ id: "tasks", lastSeq: 2 }] }),
    /人的基准：内存峰值最大 1600 MiB/
  );
});

test("报告：旧结果行带撤回与延续式字段时照常生成，次要指标表带「撤回」列", () => {
  const legacy = (seq: number, extra: Record<string, unknown>): StreamResultLine =>
    ({ ...line("search-push", seq, [5, 10]), ...extra }) as StreamResultLine;
  const lines = [
    legacy(1, {
      outcome: "failed",
      reverted: true,
      repairBudgetExhausted: false,
      attribution: "not-done",
    }),
    legacy(2, { reverted: false, repairBudgetExhausted: false }),
    legacy(3, {
      outcome: "failed",
      reverted: false,
      repairBudgetExhausted: false,
      attribution: "missing-prerequisite",
    }),
  ];
  const md = renderStreamReport(lines, { title: "旧结果", streams });
  assert.match(md, /\| 条件 \| 判定通过 \| 撤回 \| 终点按题 \|/);
  assert.match(md, /\| search-push \| 1\/3 \| 1 \| 100\.0% \|/);
});
