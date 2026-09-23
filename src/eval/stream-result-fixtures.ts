// 测试夹具：一条完整的延续式结果行，供结果行与报告的测试改写字段使用。只供测试使用。
import type { StreamResultLine } from "./stream-results.ts";

export function sampleLine(overrides: Partial<StreamResultLine> = {}): StreamResultLine {
  return {
    repo: "pigeon-harness",
    stream: "s1",
    condition: "no-gate",
    attempt: 1,
    seq: 1,
    kind: "task",
    commit: "c1",
    outcome: "passed",
    head: "h1",
    judged: true,
    repairRounds: null,
    reverted: false,
    finalVerdict: null,
    repairBudgetExhausted: null,
    fullPassRate: {
      byCount: { passed: 3, total: 4, rate: 0.75 },
      byCountCollected: { passed: 3, total: 5, rate: 0.6 },
      byTask: { passed: 1, total: 1, rate: 1 },
      humanFlaky: 0,
      humanRuns: [{ peakBytes: 500 * 1048576, limitBytes: 2048 * 1048576, wallMs: 60_000 }],
      humanSlowest: { id: "src/a.test.ts::slow", seconds: 3.5 },
    },
    regressions: 0,
    quality: { typeErrors: 0, formatErrors: 0, layerViolations: 0 },
    status: "completed",
    turns: 5,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    agentWallMs: 1000,
    wallMs: 2000,
    attribution: null,
    limitPauses: [],
    harnessRef: { commit: "abc", dirty: false },
    ...overrides,
  };
}
