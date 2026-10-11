// 被拒收的图片（决策 417）：请求以 HTTP 400 出错、且请求里有上次成功回复之后新加的带图工具结果时，把这些结果换成拒收占位
// （先写会话记录）、去掉出错消息再接着运行一次；只换新加的；仍失败照原错误收尾；没有新图或不是 400 不重试。
import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import { contextPruneSettings } from "../state/prune-config.ts";
import {
  type PruneData,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { ContextPruner } from "./context-prune.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import { INJECTION_SNAPSHOT_VERSION } from "./snapshot.ts";

const REJECTED = '400 {"type":"error","error":{"type":"invalid_request_error","message":"x"}}';
const shot = (id: string): FakeReply => ({
  text: "看图",
  toolCalls: [{ name: "shot", args: {}, id }],
});

const shotTool: AgentTool = {
  name: "shot",
  label: "shot",
  description: "截图",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [
      { type: "text", text: "截图一张" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    details: undefined,
  }),
};

type Stored = { message: AgentMessage } | { entry: SessionCustomEntry };

function harness(replies: FakeReply[]) {
  const stored: Stored[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "shot",
    description: "截图",
    parameters: Type.Object({}),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  const streamFn = createFakeStreamFn({ replies });
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: { policy: { allow: ["shot"], deny: [], approvalMode: "yolo" }, advertised: [] },
      context: { systemPrompt: "测试" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn,
    governance: createToolGovernance({ registry }),
    tools: [shotTool],
    sessionStore: {
      appendMessage: (message) => stored.push({ message }),
      append: (entry) => stored.push({ entry }),
    },
    prune: new ContextPruner(contextPruneSettings(undefined, undefined)),
  });
  return { adapter, streamFn, stored };
}

// 第 n 次请求里各工具结果带不带图（按工具调用号）
function imagesSent(fake: FakeStreamFn, call: number): Record<string, boolean> {
  const messages = fake.calls[call]?.context.messages ?? [];
  return Object.fromEntries(
    messages.flatMap((message) =>
      message.role === "toolResult"
        ? [[message.toolCallId, message.content.some((block) => block.type === "image")]]
        : []
    )
  );
}

const isPrune = (item: Stored) =>
  "entry" in item && item.entry.customType === SessionEntryType.Prune;
const prunes = (stored: Stored[]) =>
  stored.flatMap((item) =>
    "entry" in item && isPrune(item) ? [item.entry.data as PruneData] : []
  );
const isReply = (item: Stored, stop: string) =>
  "message" in item && item.message.role === "assistant" && item.message.stopReason === stop;

test("400 且带新加的图：换成拒收占位并先写进会话记录，去掉出错消息重试一次即成功", async () => {
  const h = harness([shot("a"), { text: "", streamError: REJECTED }, { text: "看到了" }]);
  const result = await h.adapter.run("看图");
  assert.equal(result.status, "completed");
  assert.equal(h.streamFn.calls.length, 3);
  assert.deepEqual(imagesSent(h.streamFn, 2), { a: false });
  const [record] = prunes(h.stored);
  assert.equal(record?.trigger, "rejected");
  assert.deepEqual(
    record?.items.map((item) => [item.toolCallId, item.reason]),
    [["a", "rejected"]]
  );
  assert.match(record?.items[0]?.placeholder ?? "", /截图一张[\s\S]*未被服务方接受/);
  // 记录写在重试那条回复之前；出错消息照实留在会话里
  const recordAt = h.stored.findIndex(isPrune);
  const replyAt = h.stored.findIndex((item) => isReply(item, "stop"));
  assert.ok(recordAt >= 0 && recordAt < replyAt);
  assert.ok(h.stored.some((item) => isReply(item, "error")));
});

test("重试仍失败按原错误收尾，只重试一次", async () => {
  const h = harness([
    shot("a"),
    { text: "", streamError: REJECTED },
    { text: "", streamError: REJECTED },
  ]);
  const result = await h.adapter.run("看图");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage ?? "", /^400 /);
  assert.equal(h.streamFn.calls.length, 3);
});

test("没有新加的图、或不是 400，都不重试", async () => {
  const noImage = harness([{ text: "", streamError: REJECTED }]);
  assert.equal((await noImage.adapter.run("你好")).status, "failed");
  assert.equal(noImage.streamFn.calls.length, 1);
  const serverError = harness([shot("a"), { text: "", streamError: "500 内部错误" }]);
  assert.equal((await serverError.adapter.run("看图")).status, "failed");
  assert.equal(serverError.streamFn.calls.length, 2);
  assert.deepEqual(prunes(serverError.stored), []);
});

test("只换上次成功回复之后新加的图，之前已被接受的图照发", async () => {
  const h = harness([shot("a"), shot("b"), { text: "", streamError: REJECTED }, { text: "好" }]);
  assert.equal((await h.adapter.run("看图")).status, "completed");
  assert.deepEqual(
    prunes(h.stored).flatMap((record) => record.items.map((item) => item.toolCallId)),
    ["b"]
  );
  assert.deepEqual(imagesSent(h.streamFn, 3), { a: true, b: false });
});
