// 决策 286 第 2 项：输入框下方一行状态栏——模型、上下文用量百分比、本会话花费、后台补做复盘进度。
// 花费的价格来源是会话记录里模型回复自带的用量与价格；没有价格时显示 token 数并注明无价格；续接会话从会话记录累计
// 已有花费（主会话、其 worker 与其复盘）；后台补做的花费单独显示、不并入。窄终端按优先级截断，不折行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ReviewBackfillSummary } from "../application/review-backfill.ts";
import { emptyCostTally } from "../application/session-cost.ts";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { backfillStatusOf, backfillSummaryLine } from "./backfill-view.ts";
import { ScriptedRuntime, usageOf } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { formatCost, statusBarText } from "./status-bar.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function lastLine(term: MockTerminal): string {
  return term.screen.contentLines().at(-1) ?? "";
}

function makeShell(options: { cols?: number; sessionId?: SessionId; root?: string }): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: ScriptedRuntime;
  cleanup: () => void;
} {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-status-"));
  const sessionId = options.sessionId ?? newSessionId();
  const term = new MockTerminal(options.cols ?? 100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    model: "deepseek/deepseek-chat",
    ...(options.root !== undefined ? { sessions: { root: options.root } } : {}),
  });
  return {
    shell,
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("状态栏在输入框下方：模型、上下文用量随最近一次回复与压缩更新、本会话花费按轮累计", async () => {
  const { shell, term, runtime, cleanup } = makeShell({});
  try {
    runtime.context = { tokens: 0, contextWindow: 200_000 };
    shell.start();
    await settle();
    assert.equal(lastLine(term).trim(), "deepseek/deepseek-chat | ctx 0% (0/200k) | cost $0");

    term.input("任务");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.context = { tokens: 50_000, contextWindow: 200_000 };
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(50_000, 0.0123),
    });
    await settle();
    assert.equal(
      lastLine(term).trim(),
      "deepseek/deepseek-chat | ctx 25% (50k/200k) | cost $0.0123"
    );
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(1000, 0.0007),
    });
    // 压缩后上下文用量随之下降
    runtime.context = { tokens: 8000, contextWindow: 200_000 };
    runtime.compacted(50_000, 8000);
    await settle();
    assert.equal(
      lastLine(term).trim(),
      "deepseek/deepseek-chat | ctx 4% (8.0k/200k) | cost $0.0130"
    );
  } finally {
    cleanup();
  }
});

test("没有价格的回复：显示 token 数并注明无价格；有价格与无价格并存时两者都显示", async () => {
  const { shell, term, runtime, cleanup } = makeShell({});
  try {
    shell.start();
    await settle();
    term.input("任务");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(12_345, 0),
    });
    await settle();
    assert.ok(lastLine(term).includes("cost 12k tok (no price)"), lastLine(term));
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(100, 0.5),
    });
    await settle();
    assert.ok(lastLine(term).includes("cost $0.5000 + 12k tok (no price)"), lastLine(term));
  } finally {
    cleanup();
  }
});

