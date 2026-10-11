// 模型请求的失败重试（决策 420）：经自带的 DeepSeek 接入与真的 pi-ai anthropic-messages 线路，调用选项注入假的 fetch
// （不连任何真实接口）。429、5xx 与连接失败按设置的次数重试，400 不重试；每次重试回调第几次、上一次的状态码与等待。
import assert from "node:assert/strict";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { test } from "vitest";
import { createDeepSeekStreamFn } from "./deepseek-stream.ts";
import { failedReply, scriptedFetch } from "./fixtures.ts";
import { type RequestRetry, retriesObservable, withRequestRetries } from "./request-retry.ts";

// 一次成功的流式回复（Anthropic 的 SSE 事件），正文为 text
function sseReply(text: string): Response {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "deepseek-flash",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const placeholder = { id: "x", provider: "x", api: "unknown", baseUrl: "" } as never;

async function request(script: Array<Response | Error>, maxRetries: number) {
  const retries: RequestRetry[] = [];
  const scripted = scriptedFetch(script);
  const fn = withRequestRetries(
    createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-test" }, streamSimple),
    {
      maxRetries,
      onRetry: (retry) => retries.push(retry),
    }
  );
  const message = await (
    await fn(placeholder, { messages: [] }, { fetch: scripted.fetch })
  ).result();
  return { message, retries, calls: scripted.calls() };
}

test("429 与 5xx 按次数重试至成功，每次重试记第几次、上一次的状态码与等待；连接失败同样重试并记错误文字", async () => {
  const ok = await request([failedReply(429), failedReply(503), sseReply("好")], 4);
  assert.equal(ok.message.stopReason, "stop");
  assert.deepEqual(ok.message.content, [{ type: "text", text: "好" }]);
  assert.equal(ok.calls, 3);
  assert.deepEqual(
    ok.retries.map(({ retry, status }) => [retry, status]),
    [
      [1, 429],
      [2, 503],
    ]
  );
  assert.ok(ok.retries.every((retry) => retry.waitMs >= 0 && retry.error === undefined));

  const offline = await request([new TypeError("fetch failed"), sseReply("好")], 4);
  assert.equal(offline.message.stopReason, "stop");
  assert.equal(offline.retries[0]?.status, undefined);
  assert.match(offline.retries[0]?.error ?? "", /fetch failed/);
});

test("400 不重试；次数用完照原错误收尾，重试次数取传入的值", async () => {
  const bad = await request([failedReply(400), sseReply("好")], 4);
  assert.equal(bad.message.stopReason, "error");
  assert.equal(bad.calls, 1);
  assert.deepEqual(bad.retries, []);

  const capped = await request([failedReply(429), failedReply(429), sseReply("好")], 1);
  assert.equal(capped.message.stopReason, "error");
  assert.equal(capped.calls, 2);
  assert.equal(capped.retries.length, 1);
});

test("只在接受自带 fetch 的线路上接管记录", () => {
  assert.equal(retriesObservable("anthropic-messages"), true);
  assert.equal(retriesObservable("google-generative-ai"), false);
  assert.equal(retriesObservable(undefined), false);
});
