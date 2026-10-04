// M2 S1（决策 024）：subscribeStream 只读流式观察口测试。
// 纪律：上游 message_update 携带 text_delta / thinking_delta 时把增量连同 runId 与 kind
// 转发给订阅者（045 修订：thinking 一并转发）；增量不进会话存储、不进 events()、不锚身份
//（013：流式载荷是上游浅拷贝 partial）——正文持久化只走 message_end 的完整消息；
// listener 自包 try/catch 进 listenerErrors，绝不毒化 Run。
import assert from "node:assert/strict";
import { test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { PiRuntimeAdapter, type StreamTextDelta } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import type { AgentMessage } from "./index.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function createSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: [], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

test("text_delta 与 thinking_delta 按序到达并携带 runId 与 kind；退订后不再收到", async () => {
  const thinking = "先想想再回答";
  const firstText = "流式增量甲乙丙丁戊己";
  const streamFn = createFakeStreamFn({
    replies: [{ thinking, text: firstText, chunkSize: 2 }, { text: "第二次回复" }],
  });
  const adapter = new PiRuntimeAdapter({
    snapshot: createSnapshot(),
    streamFn,
    governance: createToolGovernance(),
  });
  const deltas: StreamTextDelta[] = [];
  const unsubscribe = adapter.subscribeStream((delta) => deltas.push(delta));

  const first = await adapter.run("你好");

  const textOf = (kind: StreamTextDelta["kind"]): string =>
    deltas
      .filter((d) => d.kind === kind)
      .map((d) => d.delta)
      .join("");
  // 增量按序到达，按 kind 拼接 == 完整文本；每条携带本 Run 的 runId
  assert.ok(deltas.length > 1, `chunkSize=2 应产生多条增量，实际 ${deltas.length} 条`);
  assert.equal(textOf("text"), firstText);
  // 045 修订：thinking 增量一并转发，kind 区分，thinking 在文本之前（真实块序）
  assert.equal(textOf("thinking"), thinking);
  assert.equal(deltas[0]?.kind, "thinking");
  for (const delta of deltas) {
    assert.equal(delta.runId, first.runId);
  }
  assert.equal(first.status, "completed");

  // 退订后第二个 Run 不再收到增量
  unsubscribe();
  const second = await adapter.run("再来");
  assert.equal(second.status, "completed");
  assert.equal(textOf("text"), firstText);

  await adapter.dispose();
});

test("listener 抛异常进 listenerErrors，Run 与其他 listener 不受影响（同 subscribe 不变式）", async () => {
  const text = "异常侦错流式文本";
  const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 3 }] });
  const adapter = new PiRuntimeAdapter({
    snapshot: createSnapshot(),
    streamFn,
    governance: createToolGovernance(),
  });
  const collected: string[] = [];
  adapter.subscribeStream(() => {
    throw new Error("模拟订阅者故障");
  });
  adapter.subscribeStream((delta) => collected.push(delta.delta));

  const result = await adapter.run("你好");

  // Run 不被毒化：终态正常；其他 listener 收全文本
  assert.equal(result.status, "completed");
  assert.equal(collected.join(""), text);
  // 抛出的异常被吞进 listenerErrors（每条增量一次）
  assert.ok(adapter.listenerErrors().length >= 1, "listener 异常应进 listenerErrors");

  await adapter.dispose();
});

test("流式增量不进会话存储：写入面只收到 message_end 的完整消息，没有逐段增量", async () => {
  const text = "绝不逐段落盘的流式文本甲乙丙";
  const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 2 }] });
  const messages: AgentMessage[] = [];
  const entries: string[] = [];
  const adapter = new PiRuntimeAdapter({
    snapshot: createSnapshot(),
    streamFn,
    governance: createToolGovernance(),
    sessionStore: {
      appendMessage: (message) => messages.push(message),
      append: (entry) => entries.push(String(entry.customType)),
    },
  });
  const deltas: string[] = [];
  adapter.subscribeStream((delta) => deltas.push(delta.delta));

  const result = await adapter.run("你好");

  assert.equal(result.status, "completed");
  assert.ok(deltas.length > 1, "观察口照常收到多段增量");
  assert.equal(deltas.join(""), text, "观察口照常收到增量");
  // 写入面：恰两条消息（用户与助手），助手消息正文是完整文本；自定义条目只有 Run 开始与收尾
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"]
  );
  const assistant = messages[1] as { content: Array<{ type: string; text?: string }> };
  assert.deepEqual(
    assistant.content.filter((block) => block.type === "text").map((block) => block.text),
    [text]
  );
  assert.deepEqual(entries, [SessionEntryType.RunStart, SessionEntryType.RunEnd]);

  await adapter.dispose();
});

test("events() 不含流式增量：序列仍是归一化五族，载荷无模型文本", async () => {
  const text = "不进事件序列的文本";
  const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 1 }] });
  const adapter = new PiRuntimeAdapter({
    snapshot: createSnapshot(),
    streamFn,
    governance: createToolGovernance(),
  });
  const deltas: string[] = [];
  adapter.subscribeStream((delta) => deltas.push(delta.delta));

  await adapter.run("你好");

  assert.ok(deltas.length > 1, "观察口收到逐字符增量");
  const kinds = adapter.events().map((event) => event.kind);
  assert.deepEqual(kinds, ["turn.started", "turn.completed", "run.ended"]);
  assert.ok(!JSON.stringify(adapter.events()).includes(text));

  await adapter.dispose();
});
