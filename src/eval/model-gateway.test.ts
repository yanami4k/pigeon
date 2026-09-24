import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gatewayStreamFn } from "../pi-runtime/index.ts";
import {
  gatewayAccountsFromEnv,
  type ModelGateway,
  meterDelta,
  startModelGateway,
} from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";

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
    recoverySleep: () => new Promise(() => {}),
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    backoffDelaysMs: [1, 1],
    sleep: () => Promise.resolve(),
    warn: () => {},
  });
  try {
    await run(g, up, l);
  } finally {
    await g.close();
    await up.close();
  }
}

function post(g: ModelGateway, job: string, headers: Record<string, string> = {}) {
  return fetch(`${g.jobBaseUrl(job)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder", ...headers },
    body: JSON.stringify({ stream: true }),
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

test("网关：额度 403 交给控制器暂停，暂停期间直接 529 不打上游；认证 403 原样交回不暂停；交回的正文里没有 key", async () => {
  await withGateway(
    [
      { status: 403, body: "forbidden: bad key key-one" },
      {
        status: 403,
        body: '{"error":{"type":"permission_error","message":"usage limit reached, quota will reset soon"}}',
      },
    ],
    async (g, up, l) => {
      const auth = await post(g, "j");
      assert.equal(auth.status, 403);
      assert.equal(await auth.text(), "forbidden: bad key [key]");
      assert.equal(l.state, "running");
      const quota = await post(g, "j");
      assert.equal(quota.status, 403);
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "5h");
      const blocked = await post(g, "j");
      assert.equal(blocked.status, 529);
      assert.match(await blocked.text(), /网关暂停/);
      assert.equal(up.seen.length, 2, "暂停期间不打上游");
    }
  );
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

// 按 key 回应的假上游：每个 key 一个回应函数（可以返回一个等放行才完成的回应），记下各 key 的在途峰值
async function keyedUpstream(respond: Record<string, (n: number) => Scripted | Promise<Scripted>>) {
  const seen: string[] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const counts = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // 读完请求体
    }
    const key = (req.headers["x-api-key"] as string | undefined) ?? "";
    seen.push(key);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    peak.set(key, Math.max(peak.get(key) ?? 0, inFlight.get(key) ?? 0));
    const next = await (respond[key]?.(n) ?? { status: 500, body: "没有这个 key" });
    inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(next.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    peak,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function withAccounts(
  respond: Record<string, (n: number) => Scripted | Promise<Scripted>>,
  accounts: { key: string; concurrency: number }[],
  run: (
    g: ModelGateway,
    up: Awaited<ReturnType<typeof keyedUpstream>>,
    l: LimitController,
    warnings: string[]
  ) => Promise<void>
) {
  const up = await keyedUpstream(respond);
  const l = limits();
  const warnings: string[] = [];
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    accounts,
    limits: l,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    backoffDelaysMs: [1, 1],
    sleep: () => Promise.resolve(),
    recoverySleep: () => new Promise(() => {}),
    warn: (w) => warnings.push(w),
  });
  try {
    await run(g, up, l, warnings);
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

test("多账号：一个账号额度 403 只停该账号，同一请求透明换号重试；全部账号额度用完才整批暂停；探测恢复通过的账号", async () => {
  let aQuota = true;
  await withAccounts(
    { "key-a": () => (aQuota ? QUOTA : OK), "key-b": (n) => (n === 1 ? OK : QUOTA) },
    [
      { key: "key-a", concurrency: 2 },
      { key: "key-b", concurrency: 2 },
    ],
    async (g, up, l) => {
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
      assert.equal(await g.probe(), true, "账号 1 恢复即探测通过");
      assert.equal(g.accountStatus()[0]?.down, null);
      assert.equal(g.accountStatus()[1]?.down, "5h", "没通过探测的账号仍不可用");
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
