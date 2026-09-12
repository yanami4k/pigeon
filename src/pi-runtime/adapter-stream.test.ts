// M2 S1（决策 024）：subscribeStream 只读流式文本观察口测试。
// 纪律：上游 message_update 携带 text_delta 时把增量连同 runId 转发给订阅者；
// 不进 Event Log、不进 events()、不锚身份（013：流式载荷是上游浅拷贝 partial）；
// thinking 增量第一版不转发；listener 自包 try/catch 进 listenerErrors，绝不毒化 Run。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { newSessionId } from "../state/ids.ts";
import { PiRuntimeAdapter, type StreamTextDelta } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
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

test("text_delta 增量按序到达并携带 runId；thinking 增量不转发；退订后不再收到", async () => {
  const thinking = "先想想再回答";
  const firstText = "流式增量甲乙丙丁戊己";
  const streamFn = createFakeStreamFn({
    replies: [
      { thinking, text: firstText, chunkSize: 2 },
      { text: "第二次回复" },
    ],
  });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  const deltas: StreamTextDelta[] = [];
  const unsubscribe = adapter.subscribeStream((delta) => deltas.push(delta));

  const first = await adapter.run("你好");

  // 增量按序到达，拼接 == 完整文本；每条携带本 Run 的 runId
  assert.ok(deltas.length > 1, `chunkSize=2 应产生多条增量，实际 ${deltas.length} 条`);
  assert.equal(deltas.map((d) => d.delta).join(""), firstText);
  for (const delta of deltas) {
    assert.equal(delta.runId, first.runId);
  }
  // thinking 增量不转发（024 子裁决：第一版只转发 text_delta）
  assert.ok(!deltas.map((d) => d.delta).join("").includes(thinking));
  assert.equal(first.status, "completed");

  // 退订后第二个 Run 不再收到增量
  unsubscribe();
  const second = await adapter.run("再来");
  assert.equal(second.status, "completed");
  assert.equal(deltas.map((d) => d.delta).join(""), firstText);

  await adapter.dispose();
});

test("listener 抛异常进 listenerErrors，Run 与其他 listener 不受影响（同 subscribe 不变式）", async () => {
  const text = "异常侦错流式文本";
  const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 3 }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
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
  assert.ok(
    adapter.listenerErrors().length >= 1,
    "listener 异常应进 listenerErrors"
  );

  await adapter.dispose();
});

test("流式增量不进 Event Log：会话文件零文本记录（消息文本不持久化）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-stream-log-"));
  try {
    const text = "绝不落盘的流式文本甲乙丙";
    const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 2 }] });
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: createSnapshot(),
      streamFn,
      sessionId,
      eventLog,
    });
    const deltas: string[] = [];
    adapter.subscribeStream((delta) => deltas.push(delta.delta));

    const result = await adapter.run("你好");
    eventLog.close();

    assert.equal(result.status, "completed");
    assert.equal(deltas.join(""), text, "观察口照常收到增量");
    // 事件日志确实在工作（entry/事件族已落盘），但任何记录都不含模型文本
    const raw = readFileSync(JsonlEventLog.filePathFor(sessionsDir, sessionId), "utf8");
    assert.ok(raw.length > 0, "事件日志应有记录（entry/turn/run 族）");
    assert.ok(!raw.includes("流式文本"), `事件日志不得含模型文本\n${raw}`);
    assert.ok(!raw.includes("甲乙丙"), `事件日志不得含流式增量片段\n${raw}`);
    // 冷物化也读不出文本：entry 记录只有 runSeq 与 role
    const materialized = materializeSession(sessionsDir, sessionId);
    assert.ok(!JSON.stringify(materialized).includes("甲乙丙"));

    await adapter.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("events() 不含流式增量：序列仍是归一化五族，载荷无模型文本", async () => {
  const text = "不进事件序列的文本";
  const streamFn = createFakeStreamFn({ replies: [{ text, chunkSize: 1 }] });
  const adapter = new PiRuntimeAdapter({ snapshot: createSnapshot(), streamFn });
  const deltas: string[] = [];
  adapter.subscribeStream((delta) => deltas.push(delta.delta));

  await adapter.run("你好");

  assert.ok(deltas.length > 1, "观察口收到逐字符增量");
  const kinds = adapter.events().map((event) => event.kind);
  assert.deepEqual(kinds, ["turn.started", "turn.completed", "run.ended"]);
  assert.ok(!JSON.stringify(adapter.events()).includes(text));

  await adapter.dispose();
});
