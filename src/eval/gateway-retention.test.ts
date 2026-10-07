// 网关逐请求留存（决策 394）：真网关 + 假上游，按作业目录读回
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "vitest";
import { requestCostCny } from "../state/model-pricing.ts";
import { GatewayRetention, RETENTION_DIR, readRetention } from "./gateway-retention.ts";
import { type ModelGateway, startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";

const KEY = "sk-real-secret-0123456789abcdef";
const sse = (text: string) =>
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"output_tokens":1}}}',
    "",
    "event: content_block_delta",
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    "",
  ].join("\n");

// 假上游：记下收到的原始请求体；回复正文由 reply 给（缺省一段 SSE），hold 为真时发完正文不结束连接
async function withRetention(
  options: { maxTaskBytes?: number; maxJobBytes?: number; retention?: boolean },
  run: (ctx: {
    g: ModelGateway;
    jobDir: string;
    seen: string[];
    reply: { status: number; body: string; hold?: boolean };
    post: (body: string, headers?: Record<string, string>) => Promise<string>;
  }) => Promise<void>
) {
  const seen: string[] = [];
  const reply: { status: number; body: string; hold?: boolean } = { status: 200, body: sse("hi") };
  const held: http.ServerResponse[] = [];
  const up = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(reply.status, {
      "content-type": reply.status === 200 ? "text/event-stream" : "application/json",
    });
    if (reply.hold === true) {
      res.write(reply.body);
      held.push(res);
    } else res.end(reply.body);
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "pigeon-retention-"));
  const g = await startModelGateway({
    upstreamBaseUrl: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
    accounts: [{ key: KEY, concurrency: 4 }],
    limits: new LimitController({ probe: async () => true, slots: 4, warn: () => {} }),
    probeRequest: { path: "/v1/messages", body: {} },
    clock: { now: () => 0, setTimer: () => () => {} },
    warn: () => {},
  });
  if (options.retention !== false) {
    g.setRetention(
      new GatewayRetention({
        maxTaskBytes: options.maxTaskBytes ?? 1 << 20,
        maxJobBytes: options.maxJobBytes ?? 1 << 24,
        keys: [KEY],
        warn: () => {},
      })
    );
  }
  const post = async (body: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${g.jobBaseUrl("job")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "ph-key-AAA", ...headers },
      body,
    });
    return r.text();
  };
  try {
    await run({ g, jobDir: path.join(dir, "job"), seen, reply, post });
  } finally {
    await g.close();
    for (const res of held) res.destroy();
    await new Promise<void>((r) => up.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
type Msg = ReturnType<typeof msg>;
// 带缓存断点的消息：cache_control 在块上（mid 为真时排在块的键中间）。客户端每次把断点挪到最新的消息上
const cc = (m: Msg, mid = false) => {
  const { type, text } = m.content[0] as { type: string; text: string };
  const cache_control = { type: "ephemeral" };
  return { ...m, content: [mid ? { type, cache_control, text } : { type, text, cache_control }] };
};

test("留存：请求只存增量（cache_control 挪动不算对不上，真对不上才存全量并标明）、增量加 cache_control 的位置逐字还原出完整请求；大字段另存，转发逐字不变；回复与用量照记", async () => {
  await withRetention({}, async ({ g, jobDir, seen, post }) => {
    const [u1, a1, u2, a2, u3] = ["u1", "a1", "u2", "a2", "u3"].map((t, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", t)
    ) as [Msg, Msg, Msg, Msg, Msg];
    const base = {
      model: "m",
      max_tokens: 100,
      stream: true,
      system: "sys",
      tools: [{ name: "t" }],
    };
    const bodies = [
      { ...base, messages: [cc(u1)] },
      { ...base, messages: [u1, a1, cc(u2, true)] },
      // 另一路对话（摘要）：对不上前缀，存全量
      { model: "m", max_tokens: 10, system: "sum", messages: [cc(msg("user", "x"))] },
      // 两处断点；外部 agent 附带的大字段（会话日志一类）
      { ...base, messages: [u1, a1, cc(u2), a2, cc(u3)], session_log: "e".repeat(40_000) },
      // 上下文被压缩改写：对不上前缀（消息本身上的 cache_control 同样放回原处）
      {
        ...base,
        messages: [{ role: "user", cache_control: { type: "x" }, content: "compacted" }, cc(u3)],
      },
    ];
    // 第一条用缩进排版：转发若重新序列化即与原文不同
    const sent = bodies.map((b, i) => JSON.stringify(b, null, i === 0 ? 2 : undefined));
    const end = g.retainStep("job", jobDir, 3);
    for (const body of sent) await post(body);
    end();
    await post(sent[0] as string);
    assert.deepEqual(seen, [...sent, sent[0]], "转发的请求体逐字不变");

    const tries = readRetention(jobDir);
    assert.deepEqual(
      tries.map((t) => [t.seq, t.attempt, t.exchanges.length]),
      [[3, 1, 5]],
      "一步之外的请求不记"
    );
    const ex = tries[0]?.exchanges ?? [];
    ex.forEach((e, i) => {
      assert.deepEqual(e.missing, []);
      assert.equal(
        JSON.stringify(e.body),
        JSON.stringify(JSON.parse(sent[i] as string)),
        `第 ${i + 1} 次请求逐字还原（含 cache_control 的位置与键序）`
      );
      assert.equal(e.exact, i > 0, "紧凑排版的原文按 sha256 核对逐字相同");
      assert.equal(e.response?.status, 200);
      assert.equal(e.response?.stopReason, "end_turn");
      assert.deepEqual(e.response?.usage, { input: 10, output: 7, cacheRead: 4, cacheWrite: 0 });
      assert.equal(e.reply(), sse("hi"));
    });
    const shape = ex.map((e) => [
      e.request.messages?.base ?? "full",
      e.request.messages?.delta?.length,
    ]);
    assert.deepEqual(shape, [
      ["full", 1],
      [1, 2],
      ["full", 1],
      [2, 2],
      ["full", 2],
    ]);
    const large = ex[3]?.request;
    assert.equal(large?.params?.session_log, undefined, "大字段不进参数");
    assert.deepEqual(
      large?.large?.map((r) => [r.field, r.bytes]),
      [["session_log", 40_002]]
    );
    assert.match(large?.large?.[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      readdirSync(path.join(jobDir, RETENTION_DIR, "blobs")).length,
      3,
      "system 与 tools 的整段同一作业只存一份"
    );
    // 重做同一步另开 try
    const again = g.retainStep("job", jobDir, 3);
    await post(sent[0] as string);
    again();
    assert.deepEqual(
      readRetention(jobDir, 3).map((t) => t.attempt),
      [1, 2]
    );
  });
});

test("第 1 版的留存照常读：增量里原样带着 cache_control，没有位置与字段先后", () => {
  const jobDir = mkdtempSync(path.join(tmpdir(), "pigeon-retention-v1-"));
  try {
    const dir = path.join(jobDir, RETENTION_DIR, "step-1", "try-1");
    mkdirSync(dir, { recursive: true });
    const head = { at: "t", bodyBytes: 0, bodySha256: "" };
    const lines = [
      {
        ...head,
        id: 1,
        params: { model: "m" },
        messages: { count: 1, full: true, delta: [cc(msg("user", "a"))] },
      },
      {
        ...head,
        id: 2,
        params: { model: "m" },
        messages: { count: 2, base: 1, delta: [msg("assistant", "b")] },
      },
    ];
    writeFileSync(
      path.join(dir, "requests.jsonl"),
      lines.map((l) => `${JSON.stringify(l)}\n`).join("")
    );
    const bodies = readRetention(jobDir)[0]?.exchanges.map((e) => e.body);
    assert.deepEqual(bodies, [
      { model: "m", messages: [cc(msg("user", "a"))] },
      { model: "m", messages: [cc(msg("user", "a")), msg("assistant", "b")] },
    ]);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

// 留存目录下全部文件的文字（gzip 的解开）
function allText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const data = readFileSync(path.join(e.parentPath, e.name));
      return e.name.endsWith(".gz") ? gunzipSync(data).toString("utf8") : data.toString("utf8");
    })
    .join("\n");
}

test("留存：落盘内容里没有鉴权头与 key（含上游回显的 key 与打码片段）；其余请求头照记", async () => {
  await withRetention({}, async ({ g, jobDir, reply, post }) => {
    const headers = {
      authorization: "Bearer ph-auth-BBB",
      "x-session-token": "tok-CCC",
      "x-trace": "keep-me",
    };
    const body = (extra: object) =>
      JSON.stringify({ model: "m", system: KEY, messages: [msg("user", `key ${KEY}`)], ...extra });
    const end = g.retainStep("job", jobDir, 1);
    reply.body = sse(`echo ${KEY} and ****cdef`);
    await post(body({ blob: `${KEY} ${"z".repeat(20_000)}` }), headers);
    Object.assign(reply, { status: 400, body: `{"error":{"message":"bad key ${KEY} ****cdef"}}` });
    await post(body({ n: 2 }), headers);
    end();
    const text = allText(path.join(jobDir, RETENTION_DIR));
    for (const secret of [KEY, "ph-key-AAA", "ph-auth-BBB", "tok-CCC", "****cdef"]) {
      assert.equal(text.includes(secret), false, `落盘内容里出现了 ${secret}`);
    }
    const [first, second] = readRetention(jobDir, 1)[0]?.exchanges ?? [];
    assert.equal(first?.request.headers?.["x-trace"], "keep-me");
    assert.equal(second?.response?.status, 400);
    assert.match(second?.response?.body ?? "", /bad key \[key\]/);
  });
});

// 客户端读回复读到 marker 即断开（外部 agent 收到 message_stop 即断开连接的情形）
async function readThenAbort(g: ModelGateway, marker: string) {
  const abort = new AbortController();
  const r = await fetch(`${g.jobBaseUrl("job")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "ph-key-AAA" },
    body: '{"model":"m","stream":true}',
    signal: abort.signal,
  });
  const reader = r.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (reader !== undefined && !text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  abort.abort();
}

async function until(cond: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("读回复时客户端断开：已收到完整回复（message_stop 后断开）即照常计入用量与花费、全局累计，不算上游故障；message_delta 之前断开即不计价、记一次缺用量，留存标明", async () => {
  await withRetention({}, async ({ g, jobDir, reply }) => {
    const responses = () =>
      (readRetention(jobDir, 1)[0]?.exchanges ?? []).flatMap((e) =>
        e.response !== undefined ? [e.response] : []
      );
    const usage = { input: 10, output: 7, cacheRead: 4, cacheWrite: 0 };
    const cost = requestCostCny(usage, 0, 0).cny;
    const end = g.retainStep("job", jobDir, 1);
    Object.assign(reply, {
      body: `${sse("hi")}\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
      hold: true,
    });
    await readThenAbort(g, "message_stop");
    await until(() => responses().length === 1, "第一次的回复记录");
    const m1 = g.meter("job");
    assert.deepEqual([m1.input, m1.output, m1.cacheRead, m1.upstreamFailures], [10, 7, 4, 0]);
    assert.equal(m1.usageMissing, undefined);
    assert.ok(cost > 0);
    assert.equal(m1.costCny, cost);
    assert.deepEqual([g.spend().totalCny, g.spend().requests], [cost, 1], "计入全局累计");
    reply.body = sse("hi").split("event: message_delta")[0] as string;
    await readThenAbort(g, "content_block_delta");
    await until(() => responses().length === 2, "第二次的回复记录");
    end();
    const m2 = g.meter("job");
    assert.deepEqual(
      [m2.output, m2.costCny, m2.usageMissing, m2.upstreamFailures],
      [7, cost, 1, 0]
    );
    assert.deepEqual([g.spend().totalCny, g.spend().requests], [cost, 1]);
    const [first, second] = responses();
    assert.deepEqual([first?.status, first?.usage, first?.usageMissing], [200, usage, undefined]);
    assert.ok(first?.error, "断开记在留存里");
    assert.deepEqual([second?.usage, second?.usageMissing], [undefined, true]);
  });
});

