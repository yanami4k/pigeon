import assert from "node:assert/strict";
import { test } from "node:test";
import { cellScore, distribution, pairedDiffs, renderStreamReport } from "./stream-report.ts";
import { sampleLine } from "./stream-result-fixtures.ts";
import type { StreamResultLine } from "./stream-results.ts";

// 一行：要做到的 passed/total、不许挂的失败数
function line(
  condition: StreamResultLine["condition"],
  seq: number,
  f2p: [number, number],
  extra: Partial<StreamResultLine> & { p2pFailed?: number } = {}
): StreamResultLine {
  const { p2pFailed = 0, ...rest } = extra;
  const [passed, total] = f2p;
  return sampleLine({
    condition,
    seq,
    judging: {
      failToPass: { passed, total },
      score: total === 0 ? null : passed / total,
      passToPass: { failed: p2pFailed, total: 10 },
      solved: total === 0 ? null : passed === total && p2pFailed === 0,
      failedCases: { failToPass: [], passToPass: [], truncated: false },
      excludedFlaky: 0,
    },
    ...rest,
  });
}

const segments = [
  { id: "s1", firstSeq: 1, lastSeq: 3 },
  { id: "s2", firstSeq: 5, lastSeq: 9 },
];

test("每步得分（201）：各步等权平均、只算要做到的不为零的步；做成步数、不许挂的失败合计与要做到的为零的步另计；按分段取", () => {
  const lines = [
    line("neither", 1, [1, 2]),
    line("neither", 2, [3, 3]),
    line("neither", 3, [0, 0], { p2pFailed: 2 }),
    line("neither", 5, [0, 4], { p2pFailed: 1 }),
    line("neither", 6, [2, 2], { outcome: "skipped", judged: false, judging: null }),
    line("neither", 1, [2, 2], { attempt: 2 }),
    line("minimal", 1, [2, 2]),
  ];
  // 第 1 遍：(0.5 + 1 + 0) / 3，第 3 步要做到的为零不计
  assert.deepEqual(cellScore(lines, "neither", 1), {
    mean: 0.5,
    scored: 3,
    solved: 1,
    passToPassFailed: 3,
    zeroFailToPass: 1,
    judged: 4,
  });
  assert.deepEqual(cellScore(lines, "neither", 1, segments[0]), {
    mean: 0.75,
    scored: 2,
    solved: 1,
    passToPassFailed: 2,
    zeroFailToPass: 1,
    judged: 3,
  });
  assert.equal(cellScore(lines, "neither", 1, segments[1]).mean, 0);
  assert.equal(cellScore(lines, "neither", 2).mean, 1);
  assert.equal(cellScore(lines, "search-only", 1).mean, null);
});

test("同题两遍的每步得分差：只取两遍都有得分的步，给平均差、平均绝对差与样本方差", () => {
  const lines = [
    line("search-only", 1, [1, 2]),
    line("search-only", 2, [2, 2]),
    line("search-only", 3, [0, 0]),
    line("search-only", 1, [2, 2], { attempt: 2 }),
    line("search-only", 2, [1, 2], { attempt: 2 }),
    line("search-only", 3, [0, 0], { attempt: 2 }),
    line("minimal", 1, [1, 1]),
  ];
  const [d] = pairedDiffs(lines);
  assert.equal(pairedDiffs(lines).length, 1, "只跑了一遍的格子不列");
  assert.equal(d?.condition, "search-only");
  assert.equal(d?.pairs, 2);
  assert.equal(d?.meanDiff, 0);
  assert.equal(d?.meanAbsDiff, 0.5);
  assert.equal(d?.variance, 0.5);
});

test("分布：中位（偶数个取中间两个平均）、90 分位（最近秩）与最大；忽略空值", () => {
  assert.deepEqual(distribution([3, 1, null, 2, 10]), { n: 4, median: 2.5, p90: 10, max: 10 });
  assert.deepEqual(distribution(Array.from({ length: 20 }, (_, i) => i + 1)), {
    n: 20,
    median: 10.5,
    p90: 18,
    max: 20,
  });
  assert.deepEqual(distribution([null, undefined]), { n: 0, median: null, p90: null, max: null });
});

