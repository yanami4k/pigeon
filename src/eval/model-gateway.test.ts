import assert from "node:assert/strict";
import diagnostics_channel from "node:diagnostics_channel";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gatewayStreamFn } from "../pi-runtime/index.ts";
import {
  assertConcurrencyFits,
  type GatewayClock,
  gatewayAccountsFromEnv,
  type ModelGateway,
  meterDelta,
  startModelGateway,
} from "./model-gateway.ts";
import { LimitController, PROBE_SCHEDULE_MS } from "./model-limits.ts";

// 可控时钟：短于 autoBelowMs 的定时在下一轮事件循环即触发，其余等 advance 拨到；virtual 为真时 now 只随 advance 走，
// 否则为真实时间加上拨快的量。set 记下每次定时的毫秒数
function testClock(options: { autoBelowMs?: number; virtual?: boolean } = {}) {
  const autoBelowMs = options.autoBelowMs ?? 60_000;
  let offset = 0;
  const timers: { at: number; ms: number; fn: () => void; live: boolean }[] = [];
  const set: number[] = [];
  const clock: GatewayClock = {
    now: () => (options.virtual === true ? 0 : Date.now()) + offset,
    setTimer(ms, fn) {
      set.push(ms);
      if (ms < autoBelowMs) {
        const t = setImmediate(fn);
        return () => clearImmediate(t);
      }
      const t = { at: clock.now() + ms, ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  };
  return {
    clock,
    set,
    // 未到的手动定时（毫秒数）
    pending: () => timers.filter((t) => t.live).map((t) => t.ms),
    // 拨快 ms，依次触发到期的定时
    async advance(ms: number) {
      offset += ms;
      for (;;) {
        const due = timers
          .filter((t) => t.live && t.at <= clock.now())
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) return;
        due.live = false;
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

// 等到条件成立（最多 3 秒）
async function until(cond: () => boolean, what = "条件") {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Scripted {
  status: number;
  body: string;
  contentType?: string;
}

// 可编排的假上游：按顺序回应，记下每次收到的路径与 key
async function fakeUpstream(script: Scripted[]) {
  const seen: { path: string; key: string | undefined; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({
      path: req.url ?? "",
      key: req.headers["x-api-key"] as string | undefined,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const next = script.shift() ?? { status: 500, body: "脚本用完" };
    res.writeHead(next.status, { "content-type": next.contentType ?? "application/json" });
    res.end(next.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":1}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","usage":{"output_tokens":42}}',
  "",
].join("\n");

function limits() {
  return new LimitController({
    probe: async () => true,
    slots: 4,
    sleep: () => new Promise(() => {}),
    warn: () => {},
  });
}

async function withGateway(
  script: Scripted[],
  run: (
    g: ModelGateway,
    up: Awaited<ReturnType<typeof fakeUpstream>>,
    l: LimitController
  ) => Promise<void>,
  keys = ["key-one"]
) {
  const up = await fakeUpstream(script);
  const l = limits();
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts: keys.map((key) => ({ key, concurrency: 2 })),
    limits: l,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    backoffDelaysMs: [1, 1],
    clock: testClock().clock,
    warn: () => {},
  });
  try {
    await run(g, up, l);
  } finally {
    await g.close();
    await up.close();
  }
}

function post(
  g: ModelGateway,
  job: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  return fetch(`${g.jobBaseUrl(job)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder", ...headers },
    body: JSON.stringify({ stream: true }),
    ...(signal !== undefined ? { signal } : {}),
  });
}

test("网关：按作业前缀转发、注入真 key、流式原样透传并按作业计量", async () => {
  await withGateway(
    [{ status: 200, body: SSE, contentType: "text/event-stream" }],
    async (g, up) => {
      const before = g.meter("s1|no-gate|1");
      const r = await post(g, "s1|no-gate|1");
      assert.equal(r.status, 200);
      assert.equal(await r.text(), SSE);
      assert.deepEqual(
        up.seen.map((s) => [s.path, s.key, s.body]),
        [["/v1/messages", "key-one", '{"stream":true}']]
      );
      assert.deepEqual(meterDelta(g.meter("s1|no-gate|1"), before), {
        requests: 1,
        input: 120,
        output: 42,
        cacheRead: 30,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 1,
        accountRequests: [1],
      });
      assert.deepEqual(g.meter("other"), {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        accountRequests: [0],
      });
    }
  );
});

test("网关（单账号）：429 在该账号上逐级退避后重试；退避用满该账号不可用，已无可用账号即整批暂停", async () => {
  await withGateway(
    [
      { status: 429, body: "rate limited" },
      { status: 200, body: "{}" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
    ],
    async (g, up, l) => {
      assert.equal((await post(g, "j")).status, 200, "退避一次后成功");
      const exhausted = await post(g, "j");
      assert.equal(exhausted.status, 429);
      assert.equal(up.seen.length, 5);
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "rate-limit");
      assert.equal(g.accountStatus()[0]?.down, "rate-limit");
    }
  );
});

test("网关：额度 403 交给控制器暂停，暂停期间直接 529 不打上游；交回的正文里没有 key", async () => {
  await withGateway(
    [
      {
        status: 403,
        body: '{"error":{"type":"permission_error","message":"usage limit reached for key-one, quota will reset soon"}}',
      },
    ],
    async (g, up, l) => {
      const quota = await post(g, "j");
      assert.equal(quota.status, 403);
      assert.doesNotMatch(await quota.text(), /key-one/);
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "5h");
      const blocked = await post(g, "j");
      assert.equal(blocked.status, 529);
      assert.match(await blocked.text(), /网关暂停/);
      assert.equal(up.seen.length, 1, "暂停期间不打上游");
    }
  );
});

test("网关（单账号）：认不出的 403 按 other 交回（正文不含 key）、记为上游故障，不停用账号、不发限额信号", async () => {
  await withGateway(
    [
      { status: 403, body: "forbidden: request from key-one not allowed" },
      { status: 200, body: "{}" },
    ],
    async (g, _up, l) => {
      const other = await post(g, "j");
      assert.equal(other.status, 403);
      assert.equal(await other.text(), "forbidden: request from [key] not allowed");
      assert.equal(g.meter("j").upstreamFailures, 1, "这一步作废重做");
      assert.equal(g.accountStatus()[0]?.down, null, "不停用账号");
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.equal((await post(g, "j")).status, 200, "同一账号照常可用");
    }
  );
});

test("网关（单账号）：认证 403 交回（正文不含 key）、记为上游故障，该账号停用；唯一的账号停用即整批停下", async () => {
  await withGateway([{ status: 403, body: "invalid api key: key-one" }], async (g, up, l) => {
    const auth = await post(g, "j");
    assert.equal(auth.status, 403);
    assert.equal(await auth.text(), "invalid api key: [key]");
    assert.equal(g.meter("j").upstreamFailures, 1, "这一步按上游故障作废重做，不以认证错误判题");
    assert.equal(g.accountStatus()[0]?.down, "auth");
    assert.equal(l.state, "stopped");
    assert.match(l.stopReason ?? "", /认证失败/);
    assert.equal((await post(g, "j")).status, 529);
    assert.equal(up.seen.length, 1);
  });
});

const ANTHROPIC_SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

test("网关：Pigeon 的模型接入经网关走通上游 SDK——路径、真 key、流式事件与按作业计量", async () => {
  await withGateway(
    [{ status: 200, body: ANTHROPIC_SSE, contentType: "text/event-stream" }],
    async (g, up) => {
      const streamFn = gatewayStreamFn(g.jobBaseUrl("s1|no-gate|1"));
      const stream = await streamFn(
        {} as never,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
        {}
      );
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        message?: { content: { type: string; text?: string }[] };
      }>) {
        if (event.type === "done")
          text = event.message?.content.map((c) => c.text ?? "").join("") ?? "";
      }
      assert.equal(text, "你好");
      assert.equal(up.seen[0]?.path, "/v1/messages");
      assert.equal(up.seen[0]?.key, "key-one");
      assert.deepEqual(g.meter("s1|no-gate|1"), {
        requests: 1,
        input: 12,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 1,
        accountRequests: [1],
      });
    }
  );
});

test("网关：探测发极小请求，上游 200 即恢复；非 200 为未恢复", async () => {
  await withGateway(
    [
      { status: 403, body: "usage limit" },
      { status: 200, body: "{}" },
    ],
    async (g, up) => {
      assert.equal(await g.probe(), false);
      assert.equal(await g.probe(), true);
      assert.deepEqual(
        up.seen.map((s) => [s.path, s.body]),
        [
          ["/v1/messages", '{"max_tokens":1}'],
          ["/v1/messages", '{"max_tokens":1}'],
        ]
      );
    }
  );
});

test("网关（单账号）：上游 5xx 记为出事作业的上游故障、不算限额；403 并发受限降该账号上限后透明重试；已是 1 仍受限即整批暂停", async () => {
  await withGateway(
    [
      {
        status: 503,
        body: '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
      },
      { status: 403, body: "too many concurrent requests" },
      { status: 200, body: "{}" },
      { status: 403, body: "too many concurrent requests" },
    ],
    async (g, _up, l) => {
      const r1 = await post(g, "s1|minimal|1");
      assert.equal(r1.status, 503);
      await r1.text();
      assert.equal(g.meter("s1|minimal|1").upstreamFailures, 1);
      assert.equal(g.meter("s1|full|1").upstreamFailures, 0, "别的作业不受影响");
      assert.equal(l.signals, 0, "5xx 不是限额");
      const r2 = await post(g, "s1|minimal|1");
      assert.equal(r2.status, 200, "并发受限：降上限后重试成功，客户端看不到");
      await r2.text();
      assert.deepEqual([l.signals, l.state, g.accountStatus()[0]?.cap], [0, "running", 1]);
      const r3 = await post(g, "s1|minimal|1");
      assert.equal(r3.status, 403);
      await r3.text();
      assert.deepEqual([l.signals, l.state], [1, "paused"]);
      assert.equal(l.pausesSince(0)[0]?.kind, "concurrency");
      // 403 只进限额信号，不算上游故障
      assert.equal(g.meter("s1|minimal|1").upstreamFailures, 1);
    }
  );
});

type Respond = (n: number, probe: boolean) => Scripted | Promise<Scripted>;

// 按 key 回应的假上游：每个 key 一个回应函数（可以返回一个等放行才完成的回应；第二个参数说明是不是探测请求），
// 记下各 key 收到的请求（seen 为非探测请求，probes 为探测请求）、在途数与在途峰值、探测的在途峰值
async function keyedUpstream(respond: Record<string, Respond>) {
  const seen: string[] = [];
  const probes: string[] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const probeInFlight = new Map<string, number>();
  const probePeak = new Map<string, number>();
  const counts = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string, d: number) =>
    m.set(key, (m.get(key) ?? 0) + d).get(key) ?? 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const probe = Buffer.concat(chunks).toString("utf8").includes('"max_tokens":1');
    const key = (req.headers["x-api-key"] as string | undefined) ?? "";
    (probe ? probes : seen).push(key);
    const n = bump(counts, key, 1);
    peak.set(key, Math.max(peak.get(key) ?? 0, bump(inFlight, key, 1)));
    if (probe) probePeak.set(key, Math.max(probePeak.get(key) ?? 0, bump(probeInFlight, key, 1)));
    const next = await (respond[key]?.(n, probe) ?? { status: 500, body: "没有这个 key" });
    bump(inFlight, key, -1);
    if (probe) bump(probeInFlight, key, -1);
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(next.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    probes,
    inFlight,
    peak,
    probePeak,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function withAccounts(
  respond: Record<string, Respond>,
  accounts: { key: string; concurrency: number }[],
  run: (
    g: ModelGateway,
    up: Awaited<ReturnType<typeof keyedUpstream>>,
    l: LimitController,
    warnings: string[],
    clock: ReturnType<typeof testClock>
  ) => Promise<void>,
  gatewayOptions: { backoffDelaysMs?: number[]; virtual?: boolean; autoBelowMs?: number } = {}
) {
  const up = await keyedUpstream(respond);
  const l = limits();
  const warnings: string[] = [];
  const clock = testClock({
    ...(gatewayOptions.virtual !== undefined ? { virtual: gatewayOptions.virtual } : {}),
    ...(gatewayOptions.autoBelowMs !== undefined
      ? { autoBelowMs: gatewayOptions.autoBelowMs }
      : {}),
  });
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts,
    limits: l,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    backoffDelaysMs: gatewayOptions.backoffDelaysMs ?? [1, 1],
    clock: clock.clock,
    warn: (w) => warnings.push(w),
  });
  try {
    await run(g, up, l, warnings, clock);
  } finally {
    await g.close();
    await up.close();
  }
}

const OK: Scripted = { status: 200, body: "{}" };
const QUOTA: Scripted = { status: 403, body: "usage limit reached, quota will reset in 5 hours" };

test("多账号：一个账号 429 退避用满即该账号暂时不可用、请求换号，整批不暂停；按账号记请求数；告警与正文不出现 key", async () => {
  await withAccounts(
    { "key-a": () => ({ status: 429, body: "rate limited key-a" }), "key-b": () => OK },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up, l, warnings) => {
      for (let i = 0; i < 4; i++) assert.equal((await post(g, "j")).status, 200);
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.equal(g.accountStatus()[0]?.down, "rate-limit");
      assert.equal(g.accountStatus()[1]?.down, null);
      // 账号 1 撞了 3 次（首撞与两级退避后各一次）即不可用，之后不再发往它
      assert.equal(up.seen.filter((k) => k === "key-a").length, 3);
      assert.deepEqual(g.meter("j").accountRequests, [0, 4]);
      assert.ok(warnings.some((w) => /账号 1.*暂时不可用/.test(w)));
      assert.ok(warnings.every((w) => !w.includes("key-")));
    }
  );
});

test("多账号：一个账号额度 403 只停该账号，同一请求透明换号重试；全部账号额度用完才整批暂停；单独探测恢复一个账号即立即恢复整批", async () => {
  let aQuota = true;
  await withAccounts(
    { "key-a": () => (aQuota ? QUOTA : OK), "key-b": (n) => (n === 1 ? OK : QUOTA) },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up, l, _w, clock) => {
      const r1 = await post(g, "j");
      assert.equal(r1.status, 200, "账号 1 额度用完：换到账号 2，客户端看不到");
      assert.deepEqual(up.seen, ["key-a", "key-b"]);
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.equal(g.accountStatus()[0]?.down, "5h");
      const r2 = await post(g, "j");
      assert.equal(r2.status, 403, "最后一个账号也额度用完：交回 403");
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "5h");
      assert.equal((await post(g, "j")).status, 529, "暂停期间直接拒绝");
      aQuota = false;
      // 控制器的探测不探正在单独探测的账号：一个请求也不发
      assert.equal(await g.probe(), false);
      assert.deepEqual(up.probes, []);
      // 各账号单独探测的第一个间隔到了：账号 1 通过即恢复，控制器随即恢复整批（控制器自己的探测永远不醒）
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => up.probes.length === 2, "两个账号各探一次");
      await until(() => l.state === "running", "整批恢复");
      assert.equal(g.accountStatus()[0]?.down, null);
      assert.equal(g.accountStatus()[1]?.down, "5h", "没通过探测的账号仍不可用");
      assert.notEqual(l.pausesSince(0)[0]?.endedAt, null);
      assert.equal((await post(g, "j")).status, 200);
    }
  );
});

test("多账号：每月额度用完的账号不再恢复；全部账号都是每月额度用完即停下", async () => {
  await withAccounts(
    { "key-a": () => ({ status: 403, body: "monthly usage limit reached" }), "key-b": () => QUOTA },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, _up, l) => {
      assert.equal((await post(g, "j")).status, 403);
      assert.equal(l.state, "paused", "还有能恢复的账号：暂停而不是停下");
      assert.deepEqual(
        g.accountStatus().map((a) => a.down),
        ["monthly", "5h"]
      );
    }
  );
  await withAccounts(
    { "key-a": () => ({ status: 403, body: "monthly usage limit reached" }) },
    [{ key: "key-a", concurrency: 1 }],
    async (g, up, l) => {
      assert.equal((await post(g, "j")).status, 403);
      assert.equal(l.state, "stopped");
      assert.equal(await g.probe(), false);
      assert.equal(up.seen.length, 1, "每月额度用完的账号不探测");
    }
  );
});

test("多账号：每个账号在途不超过它的并发上限，满了排队；排队时间记到作业上；请求按在途占比分摊到各账号", async () => {
  const release: (() => void)[] = [];
  const held = (): Promise<Scripted> => new Promise((resolve) => release.push(() => resolve(OK)));
  await withAccounts(
    { "key-a": held, "key-b": held },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up) => {
      const jobs = ["j1", "j2", "j3", "j4"];
      const pending = jobs.map((j) => post(g, j));
      while (release.length < 3) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(release.length, 3, "三个位子占满，第四个在排队");
      assert.deepEqual(
        g.accountStatus().map((a) => a.inFlight),
        [2, 1]
      );
      release.shift()?.();
      while (release.length < 3) await new Promise((r) => setTimeout(r, 5));
      for (const r of release.splice(0)) r();
      for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
      assert.deepEqual([up.peak.get("key-a"), up.peak.get("key-b")], [2, 1]);
      const queued = jobs.filter((j) => g.meter(j).queueMs > 0);
      assert.equal(queued.length, 1, "只有第四个请求排过队");
      assert.deepEqual(
        jobs.map((j) => g.meter(j).accountRequests.reduce((a, b) => a + b, 0)),
        [1, 1, 1, 1]
      );
    }
  );
});

test("多账号：作业的在途峰值——同一作业并发两个请求记 2，resetPeak 后从当前在途数重新记", async () => {
  const release: (() => void)[] = [];
  await withAccounts(
    {
      "key-a": (n) => (n <= 2 ? new Promise((resolve) => release.push(() => resolve(OK))) : OK),
    },
    [{ key: "key-a", concurrency: 2 }],
    async (g) => {
      const both = [post(g, "j"), post(g, "j")];
      while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
      for (const r of release.splice(0)) r();
      await Promise.all(both);
      assert.equal(g.meter("j").peakInFlight, 2);
      g.resetPeak("j");
      assert.equal(g.meter("j").peakInFlight, 0);
      assert.equal((await post(g, "j")).status, 200);
      assert.equal(g.meter("j").peakInFlight, 1);
    }
  );
});

test("账号配置：KIMI_API_KEY 为账号 1，KIMI_API_KEY_2、_3… 依次为后续账号；并发缺省 2，可按账号覆盖；取值不合法即报错", () => {
  assert.deepEqual(
    gatewayAccountsFromEnv({
      KIMI_API_KEY: "a",
      KIMI_API_KEY_2: "b",
      KIMI_API_KEY_3: "c",
      KIMI_API_KEY_3_CONCURRENCY: "4",
      KIMI_API_KEY_1_CONCURRENCY: "1",
    }),
    [
      { key: "a", concurrency: 1 },
      { key: "b", concurrency: 2 },
      { key: "c", concurrency: 4 },
    ]
  );
  assert.deepEqual(gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_2: "" }), [
    { key: "a", concurrency: 2 },
  ]);
  assert.throws(() => gatewayAccountsFromEnv({}), /KIMI_API_KEY/);
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_1_CONCURRENCY: "0" }),
    /KIMI_API_KEY_1_CONCURRENCY/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_3: "c" }),
    /KIMI_API_KEY_2/,
    "编号不连续即报错，免得漏掉账号"
  );
});

test("账号配置：账号数超过上限、并发变量指向不存在的账号、KIMI_API_KEY_1 都响亮报错，不静默忽略", () => {
  const nine: Record<string, string> = { KIMI_API_KEY: "k1" };
  for (let n = 2; n <= 9; n++) nine[`KIMI_API_KEY_${n}`] = `k${n}`;
  assert.equal(gatewayAccountsFromEnv(nine).length, 9);
  assert.throws(
    () => gatewayAccountsFromEnv({ ...nine, KIMI_API_KEY_10: "k10" }),
    /KIMI_API_KEY_10.*至多 9 个/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_12: "x" }),
    /至多 9 个/,
    "远超上限的编号也报错，不因跳号检查只查到上限而漏掉"
  );
  assert.throws(
    () =>
      gatewayAccountsFromEnv({
        KIMI_API_KEY: "a",
        KIMI_API_KEY_2: "b",
        KIMI_API_KEY_3_CONCURRENCY: "4",
      }),
    /KIMI_API_KEY_3_CONCURRENCY.*没有账号 3/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_1: "b" }),
    /KIMI_API_KEY_1/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_02: "b" }),
    /写法不对/
  );
  // 空值等于没设：不报错
  assert.equal(
    gatewayAccountsFromEnv({
      KIMI_API_KEY: "a",
      KIMI_API_KEY_5: "",
      KIMI_API_KEY_5_CONCURRENCY: "",
    }).length,
    1
  );
});

// ---- 复核补修 ----

const RATE: Scripted = { status: 429, body: "rate limited" };
const CONCURRENT: Scripted = { status: 403, body: "too many concurrent requests" };

// 回 429 头与半截正文后停住的上游：之后由用例决定断开（drop）或一直等（直到客户端中止）。headersSeen 为网关一侧的
// fetch 已收到这个上游的响应头（经 undici 的诊断通道得知）——此后清空一轮微任务，网关必然停在读错误正文上
async function stallingUpstream() {
  let got = 0;
  let current: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    got += 1;
    req.resume();
    current = res;
    res.writeHead(429, { "content-type": "application/json" });
    res.write('{"error":{"type":"rate_limit_error","message":"');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let headersSeen = false;
  const onHeaders = (message: unknown) => {
    const origin = (message as { request?: { origin?: unknown } }).request?.origin;
    if (String(origin).replace(/\/$/, "") === url) headersSeen = true;
  };
  diagnostics_channel.subscribe("undici:request:headers", onHeaders);
  return {
    url,
    got: () => got,
    headersSeen: () => headersSeen,
    drop: () => current?.socket?.destroy(),
    close: () =>
      new Promise<void>((r) => {
        diagnostics_channel.unsubscribe("undici:request:headers", onHeaders);
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("在途计数不泄漏：读 429 错误正文时客户端中止、或上游在错误正文中途断开，账号在途与作业在途都归零", async () => {
  for (const mode of ["hang", "drop"] as const) {
    const up = await stallingUpstream();
    const g = await startModelGateway({
      upstreamBaseUrl: up.url,
      accounts: [{ key: "key-one", concurrency: 1 }],
      limits: limits(),
      probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
      clock: testClock().clock,
      warn: () => {},
    });
    try {
      const client = new AbortController();
      const pending = post(g, "j", {}, client.signal).then(
        (r) => r.status,
        () => "aborted"
      );
      await until(() => up.got() === 1 && up.headersSeen(), "网关收到上游的响应头");
      await new Promise((r) => setImmediate(r));
      assert.equal(g.accountStatus()[0]?.inFlight, 1, "停在读错误正文：位子仍占着");
      if (mode === "hang") {
        client.abort();
        assert.equal(await pending, "aborted");
      } else {
        up.drop();
        assert.equal(await pending, 502, "上游中途断开：交回 502");
      }
      await until(
        () => g.accountStatus()[0]?.inFlight === 0 && g.jobInFlight("j") === 0,
        `${mode}：在途归零`
      );
      assert.equal(
        g.meter("j").upstreamFailures,
        mode === "drop" ? 1 : 0,
        "上游断开记上游故障，客户端自己中止不记"
      );
    } finally {
      await g.close();
      await up.close();
    }
  }
});

test("429 退避按轮次推进：同时在途的两路一起撞 429 只退避一次（5 秒），不跳级；冷却结束后的重试成功", async () => {
  const held: ((s: Scripted) => void)[] = [];
  await withAccounts(
    { "key-a": (n) => (n <= 2 ? new Promise<Scripted>((r) => held.push(r)) : OK) },
    [{ key: "key-a", concurrency: 2 }],
    async (g, up, l, _w, clock) => {
      const both = [post(g, "j1"), post(g, "j2")];
      await until(() => held.length === 2, "两路都在途");
      for (const r of held.splice(0)) r(RATE);
      await until(() => clock.pending().includes(5_000), "5 秒冷却");
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(clock.set, [5_000], "只开一轮 5 秒冷却，没有 15 秒");
      assert.equal(g.accountStatus()[0]?.cooling, true);
      await clock.advance(5_000);
      for (const r of await Promise.all(both)) assert.equal(r.status, 200);
      assert.deepEqual(clock.set, [5_000]);
      assert.equal(up.seen.length, 4);
      assert.equal(l.state, "running");
    },
    { backoffDelaysMs: [5_000, 15_000, 45_000], virtual: true, autoBelowMs: 0 }
  );
});

test("429 退避级数：冷却开始前派出的请求在冷却中成功，不把级数归零——冷却结束后再撞即升到 15 秒", async () => {
  const held: ((s: Scripted) => void)[] = [];
  const script: (Scripted | "hold")[] = ["hold", "hold", RATE, OK];
  await withAccounts(
    {
      "key-a": () => {
        const next = script.shift() ?? OK;
        return next === "hold" ? new Promise<Scripted>((r) => held.push(r)) : next;
      },
    },
    [{ key: "key-a", concurrency: 2 }],
    async (g, _up, _l, _w, clock) => {
      const p1 = post(g, "j1");
      const p2 = post(g, "j2");
      await until(() => held.length === 2, "两路都在途");
      held.pop()?.(RATE);
      await until(() => clock.pending().includes(5_000), "5 秒冷却");
      held.pop()?.(OK);
      await until(() => g.accountStatus()[0]?.inFlight === 0, "冷却前派出的请求成功");
      await clock.advance(5_000);
      await until(() => clock.pending().includes(15_000), "升到 15 秒");
      assert.deepEqual(clock.set, [5_000, 15_000]);
      await clock.advance(15_000);
      for (const r of await Promise.all([p1, p2])) assert.equal(r.status, 200);
    },
    { backoffDelaysMs: [5_000, 15_000, 45_000], virtual: true, autoBelowMs: 0 }
  );
});

test("429 退避时长（可控时钟）：单账号两路一直撞 429，依次退避 5、15、45 秒，第 65 秒仍撞才判不可用并整批暂停，不会在约 5 秒时暂停", async () => {
  await withAccounts(
    { "key-a": () => RATE },
    [{ key: "key-a", concurrency: 2 }],
    async (g, _up, l, _w, clock) => {
      const both = [post(g, "j1"), post(g, "j2")];
      const cools: number[] = [];
      let elapsed = 0;
      for (;;) {
        await until(
          () => l.state !== "running" || clock.pending().some((ms) => ms < 60_000),
          "下一轮冷却或暂停"
        );
        if (l.state !== "running") break;
        const ms = clock.pending().find((m) => m < 60_000) ?? 0;
        cools.push(ms);
        await clock.advance(ms);
        elapsed += ms;
      }
      assert.deepEqual(cools, [5_000, 15_000, 45_000]);
      assert.equal(elapsed, 65_000, "45 秒退避之后仍撞才暂停");
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "rate-limit");
      for (const r of await Promise.all(both)) assert.equal(r.status, 429);
    },
    { backoffDelaysMs: [5_000, 15_000, 45_000], virtual: true, autoBelowMs: 0 }
  );
});

test("冷却定时器带代次号：账号恢复之后开始的新冷却，不被恢复前那一轮的旧定时器提前结束", async () => {
  const held: ((s: Scripted) => void)[] = [];
  await withAccounts(
    {
      "key-a": (n, probe) =>
        probe ? OK : n <= 2 ? new Promise<Scripted>((r) => held.push(r)) : RATE,
    },
    [{ key: "key-a", concurrency: 2 }],
    async (g, up, l, _w, clock) => {
      const p1 = post(g, "j");
      const p2 = post(g, "j");
      await until(() => held.length === 2, "两路都在途");
      held.shift()?.(RATE);
      await until(() => g.accountStatus()[0]?.cooling === true, "第一轮冷却（10 分钟）");
      held.shift()?.(QUOTA);
      await until(() => l.state === "paused", "额度用完、整批暂停");
      assert.equal((await p1).status, 429);
      assert.equal((await p2).status, 403);
      // 5 分钟：单独探测通过，账号恢复、整批恢复；旧冷却的定时器（第 10 分钟到）仍在
      await clock.advance(5 * 60_000);
      await until(() => l.state === "running", "整批恢复");
      const p3 = post(g, "j");
      await until(() => up.seen.length === 3, "恢复后的请求撞 429");
      await until(() => g.accountStatus()[0]?.cooling === true, "新一轮冷却（到第 15 分钟）");
      // 第 10 分钟：旧定时器到点，不得结束新的冷却
      await clock.advance(5 * 60_000);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(g.accountStatus()[0]?.cooling, true, "旧定时器不结束新冷却");
      assert.equal(up.seen.length, 3, "冷却中不派请求");
      await clock.advance(5 * 60_000);
      assert.equal((await p3).status, 429);
    },
    { backoffDelaysMs: [10 * 60_000], virtual: true }
  );
});

test("探测占额度：探测占该账号一个在途位子，满了等空出；探测在途时新请求排队", async () => {
  const held: ((s: Scripted) => void)[] = [];
  const probeHeld: ((s: Scripted) => void)[] = [];
  await withAccounts(
    {
      "key-a": (n, probe) =>
        probe
          ? new Promise<Scripted>((r) => probeHeld.push(r))
          : n === 1
            ? new Promise<Scripted>((r) => held.push(r))
            : OK,
    },
    [{ key: "key-a", concurrency: 1 }],
    async (g, up) => {
      const p1 = post(g, "j");
      await until(() => held.length === 1, "第一个请求在途");
      const pre = g.preflight();
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(up.probes, [], "账号满着：探测等空出");
      held.shift()?.(OK);
      assert.equal((await p1).status, 200);
      await until(() => probeHeld.length === 1, "探测发出");
      assert.equal(g.accountStatus()[0]?.inFlight, 1, "探测计入在途");
      const p2 = post(g, "j");
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(up.seen.length, 1, "探测占着唯一的位子：新请求排队");
      probeHeld.shift()?.(OK);
      await pre;
      assert.equal((await p2).status, 200);
      assert.equal(up.peak.get("key-a"), 1, "上游看到的在途从不超过上限");
    }
  );
});

test("探测占额度：同一账号同一时刻只有一路探测——开跑前探测与控制器探测同时进行也只发一路，结果共用", async () => {
  const probeHeld: ((s: Scripted) => void)[] = [];
  const respond: Respond = (_n, probe) =>
    probe ? new Promise<Scripted>((r) => probeHeld.push(r)) : OK;
  await withAccounts(
    { "key-a": respond, "key-b": respond },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up) => {
      const all = Promise.all([g.preflight(), g.probe(), g.probe()]);
      await until(() => probeHeld.length === 2, "两个账号各一路探测");
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(up.probes.length, 2);
      assert.deepEqual([up.probePeak.get("key-a"), up.probePeak.get("key-b")], [1, 1]);
      for (const r of probeHeld.splice(0)) r(OK);
      const [, a, b] = await all;
      assert.deepEqual([a, b], [true, true]);
      assert.deepEqual(
        [...up.probes].sort(),
        ["key-a", "key-b"],
        "全部可用时每个账号都探，不只第一个"
      );
    }
  );
});

test("控制器的探测：全部账号都可用时每个账号都探，不只探第一个", async () => {
  await withAccounts(
    { "key-a": () => RATE, "key-b": () => OK },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up) => {
      assert.equal(await g.probe(), true, "账号 1 撞频率限制、账号 2 通过：整体通过");
      assert.deepEqual([...up.probes].sort(), ["key-a", "key-b"]);
    }
  );
});

test("探测占额度：暂停期间控制器的探测跳过正在单独探测的账号；单独探测时该账号的在途（请求加探测）不超过上限，探测至多一路", async () => {
  const held: ((s: Scripted) => void)[] = [];
  const probeHeld: ((s: Scripted) => void)[] = [];
  await withAccounts(
    {
      "key-a": (n, probe) =>
        probe
          ? new Promise<Scripted>((r) => probeHeld.push(r))
          : n === 1
            ? new Promise<Scripted>((r) => held.push(r))
            : QUOTA,
      "key-b": (_n, probe) => (probe ? new Promise<Scripted>((r) => probeHeld.push(r)) : QUOTA),
    },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up, l, _w, clock) => {
      const p1 = post(g, "j1");
      await until(() => held.length === 1, "账号 1 上有一个在途请求");
      assert.equal((await post(g, "j2")).status, 403);
      assert.equal(l.state, "paused");
      for (let i = 0; i < 3; i++) assert.equal(await g.probe(), false);
      assert.deepEqual(up.probes, [], "控制器不探正在单独探测的账号");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => probeHeld.length === 2, "两个账号的单独探测发出");
      assert.equal(await g.probe(), false);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(up.probes.length, 2, "探测在途时控制器也不另探");
      assert.deepEqual(
        g.accountStatus().map((a) => a.inFlight),
        [2, 1],
        "探测计入在途"
      );
      assert.deepEqual([up.peak.get("key-a"), up.peak.get("key-b")], [2, 1], "不超过各账号上限");
      assert.deepEqual([up.probePeak.get("key-a"), up.probePeak.get("key-b")], [1, 1]);
      for (const r of probeHeld.splice(0)) r(OK);
      await until(() => l.state === "running", "单独探测通过即恢复整批");
      held.shift()?.(OK);
      assert.equal((await p1).status, 200);
    }
  );
});

test("开跑前逐账号探测：凡不是成功、也不是额度、并发、限流的（认证失败、认不出的 403、5xx）一律拒绝开跑并报出账号编号（不含 key）", async () => {
  await withAccounts(
    {
      "key-a": () => OK,
      "key-b": () => ({ status: 401, body: '{"error":{"message":"invalid api key key-b"}}' }),
      "key-c": () => ({ status: 403, body: "forbidden" }),
      "key-d": () => QUOTA,
      "key-e": () => ({ status: 503, body: "busy" }),
    },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
      { key: "key-c", concurrency: 1 },
      { key: "key-d", concurrency: 1 },
      { key: "key-e", concurrency: 1 },
    ],
    async (g, up) => {
      await assert.rejects(g.preflight(), (e: Error) => {
        assert.match(
          e.message,
          /账号 2（认证失败）、账号 3（认不出的回应或连不上）、账号 5（认不出的回应或连不上）/
        );
        assert.doesNotMatch(e.message, /key-/);
        return true;
      });
      assert.equal(up.probes.length, 5, "逐账号各探一次");
    }
  );
  await withAccounts(
    {
      "key-a": () => OK,
      "key-b": () => QUOTA,
      "key-c": () => CONCURRENT,
      "key-d": () => RATE,
    },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
      { key: "key-c", concurrency: 1 },
      { key: "key-d", concurrency: 1 },
    ],
    async (g, _up, _l, warnings) => {
      await g.preflight();
      for (const n of [3, 4]) {
        assert.ok(
          warnings.some((w) => w.startsWith(`账号 ${n}开跑前探测撞上限额`)),
          `并发、限流只告警，开跑后照常处理（账号 ${n}）`
        );
      }
      // 额度用完的账号直接置为不可用：容量从一开始就不含它（其余三个账号各 1），按间隔探测恢复
      assert.ok(warnings.some((w) => w.startsWith("账号 2额度用完，暂时不可用")));
      assert.equal(g.capacity(), 3);
    }
  );
});

test("认证失败：运行中 key 被吊销——该请求记为上游故障（这一步作废重做），账号停用且不探测恢复，其余账号照常", async () => {
  await withAccounts(
    {
      "key-a": (n) => (n === 1 ? OK : { status: 401, body: "invalid api key key-a" }),
      "key-b": () => OK,
    },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up, l, warnings, clock) => {
      assert.equal((await post(g, "s1|full|1")).status, 200);
      const revoked = await post(g, "s1|full|1");
      assert.equal(revoked.status, 401);
      assert.equal(await revoked.text(), "invalid api key [key]");
      assert.equal(g.meter("s1|full|1").upstreamFailures, 1);
      assert.equal(g.accountStatus()[0]?.down, "auth");
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.equal((await post(g, "s1|full|1")).status, 200);
      assert.deepEqual(up.seen, ["key-a", "key-a", "key-b"]);
      await clock.advance(24 * 60 * 60_000);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(up.probes, [], "认证失败的账号不探测恢复");
      assert.ok(warnings.some((w) => /账号 1认证失败.*需人工/.test(w)));
      assert.ok(warnings.every((w) => !w.includes("key-")));
    }
  );
});

test("403 并发：按派发时的上限判定——同时受限的几路只降一次上限、不判不可用，各等 3 秒后重试；上限 1 时派出的再受限才不可用", async () => {
  const held: ((s: Scripted) => void)[] = [];
  const HOLD = "hold" as const;
  const script: (Scripted | typeof HOLD)[] = [HOLD, HOLD, HOLD, OK, OK, OK, HOLD, HOLD, OK, OK];
  await withAccounts(
    {
      "key-a": () => {
        const next = script.shift() ?? CONCURRENT;
        return next === HOLD ? new Promise<Scripted>((r) => held.push(r)) : next;
      },
    },
    [{ key: "key-a", concurrency: 3 }],
    async (g, _up, l, _w, clock) => {
      const status = () => [g.accountStatus()[0]?.cap, g.accountStatus()[0]?.down, l.state];
      const waiting = (n: number) => clock.pending().filter((ms) => ms === 3_000).length === n;
      // 上限 3 时派出的三路一起受限：上限只降一次（到 2）
      const three = [post(g, "j1"), post(g, "j2"), post(g, "j3")];
      await until(() => held.length === 3, "三路都在途");
      for (const r of held.splice(0)) r(CONCURRENT);
      await until(() => waiting(3), "三路各等 3 秒");
      assert.deepEqual(status(), [2, null, "running"]);
      await clock.advance(3_000);
      for (const r of await Promise.all(three)) assert.equal(r.status, 200);
      // 上限 2 时派出的两路：第一路回来降到 1，第二路回来时上限已是 1，但它是在上限 2 时派出的，不判不可用
      const two = [post(g, "j1"), post(g, "j2")];
      await until(() => held.length === 2, "两路都在途");
      for (const r of held.splice(0)) r(CONCURRENT);
      await until(() => waiting(2), "两路各等 3 秒");
      assert.deepEqual(status(), [1, null, "running"]);
      await clock.advance(3_000);
      for (const r of await Promise.all(two)) assert.equal(r.status, 200);
      // 上限 1 时派出的再受限：该账号不可用
      const last = await post(g, "j1");
      assert.equal(last.status, 403);
      assert.deepEqual(status(), [1, "concurrency", "paused"]);
    },
    { virtual: true, autoBelowMs: 0 }
  );
});

test("排队中的请求被客户端中止即刻出队：作业在途即时归零、resetPeak 不受残留影响，排队时间不再累加、不记到下一步", async () => {
  const held: ((s: Scripted) => void)[] = [];
  await withAccounts(
    { "key-a": (n) => (n === 1 ? new Promise<Scripted>((r) => held.push(r)) : OK) },
    [{ key: "key-a", concurrency: 1 }],
    async (g, up) => {
      const p1 = post(g, "j1");
      await until(() => held.length === 1, "占满唯一的位子");
      const client = new AbortController();
      const p2 = post(g, "j2", {}, client.signal).catch(() => "aborted");
      await until(() => g.jobInFlight("j2") === 1, "第二个请求排队");
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(g.meter("j2").queueMs >= 30, "仍在排队的请求已等的时间实时计入");
      client.abort();
      assert.equal(await p2, "aborted");
      await until(() => g.jobInFlight("j2") === 0, "出队");
      g.resetPeak("j2");
      assert.equal(g.meter("j2").peakInFlight, 0);
      const queued = g.meter("j2").queueMs;
      held.shift()?.(OK);
      assert.equal((await p1).status, 200);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(up.seen.length, 1, "中止的请求不再派出");
      assert.equal(g.meter("j2").queueMs, queued, "排队时间不再累加");
      assert.equal(g.accountStatus()[0]?.inFlight, 0);
    }
  );
});

test("收尾：close() 取消冷却、单独探测与上限回升的定时，跑完后进程不因定时器多挂", async () => {
  const live = new Set<object>();
  const clock: GatewayClock = {
    now: Date.now,
    setTimer(ms, fn) {
      const token = {};
      live.add(token);
      const t = setTimeout(() => {
        live.delete(token);
        fn();
      }, ms);
      return () => {
        live.delete(token);
        clearTimeout(t);
      };
    },
  };
  const up = await keyedUpstream({
    "key-a": () => RATE,
    "key-b": () => QUOTA,
    "key-c": (n) => (n === 1 ? CONCURRENT : OK),
  });
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts: [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
      { key: "key-c", concurrency: 2 },
    ],
    limits: limits(),
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    concurrencyRetryDelayMs: 1,
    clock,
    warn: () => {},
  });
  try {
    assert.equal((await post(g, "j")).status, 200);
    // 账号 1 冷却 5 秒、账号 2 等 5 分钟探测、账号 3 等 30 分钟回升上限
    assert.ok(live.size >= 3, `应有三个未到的定时，实有 ${live.size}`);
  } finally {
    await g.close();
    await up.close();
  }
  assert.equal(live.size, 0, "close() 取消全部定时");
  assert.equal(
    process.getActiveResourcesInfo().filter((r) => r === "Timeout").length,
    before,
    "没有多出的计时器"
  );
});

test("上限回升：因 403 并发降下的上限每 30 分钟回升 1，最多回到配置值", async () => {
  await withAccounts(
    { "key-a": (n) => (n <= 2 ? CONCURRENT : OK) },
    [{ key: "key-a", concurrency: 3 }],
    async (g, _up, _l, warnings, clock) => {
      assert.equal((await post(g, "j")).status, 200);
      assert.equal(g.accountStatus()[0]?.cap, 1);
      await clock.advance(30 * 60_000);
      assert.equal(g.accountStatus()[0]?.cap, 2);
      await clock.advance(30 * 60_000);
      assert.equal(g.accountStatus()[0]?.cap, 3);
      await clock.advance(5 * 60 * 60_000);
      assert.equal(g.accountStatus()[0]?.cap, 3, "不超过配置值");
      assert.deepEqual(clock.pending(), [], "回到配置值即不再定时");
      assert.ok(warnings.some((w) => /账号 1并发上限回升为 3/.test(w)));
    }
  );
});

test("每月额度：单独探测中发现已转为每月额度的账号停止探测；最后一个能恢复的账号转为每月额度即整批停下", async () => {
  await withAccounts(
    {
      "key-a": (_n, probe) =>
        probe ? { status: 403, body: "monthly usage limit reached" } : QUOTA,
      "key-b": () => OK,
    },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up, l, _w, clock) => {
      assert.equal((await post(g, "j")).status, 200);
      assert.equal(g.accountStatus()[0]?.down, "5h");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => g.accountStatus()[0]?.down === "monthly", "转为每月额度");
      await clock.advance(24 * 60 * 60_000);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(up.probes, ["key-a"], "之后不再探测");
      assert.equal(l.state, "running");
    }
  );
  await withAccounts(
    {
      "key-a": (_n, probe) =>
        probe ? { status: 403, body: "monthly usage limit reached" } : QUOTA,
    },
    [{ key: "key-a", concurrency: 1 }],
    async (g, _up, l, _w, clock) => {
      assert.equal((await post(g, "j")).status, 403);
      assert.equal(l.state, "paused");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => l.state === "stopped", "整批停下");
      assert.match(l.stopReason ?? "", /每月额度/);
    }
  );
});

test("账号配置：KIMI_API_KEY_ 前缀下认不出的变量名一律报错，报错只写变量名、不写取值", () => {
  for (const name of [
    "KIMI_API_KEY_CONCURRENCY",
    "KIMI_API_KEY_2_CONCURENCY",
    "KIMI_API_KEY_B",
    "KIMI_API_KEY_",
  ]) {
    assert.throws(
      () => gatewayAccountsFromEnv({ KIMI_API_KEY: "secret-a", [name]: "secret-x" }),
      (e: Error) => {
        assert.ok(e.message.startsWith(`${name}：认不出的变量名`), e.message);
        assert.doesNotMatch(e.message, /secret-/);
        return true;
      }
    );
  }
  assert.throws(
    () => gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEY_CONCURRENCY: "" }),
    /KIMI_API_KEY_CONCURRENCY：认不出/,
    "取值为空的也报：多半是写错了名字"
  );
  assert.equal(gatewayAccountsFromEnv({ KIMI_API_KEY: "a", KIMI_API_KEYS: "x" }).length, 1);
});

test("开跑前校验：路数大于各账号配置并发之和即拒绝开跑，报出两个数（不含 key）", () => {
  const accounts = [
    { key: "secret-1", concurrency: 2 },
    { key: "secret-2", concurrency: 2 },
    { key: "secret-3", concurrency: 2 },
  ];
  assert.doesNotThrow(() => assertConcurrencyFits(6, accounts));
  assert.throws(
    () => assertConcurrencyFits(7, accounts),
    (e: Error) => {
      assert.match(e.message, /路数 7 大于各账号配置并发之和 6/);
      assert.doesNotMatch(e.message, /secret-/);
      return true;
    }
  );
});

// 可用容量（决策 163）：未停用账号当前并发上限之和
test("可用容量：额度停用、上限降低即下降，恢复与回升即回到原值，每次变化都通知；429 退避期间不下降、不通知", async () => {
  let aState: "ok" | "rate" | "quota" | "concurrent" = "ok";
  await withAccounts(
    {
      "key-a": (_n, probe) => {
        if (probe) return OK;
        if (aState === "concurrent") {
          // 只受限一次：降上限后的重试照常
          aState = "ok";
          return CONCURRENT;
        }
        return aState === "rate" ? RATE : aState === "quota" ? QUOTA : OK;
      },
      "key-b": () => OK,
      "key-c": () => OK,
    },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
      { key: "key-c", concurrency: 2 },
    ],
    async (g, _up, _l, _w, clock) => {
      let notified = 0;
      const stop = g.subscribeCapacity(() => {
        notified += 1;
      });
      assert.equal(g.capacity(), 6);
      aState = "rate";
      assert.equal((await post(g, "j")).status, 200, "撞 429 换号");
      assert.equal(g.accountStatus()[0]?.cooling, true);
      assert.deepEqual([g.capacity(), notified], [6, 0], "退避三级之内不计入容量下降");
      await clock.advance(10 * 60_000);
      aState = "concurrent";
      await until(() => g.accountStatus()[0]?.cooling === false, "冷却结束");
      assert.equal((await post(g, "j")).status, 200);
      assert.deepEqual([g.capacity(), notified], [5, 1], "上限降 1");
      await clock.advance(30 * 60_000);
      assert.deepEqual([g.capacity(), notified], [6, 2], "上限回升");
      aState = "quota";
      assert.equal((await post(g, "j")).status, 200);
      assert.deepEqual([g.capacity(), notified], [4, 3], "账号 1 额度停用");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => g.capacity() === 6, "单独探测通过、账号恢复");
      assert.equal(notified, 4);
      stop();
    },
    { backoffDelaysMs: [5_000, 15_000, 45_000], autoBelowMs: 4_000 }
  );
});

test("排队看守：作业自登记起累计等空闲账号超过阈值即通知一次；别的作业不算；停止看守后不再通知", async () => {
  const held: ((s: Scripted) => void)[] = [];
  await withAccounts(
    { "key-a": () => new Promise<Scripted>((r) => held.push(r)) },
    [{ key: "key-a", concurrency: 1 }],
    async (g, _up, _l, _w, clock) => {
      const fired: string[] = [];
      g.watchQueue("j2", 30_000, () => fired.push("j2"));
      const stopped = g.watchQueue("j3", 30_000, () => fired.push("j3"));
      g.watchQueue("j1", 30_000, () => fired.push("j1"));
      const p1 = post(g, "j1");
      await until(() => held.length === 1, "占满唯一的位子");
      const p2 = post(g, "j2");
      const p3 = post(g, "j3");
      await until(() => g.jobInFlight("j2") === 1 && g.jobInFlight("j3") === 1, "两个作业在排队");
      stopped();
      await clock.advance(29_000);
      assert.deepEqual(fired, [], "未超过阈值");
      await clock.advance(2_000);
      assert.deepEqual(fired, ["j2"], "只通知排队超时的作业，且只一次；j3 已停止看守，j1 没排队");
      await clock.advance(60_000);
      assert.deepEqual(fired, ["j2"]);
      for (let i = 0; i < 3; i++) {
        await until(() => held.length === 1, "下一个请求派出");
        held.shift()?.(OK);
      }
      for (const r of await Promise.all([p1, p2, p3])) assert.equal(r.status, 200);
    },
    { virtual: true, autoBelowMs: 0 }
  );
});

test("收尾：关闭之后不再新设定时——关闭时同一作业还有多个请求在排队，它们逐个退出时也不为排队看守设定时", async () => {
  let afterClose = 0;
  let closing = false;
  const clock: GatewayClock = {
    now: Date.now,
    setTimer(ms, fn) {
      if (closing) afterClose += 1;
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const held: ((s: Scripted) => void)[] = [];
  const up = await keyedUpstream({ "key-a": () => new Promise<Scripted>((r) => held.push(r)) });
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts: [{ key: "key-a", concurrency: 1 }],
    limits: limits(),
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    clock,
    warn: () => {},
  });
  try {
    const all = [post(g, "j1"), post(g, "j2"), post(g, "j2"), post(g, "j2")].map((p) =>
      p.catch(() => undefined)
    );
    await until(() => held.length === 1 && g.jobInFlight("j2") === 3, "一个在途、三个排队");
    g.watchQueue("j2", 30 * 60_000, () => {});
    closing = true;
    await g.close();
    for (const r of held.splice(0)) r(OK);
    await Promise.all(all);
    assert.equal(afterClose, 0, "关闭之后一个定时也不设");
  } finally {
    await up.close();
  }
});
