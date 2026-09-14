// M5 S2（决策 038）：两个 read 档工具——search_sessions（默认 20 条 + 总字节上限，超限提示收窄）
// 与 read_session_entry（按 EntryId 取完整内容块 + 同 Run 的 intent / decision / receipt 状态）；
// 经真实 Adapter 调用时只留 tool.proposed / tool.settled 事件级记录（read 档自动放行）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  asSessionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  createReadSessionEntryTool,
  createSearchSessionsTool,
  DEFAULT_SEARCH_TOOL_LIMIT,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "./search-tools.ts";

const SESSION = asSessionId("sess_01JAAAAAA30000000000000000");

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-search-tools-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function proposed(
  sessionId: SessionId,
  runId: RunId,
  toolCallId: string,
  toolName: string
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
    kind: RuntimeEventKind.ToolProposed,
    payload: { toolCallId, toolName, args: { path: "a.ts" } },
  };
}

test("search_sessions 默认 20 条上限并提示收窄（去上限变红）", () =>
  withDir(async (dir) => {
    const log = new JsonlEventLog(dir, SESSION);
    const runId = newRunId();
    for (let index = 1; index <= 25; index++) {
      log.appendEntry({
        runSeq: index,
        role: "user",
        runId,
        message: { role: "user", content: `match 第 ${index} 条` },
      });
    }
    log.close();
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    assert.equal(tool.name, SEARCH_SESSIONS_TOOL);
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.equal(DEFAULT_SEARCH_TOOL_LIMIT, 20);
    assert.equal(result.details.hits.length, 20);
    assert.equal(result.details.limited, true);
    assert.match(textOf(result), /已达 20 条上限/);
    assert.match(textOf(result), /read_session_entry/);
  }));

test("search_sessions 总字节上限：超出即停并提示收窄", () =>
  withDir(async (dir) => {
    const log = new JsonlEventLog(dir, SESSION);
    const runId = newRunId();
    for (let index = 1; index <= 10; index++) {
      log.appendEntry({
        runSeq: index,
        role: "user",
        runId,
        message: { role: "user", content: `match ${"长".repeat(60)} ${index}` },
      });
    }
    log.close();
    const tool = createSearchSessionsTool({ sessionsDir: dir, maxBytes: 800 });
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.ok(result.details.hits.length > 0 && result.details.hits.length < 10);
    assert.equal(result.details.byteCapped, true);
    assert.match(textOf(result), /字节上限/);
  }));

test("read_session_entry：完整内容块 + 同 Run 的治理邻居，其他 Run 不混入", () =>
  withDir(async (dir) => {
    const log = new JsonlEventLog(dir, SESSION);
    const runA = newRunId();
    const runB = newRunId();
    const entry = log.appendEntry({
      runSeq: 1,
      role: "user",
      runId: runA,
      message: { role: "user", content: "把 a.ts 的 beta 改成大写" },
    });
    const approved = (runId: RunId, toolCallId: string) => ({
      executionId: newExecutionId(),
      toolCallId,
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved" as const, approvedBy: "human" as const, decidedAt: 1 },
      at: 1,
      runId,
    });
    log.appendRuntimeEvent(proposed(SESSION, runA, "tc-1", "edit_file"));
    const done = log.appendIntent(approved(runA, "tc-1"));
    log.appendReceipt({
      runId: runA,
      receipt: {
        version: RECEIPT_VERSION,
        id: newReceiptId(),
        executionId: done.executionId,
        toolCallId: "tc-1",
        approvedBy: "human",
        executed: true,
        isError: false,
        startedAt: 2,
        finishedAt: 3,
        summary: "edit_file 执行完成",
      },
    });
    log.appendRuntimeEvent(proposed(SESSION, runA, "tc-2", "edit_file"));
    log.appendDecision({
      executionId: newExecutionId(),
      toolCallId: "tc-2",
      toolName: "edit_file",
      rawArgs: { path: "b.ts" },
      decision: { outcome: "rejected", approvedBy: "human", reason: "不许改 b.ts", decidedAt: 4 },
      at: 4,
      runId: runA,
    });
    log.appendRuntimeEvent(proposed(SESSION, runA, "tc-3", "edit_file"));
    log.appendIntent(approved(runA, "tc-3"));
    log.appendRuntimeEvent(proposed(SESSION, runA, "tc-4", "read_file"));
    log.appendRuntimeEvent(proposed(SESSION, runB, "tc-9", "edit_file"));
    log.appendIntent(approved(runB, "tc-9"));
    log.close();

    const tool = createReadSessionEntryTool({ sessionsDir: dir });
    assert.equal(tool.name, READ_SESSION_ENTRY_TOOL);
    const text = textOf(await tool.execute("t1", { entryId: entry.id }));
    assert.match(text, /把 a\.ts 的 beta 改成大写/);
    assert.match(text, /正文哈希.*与 entry 回指一致/);
    assert.match(text, /tc-1.*已执行/);
    assert.match(text, /tc-2.*拒绝.*不许改 b\.ts/);
    assert.match(text, /tc-3.*待对账/);
    assert.match(text, /tc-4.*只读调用/);
    assert.doesNotMatch(text, /tc-9/);
    // 显式给 sessionId 同样可读
    assert.match(
      textOf(await tool.execute("t2", { entryId: entry.id, sessionId: SESSION })),
      /beta 改成大写/
    );
  }));

