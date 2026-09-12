// M4 S3：Trace 关联视图投影的单元测试（手写事件日志 → 冷物化 materializeSession →
// buildSessionTrace 关联）。覆盖：崩溃残留待对账、孤儿 Receipt/Resolution、哈希确证挂接、
// 熔断挂接、id 错位异常（executionId 对上但 toolCallId 不符 / 实测哈希与预期不符）、
// 跨 Run 同 toolCallId 的 runId 域隔离、runId 过滤。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import {
  type ExecutionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { JsonlEventLog, materializeSession } from "./event-log.ts";
import { buildSessionTrace } from "./trace.ts";

function makeEventLog(): {
  root: string;
  sessionsDir: string;
  sessionId: SessionId;
  eventLog: JsonlEventLog;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  return {
    root,
    sessionsDir,
    sessionId,
    eventLog: new JsonlEventLog(sessionsDir, sessionId),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runtimeEvent(
  sessionId: SessionId,
  runId: RunId,
  kind: string,
  payload: unknown
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
    kind,
    payload,
  };
}

function approvedIntent(runId: RunId, toolCallId: string, executionId?: ExecutionId) {
  return {
    executionId: executionId ?? newExecutionId(),
    toolCallId,
    toolName: "edit_file",
    rawArgs: { path: "a.ts" },
    decision: {
      outcome: "approved" as const,
      approvedBy: "human" as const,
      decidedAt: 1_757_000_000_001,
    },
    at: 1_757_000_000_000,
    runId,
  };
}

function makeReceipt(
  executionId: ExecutionId,
  toolCallId: string,
  over: Partial<Receipt> = {}
): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId,
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_002,
    finishedAt: 1_757_000_000_003,
    summary: "edit_file 执行完成",
    ...over,
  };
}

test("崩溃残留：intent 已落盘、无 Receipt → 待对账（OutcomeUnknown），run/调用分类均落未知桶", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.proposed", {
        toolCallId: "tc-1-1",
        toolName: "edit_file",
        args: { path: "a.ts" },
      })
    );
    const executionId = newExecutionId();
    eventLog.appendIntent({
      ...approvedIntent(runId, "tc-1-1", executionId),
      contentHashes: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
      },
    });
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    assert.equal(trace.runs.length, 1);
    const run = trace.runs[0];
    assert.ok(run);
    assert.equal(run.ended, false);
    assert.deepEqual(run.classification?.failure, { category: "unknown" });
    const call = run.turns[0]?.toolCalls[0];
    assert.ok(call);
    assert.equal(call.toolCallId, "tc-1-1");
    assert.ok(call.proposed, "提议事件必须挂接上");
    assert.ok(call.intent, "intent 必须挂接上");
    assert.equal(call.receipt, undefined);
    assert.equal(call.pendingReconcile, true, "悬账必须标记待对账");
    assert.deepEqual(call.classification?.failure, { category: "unknown" });
    // 哈希证据随行（供人工对账）
    assert.equal(call.intent.contentHashes?.beforeHash, "aaaaaaaaaaaaaaaa");
  } finally {
    cleanup();
  }
});

test("孤儿记录：Receipt/Resolution 找不到对应 intent/decision → 如实进孤儿清单，不猜测挂接", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    const settledExecution = newExecutionId();
    eventLog.appendIntent(approvedIntent(runId, "tc-1-1", settledExecution));
    eventLog.appendReceipt({ receipt: makeReceipt(settledExecution, "tc-1-1"), runId });
    // 孤儿：executionId 无对应 intent/decision
    const orphanReceipt = makeReceipt(newExecutionId(), "tc-9-9");
    eventLog.appendReceipt({ receipt: orphanReceipt, runId });
    eventLog.appendResolution({
      executionId: newExecutionId(),
      toolCallId: "tc-8-8",
      toolName: "edit_file",
      outcome: "executed",
      method: "hash-auto",
      evidence: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
        observedHash: "bbbbbbbbbbbbbbbb",
      },
      at: 1_757_000_000_004,
      runId,
    });
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    const run = trace.runs[0];
    assert.ok(run);
    // 正常配对的调用不受影响
    const call = run.toolCalls[0];
    assert.ok(call);
    assert.equal(call.receipt?.executionId, settledExecution);
    assert.ok(call.receipt?.id !== orphanReceipt.id, "正常配对不得拿到孤儿 Receipt");
    assert.equal(call.pendingReconcile, false);
    // 孤儿挂会话级清单，Receipt 带回属 runId（信封字段）
    assert.equal(trace.orphanReceipts.length, 1);
    assert.equal(trace.orphanReceipts[0]?.receipt.id, orphanReceipt.id);
    assert.equal(trace.orphanReceipts[0]?.runId, runId);
    assert.equal(trace.orphanResolutions.length, 1);
  } finally {
    cleanup();
  }
});

