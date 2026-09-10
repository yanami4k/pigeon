// PiRuntimeAdapter 跨真实 pi-agent-core Agent seam 的测试（ROADMAP M1 完成证据）。
// 六个场景：正常完成 / 流式中途 abort / 模型报错 / 快照可重建 / listener 韧性 / dispose 空跑与幂等。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { EventEnvelopeSchema } from "../state/events.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import type { TurnCompletedPayload } from "./events.ts";
import { createFakeStreamFn, createGate, type FakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

// 固定 createdAt 的快照工厂：保证“同一快照重建”场景里两份快照逐字节一致
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

// 等待 Adapter 观察到指定 kind 的事件（订阅真实信号，不猜时间）
function waitForEvent(adapter: PiRuntimeAdapter, kind: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = adapter.subscribe((event) => {
    if (event.kind === kind) {
      unsubscribe();
      resolve();
    }
  });
  return promise;
}

test("正常完成：事件序列完整、终态 completed、快照冻结且内容正确", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "你好！有什么可以帮你？" }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });

  const result = await adapter.run("你好");

  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.syntheticFailure, false);
  assert.equal(result.errorMessage, undefined);
  assert.deepEqual(result.advertisedTools, []);

  // 完整事件序列：user 消息不产生 Pigeon 事件，assistant 消息映射为 turn 边界
  const kinds = adapter.events().map((event) => event.kind);
  assert.deepEqual(kinds, ["turn.started", "turn.completed", "run.ended"]);
  // 每条事件都是合法信封（真实 EntryId/SessionId/RunId、版本、时间戳）
  for (const event of adapter.events()) {
    assert.ok(Value.Check(EventEnvelopeSchema, event), JSON.stringify(event));
  }
  const turnCompleted = adapter.events()[1];
  assert.ok(turnCompleted);
  const payload = turnCompleted.payload as TurnCompletedPayload;
  assert.equal(payload.stopReason, "stop");
  assert.equal(payload.syntheticFailure, false);

  // 快照深冻结且内容与注入一致
  const snapshot = adapter.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.model));
  assert.ok(Object.isFrozen(snapshot.tools));
  assert.ok(Object.isFrozen(snapshot.tools.policy));
  assert.ok(Object.isFrozen(snapshot.tools.advertised));
  assert.deepEqual(snapshot, createSnapshot());
  assert.throws(() => {
    (snapshot.model as { provider: string }).provider = "篡改";
  }, TypeError);

  await adapter.dispose();
});

test("流式中途 abort：终态 aborted，事件序列完整收尾", async () => {
  // 门闩把模型流停在“已开始但未结束”的确定时间点，interrupt 后再放行
  const gate = createGate();
  const streamFn = createFakeStreamFn({
    replies: [{ text: "这是一段足够长的流式回复。", chunkSize: 2, chunkGate: gate }],
  });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  const turnStarted = waitForEvent(adapter, "turn.started");

  const runPromise = adapter.run("你好");
  await turnStarted;
  assert.equal(adapter.isRunning(), true);
  // 固定姿势：abort → waitForIdle（interrupt 内部）；abort 同步生效后放行门闩让流收尾
  const interruptPromise = adapter.interrupt();
  gate.open();
  await interruptPromise;
  const result = await runPromise;

  assert.equal(result.status, "aborted");
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.syntheticFailure, false);

  // 事件序列完整收尾：turn.started → turn.completed(aborted) → run.ended，无悬挂
  const kinds = adapter.events().map((event) => event.kind);
  assert.equal(kinds[0], "turn.started");
  assert.ok(kinds.includes("turn.completed"));
  assert.equal(kinds.at(-1), "run.ended");
  assert.equal(adapter.isRunning(), false);

  await adapter.dispose();
});

