// 运行面双写（决策 206）：Adapter 在写旧账本的同一处同时写新会话存储——每条 message_end 的完整消息、每个 Run 的开始
// （本次配置与系统提示全文）与收尾（结束方式）。新存储写失败不中断运行、不影响旧账本。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createToolGovernance } from "../application/governance.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import { newSessionId } from "../state/ids.ts";
import {
  type RunEndData,
  type RunStartData,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, createGate, type FakeReply } from "./fixtures.ts";
import type { AgentTool } from "./governance.ts";
import type { AgentMessage } from "./index.ts";
import { openSessionStoreWriter, type SessionStoreSink } from "./session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

const SYSTEM_PROMPT = "你是 Pigeon 测试助手。\n第二行";

function snapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1", maxOutputTokens: 1024 },
    tools: {
      policy: { allow: ["echo"], deny: [], approvalMode: "yolo" },
      advertised: [],
    },
    context: { systemPrompt: SYSTEM_PROMPT, taskDirective: "只改需要改的" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
    repairRounds: 2,
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

type Captured =
  | { kind: "message"; message: AgentMessage }
  | { kind: "entry"; entry: SessionCustomEntry };

function captureSink(): { sink: SessionStoreSink; captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    captured,
    sink: {
      appendMessage: (message) => captured.push({ kind: "message", message }),
      append: (entry) => captured.push({ kind: "entry", entry }),
    },
  };
}

function adapterWith(
  replies: FakeReply[],
  sessionStore: SessionStoreSink,
  extra: { eventLog?: JsonlEventLog } = {}
): PiRuntimeAdapter {
  return new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn: createFakeStreamFn({ replies }),
    governance: governance(),
    tools: [echoTool],
    sessionStore,
    // 旧 run.started 的这一步起点只进旧账本
    runStartedStepStart: () => ({ commit: "a".repeat(40) }),
    ...(extra.eventLog !== undefined ? { eventLog: extra.eventLog } : {}),
  });
}

test("双写：Run 开始带本次配置与系统提示全文，完整消息按序写，Run 收尾带结束方式与消息条数", async () => {
  const { sink, captured } = captureSink();
  const adapter = adapterWith(
    [{ text: "调工具", toolCalls: [{ name: "echo", args: { text: "回声" } }] }, { text: "完成" }],
    sink
  );
  const result = await adapter.run("做事");
  assert.equal(result.status, "completed");
  assert.deepEqual(
    captured.map((item) =>
      item.kind === "message" ? item.message.role : (item.entry.customType as string)
    ),
    [
      SessionEntryType.RunStart,
      "user",
      "assistant",
      "toolResult",
      "assistant",
      SessionEntryType.RunEnd,
    ]
  );
  const start = (captured[0] as { entry: { data: RunStartData } }).entry.data;
  assert.equal(start.runId, result.runId);
  assert.equal(start.systemPrompt, SYSTEM_PROMPT);
  assert.equal(start.taskDirective, "只改需要改的");
  assert.equal(start.repairRounds, 2);
  assert.deepEqual(start.advertisedTools, ["echo"]);
  assert.deepEqual(start.policy, { allow: ["echo"], deny: [], approvalMode: "yolo" });
  assert.deepEqual(start.model, {
    provider: "fake-provider",
    id: "fake-model-1",
    thinkingLevel: "off",
    maxOutputTokens: 1024,
  });
  assert.equal("stepStart" in start, false, "这一步起点不进新存储");
  assert.equal("structuredMemory" in start, false);
  assert.equal("systemPromptHash" in start, false);
  // 消息与 transcript 逐条一致（完整消息，含工具调用参数、用量与停止原因）
  const messages = captured.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  assert.deepEqual(messages, adapter.transcript());
  // 上游 agent-loop 构造工具结果消息时恒带 usage 键，工具不报用量即为 undefined：写入前必须剥掉，否则上游序列化拒绝整条
  const toolResult = messages.find((message) => message.role === "toolResult") as
    | Record<string, unknown>
    | undefined;
  assert.ok(toolResult !== undefined && Object.hasOwn(toolResult, "usage"));
  assert.equal(toolResult.usage, undefined);
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.runId, result.runId);
  assert.equal(end.ending, "completed");
  assert.equal(end.stopReason, "stop");
  assert.equal(end.messageCount, 4);
  await adapter.dispose();
});

test("双写：撞上限的一方带原因中止，收尾条目一次写全结束方式；不带原因的中止记为中止", async () => {
  for (const cause of ["turn-limit", "wall-clock-limit", "token-limit", undefined] as const) {
    const gate = createGate();
    const { sink, captured } = captureSink();
    const adapter = adapterWith([{ text: "慢慢说", chunkSize: 1, chunkGate: gate }], sink);
    const running = adapter.run("说话");
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = adapter.interrupt(cause);
    gate.open();
    await stopping;
    const result = await running;
    assert.equal(result.status, "aborted");
    const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
    assert.equal(end.ending, cause ?? "aborted");
    assert.equal(end.stopReason, "aborted");
    await adapter.dispose();
  }
});

