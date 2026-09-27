import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUpstreamFailure,
  isQuotaError,
  LimitController,
  PROBE_SCHEDULE_MS,
  parseUpstreamError,
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

// DeepSeek 两个端点实测的错误正文形状（OpenAI 风格；Anthropic 兼容端点也是这个形状）
const deepseekError = (type: string, message: string) =>
  JSON.stringify({ error: { message, type, param: null, code: "invalid_request_error" } });

test("上游失败分类（DeepSeek）：401 认证、402 余额不足、429 频率限制、503 服务器繁忙、500 服务器故障，其余为 other", () => {
  assert.deepEqual(
    classifyUpstreamFailure(
      401,
      deepseekError(
        "authentication_error",
        "Authentication Fails, Your api key: ****robe is invalid"
      )
    ),
    { kind: "auth" }
  );
  assert.deepEqual(
    classifyUpstreamFailure(402, deepseekError("invalid_request_error", "Insufficient Balance")),
    { kind: "balance" }
  );
  assert.deepEqual(classifyUpstreamFailure(429, "rate limited"), { kind: "rate-limit" });
  assert.deepEqual(classifyUpstreamFailure(503, "Server overloaded"), { kind: "busy" });
  assert.deepEqual(classifyUpstreamFailure(500, "boom"), { kind: "server" });
  // 400、422 是请求问题，其他 5xx 也原样交回
  assert.deepEqual(
    classifyUpstreamFailure(
      400,
      deepseekError("invalid_request_error", "Invalid max_tokens value")
    ),
    { kind: "other" }
  );
  assert.deepEqual(classifyUpstreamFailure(422, "bad param"), { kind: "other" });
  assert.deepEqual(classifyUpstreamFailure(502, "bad gateway"), { kind: "other" });
});

test("上游失败分类：Kimi 的 403 额度窗口语义已删去——明说用量上限的 403 也不再当额度；403 只认并发与明确的认证", () => {
  assert.deepEqual(
    classifyUpstreamFailure(
      403,
      '{"error":{"type":"permission_error","message":"usage limit reached, quota will reset in 3 hours"}}'
    ),
    { kind: "other" }
  );
  assert.deepEqual(classifyUpstreamFailure(403, "本月额度已用完"), { kind: "other" });
  assert.deepEqual(classifyUpstreamFailure(403, "too many concurrent requests"), {
    kind: "concurrency",
  });
  assert.deepEqual(classifyUpstreamFailure(403, "invalid x-api-key"), { kind: "auth" });
  assert.deepEqual(classifyUpstreamFailure(403, deepseekError("authentication_error", "x")), {
    kind: "auth",
  });
  assert.deepEqual(classifyUpstreamFailure(403, "forbidden"), { kind: "other" });
});

test("错误正文按 OpenAI 形状解析：取 message、type、param、code；Anthropic 形状同样取得出；认不出为 null", () => {
  assert.deepEqual(
    parseUpstreamError(
      '{"error":{"message":"Invalid temperature value","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'
    ),
    {
      message: "Invalid temperature value",
      type: "invalid_request_error",
      param: null,
      code: "invalid_request_error",
    }
  );
  assert.deepEqual(
    parseUpstreamError('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'),
    { message: "busy", type: "overloaded_error", param: null, code: null }
  );
  assert.equal(parseUpstreamError("<html>502</html>"), null);
  assert.equal(parseUpstreamError('{"detail":"x"}'), null);
});

test("脱敏：正文回显的密钥末四位（****xxxx）一并去掉；配置的 key 原样替换", () => {
  const body = deepseekError(
    "authentication_error",
    "Authentication Fails, Your api key: ****robe is invalid (request_id: 1a2b)"
  );
  const scrubbed = scrubKeys(body, ["sk-real-key-robe"]);
  assert.doesNotMatch(scrubbed, /robe/);
  assert.match(scrubbed, /Your api key: \[key\] is invalid/);
  assert.equal(scrubKeys("key ***abcd and ****** end", []), "key [key] and ****** end");
  assert.equal(scrubKeys("x sk-real y", ["sk-real"]), "x [key] y");
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
    // 直接拨到某个时刻（不触发等待点）
    set(ms: number): void {
      now = ms;
    },
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
  limits.onLimit("rate-limit");
  limits.onLimit("rate-limit");
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
  assert.equal(records[0]?.kind, "rate-limit");
  assert.equal(records[0]?.startedAt, new Date(0).toISOString());
  const waited =
    (PROBE_SCHEDULE_MS[0] ?? 0) + (PROBE_SCHEDULE_MS[1] ?? 0) + (PROBE_SCHEDULE_MS[2] ?? 0);
  assert.equal(records[0]?.endedAt, new Date(waited).toISOString());
  assert.deepEqual(PROBE_SCHEDULE_MS.slice(0, 2), [5 * 60_000, 10 * 60_000]);
  assert.ok(PROBE_SCHEDULE_MS.every((ms) => ms <= 30 * 60_000));
  assert.equal(warnings.length, 2, "开始与恢复各一条告警");
});

