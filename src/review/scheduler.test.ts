// 后台审阅调度（M6 S2，决策 064 子裁决 ①②④）：主会话每 N 轮触发一次（缺省 8），Run 结束固定补一次；
// N 为 0 表示只在 Run 结束审，关闭则一律不审。全局同时只跑 1 个审阅，上一次未收尾则跳过本次并记录。
// 审阅派出或收尾出错一律吞掉并记下，主 Run 不受影响。每次审阅只喂上次审阅点之后的增量。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newRunId, newSessionId } from "../state/ids.ts";
import {
  createReviewGate,
  DEFAULT_REVIEW_EVERY_TURNS,
  ReviewScheduler,
  type ReviewSkip,
  type ReviewSpawnRequest,
} from "./scheduler.ts";

function harness(
  options: {
    everyTurns?: number;
    enabled?: boolean;
    gate?: ReturnType<typeof createReviewGate>;
  } = {}
) {
  const spawns: ReviewSpawnRequest[] = [];
  const skips: ReviewSkip[] = [];
  const errors: unknown[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let throughRunSeq = 0;
  const scheduler = new ReviewScheduler({
    sessionId: newSessionId(),
    everyTurns: options.everyTurns ?? DEFAULT_REVIEW_EVERY_TURNS,
    enabled: options.enabled ?? true,
    gate: options.gate ?? createReviewGate(),
    spawn: (request) => {
      spawns.push(request);
      throughRunSeq += 10;
      const done = Promise.withResolvers<void>();
      pending.push({ resolve: done.resolve, reject: done.reject });
      return { throughRunSeq, done: done.promise };
    },
    recordSkip: (skip) => skips.push(skip),
    reportError: (error) => errors.push(error),
  });
  const finishAll = async (): Promise<void> => {
    for (const item of pending.splice(0)) {
      item.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { scheduler, spawns, skips, errors, pending, finishAll };
}

test("缺省每 8 轮触发一次，Run 结束固定补一次", async () => {
  assert.equal(DEFAULT_REVIEW_EVERY_TURNS, 8);
  const { scheduler, spawns, finishAll } = harness();
  const runId = newRunId();
  for (let turn = 1; turn <= 7; turn += 1) {
    scheduler.onTurnCompleted(runId);
  }
  assert.equal(spawns.length, 0, "不到 8 轮不触发");
  scheduler.onTurnCompleted(runId);
  assert.equal(spawns.length, 1, "第 8 轮触发");
  assert.equal(spawns[0]?.reason, "turns");
  await finishAll();
  scheduler.onRunEnded(runId);
  assert.equal(spawns.length, 2, "Run 结束补一次");
  assert.equal(spawns[1]?.reason, "run-end");
});

test("每次只喂增量：第二次审阅的起点是上一次审阅覆盖到的条目号", async () => {
  const { scheduler, spawns, finishAll } = harness({ everyTurns: 2 });
  const runId = newRunId();
  scheduler.onTurnCompleted(runId);
  scheduler.onTurnCompleted(runId);
  assert.equal(spawns[0]?.sinceRunSeq, undefined, "首次审阅从头开始");
  await finishAll();
  scheduler.onTurnCompleted(runId);
  scheduler.onTurnCompleted(runId);
  assert.equal(spawns[1]?.sinceRunSeq, 10, "第二次从上次覆盖到的条目号之后开始");
});

test("N 为 0 只在 Run 结束审；关闭时一律不审", () => {
  const onlyEnd = harness({ everyTurns: 0 });
  const runId = newRunId();
  for (let turn = 1; turn <= 20; turn += 1) {
    onlyEnd.scheduler.onTurnCompleted(runId);
  }
  assert.equal(onlyEnd.spawns.length, 0);
  onlyEnd.scheduler.onRunEnded(runId);
  assert.equal(onlyEnd.spawns.length, 1);

  const off = harness({ enabled: false });
  for (let turn = 1; turn <= 20; turn += 1) {
    off.scheduler.onTurnCompleted(runId);
  }
  off.scheduler.onRunEnded(runId);
  assert.equal(off.spawns.length, 0);
});

test("全局并发 1：上一次未收尾时跳过本次并记录；跨会话共用同一闸", async () => {
  const gate = createReviewGate();
  const first = harness({ everyTurns: 1, gate });
  const second = harness({ everyTurns: 1, gate });
  const runA = newRunId();
  const runB = newRunId();
  first.scheduler.onTurnCompleted(runA);
  assert.equal(first.spawns.length, 1);
  first.scheduler.onTurnCompleted(runA);
  assert.equal(first.spawns.length, 1, "同会话未收尾不再派出");
  assert.equal(first.skips.length, 1, "跳过记录一条");
  second.scheduler.onTurnCompleted(runB);
  assert.equal(second.spawns.length, 0, "另一个会话也受全局闸约束");
  assert.equal(second.skips.length, 1);
  await first.finishAll();
  second.scheduler.onTurnCompleted(runB);
  assert.equal(second.spawns.length, 1, "闸释放后可以派出");
});

test("审阅派出抛错或收尾失败：吞掉并记录，调度器不抛、闸会释放", async () => {
  const gate = createReviewGate();
  const errors: unknown[] = [];
  const crashing = new ReviewScheduler({
    sessionId: newSessionId(),
    everyTurns: 1,
    enabled: true,
    gate,
    spawn: () => {
      throw new Error("派出失败");
    },
    recordSkip: () => {},
    reportError: (error) => errors.push(error),
  });
  const runId = newRunId();
  assert.doesNotThrow(() => crashing.onTurnCompleted(runId));
  assert.equal(errors.length, 1);
  assert.equal(gate.busy(), false, "派出失败不占闸");

  const rejecting = new ReviewScheduler({
    sessionId: newSessionId(),
    everyTurns: 1,
    enabled: true,
    gate,
    spawn: () => ({ throughRunSeq: 1, done: Promise.reject(new Error("审阅崩溃")) }),
    recordSkip: () => {},
    reportError: (error) => errors.push(error),
  });
  assert.doesNotThrow(() => rejecting.onTurnCompleted(runId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 2, "收尾失败同样记录");
  assert.equal(gate.busy(), false, "收尾失败后闸释放");
});

// ---- 064 修订：Run 结束补审遇忙排队 ----

test("结束补审遇忙：不跳过而是排队，上一次审阅收尾后立即执行", async () => {
  const gate = createReviewGate();
  const busy = harness({ everyTurns: 1, gate });
  const target = harness({ everyTurns: 8, gate });
  const runA = newRunId();
  const runB = newRunId();
  busy.scheduler.onTurnCompleted(runA);
  assert.equal(busy.spawns.length, 1, "占住全局闸");
  target.scheduler.onRunEnded(runB);
  assert.equal(target.spawns.length, 0, "闸忙时不立即派出");
  assert.equal(target.skips.length, 0, "结束补审遇忙不落跳过记录");
  await busy.finishAll();
  assert.equal(target.spawns.length, 1, "上一次收尾后立即执行排队的补审");
  assert.equal(target.spawns[0]?.reason, "run-end");
  assert.equal(target.spawns[0]?.runId, runB);
});

test("结束补审连续遇忙两次：每个会话只排一个，新的覆盖旧的，只执行最新那一次", async () => {
  const gate = createReviewGate();
  const busy = harness({ everyTurns: 1, gate });
  const target = harness({ everyTurns: 8, gate });
  const older = newRunId();
  const newer = newRunId();
  busy.scheduler.onTurnCompleted(newRunId());
  target.scheduler.onRunEnded(older);
  target.scheduler.onRunEnded(newer);
  await busy.finishAll();
  assert.equal(target.spawns.length, 1, "只执行一次");
  assert.equal(target.spawns[0]?.runId, newer, "执行的是最新的那一次");
  await target.finishAll();
  assert.equal(target.spawns.length, 1, "旧请求不会在之后补跑");
});

test("中途按轮次触发遇忙仍跳过，跳过原因为忙", () => {
  const gate = createReviewGate();
  const busy = harness({ everyTurns: 1, gate });
  const target = harness({ everyTurns: 1, gate });
  busy.scheduler.onTurnCompleted(newRunId());
  target.scheduler.onTurnCompleted(newRunId());
  assert.equal(target.spawns.length, 0);
  assert.equal(target.skips.length, 1);
  assert.equal(target.skips[0]?.cause, "busy");
});

test("有排队时退出：清掉排队并落一条原因为退出的跳过记录，之后闸释放也不再执行", async () => {
  const gate = createReviewGate();
  const busy = harness({ everyTurns: 1, gate });
  const target = harness({ everyTurns: 8, gate });
  const runId = newRunId();
  busy.scheduler.onTurnCompleted(newRunId());
  target.scheduler.onRunEnded(runId);
  target.scheduler.shutdown();
  assert.equal(target.skips.length, 1);
  assert.equal(target.skips[0]?.cause, "exit");
  assert.equal(target.skips[0]?.runId, runId);
  await busy.finishAll();
  assert.equal(target.spawns.length, 0, "退出后排队项不再执行");
});