const du = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((n, e) => n + readFileSync(path.join(e.parentPath, e.name)).length, 0);

test("留存上限：放不下的请求只记摘要、回复正文不存，都标明；大字段超过单题上限的四分之一只记大小与摘要；续跑接着已落盘的量算单作业上限", async () => {
  await withRetention({ maxTaskBytes: 8000 }, async ({ g, jobDir, reply, post }) => {
    const end = g.retainStep("job", jobDir, 1);
    // 不可压缩的大字段：超过四分之一（2000 字节）
    await post(JSON.stringify({ model: "m", noise: randomBytes(15_000).toString("base64") }));
    reply.body = sse(randomBytes(12_000).toString("base64"));
    await post(JSON.stringify({ model: "m", messages: [msg("user", "y".repeat(9000))] }));
    end();
    const [first, second] = readRetention(jobDir, 1)[0]?.exchanges ?? [];
    assert.equal(first?.request.large?.[0]?.slice, undefined, "大字段只记大小与摘要");
    assert.deepEqual(first?.missing, ["noise"]);
    assert.equal(second?.request.truncated, "task-cap");
    assert.deepEqual(second?.request.messages, { count: 1 });
    assert.deepEqual(second?.missing, ["body"]);
    assert.equal(second?.response?.reply?.truncated, "task-cap");
    assert.equal(second?.reply(), undefined);
    // 续跑：新的留存接着已落盘的量算单作业上限
    const used = du(path.join(jobDir, RETENTION_DIR));
    g.setRetention(
      new GatewayRetention({
        maxTaskBytes: 1 << 20,
        maxJobBytes: used + 100,
        keys: [KEY],
        warn() {},
      })
    );
    const next = g.retainStep("job", jobDir, 2);
    await post(JSON.stringify({ model: "m", messages: [msg("user", "z".repeat(200))] }));
    next();
    assert.equal(readRetention(jobDir, 2)[0]?.exchanges[0]?.request.truncated, "job-cap");
  });
});

test("留存关着（没给 setRetention）：跑批器照常告知每一步，作业目录里什么都不写", async () => {
  await withRetention({ retention: false }, async ({ g, jobDir, seen, post }) => {
    const end = g.retainStep("job", jobDir, 1);
    await post('{"model":"m"}');
    end();
    assert.equal(seen.length, 1);
    assert.equal(existsSync(jobDir), false);
  });
});
