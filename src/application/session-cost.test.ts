// 会话花费（决策 286 第 2 项）：价格取会话记录里模型回复自带的用量与价格，没有价格的 token 单列；
// 本会话 = 主会话 + 其 worker + 其复盘；/fork 分支与别的会话不计；运行期间新出现的子会话收尾后计入一次。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accumulatedSessionCost,
  ChildSessionCosts,
  costTallyOfView,
  sessionCostTally,
} from "./session-cost.ts";
import { createFixtureSession, forkFixture, spawnFixtureWorker } from "./session-store-fixtures.ts";

function usage(totalTokens: number, cost: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("累计花费：主会话 + worker + 复盘；/fork 分支、别的会话不计；无价格的 token 单列；工具另发请求的用量计入", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const main = createFixtureSession({ sessionsDir });
    const runId = main.startRun({ task: "主任务" });
    main.assistant({ text: "好", usage: usage(1000, 0.1) });
    main.toolTurn({
      name: "web_fetch",
      result: "提炼",
      details: { modelUsage: usage(200, 0.01) },
    });
    main.assistant({ text: "没有价格的模型", usage: usage(700, 0) });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({ text: "做完", usage: usage(300, 0.02) });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({ text: "记下", usage: usage(50, 0.005) });
    review.endRun();
    await review.close();
    const branch = await forkFixture({
      sessionsDir,
      sourceSessionId: main.sessionId,
      runId,
      runSeq: 2,
    });
    branch.startRun({ task: "分支续跑" });
    branch.assistant({ text: "分支", usage: usage(999, 5) });
    branch.endRun();
    await branch.close();

    const own = sessionCostTally(sessionsDir, main.sessionId);
    assert.deepEqual(
      { cost: Number(own.cost.toFixed(4)), priced: own.pricedTokens, unpriced: own.unpricedTokens },
      { cost: 0.11, priced: 1200, unpriced: 700 }
    );
    const total = accumulatedSessionCost(sessionsDir, main.sessionId);
    assert.equal(Number(total.cost.toFixed(4)), 0.135, "0.1 + 0.01 + 0.02 + 0.005，不含分支的 5");
    assert.equal(total.unpricedTokens, 700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行期间的子会话：收尾后计入一次；没收尾的下次再看；打开之前就有的不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-child-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    const early = spawnFixtureWorker(main, { sessionsDir, name: "early", task: "早先的" });
    early.startRun({ task: "早先的" });
    early.assistant({ text: "早", usage: usage(10, 1) });
    early.endRun();
    await early.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tracker = new ChildSessionCosts(sessionsDir, main.sessionId, Date.now());
    const late = spawnFixtureWorker(main, { sessionsDir, name: "late", task: "之后的" });
    late.startRun({ task: "之后的" });
    late.assistant({ text: "晚", usage: usage(20, 0.3) });
    await late.writer.flush();
    assert.equal(tracker.collect().cost, 0, "没收尾不计");
    late.endRun();
    await late.close();
    assert.equal(tracker.collect().cost, 0.3);
    assert.equal(tracker.collect().cost, 0, "只计一次");
    main.endRun();
    await main.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-09-29（周二）北京时间 10:00（高峰）与 20:00（空闲）
const PEAK_MS = Date.UTC(2026, 8, 29, 2, 0, 0);
const OFF_PEAK_MS = Date.UTC(2026, 8, 29, 12, 0, 0);

function deepseekMessage(startMs: number, endMs: number, input: number, provider = "deepseek") {
  return {
    role: "assistant",
    raw: { provider, timestamp: startMs },
    timestamp: endMs,
    usage: { ...usage(input, 0), input },
  };
}

test("DeepSeek 回复自带价格为 0：按官方人民币价目计，高峰翻倍；别的模型价格为 0 仍记作无价格", () => {
  // 缓存未命中输入 100 万 token：空闲 ¥1、高峰 ¥2
  const view = (messages: unknown[]) =>
    ({ messages }) as unknown as Parameters<typeof costTallyOfView>[0];
  const offPeak = costTallyOfView(
    view([deepseekMessage(OFF_PEAK_MS, OFF_PEAK_MS + 5000, 1_000_000)])
  );
  assert.deepEqual(offPeak, {
    cost: 0,
    pricedTokens: 0,
    cny: 1,
    cnyTokens: 1_000_000,
    unpricedTokens: 0,
  });
  const peak = costTallyOfView(view([deepseekMessage(PEAK_MS, PEAK_MS + 5000, 1_000_000)]));
  assert.equal(peak.cny, 2);
  // 开始在空闲、结束落进高峰：整条按高峰（与跑批网关同一口径）
  const straddle = costTallyOfView(
    view([deepseekMessage(PEAK_MS - 60_000, PEAK_MS + 1000, 1_000_000)])
  );
  assert.equal(straddle.cny, 2);
  const other = costTallyOfView(view([deepseekMessage(PEAK_MS, PEAK_MS, 1_000_000, "custom")]));
  assert.deepEqual(other, {
    cost: 0,
    pricedTokens: 0,
    cny: 0,
    cnyTokens: 0,
    unpricedTokens: 1_000_000,
  });
});

test("DeepSeek 计价同样用于续接累计：主会话、worker 与复盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-deepseek-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    main.assistant({
      text: "好",
      provider: "deepseek",
      timestamp: PEAK_MS,
      usage: { ...usage(1_000_000, 0) },
    });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({
      text: "做完",
      provider: "deepseek",
      timestamp: PEAK_MS,
      usage: usage(500_000, 0),
    });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({
      text: "记下",
      provider: "deepseek",
      timestamp: PEAK_MS,
      usage: usage(250_000, 0),
    });
    review.endRun();
    await review.close();
    const total = accumulatedSessionCost(sessionsDir, main.sessionId);
    // 高峰价：(100 万 + 50 万 + 25 万) 未命中输入 × ¥1/百万 × 2
    assert.equal(Number(total.cny.toFixed(6)), 3.5);
    assert.equal(total.cnyTokens, 1_750_000);
    assert.equal(total.unpricedTokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
