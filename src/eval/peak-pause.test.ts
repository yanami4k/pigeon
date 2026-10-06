// 高峰自动暂停（决策 393）：限额控制器的放行，虚拟时钟 + 价目的高峰判定
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LimitController,
  type LimitControllerOptions,
  type PeakPauseRecord,
  peakClearFrom,
} from "./model-limits.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import { runAdmittedAgent } from "./stream-runner.ts";

const MIN = 60_000;
// 北京时间 → 毫秒；iso 为同一时刻的记录写法（缺省日期 2026-10-12，周一）
const bj = (s: string) => Date.parse(`${s}+08:00`);
const iso = (hm: string) => new Date(bj(`2026-10-12T${hm}:00`)).toISOString();

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function virtualClock(start: number) {
  let now = start;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const setTimer = (ms: number, fn: () => void) => {
    const t = { at: now + ms, fn, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  return {
    now: () => now,
    setTimer,
    sleep: (ms: number) => new Promise<void>((r) => setTimer(ms, r)),
    // 拨到 target，依次触发到期的定时
    async to(target: number) {
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        due.live = false;
        due.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

function controller(
  clock: ReturnType<typeof virtualClock>,
  options: Partial<LimitControllerOptions> = {}
) {
  const events: [string, PeakPauseRecord][] = [];
  const limits = new LimitController({
    probe: async () => false,
    slots: 4,
    now: clock.now,
    sleep: clock.sleep,
    warn: () => {},
    ...options,
  });
  const enable = (marginMs = 30 * MIN) =>
    limits.enablePeakPause({
      marginMs,
      setTimer: clock.setTimer,
      onChange: (event, record) => events.push([event, record]),
    });
  return { limits, events, enable };
}

test("高峰暂停：进入高峰前余量内不放行新的一步，在途的照常做完；出高峰自动放行，等待不计入这一步的墙钟；每次暂停与恢复都记下", async () => {
  const clock = virtualClock(bj("2026-10-12T08:00:00"));
  const { limits, events, enable } = controller(clock);
  enable();
  const early = await limits.acquire();
  await clock.to(bj("2026-10-12T08:29:59"));
  const late = await limits.acquire();
  assert.equal(late.waitedMs, 0, "离高峰还多于余量：照常放行");
  await clock.to(bj("2026-10-12T08:30:00"));
  assert.deepEqual(events, [
    ["pause", { startedAt: iso("08:30"), until: iso("12:00"), endedAt: null }],
  ]);
  let runAt: number | undefined;
  const step = runAdmittedAgent({ limits }, "job", async () => {
    runAt = clock.now();
    return { status: "done", turns: 1, usage: ZERO_USAGE, wallMs: 0 };
  });
  early();
  late();
  await settle();
  assert.equal(runAt, undefined, "余量内有空位也不放行新的一步");
  assert.equal(limits.state, "running", "在途的步照常：网关照常转发");
  assert.equal(limits.signals, 0, "在途的步不作废");
  await clock.to(bj("2026-10-12T12:00:00"));
  assert.equal(runAt, bj("2026-10-12T12:00:00"), "出高峰自动放行，这一步的墙钟从这时才开始");
  const admitted = await step;
  assert.equal(admitted.admissionWaitMs, 210 * MIN);
  assert.deepEqual(admitted.voidReasons, []);
  assert.deepEqual(events[1], [
    "resume",
    { startedAt: iso("08:30"), until: iso("12:00"), endedAt: iso("12:00") },
  ]);
  // 午间只放行到 13:30：再停到 18:00
  await clock.to(bj("2026-10-12T13:30:00"));
  assert.deepEqual(events[2], [
    "pause",
    { startedAt: iso("13:30"), until: iso("18:00"), endedAt: null },
  ]);
  limits.close();
});

test("高峰判定照价目：法定节假日全天放行，调休上班日按工作日；余量为 0 只在高峰时段内停", () => {
  const margin = 30 * MIN;
  const at = (s: string) => bj(`2026-10-${s}:00`);
  assert.equal(peakClearFrom(at("01T08:45"), margin), at("01T08:45"), "国庆假期");
  assert.equal(peakClearFrom(at("10T08:45"), margin), at("10T12:00"), "调休上班的周六");
  assert.equal(peakClearFrom(at("11T10:00"), margin), at("11T10:00"), "周日");
  assert.equal(peakClearFrom(at("12T08:45"), 0), at("12T08:45"));
  assert.equal(peakClearFrom(at("12T17:59"), 0), at("12T18:00"));
});

test("高峰暂停的时间不计入整批暂停的总等待上限", async () => {
  const clock = virtualClock(bj("2026-10-12T09:00:00"));
  const { limits, enable } = controller(clock, { maxWaitMs: 60 * MIN });
  enable(0);
  // 账号全不可用：整批暂停并探测，探测一直不通
  limits.onLimit("busy");
  await clock.to(bj("2026-10-12T12:30:00"));
  assert.equal(limits.state, "paused", "9–12 点的高峰暂停不算进 60 分钟");
  await clock.to(bj("2026-10-12T14:00:00"));
  assert.equal(limits.state, "stopped");
  limits.close();
});

test("不开高峰暂停：高峰时段照常放行（与之前相同）", async () => {
  const clock = virtualClock(bj("2026-10-12T10:00:00"));
  const { limits } = controller(clock);
  let waited: number | undefined;
  void limits.acquire().then((a) => {
    waited = a.waitedMs;
  });
  await settle();
  assert.equal(waited, 0);
  limits.close();
});
