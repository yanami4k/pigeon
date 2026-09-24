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
  assert.deepEqual(classifyUpstreamFailure(401, "invalid x-api-key"), { kind: "auth" });
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

test("路数固定：限额信号不再降路（并发受限由网关按账号降上限）；全部账号并发受限报来时整批暂停", async () => {
  const clock = manualClock();
  const limits = new LimitController({
    probe: async () => true,
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 2,
  });
  const a = await limits.acquire();
  limits.onLimit("concurrency");
  assert.equal(limits.slots, 2);
  assert.equal(limits.state, "paused");
  assert.equal(limits.pausesSince(0)[0]?.kind, "concurrency");
  assert.equal(limits.signals, 1);
  a();
});

test("停止信号：与每月额度用完同一路径——计一次信号、通知在途的看守、状态为已停止，之后取新步即报停止原因；重复收到不再计", async () => {
  // 暂停后的探测不真的等（不留定时器）
  const limits = new LimitController({
    probe: async () => true,
    slots: 2,
    warn: () => {},
    sleep: () => new Promise<void>(() => {}),
  });
  let notified = 0;
  limits.subscribe(() => {
    notified += 1;
  });
  limits.onLimit("5h");
  assert.equal(limits.shutdownReason, undefined, "暂停不算停止信号");
  limits.shutdown("收到 SIGTERM");
  assert.equal(limits.shutdownReason, "收到 SIGTERM");
  assert.equal(limits.state, "stopped");
  assert.equal(limits.signals, 2);
  assert.equal(notified, 2);
  await assert.rejects(limits.ready(), /收到 SIGTERM/);
  await assert.rejects(limits.acquire(), /收到 SIGTERM/);
  limits.shutdown("又一次");
  assert.equal(limits.signals, 2);
  assert.equal(notified, 2);
  assert.equal(limits.shutdownReason, "收到 SIGTERM");
});

test("网关通知账号恢复（recovered）即立即恢复整批、记下暂停止点；旧的探测循环醒来不替之后的新暂停收尾", async () => {
  const clock = manualClock();
  let probes = 0;
  const limits = new LimitController({
    probe: async () => {
      probes++;
      return true;
    },
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 2,
  });
  limits.onLimit("5h");
  const ready = limits.ready();
  limits.recovered();
  await ready;
  assert.equal(limits.state, "running");
  assert.equal(limits.pausesSince(0)[0]?.endedAt, new Date(0).toISOString());
  assert.equal(probes, 0, "不等下一轮探测");
  limits.recovered();
  assert.equal(limits.state, "running", "运行中通知恢复无副作用");
  // 新开一次暂停：第一次暂停的探测循环先醒（同一时刻排在前面），不得探测、不得结束新的暂停
  limits.onLimit("weekly");
  await clock.tick();
  assert.equal(limits.state, "paused");
  assert.equal(probes, 0, "旧循环醒来即退出");
  await clock.tick();
  assert.equal(limits.state, "running", "新暂停由它自己的循环探测恢复");
  assert.equal(probes, 1);
});

test("认证失败：全部账号都不会自行恢复且其中有认证失败即停下，原因说明需人工处理 key", async () => {
  const limits = new LimitController({ probe: async () => true, slots: 2, warn: () => {} });
  limits.onLimit("auth");
  assert.equal(limits.state, "stopped");
  await assert.rejects(limits.ready(), /认证失败.*key/);
});

test("收尾：缺省计时下，暂停中的探测定时在恢复、停下或 close() 时取消，进程不因它多挂", async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timeouts();
  const limits = new LimitController({ probe: async () => false, slots: 2, warn: () => {} });
  limits.onLimit("5h");
  assert.equal(timeouts(), before + 1, "暂停中有一个探测定时");
  limits.recovered();
  await new Promise((r) => setImmediate(r));
  assert.equal(timeouts(), before, "恢复即取消");
  limits.onLimit("5h");
  assert.equal(timeouts(), before + 1);
  limits.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(timeouts(), before, "close() 取消");
});
