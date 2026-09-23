import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUpstreamFailure,
  isQuotaError,
  LimitController,
  PROBE_SCHEDULE_MS,
  scrubKeys,
} from "./model-limits.ts";

test("限额识别沿用既有口径：明说用量上限的 403 是限额，其余 401/403 是认证；上下文超长不算", () => {
  assert.equal(
    isQuotaError(
      "403 permission_error: You've reached your usage limit, quota will reset at 18:00"
    ),
    true
  );
  assert.equal(isQuotaError("403 forbidden: invalid api key"), false);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isQuotaError("context length exceeded"), false);
  assert.equal(scrubKeys("bad key sk-abc in sk-abc", ["sk-abc", ""]), "bad key [key] in [key]");
});

test("上游失败分类：429 为频率限制；403 按文案分并发、每月、每周、5 小时（额度类缺省）；其余 403 为认证", () => {
  assert.deepEqual(classifyUpstreamFailure(429, "rate limited"), { kind: "rate-limit" });
  assert.deepEqual(
    classifyUpstreamFailure(
      403,
      '{"error":{"type":"permission_error","message":"usage limit reached, quota will reset in 3 hours"}}'
    ),
    { kind: "5h" }
  );
  assert.deepEqual(classifyUpstreamFailure(403, "Your weekly usage limit has been reached"), {
    kind: "weekly",
  });
  assert.deepEqual(classifyUpstreamFailure(403, "本月额度已用完"), { kind: "monthly" });
  assert.deepEqual(classifyUpstreamFailure(403, "too many concurrent requests"), {
    kind: "concurrency",
  });
  assert.deepEqual(classifyUpstreamFailure(403, "并发请求数超过上限"), { kind: "concurrency" });
  assert.deepEqual(classifyUpstreamFailure(403, "forbidden"), { kind: "auth" });
  assert.deepEqual(classifyUpstreamFailure(500, "boom"), { kind: "other" });
});

function manualClock() {
  let now = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: now + ms, resolve });
      }),
    // 推进到下一个等待点
    async tick(): Promise<boolean> {
      waiters.sort((a, b) => a.at - b.at);
      const next = waiters.shift();
      if (next === undefined) return false;
      now = next.at;
      next.resolve();
      await new Promise((r) => setTimeout(r, 0));
      return true;
    },
  };
}

test("额度暂停：整批暂停、按拉长的间隔探测，探到恢复即放行并记下暂停起止；暂停编号前进", async () => {
  const clock = manualClock();
  const outcomes = [false, false, true];
  const warnings: string[] = [];
  const limits = new LimitController({
    probe: async () => outcomes.shift() ?? true,
    sleep: clock.sleep,
    now: clock.now,
    warn: (w) => warnings.push(w),
    slots: 4,
  });
  const epoch = limits.epoch;
  limits.onLimit("5h");
  limits.onLimit("5h");
  assert.equal(limits.state, "paused");
  assert.equal(limits.epoch, epoch + 1, "暂停中再撞不重复开暂停");
  const ready = limits.ready();
  await clock.tick();
  await clock.tick();
  await clock.tick();
  await ready;
  assert.equal(limits.state, "running");
  const records = limits.pausesSince(epoch);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, "5h");
  assert.equal(records[0]?.startedAt, new Date(0).toISOString());
  const waited =
    (PROBE_SCHEDULE_MS[0] ?? 0) + (PROBE_SCHEDULE_MS[1] ?? 0) + (PROBE_SCHEDULE_MS[2] ?? 0);
  assert.equal(records[0]?.endedAt, new Date(waited).toISOString());
  assert.deepEqual(PROBE_SCHEDULE_MS.slice(0, 2), [5 * 60_000, 10 * 60_000]);
  assert.ok(PROBE_SCHEDULE_MS.every((ms) => ms <= 30 * 60_000));
  assert.equal(warnings.length, 2, "开始与恢复各一条告警");
});

test("额度暂停：总等待逾 6 小时即停止；每月额度直接停止并告警，不探测", async () => {
  const clock = manualClock();
  let probes = 0;
  const limits = new LimitController({
    probe: async () => {
      probes++;
      return false;
    },
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 2,
    maxWaitMs: 60 * 60_000,
  });
  limits.onLimit("weekly");
  const ready = limits.ready().then(
    () => "resolved",
    (e: Error) => e.message
  );
  while (await clock.tick()) {}
  assert.match(await ready, /等待逾 60 分钟仍未恢复/);
  assert.equal(limits.state, "stopped");
  assert.ok(probes >= 1);

  const monthly = new LimitController({
    probe: async () => {
      throw new Error("不该探测");
    },
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 2,
  });
  monthly.onLimit("monthly");
  assert.equal(monthly.state, "stopped");
  await assert.rejects(monthly.ready(), /每月额度用完/);
});

test("并发受限：先降一路（下限 1），已是 1 路仍受限则暂停；告警去重", async () => {
  const clock = manualClock();
  const warnings: string[] = [];
  const limits = new LimitController({
    probe: async () => true,
    sleep: clock.sleep,
    now: clock.now,
    warn: (w) => warnings.push(w),
    slots: 2,
  });
  const a = await limits.acquire();
  const b = await limits.acquire();
  let third = false;
  const c = limits.acquire().then((release) => {
    third = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(third, false, "满额时排队");
  limits.onLimit("concurrency");
  assert.equal(limits.slots, 1);
  a();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(third, false, "降路后仍要等占用降到 1 路以下");
  b();
  const releaseC = await c;
  assert.equal(third, true);
  releaseC();
  limits.onLimit("concurrency");
  assert.equal(limits.state, "paused");
  assert.equal(limits.slots, 1);
  assert.equal(warnings.filter((w) => w.includes("降为 1 路")).length, 1);
});