test("read_session_entry：截断块如实标注不得支撑确定性结论；找不到 entry 响亮报错", () =>
  withDir(async (dir) => {
    const log = new JsonlEventLog(dir, SESSION, { content: { blockLimitBytes: 30 } });
    const entry = log.appendEntry({
      runSeq: 1,
      role: "toolResult",
      runId: newRunId(),
      message: {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "tc-1",
        isError: false,
        content: [{ type: "text", text: "很长的工具输出".repeat(10) }],
      },
    });
    log.close();
    const tool = createReadSessionEntryTool({ sessionsDir: dir });
    const text = textOf(await tool.execute("t1", { entryId: entry.id }));
    assert.match(text, /已截断/);
    assert.match(text, /不得支撑确定性结论/);
    await assert.rejects(tool.execute("t2", { entryId: newEntryId() }), /未找到 entry/);
  }));

test("经真实 Adapter 调用 search_sessions：read 档自动放行，只留 tool.proposed / tool.settled", () =>
  withDir(async (dir) => {
    const old = new JsonlEventLog(dir, SESSION);
    old.appendEntry({
      runSeq: 1,
      role: "user",
      runId: newRunId(),
      message: { role: "user", content: "上周部署过网关" },
    });
    old.close();

    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(dir, sessionId);
    const registry = new ToolRegistry();
    for (const registration of sessionToolRegistrations(dir)) {
      registry.register(registration);
    }
    const adapter = new PiRuntimeAdapter({
      snapshot: {
        version: INJECTION_SNAPSHOT_VERSION,
        model: { provider: "fake-provider", id: "fake-model-1" },
        tools: {
          policy: { allow: [SEARCH_SESSIONS_TOOL], deny: [], approvalMode: "prompt" },
          advertised: [SEARCH_SESSIONS_TOOL],
        },
        context: { systemPrompt: "测试" },
        memory: [],
        skills: [],
        createdAt: 1,
      },
      streamFn: createFakeStreamFn({
        replies: [
          { text: "", toolCalls: [{ name: SEARCH_SESSIONS_TOOL, args: { keywords: ["部署"] } }] },
          { text: "查到了" },
        ],
      }),
      registry,
      tools: [createSearchSessionsTool({ sessionsDir: dir })],
      sessionId,
      eventLog,
    });
    const result = await adapter.run("我们以前部署过什么");
    assert.equal(result.status, "completed");
    await adapter.dispose();
    eventLog.close();

    const materialized = materializeSession(dir, sessionId);
    const kinds = materialized.runtimeEvents
      .filter((event) => event.kind === "tool.proposed" || event.kind === "tool.settled")
      .map((event) => [event.kind, (event.payload as { toolName: string }).toolName]);
    assert.deepEqual(kinds, [
      ["tool.proposed", SEARCH_SESSIONS_TOOL],
      ["tool.settled", SEARCH_SESSIONS_TOOL],
    ]);
    const settled = materialized.runtimeEvents.find((event) => event.kind === "tool.settled");
    assert.ok(settled?.kind === "tool.settled");
    assert.equal(settled.payload.isError, false);
    assert.equal(materialized.intents.length, 0);
    assert.equal(materialized.decisions.length, 0);
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "policy:auto");
  }));