test("模型报错：终态 failed，errorMessage 被记录，合成消息被识别标注", async () => {
  const streamFn = createFakeStreamFn({
    replies: [{ text: "不会用到" }],
    failOnCall: 1,
    failureMessage: "模拟上游 500",
  });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });

  const result = await adapter.run("你好");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /模拟上游 500/);
  assert.equal(result.syntheticFailure, true);

  // 合成消息走正常广播路径：turn.started → turn.completed → run.ended
  const kinds = adapter.events().map((event) => event.kind);
  assert.deepEqual(kinds, ["turn.started", "turn.completed", "run.ended"]);
  const turnCompleted = adapter.events()[1];
  assert.ok(turnCompleted);
  const payload = turnCompleted.payload as TurnCompletedPayload;
  assert.equal(payload.stopReason, "error");
  assert.equal(payload.syntheticFailure, true);
  assert.match(payload.errorMessage ?? "", /模拟上游 500/);

  await adapter.dispose();
});

test("快照可重建：同一 InjectionSnapshot 跑两次 Run，事件序列等价", async () => {
  const snapshot = createSnapshot();

  const streamFn1 = createFakeStreamFn({ replies: [{ text: "固定回复" }] });
  const adapter1 = new PiRuntimeAdapter({ snapshot, streamFn: streamFn1 });
  const result1 = await adapter1.run("你好");

  const streamFn2 = createFakeStreamFn({ replies: [{ text: "固定回复" }] });
  const adapter2 = new PiRuntimeAdapter({ snapshot, streamFn: streamFn2 });
  const result2 = await adapter2.run("你好");

  assert.equal(result1.status, "completed");
  assert.equal(result2.status, "completed");
  // 事件序列等价：剥掉 ID / 时间戳 / sessionId / runId 后逐条一致
  const strip = (adapter: PiRuntimeAdapter) =>
    adapter.events().map(({ kind, payload }) => ({ kind, payload }));
  assert.deepEqual(strip(adapter1), strip(adapter2));
  // 两次 Run 注入了相同的 systemPrompt 与用户消息
  const contextOf = (streamFn: FakeStreamFn) => {
    const call = streamFn.calls[0];
    assert.ok(call);
    return call.context;
  };
  assert.equal(contextOf(streamFn1).systemPrompt, snapshot.context.systemPrompt);
  assert.deepEqual(
    contextOf(streamFn1).messages.map((m) => ({ role: m.role, content: m.content })),
    contextOf(streamFn2).messages.map((m) => ({ role: m.role, content: m.content }))
  );

  await adapter1.dispose();
  await adapter2.dispose();
});

test("listener 韧性：抛异常的 listener 被吞掉并记录，Run 不受影响", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "正常回复" }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  const seen: string[] = [];
  adapter.subscribe((event) => {
    seen.push(event.kind);
  });
  adapter.subscribe(() => {
    throw new Error("listener 炸了");
  });

  const result = await adapter.run("你好");

  // Run 终态不受坏 listener 影响
  assert.equal(result.status, "completed");
  // 坏 listener 不影响排在其前后的正常 listener
  assert.deepEqual(seen, ["turn.started", "turn.completed", "run.ended"]);
  // 异常被吞掉并记录：每个事件一次
  assert.equal(adapter.listenerErrors().length, 3);
  for (const error of adapter.listenerErrors()) {
    assert.ok(error instanceof Error);
    assert.equal((error as Error).message, "listener 炸了");
  }
  // transcript 里没有因 listener 异常产生的合成错误消息
  const last = adapter.transcript().at(-1);
  assert.ok(last);
  assert.equal(last.role, "assistant");
  if (last.role === "assistant") {
    assert.equal(last.stopReason, "stop");
  }

  await adapter.dispose();
});

test("dispose 空跑与幂等：从未 Run 直接释放不抛不悬挂，释放后拒绝 Run，重复释放无副作用", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "不会用到" }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });

  // 从未 run 过的 adapter 直接 dispose：正常 await 返回即证明不抛异常、不悬挂
  await adapter.dispose();
  // 幂等：第二次 dispose 同样正常返回
  await adapter.dispose();

  // 释放后的行为契约：再启动 Run 必须抛“已释放”错误
  await assert.rejects(adapter.run("你好"), /已释放/);
});