test("哈希自动确证：resolution 按 executionId 挂接回悬账调用，确证后不再待对账", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    const executionId = newExecutionId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.proposed", {
        toolCallId: "tc-1-1",
        toolName: "edit_file",
        args: { path: "a.ts" },
      })
    );
    eventLog.appendIntent(approvedIntent(runId, "tc-1-1", executionId));
    eventLog.appendResolution({
      executionId,
      toolCallId: "tc-1-1",
      toolName: "edit_file",
      outcome: "executed",
      method: "hash-auto",
      evidence: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
        observedHash: "bbbbbbbbbbbbbbbb",
      },
      at: 1_757_000_000_004,
      runId,
    });
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    const call = trace.runs[0]?.turns[0]?.toolCalls[0];
    assert.ok(call);
    assert.equal(call.resolution?.outcome, "executed");
    assert.equal(call.resolution?.executionId, call.intent?.executionId);
    assert.equal(call.pendingReconcile, false, "确证销账后不得再标待对账");
    assert.deepEqual(call.classification?.failure, null, "确证已执行 = 非失败");
  } finally {
    cleanup();
  }
});

test("熔断挂接：breaker 记录归 run 并回指触发调用；上游拦截调用按 toolCallId 挂分类（业务失败）", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
    // 幽灵工具名：上游拦截，hook 从未运行 → 只有事件级记录，无治理族
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.proposed", {
        toolCallId: "tc-1-1",
        toolName: "ghost_tool",
        args: {},
      })
    );
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.settled", {
        toolCallId: "tc-1-1",
        toolName: "ghost_tool",
        isError: true,
        errorKind: "domain",
      })
    );
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "turn.completed", {
        stopReason: "aborted",
        syntheticFailure: false,
      })
    );
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "run.ended", { messageCount: 0 }));
    eventLog.appendBreaker({
      toolName: "ghost_tool",
      toolCallId: "tc-1-1",
      scope: "intercepted",
      count: 3,
      threshold: 3,
      at: 1_757_000_000_005,
      runId,
    });
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    const run = trace.runs[0];
    assert.ok(run);
    assert.equal(run.ended, true);
    assert.equal(run.breakers.length, 1);
    assert.deepEqual(run.classification?.failure, { category: "cancelled", breaker: true });
    const call = run.turns[0]?.toolCalls[0];
    assert.ok(call);
    assert.equal(call.intent, undefined, "上游拦截调用无治理记录");
    assert.equal(call.breakers.length, 1, "熔断记录必须回指触发它的调用");
    assert.equal(call.breakers[0]?.scope, "intercepted");
    assert.deepEqual(call.classification?.failure, { category: "business" });
  } finally {
    cleanup();
  }
});

test("id 错位即异常：Receipt 的 toolCallId 与意图不符 / 实测改后哈希与预期不符 → 挂接但标异常", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    const executionId = newExecutionId();
    eventLog.appendIntent({
      ...approvedIntent(runId, "tc-1-1", executionId),
      contentHashes: {
        path: "a.ts",
        beforeHash: "aaaaaaaaaaaaaaaa",
        expectedAfterHash: "bbbbbbbbbbbbbbbb",
      },
    });
    // executionId 对得上（权威键），但 toolCallId 与实测哈希都对不上
    eventLog.appendReceipt({
      receipt: makeReceipt(executionId, "tc-OTHER", { contentAfterHash: "cccccccccccccccc" }),
      runId,
    });
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    const call = trace.runs[0]?.toolCalls[0];
    assert.ok(call);
    assert.ok(call.receipt, "executionId 权威键对上必须挂接");
    assert.ok(
      call.anomalies.some((line) => line.includes("toolCallId")),
      "toolCallId 不符必须标异常"
    );
    assert.ok(
      call.anomalies.some((line) => line.includes("哈希")),
      "实测改后哈希与预期不符必须标异常"
    );
  } finally {
    cleanup();
  }
});