test("双写：中止原因只管当前 Run，下一个 Run 不继承", async () => {
  const gate = createGate();
  const { sink, captured } = captureSink();
  const adapter = adapterWith([{ text: "慢慢说", chunkSize: 1, chunkGate: gate }], sink);
  const first = adapter.run("一");
  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stopping = adapter.interrupt("turn-limit");
  gate.open();
  await stopping;
  await first;
  await adapter.run("二");
  const ends = captured.flatMap((item) =>
    item.kind === "entry" && item.entry.customType === SessionEntryType.RunEnd
      ? [(item.entry.data as RunEndData).ending]
      : []
  );
  assert.deepEqual(ends, ["turn-limit", "completed"]);
  await adapter.dispose();
});

test("双写：模型出错收尾记为出错，带错误文本", async () => {
  const { sink, captured } = captureSink();
  const adapter = adapterWith([{ text: "", streamError: "上游 500" }], sink);
  const result = await adapter.run("做事");
  assert.equal(result.status, "failed");
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.ending, "error");
  assert.equal(end.stopReason, "error");
  assert.equal(end.errorMessage, "上游 500");
  await adapter.dispose();
});

test("双写：熔断中止的 Run 记为熔断", async () => {
  const { sink, captured } = captureSink();
  const adapter = new PiRuntimeAdapter({
    snapshot: snapshot(),
    streamFn: createFakeStreamFn({
      replies: [{ text: "调", toolCalls: [{ name: "echo", args: { text: "x" } }] }],
    }),
    // 首次调用即落闸的治理桩
    governance: (host) => {
      let tripped = false;
      return {
        beginRun: () => {
          tripped = false;
        },
        decide: async () => {
          tripped = true;
          host.abort();
          return { kind: "block", reason: "熔断" };
        },
        governs: () => true,
        settle: () => {},
        runOutcome: () => ({ breakerTripped: tripped, toolExecutions: [] }),
        toolExecutions: () => [],
      };
    },
    tools: [echoTool],
    sessionStore: sink,
  });
  const result = await adapter.run("做事");
  assert.equal(result.status, "aborted");
  const end = (captured.at(-1) as { entry: { data: RunEndData } }).entry.data;
  assert.equal(end.ending, "breaker");
  await adapter.dispose();
});

test("双写：新存储写入面抛错不中断运行、不影响旧账本，异常进内部错误清单", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-dual-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, newSessionId());
  try {
    const broken: SessionStoreSink = {
      appendMessage: () => {
        throw new Error("消息写坏了");
      },
      append: () => {
        throw new Error("条目写坏了");
      },
    };
    const adapter = adapterWith([{ text: "好" }], broken, { eventLog });
    const result = await adapter.run("做事");
    assert.equal(result.status, "completed");
    const session = materializeSession(sessionsDir, eventLog.sessionId);
    assert.equal(session.entries.length, 2, "旧账本的消息照写");
    assert.equal(session.runStarteds.length, 1);
    assert.equal(session.unfinishedRuns.length, 0);
    // 同一事件的归一化、旧账本运行事件与对外转发一个都不缺
    assert.deepEqual(
      session.runtimeEvents.map((event) => event.kind),
      ["turn.started", "turn.completed", "run.ended"]
    );
    assert.deepEqual(
      adapter.events().map((event) => event.kind),
      ["turn.started", "turn.completed", "run.ended"]
    );
    assert.ok(adapter.listenerErrors().some((error) => String(error).includes("消息写坏了")));
    assert.ok(adapter.listenerErrors().some((error) => String(error).includes("条目写坏了")));
    await adapter.dispose();
  } finally {
    eventLog.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("双写：接真实写者，新文件里 Run 开始、消息、Run 收尾与旧账本同序同数", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-dual-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const eventLog = new JsonlEventLog(sessionsDir, sessionId);
  const store = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: snapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "调", toolCalls: [{ name: "echo", args: { text: "x" } }] },
          { text: "好" },
        ],
      }),
      governance: governance(),
      tools: [echoTool],
      sessionId,
      eventLog,
      sessionStore: store,
    });
    await adapter.run("一");
    await adapter.run("二");
    await adapter.dispose();
    await store.close();
    const view = readSessionFile(locateSessionFile(sessionsDir, sessionId)?.path ?? "");
    assert.ok(view !== undefined);
    const kinds = view.entries.map((entry) =>
      entry.type === "custom" ? String(entry.customType) : "message"
    );
    const old = materializeSession(sessionsDir, sessionId);
    assert.equal(kinds.filter((kind) => kind === "message").length, old.entries.length);
    assert.equal(kinds.filter((kind) => kind === SessionEntryType.RunStart).length, 2);
    assert.equal(kinds.filter((kind) => kind === SessionEntryType.RunEnd).length, 2);
    assert.equal(kinds[0], SessionEntryType.RunStart);
    assert.equal(kinds.at(-1), SessionEntryType.RunEnd);
  } finally {
    eventLog.close();
    rmSync(root, { recursive: true, force: true });
  }
});
