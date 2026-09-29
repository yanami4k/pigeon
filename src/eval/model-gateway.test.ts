import assert from "node:assert/strict";
import diagnostics_channel from "node:diagnostics_channel";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gatewayStreamFn } from "../pi-runtime/index.ts";
import { requestCostCny } from "../state/model-pricing.ts";
import {
  assertConcurrencyFits,
  type GatewayClock,
  gatewayAccountsFromEnv,
  type ModelGateway,
  meterDelta,
  redactBody,
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
    serverErrorRetryDelaysMs: [1, 1],
    // 虚拟时钟：计价时刻固定在 0（北京时间 1970-01-01 周四 8 时，空闲时段）
    clock: testClock({ virtual: true }).clock,
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
        costCny: requestCostCny({ input: 120, cacheRead: 30, cacheWrite: 0, output: 42 }, 0, 0).cny,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 1,
        peakInputTokens: 150,
        accountRequests: [1],
      });
      assert.deepEqual(g.meter("other"), {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costCny: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        peakInputTokens: 0,
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

// DeepSeek 实测的错误正文形状（两个端点都是 OpenAI 风格）
const deepseekError = (type: string, message: string) =>
  JSON.stringify({ error: { message, type, param: null, code: "invalid_request_error" } });
const BALANCE: Scripted = {
  status: 402,
  body: deepseekError("invalid_request_error", "Insufficient Balance"),
};
const BUSY: Scripted = { status: 503, body: deepseekError("server_error", "Server overloaded") };

test("网关（单账号）：402 余额不足即停批（计一次限额信号，这一步作废、不当真失败），停下期间直接 529 不打上游；交回的正文里没有 key", async () => {
  await withGateway(
    [
      {
        status: 402,
        body: deepseekError("invalid_request_error", "Insufficient Balance for key-one"),
      },
    ],
    async (g, up, l) => {
      const balance = await post(g, "j");
      assert.equal(balance.status, 402);
      assert.doesNotMatch(await balance.text(), /key-one/);
      assert.equal(l.state, "stopped");
      assert.equal(l.signals, 1, "限额信号：跑批器据此作废这一步");
      assert.match(l.stopReason ?? "", /余额不足/);
      assert.equal(g.accountStatus()[0]?.down, "balance");
      assert.equal(g.meter("j").upstreamFailures, 0, "不是上游故障");
      const blocked = await post(g, "j");
      assert.equal(blocked.status, 529);
      assert.match(await blocked.text(), /网关暂停/);
      assert.equal(await g.probe(), false, "余额不足的账号不探测");
      assert.equal(up.seen.length, 1, "停下期间不打上游");
    }
  );
});

test("网关（单账号）：503 服务器繁忙按 429 同样退避后重试，不记上游故障、不作废；退避用满即该账号暂时不可用、整批暂停", async () => {
  await withGateway([BUSY, { status: 200, body: "{}" }, BUSY, BUSY, BUSY], async (g, up, l) => {
    assert.equal((await post(g, "j")).status, 200, "退避一次后成功");
    assert.equal(g.meter("j").upstreamFailures, 0);
    assert.equal(l.signals, 0);
    const exhausted = await post(g, "j");
    assert.equal(exhausted.status, 503);
    assert.equal(up.seen.length, 5);
    assert.equal(l.state, "paused");
    assert.equal(l.pausesSince(0)[0]?.kind, "busy");
    assert.equal(g.accountStatus()[0]?.down, "busy");
  });
});

test("网关（单账号）：500 服务器故障不动账号、这次请求退避重试有限次——重试后成功即照常；用满仍是 500 即交回并记上游故障（这一步作废重做）", async () => {
  const E500: Scripted = { status: 500, body: deepseekError("server_error", "internal error") };
  await withGateway(
    [E500, E500, { status: 200, body: "{}" }, E500, E500, E500],
    async (g, up, l) => {
      assert.equal((await post(g, "a")).status, 200, "两次 500 之后成功");
      assert.equal(g.meter("a").upstreamFailures, 0);
      const failed = await post(g, "b");
      assert.equal(failed.status, 500, "首次加两次重试都是 500：交回");
      assert.equal(g.meter("b").upstreamFailures, 1);
      assert.equal(up.seen.length, 6);
      assert.deepEqual([l.state, l.signals, g.accountStatus()[0]?.down], ["running", 0, null]);
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

test("网关（单账号）：认证 401 交回（正文不含 key，也不含回显的末四位）、记为上游故障，该账号停用；唯一的账号停用即整批停下", async () => {
  const body = deepseekError(
    "authentication_error",
    "Authentication Fails, Your api key: ****-one is invalid (request_id: 1f2e)"
  );
  await withGateway([{ status: 401, body }], async (g, up, l) => {
    const auth = await post(g, "j");
    assert.equal(auth.status, 401);
    const text = await auth.text();
    assert.doesNotMatch(text, /-one/);
    assert.match(text, /Your api key: \[key\] is invalid/);
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
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"deepseek-flash","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":64,"output_tokens":0,"service_tier":"standard"}}}',
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
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":64,"output_tokens":5,"service_tier":"standard"}}',
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
      // 自构模型对象的请求参数（决策 203）：模型名 deepseek-flash、显式关思考、单次输出上限 16384
      const sent = JSON.parse(up.seen[0]?.body ?? "{}") as Record<string, unknown>;
      assert.equal(sent.model, "deepseek-flash");
      assert.deepEqual(sent.thinking, { type: "disabled" });
      assert.equal(sent.max_tokens, 16384);
      assert.deepEqual(g.meter("s1|no-gate|1"), {
        requests: 1,
        input: 12,
        output: 5,
        cacheRead: 64,
        cacheWrite: 0,
        costCny: requestCostCny({ input: 12, cacheRead: 64, cacheWrite: 0, output: 5 }, 0, 0).cny,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 1,
        peakInputTokens: 76,
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

test("网关（单账号）：上游 502 记为出事作业的上游故障、不算限额；403 并发受限降该账号上限后透明重试；已是 1 仍受限即整批暂停", async () => {
  await withGateway(
    [
      { status: 502, body: "bad gateway" },
      { status: 403, body: "too many concurrent requests" },
      { status: 200, body: "{}" },
      { status: 403, body: "too many concurrent requests" },
    ],
    async (g, _up, l) => {
      const r1 = await post(g, "s1|minimal|1");
      assert.equal(r1.status, 502);
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
  gatewayOptions: {
    backoffDelaysMs?: number[];
    virtual?: boolean;
    autoBelowMs?: number;
  } = {}
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
// 退避级数为空时一次 503 即该账号暂时不可用（按间隔探测恢复）：用来检验账号停用、换号与恢复本身
const NO_BACKOFF = { backoffDelaysMs: [] as number[] };

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

test("多账号：一个账号暂时不可用只停该账号，同一请求透明换号重试；全部账号不可用才整批暂停；单独探测恢复一个账号即立即恢复整批", async () => {
  let aBusy = true;
  await withAccounts(
    { "key-a": () => (aBusy ? BUSY : OK), "key-b": (n) => (n === 1 ? OK : BUSY) },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up, l, _w, clock) => {
      const r1 = await post(g, "j");
      assert.equal(r1.status, 200, "账号 1 不可用：换到账号 2，客户端看不到");
      assert.deepEqual(up.seen, ["key-a", "key-b"]);
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.equal(g.accountStatus()[0]?.down, "busy");
      const r2 = await post(g, "j");
      assert.equal(r2.status, 503, "最后一个账号也不可用：交回 503");
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "busy");
      assert.equal((await post(g, "j")).status, 529, "暂停期间直接拒绝");
      aBusy = false;
      // 控制器的探测不探正在单独探测的账号：一个请求也不发
      assert.equal(await g.probe(), false);
      assert.deepEqual(up.probes, []);
      // 各账号单独探测的第一个间隔到了：账号 1 通过即恢复，控制器随即恢复整批（控制器自己的探测永远不醒）
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => up.probes.length === 2, "两个账号各探一次");
      await until(() => l.state === "running", "整批恢复");
      assert.equal(g.accountStatus()[0]?.down, null);
      assert.equal(g.accountStatus()[1]?.down, "busy", "没通过探测的账号仍不可用");
      assert.notEqual(l.pausesSince(0)[0]?.endedAt, null);
      assert.equal((await post(g, "j")).status, 200);
    },
    NO_BACKOFF
  );
});

test("多账号：余额不足的账号不再恢复、请求换号；全部账号都是余额不足即停下；错误正文去密钥后记一次日志", async () => {
  await withAccounts(
    { "key-a": () => BALANCE, "key-b": () => BUSY },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, _up, l) => {
      assert.equal((await post(g, "j")).status, 503);
      assert.equal(l.state, "paused", "还有能恢复的账号：暂停而不是停下");
      assert.deepEqual(
        g.accountStatus().map((a) => a.down),
        ["balance", "busy"]
      );
    },
    NO_BACKOFF
  );
  await withAccounts(
    { "key-a": () => BALANCE, "key-b": () => OK },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, _up, l, warnings) => {
      assert.equal((await post(g, "j")).status, 200, "账号 1 余额不足：换到账号 2");
      assert.deepEqual([l.state, l.signals], ["running", 0]);
      assert.ok(warnings.some((w) => /账号 1余额不足：不再使用/.test(w)));
      assert.ok(
        warnings.some((w) =>
          /账号 1上游错误（已去密钥）：invalid_request_error.*Insufficient Balance/.test(w)
        )
      );
    }
  );
  await withAccounts(
    { "key-a": () => BALANCE },
    [{ key: "key-a", concurrency: 1 }],
    async (g, up, l) => {
      assert.equal((await post(g, "j")).status, 402);
      assert.equal(l.state, "stopped");
      assert.equal(await g.probe(), false);
      assert.equal(up.seen.length, 1, "余额不足的账号不探测");
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

test("账号配置：DEEPSEEK_API_KEY 为账号 1，DEEPSEEK_API_KEY_2、_3… 依次为后续账号；并发缺省 2500（官方单账号上限），可按账号覆盖；取值不合法即报错", () => {
  assert.deepEqual(
    gatewayAccountsFromEnv({
      DEEPSEEK_API_KEY: "a",
      DEEPSEEK_API_KEY_2: "b",
      DEEPSEEK_API_KEY_3: "c",
      DEEPSEEK_API_KEY_3_CONCURRENCY: "4",
      DEEPSEEK_API_KEY_1_CONCURRENCY: "1",
    }),
    [
      { key: "a", concurrency: 1 },
      { key: "b", concurrency: 2500 },
      { key: "c", concurrency: 4 },
    ]
  );
  assert.deepEqual(gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_2: "" }), [
    { key: "a", concurrency: 2500 },
  ]);
  assert.throws(() => gatewayAccountsFromEnv({}), /DEEPSEEK_API_KEY/);
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_1_CONCURRENCY: "0" }),
    /DEEPSEEK_API_KEY_1_CONCURRENCY/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_3: "c" }),
    /DEEPSEEK_API_KEY_2/,
    "编号不连续即报错，免得漏掉账号"
  );
});

test("账号配置：账号数超过上限、并发变量指向不存在的账号、DEEPSEEK_API_KEY_1 都响亮报错，不静默忽略", () => {
  const nine: Record<string, string> = { DEEPSEEK_API_KEY: "k1" };
  for (let n = 2; n <= 9; n++) nine[`DEEPSEEK_API_KEY_${n}`] = `k${n}`;
  assert.equal(gatewayAccountsFromEnv(nine).length, 9);
  assert.throws(
    () => gatewayAccountsFromEnv({ ...nine, DEEPSEEK_API_KEY_10: "k10" }),
    /DEEPSEEK_API_KEY_10.*至多 9 个/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_12: "x" }),
    /至多 9 个/,
    "远超上限的编号也报错，不因跳号检查只查到上限而漏掉"
  );
  assert.throws(
    () =>
      gatewayAccountsFromEnv({
        DEEPSEEK_API_KEY: "a",
        DEEPSEEK_API_KEY_2: "b",
        DEEPSEEK_API_KEY_3_CONCURRENCY: "4",
      }),
    /DEEPSEEK_API_KEY_3_CONCURRENCY.*没有账号 3/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_1: "b" }),
    /DEEPSEEK_API_KEY_1/
  );
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_02: "b" }),
    /写法不对/
  );
  // 空值等于没设：不报错
  assert.equal(
    gatewayAccountsFromEnv({
      DEEPSEEK_API_KEY: "a",
      DEEPSEEK_API_KEY_5: "",
      DEEPSEEK_API_KEY_5_CONCURRENCY: "",
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
            : BUSY,
      "key-b": (_n, probe) => (probe ? new Promise<Scripted>((r) => probeHeld.push(r)) : BUSY),
    },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up, l, _w, clock) => {
      const p1 = post(g, "j1");
      await until(() => held.length === 1, "账号 1 上有一个在途请求");
      assert.equal((await post(g, "j2")).status, 503);
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
    },
    NO_BACKOFF
  );
});