test("报告：每步得分表（分段与合并）、多遍均值与范围、同题两遍差、用量分布、每步明细与次要指标；旧口径的结果行只报条数；不再有终点值与补跑提示", () => {
  const lines = [
    line("neither", 1, [1, 2], { outcome: "failed" }),
    line("neither", 5, [2, 2], {
      memoryAtStart: { bytes: 300, entries: 2, entryChars: 120 },
      gateway: {
        queueMs: 0,
        accountRequests: [3],
        peakInFlight: 1,
        costCny: 0.3,
        reviewCostCny: null,
        peakInputTokens: 50_000,
      },
    }),
    line("neither", 1, [2, 2], { attempt: 2 }),
    line("neither", 5, [2, 2], { attempt: 2, p2pFailed: 1 }),
    line("minimal", 1, [0, 2], { outcome: "failed" }),
    line("minimal", 5, [0, 0]),
    // 旧口径的行：没有 judging、带全量测试通过率
    {
      ...line("minimal", 9, [1, 1]),
      judging: undefined,
      fullPassRate: null,
    } as unknown as StreamResultLine,
  ];
  const md = renderStreamReport(lines, { title: "校准", segments });
  assert.match(md, /^# 提交流实验报告：校准/m);
  assert.match(md, /\| 条件 \| 遍 \| 合并 \| s1（第 1–3 步） \| s2（第 5–9 步） \| 做成步数 \|/);
  assert.match(
    md,
    /\| neither \| 1 \| 75\.0%（2 步） \| 50\.0%（1 步） \| 100\.0%（1 步） \| 1\/2 \| 0 \| 0 \| 2 \|/
  );
  assert.match(
    md,
    /\| neither \| 2 \| 100\.0%（2 步） \| 100\.0%（1 步） \| 100\.0%（1 步） \| 1\/2 \| 1 \| 0 \| 2 \|/
  );
  assert.match(md, /\| minimal \| 1 \| 0\.0%（1 步） \|.*\| 0\/1 \| 0 \| 1 \| 2 \|/);
  assert.match(
    md,
    /\| neither \| 87\.5%（2 遍，75\.0%–100\.0%） \| 75\.0%（2 遍，50\.0%–100\.0%） \|/
  );
  assert.match(md, /\| neither \| 2 \| -25\.0 点 \| 25\.0 点 \|/);
  assert.match(md, /## 每步用量/);
  assert.match(md, /\| neither \| 4 \| 5 \/ 5 \/ 5 \|/);
  assert.match(md, /\| 5 \| 2\/2 成 \| 0\/0 \|/);
  assert.match(md, /\| 1 \| 1\/2 \| 0\/2 \|/);
  assert.match(md, /旧口径的结果行 1 条/);
  assert.doesNotMatch(md, /终点|补跑/);
});

test("报告：次要指标单列验证工具故障的步次（决策 170 ③）——第一遍各步合计；未开回炉的条件记为—", () => {
  const lines = [
    line("neither", 1, [1, 1], { verifyToolFaults: 2 }),
    line("neither", 5, [1, 1], { verifyToolFaults: 1 }),
    line("neither", 1, [1, 1], { attempt: 2, verifyToolFaults: 5 }),
    line("minimal", 1, [1, 1], { verifyToolFaults: null }),
  ];
  const md = renderStreamReport(lines, { title: "工具故障", segments });
  const secondary = md.slice(md.indexOf("## 次要指标"));
  assert.match(secondary, /\| 依赖环境选不出而作废的步 \| 验证工具故障（步次） \|/);
  assert.match(secondary, /^\| neither \|.*\| 3 \|$/m);
  assert.match(secondary, /^\| minimal \|.*\| — \|$/m);
});
