import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gatewayStreamFn } from "../pi-runtime/index.ts";
import { type ModelGateway, meterDelta, startModelGateway } from "./model-gateway.ts";
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
  keys = ["key-one", "key-two"]
) {
  const up = await fakeUpstream(script);
  const l = limits();
  const g = await startModelGateway({
    upstreamBaseUrl: up.url,
    keys,
    limits: l,
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
      });
      assert.deepEqual(g.meter("other"), {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
      });
    }
  );
});

test("网关：429 切到另一个 key 并保持使用；两个都撞则共享退避后重试；退避用满即整批暂停", async () => {
  await withGateway(
    [
      { status: 429, body: "rate limited" },
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 200, body: "{}" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
      { status: 429, body: "x" },
    ],
    async (g, up, l) => {
      assert.equal((await post(g, "j")).status, 200);
      assert.equal((await post(g, "j")).status, 200);
      assert.deepEqual(
        up.seen.map((s) => s.key),
        ["key-one", "key-two", "key-two"]
      );
      assert.equal((await post(g, "j")).status, 200, "两个都撞：退避一次后成功");
      const exhausted = await post(g, "j");
      assert.equal(exhausted.status, 429);
      assert.equal(l.state, "paused");
      assert.equal(l.pausesSince(0)[0]?.kind, "rate-limit");
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

test("网关：上游 5xx 记为出事作业的上游故障、不算限额；403 并发受限与 403 额度记为限额信号", async () => {
  await withGateway(
    [
      {
        status: 503,
        body: '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
      },
      { status: 403, body: "too many concurrent requests" },
      { status: 403, body: "usage limit reached, quota will reset in 5 hours" },
    ],
    async (g, _up, l) => {
      const r1 = await post(g, "s1|minimal|1");
      assert.equal(r1.status, 503);
      await r1.text();
      assert.equal(g.meter("s1|minimal|1").upstreamFailures, 1);
      assert.equal(g.meter("s1|full|1").upstreamFailures, 0, "别的作业不受影响");
      assert.equal(l.signals, 0, "5xx 不是限额");
      const r2 = await post(g, "s1|minimal|1");
      assert.equal(r2.status, 403);
      await r2.text();
      assert.deepEqual([l.signals, l.slots, l.state], [1, 3, "running"]);
      const r3 = await post(g, "s1|minimal|1");
      assert.equal(r3.status, 403);
      await r3.text();
      assert.deepEqual([l.signals, l.state], [2, "paused"]);
      // 403 只进限额信号，不算上游故障
      assert.equal(g.meter("s1|minimal|1").upstreamFailures, 1);
    }
  );
});
