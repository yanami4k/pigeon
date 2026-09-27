// 空回复（决策 170 ②）：末条助手消息既无非空文字、也无工具调用，且以正常停止收尾（思考块不算内容）即空回复。
// 运行面在同一个 Run 里重试一次——从 Agent 状态里去掉这条空消息再接着运行，重试那一轮照常计轮；仍空即以空回复异常结束，
// 收尾条目的结束方式记 empty-reply，失败分类为业务失败。一个 Run 只发一次 run.ended。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createToolGovernance } from "../application/governance.ts";
import type { EventEnvelope } from "../state/events.ts";
import {
  type RunEndData,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import type { SessionStoreSink } from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function snapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: ["echo"], deny: [], approvalMode: "yolo" }, advertised: [] },
    context: { systemPrompt: "测试" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

const echoTool: AgentTool = {
  name: "echo",
  label: "echo",
  description: "原样返回",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: (params as { text: string }).text }],
    details: undefined,
  }),
};

function governance() {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "原样返回",
    parameters: Type.Object({ text: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return createToolGovernance({ registry });
}

interface Harness {
  adapter: PiRuntimeAdapter;
  streamFn: FakeStreamFn;
  events: EventEnvelope[];
  stored: Array<
    { kind: "message"; message: AgentMessage } | { kind: "entry"; entry: SessionCustomEntry }
  >;
}

function harness(replies: FakeReply[]): Harness {
  const stored: Harness["stored"] = [];
  const sink: SessionStoreSink = {
    appendMessage: (message) => stored.push({ kind: "message", message }),
    append: (entry) => stored.push({ kind: "entry", entry }),
  };
  const streamFn = createFakeStreamFn({ replies });
  const adapter = new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn,
    governance: governance(),
    tools: [echoTool],
    sessionStore: sink,
  });
  const events: EventEnvelope[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, streamFn, events, stored };
}

function runEnd(h: Harness): RunEndData | undefined {
  const entry = h.stored.findLast(
    (item) => item.kind === "entry" && item.entry.customType === SessionEntryType.RunEnd
  );
  return entry?.kind === "entry" ? (entry.entry.data as RunEndData) : undefined;
}

function count(h: Harness, kind: string): number {
  return h.events.filter((event) => event.kind === kind).length;
}

function assistantTexts(messages: readonly AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      (message.content as Array<{ type: string; text?: string }>)
        .map((block) => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`))
        .join("")
    );
}

test("空回复重试一次即有内容：同一个 Run 里去掉空消息接着跑，正常完成；重试那一轮照常计轮，只发一次 run.ended", async () => {
  const h = harness([{ text: "" }, { text: "改好了" }]);
  const result = await h.adapter.run("做事");
  assert.equal(result.status, "completed");
  assert.equal(result.emptyReply, false);
  assert.equal(result.failure, null);
  assert.equal(h.streamFn.calls.length, 2, "只重试一次");
  // 重试那次请求里没有那条空消息：末条是用户消息
  const retryMessages = h.streamFn.calls[1]?.context.messages ?? [];
  assert.equal(retryMessages.at(-1)?.role, "user");
  assert.equal(retryMessages.filter((message) => message.role === "assistant").length, 0);
  // Agent 的对话里也去掉了空消息
  assert.deepEqual(assistantTexts(h.adapter.transcript()), ["改好了"]);
  assert.equal(count(h, "turn.completed"), 2, "重试那一轮计入轮数");
  assert.equal(count(h, "run.ended"), 1);
  assert.equal(runEnd(h)?.ending, "completed");
  // 会话文件如实留下那条空消息（它确实发生过），收尾条目的消息条数含它
  assert.deepEqual(
    h.stored.flatMap((item) => (item.kind === "message" ? [item.message] : [])).map((m) => m.role),
    ["user", "assistant", "assistant"]
  );
  assert.equal(runEnd(h)?.messageCount, 3);
});

test("空回复重试一次仍空：以空回复异常结束——终态失败、收尾条目记 empty-reply、失败分类为业务失败，不再重试", async () => {
  const h = harness([{ text: "" }]);
  const result = await h.adapter.run("做事");
  assert.equal(h.streamFn.calls.length, 2, "只重试一次");
  assert.equal(result.status, "failed");
  assert.equal(result.emptyReply, true);
  assert.deepEqual(result.failure, { category: "business" });
  assert.match(result.errorMessage ?? "", /空回复/);
  assert.equal(count(h, "turn.completed"), 2);
  assert.equal(count(h, "run.ended"), 1);
  const end = runEnd(h);
  assert.equal(end?.ending, "empty-reply");
  assert.equal(end?.stopReason, "stop");
  assert.match(end?.errorMessage ?? "", /空回复/);
});

test("判空：思考块不算内容，只有空白的文字也算空；有工具调用、或以撞输出上限收尾的不算空回复", async () => {
  const thinkingOnly = harness([{ text: "", thinking: "想了很久" }, { text: "好了" }]);
  const thinkingResult = await thinkingOnly.adapter.run("做事");
  assert.equal(thinkingOnly.streamFn.calls.length, 2, "只有思考块即空回复，重试");
  assert.equal(thinkingResult.status, "completed");

  const blank = harness([{ text: " \n\t " }]);
  const blankResult = await blank.adapter.run("做事");
  assert.equal(blank.streamFn.calls.length, 2);
  assert.equal(blankResult.emptyReply, true);

  const toolOnly = harness([
    { text: "", toolCalls: [{ name: "echo", args: { text: "回声" } }] },
    { text: "完成" },
  ]);
  const toolResult = await toolOnly.adapter.run("做事");
  assert.equal(toolOnly.streamFn.calls.length, 2, "工具调用之后的正常一轮，不是重试");
  assert.equal(toolResult.status, "completed");
  assert.equal(toolResult.emptyReply, false);

  const truncated = harness([{ text: "", stopReason: "length" }]);
  const truncatedResult = await truncated.adapter.run("做事");
  assert.equal(truncated.streamFn.calls.length, 1, "撞输出上限不是空回复，不重试");
  assert.equal(truncatedResult.emptyReply, false);
  assert.equal(runEnd(truncated)?.ending, "completed");
});

test("空回复那一轮里已来了中止请求（撞上限）：不重试，以空回复异常结束，仍只发一次 run.ended", async () => {
  const h = harness([{ text: "" }, { text: "不该到这里" }]);
  h.adapter.subscribe((event) => {
    if (event.kind === "turn.completed") {
      h.adapter.interrupt("turn-limit").catch(() => {});
    }
  });
  const result = await h.adapter.run("做事");
  assert.equal(h.streamFn.calls.length, 1, "撞了上限不再发重试请求");
  assert.equal(result.emptyReply, true);
  assert.equal(count(h, "run.ended"), 1);
  assert.equal(runEnd(h)?.ending, "empty-reply");
});

test("下一个 Run 照常可以再重试一次：重试次数按 Run 计", async () => {
  const h = harness([{ text: "" }, { text: "第一次" }, { text: "" }, { text: "第二次" }]);
  const first = await h.adapter.run("一");
  const second = await h.adapter.run("二");
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(h.streamFn.calls.length, 4);
  assert.deepEqual(assistantTexts(h.adapter.transcript()), ["第一次", "第二次"]);
  assert.equal(count(h, "run.ended"), 2);
});
