// M4 S5（D3 Pi entry 映射）测试：每条 message_end 落地时刻分配 EntryId 并同步落盘，
// (runId, runSeq) 为权威键。覆盖：多轮工具调用 Run 的完整 entry 序列、abort 与上游
// 合成失败消息占序号、跨 Run 序号连续性、事件序 = transcript 序不变式、
// 写盘失败不毒化 Run（记录逻辑自身绝不抛——上游 listener 路径无防护）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { type EntryRecord, JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, createGate } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-entry-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeEventLog(root: string): {
  eventLog: JsonlEventLog;
  sessionsDir: string;
  sessionId: SessionId;
} {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  return { eventLog: new JsonlEventLog(sessionsDir, sessionId), sessionsDir, sessionId };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

function makeSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["edit_file"], deny: [], approvalMode: "yolo" },
      advertised: [],
    },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
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

test("entry 映射：多轮工具调用 Run 逐条落 entry，runSeq 连续且事件序 = transcript 序", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });

    const result = await adapter.run("改文件");
    assert.equal(result.status, "completed");
    await adapter.dispose();
    eventLog.close();

    // 冷物化读取 entry 族：user → assistant(toolCall) → toolResult → assistant(text)
    // 四条 message_end 各占一个序号，runSeq 从 1 连续
    const materialized = materializeSession(sessionsDir, sessionId);
    const entries = materialized.entries;
    assert.equal(entries.length, 4);
    assert.deepEqual(
      entries.map((entry) => entry.runSeq),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      entries.map((entry) => entry.role),
      ["user", "assistant", "toolResult", "assistant"]
    );
    // 权威键 (runId, runSeq)：全部归属于本 Run
    assert.ok(entries.every((entry) => entry.runId === result.runId));
    // 信封 id 即分配的 EntryId，互不相同
    assert.equal(new Set(entries.map((entry) => entry.id as string)).size, 4);
    assert.ok(entries.every((entry) => entry.id.startsWith("entry_")));

    // 事件序 = transcript 序不变式：entry 的 role 序列与 transcript 逐条对齐
    assert.deepEqual(
      adapter.transcript().map((message) => message.role),
      entries.map((entry) => entry.role)
    );
  } finally {
    cleanup();
  }
});

test("abort 与上游合成失败消息同样占 runSeq 序号；跨 Run 序号各自从 1 连续", async () => {
  const { root, cleanup } = makeWorkspace({});
  const { eventLog, sessionsDir, sessionId } = makeEventLog(root);
  try {
    // 三次 Run 共用一个假流：run1 吃第一条（无门闩，正常完成）；run2 吃第二条
    // （门闩挂起，流式中途 abort）；第 3 次调用直接抛错（上游合成失败消息，
    // handleRunFailure 路径——合成消息照常走 message_end 进 transcript，占一个序号）
    const gate = createGate();
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "第一题答案" },
          { text: "一段足够长的流式回复，用于中途打断。", chunkSize: 2, chunkGate: gate },
        ],
        failOnCall: 3,
        failureMessage: "模拟上游 500",
      }),
      registry: makeRegistry(),
      sessionId,
      eventLog,
    });

    // run1 正常完成（user + assistant 两条 entry）
    const run1 = await adapter.run("第一题");
    assert.equal(run1.status, "completed");

    // run2 流式中途 abort：aborted assistant 消息照常落 transcript，占一个序号
    // 等 turn.started（订阅真实信号，不猜时间）后打断，再放开闸门让流收尾
    const turnStarted = waitForEvent(adapter, "turn.started");
    const run2Promise = adapter.run("第二题");
    await turnStarted;
    const interrupt = adapter.interrupt();
    gate.open();
    await interrupt;
    const run2 = await run2Promise;
    assert.equal(run2.status, "aborted");

    // run3 模型层失败：上游合成失败消息走 message_start/message_end 进 transcript，占一个序号
    const run3 = await adapter.run("第三题");
    assert.equal(run3.status, "failed");
    assert.equal(run3.syntheticFailure, true);

    await adapter.dispose();
    eventLog.close();

    const materialized = materializeSession(sessionsDir, sessionId);
    const byRun = new Map<string, EntryRecord[]>();
    for (const entry of materialized.entries) {
      const list = byRun.get(entry.runId) ?? [];
      list.push(entry);
      byRun.set(entry.runId, list);
    }
    // 每个 Run 的 entry：user + assistant 两条；abort/合成失败消息占 runSeq=2
    for (const run of [run1, run2, run3]) {
      const entries = byRun.get(run.runId) ?? [];
      assert.deepEqual(
        entries.map((entry) => entry.runSeq),
        [1, 2],
        `${run.runId} runSeq 必须从 1 连续（abort/合成失败消息占序号）`
      );
      assert.deepEqual(
        entries.map((entry) => entry.role),
        ["user", "assistant"]
      );
    }

    // 事件序 = transcript 序不变式（跨三个 Run 全量对齐）：
    // 落盘 entry 序列的 role 与 transcript 逐条一致——abort 与合成失败消息都在位
    const transcript = adapter.transcript();
    assert.equal(transcript.length, 6);
    assert.deepEqual(
      transcript.map((message) => message.role),
      materialized.entries.map((entry) => entry.role)
    );
    // transcript 第 4 条（run2 的 assistant）是 aborted，第 6 条（run3）是合成失败——
    // 两者都占着 entry 序号（runSeq=2），冷物化重放不会错位
    const aborted = transcript[3];
    assert.ok(aborted?.role === "assistant" && aborted.stopReason === "aborted");
    const synthetic = transcript[5];
    assert.ok(synthetic?.role === "assistant" && synthetic.stopReason === "error");
  } finally {
    cleanup();
  }
});

test("entry 写盘失败不毒化 Run：故障进 listenerErrors，事件落盘与转发照常", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  const { eventLog, sessionId } = makeEventLog(root);
  try {
    // 故障注入：entry 写盘即抛错（模拟磁盘故障）——记录逻辑自身绝不抛回上游
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendEntry: () => {
        throw new Error("模拟磁盘写失败：entry 未落盘");
      },
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendReceipt: eventLog.appendReceipt.bind(eventLog),
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(original) }] },
          { text: "完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog: poison,
    });
    const forwarded: string[] = [];
    adapter.subscribe((event) => forwarded.push(event.kind));

    const result = await adapter.run("改文件");
    // Run 终态不受影响：transcript 完整、归一化事件照常落盘与转发
    assert.equal(result.status, "completed");
    assert.equal(adapter.transcript().length, 4);
    assert.deepEqual(forwarded, [
      "turn.started",
      "turn.completed",
      "tool.proposed",
      "tool.settled",
      "turn.started",
      "turn.completed",
      "run.ended",
    ]);
    // 故障响亮记录（4 条 message_end 各失败一次），不是静默吞掉
    assert.equal(adapter.listenerErrors().length, 4);
    await adapter.dispose();
    eventLog.close();
  } finally {
    cleanup();
  }
});
