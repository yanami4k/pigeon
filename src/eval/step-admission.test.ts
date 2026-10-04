// 决策 163 的整体用例：真网关（虚拟时钟）+ 按可用容量放行的限额控制器 + 正式跑批与预算试跑共用的 runAdmittedAgent；
// agent 是模拟的：每一步发一个模型请求、等它回来，按步中止即停下；各路按"作废即重做同一步"循环，与跑批器同一口径
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  assertConcurrencyFits,
  type GatewayClock,
  type ModelGateway,
  startModelGateway,
} from "./model-gateway.ts";
import { LimitController, PROBE_SCHEDULE_MS } from "./model-limits.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import { runAdmittedAgent, type StepAgentResult } from "./stream-runner.ts";

// 虚拟时钟：全部定时手动拨到
function virtualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: GatewayClock = {
    now: () => now,
    setTimer(ms, fn) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  };
  return {
    clock,
    now: () => now,
    async advance(ms: number) {
      const target = now + ms;
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

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// 等一个承诺，至多 5 秒（真实时间）：卡住即报错，用例的收尾照常执行、进程不因此挂住
async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等不到${what}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(cond: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Held {
  key: string;
  lane: string;
  answer: (status: number, body: string) => void;
}

// 假上游：请求体里带路名；模型请求一律扣住等用例回应，探测按 probe 回应
async function heldUpstream(probe: (key: string) => { status: number; body: string }) {
  const held: Held[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const key = (req.headers["x-api-key"] as string | undefined) ?? "";
    const answer = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };
    if (body.includes('"max_tokens":1')) {
      const p = probe(key);
      answer(p.status, p.body);
      return;
    }
    held.push({ key, lane: (JSON.parse(body) as { lane: string }).lane, answer });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    held,
    // 回应某一路扣住的请求
    answer(lane: string, status = 200, body = "{}") {
      const i = held.findIndex((h) => h.lane === lane);
      assert.notEqual(i, -1, `${lane} 没有扣住的请求`);
      const [h] = held.splice(i, 1);
      h?.answer(status, body);
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// 服务器繁忙（503）：setup 传入空的退避级数时一次即让该账号暂时不可用、按间隔探测恢复；这里检验的是按容量放行
const BUSY = {
  status: 503,
  body: '{"error":{"message":"Server overloaded","type":"server_error","param":null,"code":null}}',
};
const OK = { status: 200, body: "{}" };

// 跑批的若干路：每路按顺序做几步，作废即重做同一步；记下同时在跑的 agent 数、每步的尝试与放行等待
function lanes(g: ModelGateway, limits: LimitController) {
  const running = new Set<string>();
  let maxRunning = 0;
  const events: string[] = [];
  const results = new Map<string, { attempts: number; admissionWaitMs: number }>();
  const agentFor =
    (lane: string) =>
    async (abortSignal: AbortSignal): Promise<StepAgentResult> => {
      running.add(lane);
      maxRunning = Math.max(maxRunning, running.size);
      events.push(`start ${lane}`);
      try {
        const r = await fetch(`${g.jobBaseUrl(lane)}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "placeholder" },
          body: JSON.stringify({ lane }),
          signal: abortSignal,
        });
        await r.text();
        return { status: "done", turns: 1, usage: ZERO_USAGE, wallMs: 0 };
      } catch {
        events.push(`aborted ${lane}`);
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs: 0,
          interrupted: "按步中止",
        };
      } finally {
        running.delete(lane);
      }
    };
  // 停下：用例收尾时先停，免得网关关掉后各路"连不上—作废—重做"空转
  let stopped = false;
  const run = async (lane: string, steps: number) => {
    for (let s = 1; s <= steps; s++) {
      const name = steps === 1 ? lane : `${lane}.${s}`;
      for (let attempt = 1; ; attempt++) {
        if (stopped) return;
        if (attempt > 10) throw new Error(`${name} 作废超过 10 次`);
        const r = await runAdmittedAgent({ limits, gateway: g }, name, agentFor(name));
        if (r.voidReasons.length === 0) {
          results.set(name, { attempts: attempt, admissionWaitMs: r.admissionWaitMs });
          events.push(`done ${name}`);
          break;
        }
        events.push(`void ${name}`);
      }
    }
  };
  return {
    running,
    events,
    results,
    maxRunning: () => maxRunning,
    resetMax: () => {
      maxRunning = running.size;
    },
    stop: () => {
      stopped = true;
    },
    run,
  };
}

async function setup(
  probe: (key: string) => { status: number; body: string },
  slots: number,
  backoffDelaysMs?: number[]
) {
  const up = await heldUpstream(probe);
  const vc = virtualClock();
  let gateway: ModelGateway | undefined;
  const limits = new LimitController({
    probe: async () => false,
    slots,
    capacity: () => gateway?.capacity() ?? Number.POSITIVE_INFINITY,
    sleep: () => new Promise(() => {}),
    now: vc.now,
    warn: () => {},
  });
  const accounts = ["key-a", "key-b", "key-c"].map((key) => ({ key, concurrency: 2 }));
  assertConcurrencyFits(slots, accounts);
  gateway = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts,
    limits,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    ...(backoffDelaysMs !== undefined ? { backoffDelaysMs } : {}),
    clock: vc.clock,
    warn: () => {},
  });
  gateway.subscribeCapacity(() => limits.capacityChanged());
  return { up, vc, g: gateway, limits };
}

test("按剩余容量放行（6 路、3 个账号各 2）：账号 2 停用后同时在跑的 agent 不超过 4；排队超 30 秒的在途步被及时中止、放行后重做；容量不足数小时不停作业；账号恢复后回到 6 路；等待的各路先来先放行", async () => {
  let bBusy = false;
  const { up, vc, g, limits } = await setup((key) => (key === "key-b" && bBusy ? BUSY : OK), 6, []);
  const L = lanes(g, limits);
  try {
    // 7 路作业、配置 6 路：前 6 路放行，L7 等
    const names = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
    const done = names.map((n) => L.run(n, 1));
    await until(() => up.held.length === 6, "6 路都在等模型回应");
    assert.equal(L.running.size, 6);
    assert.ok(!L.events.includes("start L7"), "不超过配置路数");
    // 账号 2 不可用：它上面的两路换号，另两个账号都满，排队
    bBusy = true;
    const victims = up.held.filter((h) => h.key === "key-b").map((h) => h.lane);
    assert.equal(victims.length, 2);
    for (const v of victims) up.answer(v, BUSY.status, BUSY.body);
    await until(() => g.accountStatus()[1]?.down === "busy", "账号 2 停用");
    await settle();
    assert.equal(g.capacity(), 4);
    assert.equal(up.held.length, 4, "两路换号后排队，没有派出");
    assert.ok(victims.every((v) => g.jobInFlight(v) === 1));
    // 排队 30 秒之内不动；过了 30 秒即中止（agent 没跑完、请求还在排队）
    await vc.advance(29_000);
    assert.ok(!L.events.some((e) => e.startsWith("void")));
    await vc.advance(2_000);
    await until(() => victims.every((v) => L.events.includes(`void ${v}`)), "两路作废");
    for (const v of victims) assert.ok(L.events.includes(`aborted ${v}`), `${v} 由按步中止停下`);
    assert.equal(L.running.size, 4, "作废后重做的两路在等放行：同时在跑的只剩 4");
    // 从在途步中止之后起算：同时在跑的不超过剩余容量
    L.resetMax();
    // 容量不足持续数小时：不停任何作业、不再作废
    await vc.advance(3 * 60 * 60_000);
    assert.equal(L.running.size, 4);
    assert.equal(L.events.filter((e) => e.startsWith("void")).length, 2);
    // 一路跑完：按先来后到放行等得最久的 L7
    const first = up.held[0]?.lane as string;
    up.answer(first);
    await until(() => L.events.includes("start L7"), "L7 放行");
    await settle();
    assert.deepEqual(
      victims.map((v) => L.events.filter((e) => e === `start ${v}`).length),
      [1, 1],
      "作废的两路还在等"
    );
    assert.ok(L.maxRunning() <= 4, `同时在跑的不超过 4，实为 ${L.maxRunning()}`);
    // 账号 2 恢复（下一次单独探测通过）：容量回到 6，两路按作废的先后放行，回到 6 路
    bBusy = false;
    await vc.advance(PROBE_SCHEDULE_MS.at(-1) ?? 0);
    await until(() => L.running.size === 6, "回到 6 路");
    assert.equal(g.capacity(), 6);
    const secondStart = (v: string) =>
      L.events.findIndex(
        (e, i) => e === `start ${v}` && L.events.slice(0, i).includes(`start ${v}`)
      );
    const voidOrder = L.events.filter((e) => e.startsWith("void ")).map((e) => e.slice(5));
    const restartOrder = [...victims].sort((a, b) => secondStart(a) - secondStart(b));
    assert.deepEqual(restartOrder, voidOrder, "先作废（先开始等）的先放行");
    assert.ok(
      victims.every((v) => secondStart(v) > L.events.indexOf("start L7")),
      "L7 等得最久，最先放行"
    );
    // 收尾：全部回应
    while (up.held.length > 0) up.answer(up.held[0]?.lane as string);
    await within(Promise.all(done), "各路做完");
    for (const v of victims) {
      assert.equal(L.results.get(v)?.attempts, 2, `${v} 作废一次、重做一次`);
      assert.ok((L.results.get(v)?.admissionWaitMs ?? 0) >= 3 * 60 * 60_000, "放行等待记下了");
    }
    for (const n of names.filter((n) => !victims.includes(n))) {
      assert.equal(L.results.get(n)?.attempts, 1);
    }
  } finally {
    L.stop();
    await g.close();
    limits.close();
    await up.close();
  }
});

test("按剩余容量放行：429 退避期间可用容量不下降，退避中跑完一步的那一路，下一步照常放行", async () => {
  const { up, vc, g, limits } = await setup(() => OK, 6);
  const L = lanes(g, limits);
  try {
    // L1 做两步；其余各一步
    const all = [L.run("L1", 2), ...["L2", "L3", "L4", "L5", "L6"].map((n) => L.run(n, 1))];
    await until(() => up.held.length === 6, "6 路都在等模型回应");
    // 挑一个不承载 L1 的账号，让它上面的两路撞 429：该账号进入 5 秒退避，两路排队
    const l1Key = up.held.find((h) => h.lane === "L1.1")?.key;
    const rated = ["key-a", "key-b", "key-c"].find((k) => k !== l1Key) as string;
    const index = ["key-a", "key-b", "key-c"].indexOf(rated);
    for (const lane of up.held.filter((h) => h.key === rated).map((h) => h.lane)) {
      up.answer(lane, 429, "rate limited");
    }
    await until(() => g.accountStatus()[index]?.cooling === true, "账号退避中");
    assert.equal(g.capacity(), 6, "退避不计入容量下降");
    assert.equal(limits.admitLimit(), 6);
    // 退避中 L1 跑完第一步：第二步照常放行，同时在跑的仍是 6
    up.answer("L1.1");
    await until(() => L.events.includes("start L1.2"), "L1 的第二步放行");
    assert.equal(L.running.size, 6, "退避期间放行数不下降");
    // 退避结束，全部回应
    await vc.advance(5_000);
    await until(() => up.held.length === 6, "排队的两路派出");
    while (up.held.length > 0) up.answer(up.held[0]?.lane as string);
    await within(Promise.all(all), "各路做完");
    assert.ok(!L.events.some((e) => e.startsWith("void")), "秒级退避不作废");
  } finally {
    L.stop();
    await g.close();
    limits.close();
    await up.close();
  }
});