test("开跑前逐账号探测：凡不是成功、也不是并发、限流、繁忙的（认证失败、余额不足、认不出的 403、500）一律拒绝开跑并报出账号编号（不含 key）", async () => {
  await withAccounts(
    {
      "key-a": () => OK,
      "key-b": () => ({ status: 401, body: '{"error":{"message":"invalid api key key-b"}}' }),
      "key-c": () => ({ status: 403, body: "forbidden" }),
      "key-d": () => BALANCE,
      "key-e": () => ({ status: 500, body: "boom" }),
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
          /账号 2（认证失败）、账号 3（认不出的回应或连不上）、账号 4（余额不足）、账号 5（认不出的回应或连不上）/
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
      "key-b": () => BUSY,
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
      for (const n of [2, 3, 4]) {
        assert.ok(
          warnings.some((w) => w.startsWith(`账号 ${n}开跑前探测撞上限额`)),
          `繁忙、并发、限流只告警，开跑后照常处理（账号 ${n}）`
        );
      }
      assert.equal(g.capacity(), 4);
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
    "key-b": () => BUSY,
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
    // 账号 1 只退避一级即不可用：之后等 5 分钟探测
    backoffDelaysMs: [5_000],
    clock,
    warn: () => {},
  });
  try {
    assert.equal((await post(g, "j")).status, 200);
    // 账号 1 冷却 5 秒、账号 2 冷却 5 秒、账号 3 等 30 分钟回升上限
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

test("余额不足：单独探测中发现已余额不足的账号停止探测；最后一个能恢复的账号转为余额不足即整批停下", async () => {
  await withAccounts(
    {
      "key-a": (_n, probe) => (probe ? BALANCE : BUSY),
      "key-b": () => OK,
    },
    [
      { key: "key-a", concurrency: 1 },
      { key: "key-b", concurrency: 1 },
    ],
    async (g, up, l, _w, clock) => {
      assert.equal((await post(g, "j")).status, 200);
      assert.equal(g.accountStatus()[0]?.down, "busy");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => g.accountStatus()[0]?.down === "balance", "转为余额不足");
      await clock.advance(24 * 60 * 60_000);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(up.probes, ["key-a"], "之后不再探测");
      assert.equal(l.state, "running");
    },
    NO_BACKOFF
  );
  await withAccounts(
    { "key-a": (_n, probe) => (probe ? BALANCE : BUSY) },
    [{ key: "key-a", concurrency: 1 }],
    async (g, _up, l, _w, clock) => {
      assert.equal((await post(g, "j")).status, 503);
      assert.equal(l.state, "paused");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => l.state === "stopped", "整批停下");
      assert.match(l.stopReason ?? "", /余额不足/);
    },
    NO_BACKOFF
  );
});

test("账号配置：DEEPSEEK_API_KEY_ 前缀下认不出的变量名一律报错，报错只写变量名、不写取值", () => {
  for (const name of [
    "DEEPSEEK_API_KEY_CONCURRENCY",
    "DEEPSEEK_API_KEY_2_CONCURENCY",
    "DEEPSEEK_API_KEY_B",
    "DEEPSEEK_API_KEY_",
  ]) {
    assert.throws(
      () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "secret-a", [name]: "secret-x" }),
      (e: Error) => {
        assert.ok(e.message.startsWith(`${name}：认不出的变量名`), e.message);
        assert.doesNotMatch(e.message, /secret-/);
        return true;
      }
    );
  }
  assert.throws(
    () => gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEY_CONCURRENCY: "" }),
    /DEEPSEEK_API_KEY_CONCURRENCY：认不出/,
    "取值为空的也报：多半是写错了名字"
  );
  assert.equal(gatewayAccountsFromEnv({ DEEPSEEK_API_KEY: "a", DEEPSEEK_API_KEYS: "x" }).length, 1);
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
test("可用容量：上限降低、账号停用即下降，恢复与回升即回到原值，每次变化都通知；429 退避期间不下降、不通知", async () => {
  let aState: "ok" | "rate" | "concurrent" = "ok";
  await withAccounts(
    {
      "key-a": (_n, probe) => {
        if (probe) return OK;
        if (aState === "concurrent") {
          // 只受限一次：降上限后的重试照常
          aState = "ok";
          return CONCURRENT;
        }
        return aState === "rate" ? RATE : OK;
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
      // 上限已是 1 时派出的请求再受限：账号 1 暂时不可用，容量去掉它
      aState = "concurrent";
      assert.equal((await post(g, "j")).status, 200, "换号");
      assert.deepEqual([g.capacity(), notified], [4, 2], "账号 1 停用");
      await clock.advance(PROBE_SCHEDULE_MS[0] ?? 0);
      await until(() => g.capacity() === 5, "单独探测通过、账号恢复（上限仍是 1）");
      assert.equal(notified, 3);
      await clock.advance(30 * 60_000);
      assert.deepEqual([g.capacity(), notified], [6, 4], "上限回升");
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

// ---- 花费（决策 235）：逐请求按开始与结束时刻计价、全局累计落盘续算、到上限停批 ----

// 北京时间的时刻
const bj = (date: string, time: string) => Date.parse(`${date}T${time}+08:00`);

// 手动时钟：now 取 t；定时在下一轮事件循环即触发（这些用例不看退避与探测间隔）
function fixedClock(start: number) {
  const state = { t: start };
  const clock: GatewayClock = {
    now: () => state.t,
    setTimer(_ms, fn) {
      const x = setImmediate(fn);
      return () => clearImmediate(x);
    },
  };
  return { state, clock };
}

// 假上游：回应前把时钟拨到 endAt（模拟请求耗时跨过某个时刻），回 DeepSeek 形状的流式或非流式用量
async function timedUpstream(
  state: { t: number },
  steps: { endAt: number; usage: Record<string, number>; stream?: boolean }[]
) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // 读完请求体
    }
    const step = steps.shift();
    if (step === undefined) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("脚本用完");
      return;
    }
    state.t = step.endAt;
    const usage = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      ...step.usage,
    };
    if (step.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [], usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      [
        "event: message_start",
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { ...usage, output_tokens: 0 } } })}`,
        "",
        "event: message_delta",
        `data: ${JSON.stringify({ type: "message_delta", usage })}`,
        "",
        "",
      ].join("\n")
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// 这几例起的网关：断言失败时也要在 finally 里全部关掉，否则监听不关、测试进程退不出
const spendGateways = new Set<ModelGateway>();
async function closeSpendGateways() {
  for (const g of spendGateways) await g.close();
  spendGateways.clear();
}

async function spendGateway(
  url: string,
  clock: GatewayClock,
  l: LimitController,
  spend: { file?: string; limitCny?: number } = {}
) {
  const g = await startModelGateway({
    upstreamBaseUrl: url,
    accounts: [{ key: "key-one", concurrency: 2 }],
    limits: l,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    clock,
    spend,
    warn: () => {},
  });
  spendGateways.add(g);
  return g;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

test("花费：每条请求按开始与结束时刻计价——跨入高峰的整条按高峰价，空闲时段按空闲价；记到作业并计入全局累计；探测也计入全局累计", async () => {
  const { state, clock } = fixedClock(bj("2026-09-28", "08:59:50"));
  const u1 = { input_tokens: 1000, cache_read_input_tokens: 64_000, output_tokens: 200 };
  const u2 = { input_tokens: 500, cache_read_input_tokens: 0, output_tokens: 100 };
  const up = await timedUpstream(state, [
    { endAt: bj("2026-09-28", "09:00:05"), usage: u1 },
    { endAt: bj("2026-09-28", "12:30:10"), usage: u2 },
    {
      endAt: bj("2026-09-28", "12:31:00"),
      usage: { input_tokens: 5, output_tokens: 1 },
      stream: false,
    },
  ]);
  const l = limits();
  const g = await spendGateway(up.url, clock, l);
  try {
    assert.equal((await (await post(g, "s1|full|1")).text()).length > 0, true);
    const peak = requestCostCny(
      { input: 1000, cacheRead: 64_000, cacheWrite: 0, output: 200 },
      bj("2026-09-28", "08:59:50"),
      bj("2026-09-28", "09:00:05")
    );
    assert.equal(peak.peak, true);
    assert.ok(near(g.meter("s1|full|1").costCny, peak.cny));
    // 高峰价是空闲价的两倍：(1000×1 + 64000×0.02 + 200×4) ÷ 100 万 × 2
    assert.ok(near(peak.cny, ((1000 + 64_000 * 0.02 + 200 * 4) / 1e6) * 2));
    state.t = bj("2026-09-28", "12:30:00");
    await (await post(g, "s1|full|1")).text();
    const idle = requestCostCny(
      { input: 500, cacheRead: 0, cacheWrite: 0, output: 100 },
      bj("2026-09-28", "12:30:00"),
      bj("2026-09-28", "12:30:10")
    );
    assert.equal(idle.peak, false);
    assert.ok(near(g.meter("s1|full|1").costCny, peak.cny + idle.cny));
    assert.equal(g.meter("s2|full|1").costCny, 0, "别的作业不受影响");
    // 探测：没有作业，只进全局累计
    assert.equal(await g.probe(), true);
    const probe = requestCostCny({ input: 5, cacheRead: 0, cacheWrite: 0, output: 1 }, 0, 0).cny;
    const spent = g.spend();
    assert.ok(near(spent.totalCny, peak.cny + idle.cny + probe));
    assert.deepEqual([spent.requests, spent.peakRequests, spent.limitCny], [3, 1, null]);
    assert.equal(l.state, "running");
  } finally {
    await g.close();
    await up.close();
  }
});

test("花费累计落盘：每记一笔即整份写入；进程重启（新网关读同一文件）接着累计；文件认不出即拒绝启动", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pigeon-spend-"));
  const file = path.join(dir, "gateway-spend.json");
  try {
    const { state, clock } = fixedClock(bj("2026-10-03", "10:00:00"));
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const up = await timedUpstream(state, [
      { endAt: bj("2026-10-03", "10:00:01"), usage },
      { endAt: bj("2026-10-03", "10:00:02"), usage },
    ]);
    try {
      const first = await spendGateway(up.url, clock, limits(), { file });
      await (await post(first, "j")).text();
      await first.close();
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        totalCny: number;
        requests: number;
      };
      // 国庆假期（周六）：空闲价，100 万未命中输入 ¥1
      assert.ok(near(saved.totalCny, 1));
      assert.equal(saved.requests, 1);
      const second = await spendGateway(up.url, clock, limits(), { file });
      assert.ok(near(second.spend().totalCny, 1), "启动即接着上次的累计");
      await (await post(second, "j")).text();
      assert.ok(near(second.spend().totalCny, 2));
      assert.equal(second.meter("j").costCny, 1, "作业计量只算本进程的请求");
      await second.close();
      assert.ok(near((JSON.parse(readFileSync(file, "utf8")) as { totalCny: number }).totalCny, 2));
    } finally {
      await closeSpendGateways();
      await up.close();
    }
    writeFileSync(file, "{}");
    await assert.rejects(
      spendGateway("http://127.0.0.1:9", fixedClock(0).clock, limits(), { file }),
      /花费累计文件.*认不出/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("花费上限：累计到上限即交给控制器停批（计一次限额信号，在途的步作废、不当真失败）；之后请求一律 529 不打上游；已到上限的累计文件开跑前即拒绝、不发探测", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pigeon-spend-"));
  const file = path.join(dir, "gateway-spend.json");
  try {
    const { state, clock } = fixedClock(bj("2026-10-03", "10:00:00"));
    const usage = { input_tokens: 600_000, output_tokens: 0 };
    let requests = 0;
    const steps = [
      { endAt: bj("2026-10-03", "10:00:01"), usage },
      { endAt: bj("2026-10-03", "10:00:02"), usage },
    ];
    const up = await timedUpstream(state, steps);
    try {
      const l = limits();
      const g = await spendGateway(up.url, clock, l, { file, limitCny: 1 });
      await (await post(g, "j")).text();
      requests += 1;
      assert.deepEqual([l.state, l.signals], ["running", 0], "¥0.6：未到上限");
      await (await post(g, "j")).text();
      requests += 1;
      assert.equal(l.state, "stopped", "¥1.2：到上限即停批");
      assert.equal(l.signals, 1);
      assert.match(l.stopReason ?? "", /花费累计 ¥1\.20，已到上限 ¥1/);
      const blocked = await post(g, "j");
      assert.equal(blocked.status, 529);
      assert.equal(steps.length, 0);
      assert.equal(requests, 2);
      await g.close();
      const again = await spendGateway(up.url, clock, limits(), { file, limitCny: 1 });
      await assert.rejects(again.preflight(), /花费累计 ¥1\.20 已到上限 ¥1：拒绝开跑/);
      await again.close();
      // 调高上限即可续跑
      const raised = await spendGateway(up.url, clock, limits(), { file, limitCny: 5 });
      assert.equal(raised.spend().limitCny, 5);
      await raised.close();
    } finally {
      await closeSpendGateways();
      await up.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("用量读法：message_delta 带输入与缓存字段时以它为准（DeepSeek 两处都带；与 pi-ai 一致）", async () => {
  const sse = [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"output_tokens":0}}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","usage":{"input_tokens":12,"cache_read_input_tokens":128,"output_tokens":7}}',
    "",
  ].join("\n");
  await withGateway([{ status: 200, body: sse, contentType: "text/event-stream" }], async (g) => {
    await (await post(g, "j")).text();
    const m = g.meter("j");
    assert.deepEqual([m.input, m.cacheRead, m.output], [12, 128, 7]);
  });
});

test("日志脱敏：DeepSeek 401 正文回显的密钥末四位、api key 后跟空格的写法、形似密钥的串一律去掉，只留说明文字与数字", () => {
  const body = JSON.stringify({
    error: {
      message:
        "Authentication Fails, Your api key: ****robe is invalid (request_id: 0123456789abcdefABCDEF)",
      type: "authentication_error",
      param: null,
      code: "invalid_request_error",
    },
  });
  const line = redactBody(body, ["sk-configured-robe"]);
  for (const secret of ["robe", "0123456789abcdefABCDEF"]) {
    assert.ok(!line.includes(secret), `日志里出现了 ${secret}`);
  }
  assert.match(line, /Authentication Fails/);
  assert.equal(
    redactBody("api key: sk-abcdef123456 is invalid", []),
    "api key: [已去除] is invalid"
  );
  assert.equal(
    redactBody("token=abc Bearer xyz   plain 42", []),
    "token=[已去除] Bearer [已去除] plain 42"
  );
  assert.ok(redactBody(`${"x ".repeat(300)}`, []).length <= 200);
});

test("单次请求输入 token 峰值：取每个请求的未命中 + 缓存命中 + 缓存写入的最大值（不是累加）；resetPeak 清零；按步做差时取步末的值；别的作业不受影响", async () => {
  const sse = (usage: Record<string, number>) =>
    [
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { usage } })}`,
      "",
      "event: message_delta",
      `data: ${JSON.stringify({ type: "message_delta", usage })}`,
      "",
    ].join("\n");
  const stream = (usage: Record<string, number>): Scripted => ({
    status: 200,
    body: sse(usage),
    contentType: "text/event-stream",
  });
  await withGateway(
    [
      stream({ input_tokens: 100, cache_read_input_tokens: 5_000, output_tokens: 9 }),
      stream({
        input_tokens: 40,
        cache_read_input_tokens: 9_000,
        cache_creation_input_tokens: 60,
        output_tokens: 9,
      }),
      stream({ input_tokens: 10, cache_read_input_tokens: 2_000, output_tokens: 9 }),
      stream({ input_tokens: 700, cache_read_input_tokens: 0, output_tokens: 9 }),
    ],
    async (g) => {
      for (let i = 0; i < 3; i++) await (await post(g, "s1|minimal|1")).text();
      assert.equal(
        g.meter("s1|minimal|1").peakInputTokens,
        9_100,
        "第二个请求最大：40 + 9000 + 60"
      );
      const before = g.meter("s1|minimal|1");
      g.resetPeak("s1|minimal|1");
      assert.equal(g.meter("s1|minimal|1").peakInputTokens, 0, "每步开始时清零");
      await (await post(g, "s1|minimal|1")).text();
      assert.equal(meterDelta(g.meter("s1|minimal|1"), before).peakInputTokens, 700);
      assert.equal(g.meter("s1|full|1").peakInputTokens, 0);
    }
  );
});