test("跨 Run 同 toolCallId：关联以 (runId, toolCallId) 为域，绝不跨 Run 串线；runId 过滤生效", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runA = newRunId();
    const runB = newRunId();
    const execA = newExecutionId();
    const execB = newExecutionId();
    // 两个 Run 各自出现 toolCallId 同为 tc-1-1 的调用（fake/上游均可能如此）
    for (const [runId, executionId] of [
      [runA, execA],
      [runB, execB],
    ] as const) {
      eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
      eventLog.appendRuntimeEvent(
        runtimeEvent(sessionId, runId, "tool.proposed", {
          toolCallId: "tc-1-1",
          toolName: "edit_file",
          args: { path: "a.ts" },
        })
      );
      eventLog.appendIntent(approvedIntent(runId, "tc-1-1", executionId));
      eventLog.appendRuntimeEvent(
        runtimeEvent(sessionId, runId, "tool.settled", {
          toolCallId: "tc-1-1",
          toolName: "edit_file",
          isError: false,
        })
      );
      eventLog.appendReceipt({ receipt: makeReceipt(executionId, "tc-1-1"), runId });
      eventLog.appendRuntimeEvent(
        runtimeEvent(sessionId, runId, "turn.completed", {
          stopReason: "stop",
          syntheticFailure: false,
        })
      );
      eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "run.ended", { messageCount: 0 }));
    }
    eventLog.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    assert.equal(trace.runs.length, 2);
    const [traceA, traceB] = trace.runs;
    assert.ok(traceA);
    assert.ok(traceB);
    assert.equal(traceA.runId, runA);
    assert.equal(traceB.runId, runB);
    // 各自挂各自的 intent/receipt（executionId 不串）
    assert.equal(traceA.toolCalls[0]?.intent?.executionId, execA);
    assert.equal(traceA.toolCalls[0]?.receipt?.executionId, execA);
    assert.equal(traceB.toolCalls[0]?.intent?.executionId, execB);
    assert.equal(traceB.toolCalls[0]?.receipt?.executionId, execB);
    assert.ok(traceA.toolCalls[0]?.anomalies.length === 0);
    assert.ok(traceB.toolCalls[0]?.anomalies.length === 0);

    // runId 过滤：只出一个 Run，另一个 Run 的 id 不出现
    const filtered = buildSessionTrace(materializeSession(sessionsDir, sessionId), {
      runId: runB,
    });
    assert.equal(filtered.runs.length, 1);
    assert.equal(filtered.runs[0]?.runId, runB);
    assert.equal(filtered.runs[0]?.toolCalls[0]?.intent?.executionId, execB);
  } finally {
    cleanup();
  }
});

test("D2 冷侧缺口（M4 收口决策 ③）：撕裂尾巴归属拥有文件末条记录的 Run；entry 断号按 Run 汇总", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runA = newRunId();
    const runB = newRunId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runA, "turn.started", {}));
    eventLog.appendEntry({ runSeq: 1, role: "user", runId: runA });
    eventLog.appendEntry({ runSeq: 3, role: "assistant", runId: runA });
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runA, "run.ended", { messageCount: 0 }));
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runB, "turn.started", {}));
    eventLog.close();
    appendFileSync(eventLog.path, '{"version":5,"id":"entry_', "utf8");

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId));
    assert.equal(trace.tornTail, true, "文件级事实随投影传递");
    const traceA = trace.runs.find((run) => run.runId === runA);
    const traceB = trace.runs.find((run) => run.runId === runB);
    assert.ok(traceA && traceB);
    assert.equal(traceA.tornTail, false, "runA 之后还有记录，尾巴与它无关");
    assert.equal(traceB.tornTail, true, "runB 拥有文件末条记录");
    assert.deepEqual(traceA.entryGaps, [2]);
    assert.deepEqual(traceB.entryGaps, []);
    // --run 过滤掉拥有尾巴的 Run 时，会话级 tornTail 仍如实为 true
    const onlyA = buildSessionTrace(materializeSession(sessionsDir, sessionId), { runId: runA });
    assert.equal(onlyA.tornTail, true);
    assert.equal(onlyA.runs[0]?.tornTail, false);
  } finally {
    cleanup();
  }
});