test("续接会话从会话记录累计已有花费：主会话 + 其 worker + 其复盘；别的会话与无关子会话不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    main.assistant({ text: "好", usage: usageOf(1000, 0.05) });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w1", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({ text: "做完", usage: usageOf(500, 0.02) });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({
      task: "复盘",
      config: { memoryReview: { kind: "pre-compaction", template: "t" } },
    });
    review.assistant({ text: "记下了", usage: usageOf(300, 0.003) });
    review.endRun();
    await review.close();
    const other = createFixtureSession({ sessionsDir });
    other.startRun({ task: "别的会话" });
    other.assistant({ text: "嗯", usage: usageOf(100, 9) });
    other.endRun();
    await other.close();

    const { shell, term, cleanup } = makeShell({ sessionId: main.sessionId, root });
    try {
      shell.start();
      await settle();
      assert.ok(lastLine(term).includes("cost $0"), "新开时从零算");
      shell.announceResumed(root, ["续跑报告"]);
      await settle();
      assert.ok(lastLine(term).includes("cost $0.0730"), lastLine(term));
      assert.ok(screenText(term).includes("续跑报告"));
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本会话运行期间收尾的 worker 花费计入；没收尾的不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-child-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const mainId = newSessionId();
    const { shell, term, runtime, cleanup } = makeShell({ sessionId: mainId, root });
    try {
      shell.start();
      await settle();
      const main = createFixtureSession({ sessionsDir, sessionId: mainId });
      main.startRun({ task: "主任务" });
      const worker = spawnFixtureWorker(main, { sessionsDir, name: "w2", task: "子任务" });
      worker.startRun({ task: "子任务" });
      worker.assistant({ text: "进行中", usage: usageOf(400, 0.04) });
      await worker.writer.flush();
      term.input("任务");
      term.input("\r");
      await settle();
      assert.ok(lastLine(term).includes("cost $0"), "worker 没收尾不计");
      worker.endRun();
      await worker.close();
      await main.close();
      term.input("再来");
      term.input("\r");
      await settle();
      assert.deepEqual(runtime.runs, ["任务", "再来"]);
      assert.ok(lastLine(term).includes("cost $0.0400"), lastLine(term));
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("后台补做进度进状态栏（第几个、共几个、花了多少）；消息区只留失败或全部补完一行", async () => {
  const { shell, term, cleanup } = makeShell({});
  try {
    shell.start();
    await settle();
    const cost = { cost: 0.01, pricedTokens: 1000, unpricedTokens: 0 };
    shell.setBackfillProgress(
      backfillStatusOf({ planned: 5, current: 2, completed: 1, failed: 0, cost })
    );
    await settle();
    assert.ok(lastLine(term).includes("backfill 2/5 $0.0100"), lastLine(term));
    assert.ok(!screenText(term).includes("后台补做复盘"), "进度不进消息区");
    assert.ok(lastLine(term).includes("cost $0 "), "补做花费不并入本会话");
    shell.setBackfillProgress(
      backfillStatusOf({ planned: 5, completed: 5, failed: 0, cost: emptyCostTally() })
    );
    await settle();
    assert.ok(!lastLine(term).includes("backfill"), "不在补时不显示");
  } finally {
    cleanup();
  }
  const summary = (over: Partial<ReviewBackfillSummary>): ReviewBackfillSummary => ({
    planned: 2,
    completed: [],
    failed: [],
    stale: [],
    busy: [],
    ...over,
  });
  const done = [newSessionId(), newSessionId()];
  const last = {
    planned: 2,
    completed: 2,
    failed: 0,
    cost: { cost: 0.02, pricedTokens: 10, unpricedTokens: 0 },
  };
  assert.equal(
    backfillSummaryLine(summary({ completed: done }), last),
    "后台补做复盘：全部补完（2 个，花费 $0.0200）"
  );
  assert.equal(
    backfillSummaryLine(
      summary({
        completed: [done[0] as SessionId],
        failed: [{ sessionId: done[1] as SessionId, error: "超时" }],
      }),
      last
    ),
    "后台补做复盘：1 个失败，留待下次启动重试（首个原因：超时）"
  );
  assert.equal(backfillSummaryLine(summary({ planned: 0 }), undefined), undefined);
});

test("窄终端按优先级截断、不折行：先换短写法，再依次去掉补做、模型、花费，上下文用量留到最后", async () => {
  const state = {
    model: "deepseek/deepseek-chat",
    context: { tokens: 50_000, contextWindow: 200_000 },
    cost: { cost: 1.23456, pricedTokens: 1, unpricedTokens: 0 },
    backfill: {
      planned: 5,
      current: 3,
      completed: 2,
      failed: 0,
      cost: { cost: 0.1, pricedTokens: 1, unpricedTokens: 0 },
    },
  };
  assert.equal(
    statusBarText(state, 200),
    "deepseek/deepseek-chat | ctx 25% (50k/200k) | cost $1.2346 | backfill 3/5 $0.1000"
  );
  assert.equal(
    statusBarText(state, 70),
    "deepseek/deepseek-chat | ctx 25% | cost $1.23 | backfill 3/5"
  );
  assert.equal(statusBarText(state, 50), "deepseek/deepseek-chat | ctx 25% | cost $1.23");
  assert.equal(statusBarText(state, 30), "ctx 25% | cost $1.23");
  assert.equal(statusBarText(state, 12), "ctx 25%");
  assert.equal(statusBarText(state, 5), "ctx 2");
  assert.equal(formatCost({ cost: 0, pricedTokens: 0, unpricedTokens: 0 }, false), "$0");

  const { shell, term, runtime, cleanup } = makeShell({ cols: 40 });
  try {
    runtime.context = { tokens: 150_000, contextWindow: 200_000 };
    shell.start();
    await settle();
    const bar = lastLine(term);
    assert.ok(visibleWidth(bar) <= 40, bar);
    assert.ok(bar.includes("ctx 75%"), bar);
    assert.equal(
      term.screen.contentLines().filter((line) => line.includes("ctx 75%")).length,
      1,
      "状态栏恰好一行"
    );
  } finally {
    cleanup();
  }
});