// 以原样字节发一条请求（不经 JSON.stringify），用来核对网关是否逐字转发
function postRaw(g: ModelGateway, job: string, body: string) {
  return fetch(`${g.jobBaseUrl(job)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder" },
    body,
  });
}

// 核对转发后的计量与只发一条请求、上游回 SSE 时一致
function assertMeteredOnce(g: ModelGateway, job: string) {
  const m = g.meter(job);
  assert.deepEqual(
    [m.requests, m.input, m.output, m.cacheRead, m.cacheWrite, m.upstreamFailures],
    [1, 120, 42, 30, 0, 0]
  );
  assert.ok(
    near(
      m.costCny,
      requestCostCny({ input: 120, cacheRead: 30, cacheWrite: 0, output: 42 }, 0, 0).cny
    )
  );
}

test("工具定义的 type：tools 里 type 为 custom 的项去掉 type 再转发，其余字段（别的 type 取值、消息里的 type）逐字不变；计量与花费照常", async () => {
  const tool = (name: string) => ({
    name,
    description: `run ${name}`,
    input_schema: { type: "object", properties: { type: { type: "string" } } },
  });
  const request = {
    model: "deepseek-chat",
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: 'say "custom"' }] }],
    tools: [
      { ...tool("bash"), type: "custom" },
      { type: "web_search_20250305", name: "web_search" },
      tool("edit"),
      { type: "custom", ...tool("view"), cache_control: { type: "ephemeral" } },
    ],
    stream: true,
  };
  const { type: _a, ...bash } = request.tools[0] as { type: string };
  const { type: _b, ...view } = request.tools[3] as { type: string };
  const expected = { ...request, tools: [bash, request.tools[1], request.tools[2], view] };
  await withGateway(
    [{ status: 200, body: SSE, contentType: "text/event-stream" }],
    async (g, up) => {
      const r = await postRaw(g, "s1|minimal|1", JSON.stringify(request, null, 1));
      assert.equal(r.status, 200);
      assert.equal(await r.text(), SSE);
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0]?.body, JSON.stringify(expected));
      assertMeteredOnce(g, "s1|minimal|1");
    }
  );
});

test("工具定义的 type：tools 里没有 type 为 custom 的项时按原字节转发，空白、键序、数字与转义写法一个字节不动", async () => {
  const raw =
    '{ "model" : "deepseek-chat",\n  "max_tokens": 4096, "temperature": 1.0,\n' +
    '  "system": [{"type": "text", "text": "caf\\u00e9 \\/ custom", "cache_control": {"type":"ephemeral"}}],\n' +
    '  "tools": [ {"name":"bash","type":"web_search_20250305"}, {"input_schema":{"type":"object"},"name":"edit"} ],\n' +
    '  "messages": [{"role":"user","content":"{\\"type\\":\\"custom\\"}"}], "stream": true }';
  await withGateway(
    [{ status: 200, body: SSE, contentType: "text/event-stream" }],
    async (g, up) => {
      const r = await postRaw(g, "s1|full|1", raw);
      assert.equal(await r.text(), SSE);
      assert.equal(up.seen[0]?.body, raw);
      assertMeteredOnce(g, "s1|full|1");
    }
  );
});

test("工具定义的 type：请求体不是合法 JSON、不是对象或 tools 不是数组时原样转发；计量与花费照常", async () => {
  const bodies = [
    '{"tools":[{"name":"bash","type":"custom"}],',
    '[{"tools":[{"name":"bash","type":"custom"}]}]',
    '{"tools":{"type":"custom"}}',
  ];
  await withGateway(
    bodies.map(() => ({ status: 200, body: SSE, contentType: "text/event-stream" })),
    async (g, up) => {
      for (const [i, body] of bodies.entries()) {
        assert.equal(await (await postRaw(g, `j${i}`, body)).text(), SSE);
        assertMeteredOnce(g, `j${i}`);
      }
      assert.deepEqual(
        up.seen.map((s) => s.body),
        bodies
      );
    }
  );
});
