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
  // 新结果行不带撤回字段：次要指标表没有"撤回"列
  assert.match(md, /\| 条件 \| 判定通过 \| 回归 \|/);
  assert.doesNotMatch(md, /\| 撤回 \|/);
  assert.match(md, /\| no-gate \| 1\/2 \| 1 \|/);
  // 用量按未命中输入、缓存命中、输出分列（额度不计缓存命中的部分）：夹具每行 10 / 0 / 5，三行合计
  assert.match(md, /\| no-gate \| 1\/2 \|.*\| 30 \/ 0 \/ 15 \|/);
  assert.match(md, /没做出来 1/);
  assert.match(md, /回归 1/);
  assert.match(md, /no-gate 与 minimal：终点相差 10\.0 个百分点/);
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
    renderStreamReport(lines, { title: "t", streams: [{ id: "s1", lastSeq: 2 }] }),
    /人的基准：内存峰值最大 1600 MiB/
  );
});

test("报告：旧结果行带撤回字段时照常生成，次要指标表带「撤回」列，旧的缺前置归因照常显示", () => {
  const legacy = (seq: number, extra: Record<string, unknown>): StreamResultLine =>
    ({ ...line("full", seq, [5, 10]), ...extra }) as StreamResultLine;
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
  assert.match(md, /\| 条件 \| 判定通过 \| 撤回 \| 回归 \|/);
  assert.match(md, /\| full \| 1\/3 \| 1 \| 0 \|/);
  assert.match(md, /缺前置 1/);
});