test("transcript 隔离：观察拷贝的嵌套修改不污染 Agent 状态与后续 Run", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "原始回复" }, { text: "第二次回复" }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  await adapter.run("你好");

  // 在观察拷贝上就地篡改嵌套的 text 内容
  const copy = adapter.transcript();
  const copiedAssistant = copy.find((message) => message.role === "assistant");
  assert.ok(copiedAssistant);
  assert.equal(copiedAssistant.role, "assistant");
  const copiedText = copiedAssistant.content[0];
  assert.ok(copiedText);
  assert.equal(copiedText.type, "text");
  if (copiedText.type !== "text") {
    return;
  }
  copiedText.text = "已被篡改";

  // 重新观察：拿到的是未被污染的内容
  const fresh = adapter.transcript();
  const freshAssistant = fresh.find((message) => message.role === "assistant");
  assert.ok(freshAssistant);
  assert.equal(freshAssistant.role, "assistant");
  const freshText = freshAssistant.content[0];
  assert.ok(freshText);
  assert.equal(freshText.type, "text");
  if (freshText.type === "text") {
    assert.equal(freshText.text, "原始回复");
  }

  // 篡改不得进入 Agent 状态：第二次 Run 的上下文中助手消息仍是原文
  const result = await adapter.run("再说一次");
  assert.equal(result.status, "completed");
  const secondCall = streamFn.calls[1];
  assert.ok(secondCall);
  const contextAssistant = secondCall.context.messages.find(
    (message) => message.role === "assistant"
  );
  assert.ok(contextAssistant);
  assert.equal(contextAssistant.role, "assistant");
  const contextText = contextAssistant.content[0];
  assert.ok(contextText);
  assert.equal(contextText.type, "text");
  if (contextText.type === "text") {
    assert.equal(contextText.text, "原始回复");
  }

  await adapter.dispose();
});

test("事件冻结：listener 篡改事件被 TypeError 拦截，事件日志保持完整", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "正常回复" }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  adapter.subscribe((event) => {
    // 冻结对象上的写入在严格模式下抛 TypeError，被自包 try/catch 吞进 listenerErrors
    (event.payload as Record<string, unknown>).tampered = true;
  });

  const result = await adapter.run("你好");

  assert.equal(result.status, "completed");
  // 每条归一化事件（turn.started / turn.completed / run.ended）各触发一次篡改失败
  const errors = adapter.listenerErrors();
  assert.equal(errors.length, 3);
  for (const error of errors) {
    assert.ok(error instanceof TypeError);
  }
  // 日志中的信封深冻结且未被污染
  for (const event of adapter.events()) {
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.payload));
    assert.equal((event.payload as Record<string, unknown>).tampered, undefined);
  }

  await adapter.dispose();
});

test("模型身份守卫：options.model 携带 provider/id 直接抛错", () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "不会用到" }] });
  const snapshot = createSnapshot();

  assert.throws(
    () =>
      new PiRuntimeAdapter({
        snapshot,
        streamFn,
        // @ts-expect-error 类型门：provider 属于快照身份，options.model 不允许携带
        model: { provider: "evil-provider" },
      }),
    /模型身份/
  );
  assert.throws(
    () =>
      new PiRuntimeAdapter({
        snapshot,
        streamFn,
        // @ts-expect-error 类型门：id 属于快照身份，options.model 不允许携带
        model: { id: "evil-model" },
      }),
    /模型身份/
  );
});

test("模型元数据合并：仅补 api/baseUrl 时 Agent 实际模型的身份仍来自快照", async () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "正常回复" }] });
  const snapshot = createSnapshot();
  const adapter = new PiRuntimeAdapter({
    snapshot,
    streamFn,
    model: { api: "anthropic-messages", baseUrl: "https://example.invalid" },
  });

  const result = await adapter.run("你好");

  assert.equal(result.status, "completed");
  // 假 streamFn 收到的 model：身份字段来自快照，元数据字段来自 options.model
  const call = streamFn.calls[0];
  assert.ok(call);
  assert.equal(call.model.provider, snapshot.model.provider);
  assert.equal(call.model.id, snapshot.model.id);
  assert.equal(call.model.api, "anthropic-messages");
  assert.equal(call.model.baseUrl, "https://example.invalid");

  await adapter.dispose();
});