test("额度暂停：总等待逾 6 小时即停止；余额不足直接停止并告警，不探测", async () => {
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
  limits.onLimit("busy");
  const ready = limits.ready().then(
    () => "resolved",
    (e: Error) => e.message
  );
  while (await clock.tick()) {}
  assert.match(await ready, /等待逾 60 分钟仍未恢复/);
  assert.equal(limits.state, "stopped");
  assert.ok(probes >= 1);

  const balance = new LimitController({
    probe: async () => {
      throw new Error("不该探测");
    },
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 2,
  });
  balance.onLimit("balance");
  assert.equal(balance.state, "stopped");
  await assert.rejects(balance.ready(), /余额不足/);
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

test("停止信号：与余额不足同一路径——计一次信号、通知在途的看守、状态为已停止，之后取新步即报停止原因；重复收到不再计", async () => {
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
  limits.onLimit("rate-limit");
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
  limits.onLimit("rate-limit");
  const ready = limits.ready();
  limits.recovered();
  await ready;
  assert.equal(limits.state, "running");
  assert.equal(limits.pausesSince(0)[0]?.endedAt, new Date(0).toISOString());
  assert.equal(probes, 0, "不等下一轮探测");
  limits.recovered();
  assert.equal(limits.state, "running", "运行中通知恢复无副作用");
  // 新开一次暂停：第一次暂停的探测循环先醒（同一时刻排在前面），不得探测、不得结束新的暂停
  limits.onLimit("busy");
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
  limits.onLimit("rate-limit");
  assert.equal(timeouts(), before + 1, "暂停中有一个探测定时");
  limits.recovered();
  await new Promise((r) => setImmediate(r));
  assert.equal(timeouts(), before, "恢复即取消");
  limits.onLimit("rate-limit");
  assert.equal(timeouts(), before + 1);
  limits.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(timeouts(), before, "close() 取消");
});

test("收尾：关闭之后再报来限额也不开新的暂停、不设新的探测定时", async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timeouts();
  const limits = new LimitController({ probe: async () => false, slots: 2, warn: () => {} });
  limits.close();
  limits.onLimit("rate-limit");
  assert.equal(limits.state, "running");
  assert.equal(timeouts(), before);
});

// 放行（决策 163）：同时在跑的 agent 数小于可用容量且不超过配置路数
test("放行：同时在跑的数取配置路数与可用容量的小者；空出或容量回升即按先来后到放行等待的各路", async () => {
  const clock = manualClock();
  let capacity = 4;
  const limits = new LimitController({
    probe: async () => true,
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 6,
    capacity: () => capacity,
  });
  const running = await Promise.all([1, 2, 3, 4].map(() => limits.acquire()));
  assert.ok(running.every((r) => r.waitedMs === 0));
  const order: string[] = [];
  const waiting = ["a", "b", "c"].map((name) =>
    limits.acquire().then((r) => {
      order.push(name);
      return r;
    })
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], "已有 4 路在跑、容量 4：都等");
  running[0]?.();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["a"], "空出一路：只放行最先等的");
  capacity = 6;
  limits.capacityChanged();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["a", "b", "c"], "容量回升：按先来后到再放行两路");
  capacity = 100;
  limits.capacityChanged();
  let admitted = false;
  const extra = limits.acquire().then((r) => {
    admitted = true;
    return r;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(admitted, false, "不超过配置路数 6");
  (await waiting[0])?.();
  await extra;
  assert.equal(admitted, true);
});

test("放行：等待的时长按控制器的时钟计，容量不足等多久都不作废；整批停下时等待的各路报错退出", async () => {
  const clock = manualClock();
  let capacity = 1;
  const limits = new LimitController({
    probe: async () => true,
    sleep: clock.sleep,
    now: clock.now,
    warn: () => {},
    slots: 3,
    capacity: () => capacity,
  });
  const first = await limits.acquire();
  const second = limits.acquire();
  const third = limits.acquire().then(
    () => "admitted",
    (e: Error) => e.message
  );
  clock.set(3 * 60 * 60_000);
  capacity = 2;
  limits.capacityChanged();
  assert.equal((await second).waitedMs, 3 * 60 * 60_000, "容量不足等了三小时：只记等待");
  assert.equal(limits.state, "running");
  limits.onLimit("balance");
  assert.match(await third, /余额不足/);
  first();
});

test("停止信号与放行队列：取步者刚过放行门、尚未入队时收到停止，以停止原因释放、不被放行；之后取新步一律拒绝", async () => {
  const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
  const first = await limits.acquire();
  const queued = limits.acquire();
  limits.shutdown("收到 SIGTERM");
  await assert.rejects(queued, /收到 SIGTERM/);
  first();
  await assert.rejects(limits.acquire(), /收到 SIGTERM/);
});

test("已因余额不足停下后再收到停止信号：照样记下停止原因（作业容器按停止信号保留），不再计信号", () => {
  const limits = new LimitController({ probe: async () => true, slots: 2, warn: () => {} });
  limits.onLimit("balance");
  assert.equal(limits.state, "stopped");
  const signals = limits.signals;
  limits.shutdown("收到 SIGTERM");
  assert.equal(limits.shutdownReason, "收到 SIGTERM");
  assert.equal(limits.signals, signals);
});

test("花费上限：到上限即走停下路径——计一次信号、通知看守、状态为已停止，原因写明累计与上限；重复报来不再计", async () => {
  const limits = new LimitController({ probe: async () => true, slots: 2, warn: () => {} });
  let notified = 0;
  limits.subscribe(() => notified++);
  const signals = limits.signals;
  limits.spendLimitReached(650.12, 650);
  assert.equal(limits.state, "stopped");
  assert.equal(limits.signals, signals + 1);
  assert.equal(notified, 1);
  await assert.rejects(limits.ready(), /花费.*650\.12.*上限 ¥650/);
  limits.spendLimitReached(651, 650);
  assert.equal(limits.signals, signals + 1);
});
