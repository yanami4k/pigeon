// M4 S4：Replay 只读重建投影的单元测试（手写事件日志 → 冷物化 materializeSession →
// buildRunReplay）。覆盖：时间线严格按落盘顺序（治理族与运行时事件穿插、不分组不重排）、
// 待对账 intent 标注、孤儿 Receipt/Resolution 标注、撕裂尾巴传递、崩溃残留（无 run.ended）、
// Run 级四分类挂接、未知 Run 返回 null。
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
import { buildRunReplay } from "./replay.ts";

function makeEventLog(): {
  sessionsDir: string;
  sessionId: SessionId;
  eventLog: JsonlEventLog;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  return {
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

function makeReceipt(executionId: ExecutionId, toolCallId: string): Receipt {
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
  };
}

test("时间线按落盘顺序：治理族与运行时事件穿插原位呈现，正常 Run 无标注", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    const executionId = newExecutionId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.proposed", {
        toolCallId: "tc-1",
        toolName: "edit_file",
        args: { path: "a.ts" },
      })
    );
    eventLog.appendIntent(approvedIntent(runId, "tc-1", executionId));
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.settled", {
        toolCallId: "tc-1",
        toolName: "edit_file",
        isError: false,
      })
    );
    eventLog.appendReceipt({ receipt: makeReceipt(executionId, "tc-1"), runId });
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "turn.completed", {
        stopReason: "stop",
        syntheticFailure: false,
      })
    );
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "run.ended", { messageCount: 2 }));
    eventLog.close();

    const replay = buildRunReplay(materializeSession(sessionsDir, sessionId), runId);
    assert.ok(replay, "已知 Run 必须能重建");
    assert.equal(replay.sessionId, sessionId);
    assert.equal(replay.ended, true);
    assert.equal(replay.tornTail, false);
    assert.equal(replay.classification?.failure, null, "正常收尾不是失败");
    assert.deepEqual(
      replay.events.map((event) => event.record.kind),
      [
        "turn.started",
        "tool.proposed",
        "intent",
        "tool.settled",
        "receipt",
        "turn.completed",
        "run.ended",
      ],
      "时间线必须严格按落盘顺序，治理族穿插原位（与 trace 的分组视图相区别）"
    );
    for (const event of replay.events) {
      assert.deepEqual(event.annotations, [], "正常 Run 不应有异常标注");
    }
  } finally {
    cleanup();
  }
});

test("崩溃残留：ended=false、分类落未知桶、悬账 intent 标注待对账；未知 Run 返回 null", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "turn.started", {}));
    eventLog.appendRuntimeEvent(
      runtimeEvent(sessionId, runId, "tool.proposed", {
        toolCallId: "tc-9",
        toolName: "edit_file",
        args: { path: "a.ts" },
      })
    );
    eventLog.appendIntent(approvedIntent(runId, "tc-9"));
    eventLog.close();

    const replay = buildRunReplay(materializeSession(sessionsDir, sessionId), runId);
    assert.ok(replay);
    assert.equal(replay.ended, false, "无 run.ended = 崩溃残留可能");
    assert.deepEqual(replay.classification?.failure, { category: "unknown" });
    const intent = replay.events.find((event) => event.record.kind === "intent");
    assert.ok(intent);
    assert.equal(intent.annotations.length, 1);
    assert.ok(intent.annotations[0]?.includes("待对账"), "悬账 intent 必须如实标注");
    assert.ok(intent.annotations[0]?.includes("OutcomeUnknown"));

    assert.equal(
      buildRunReplay(materializeSession(sessionsDir, sessionId), newRunId()),
      null,
      "未知 Run 返回 null（由命令层响亮报错）"
    );
  } finally {
    cleanup();
  }
});

test("孤儿 Receipt/Resolution 与撕裂尾巴如实标注", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runId = newRunId();
    // 孤儿：executionId 无对应 intent/decision
    eventLog.appendReceipt({ receipt: makeReceipt(newExecutionId(), "tc-x"), runId });
    eventLog.appendResolution({
      executionId: newExecutionId(),
      toolCallId: "tc-y",
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
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runId, "run.ended", { messageCount: 0 }));
    eventLog.close();
    // 模拟进程死于写盘中途：半截末行
    appendFileSync(eventLog.path, '{"version":2,"id":"entry_', "utf8");

    const replay = buildRunReplay(materializeSession(sessionsDir, sessionId), runId);
    assert.ok(replay);
    assert.equal(replay.tornTail, true, "撕裂尾巴必须随物化结果传递到回放");
    const receipt = replay.events.find((event) => event.record.kind === "receipt");
    const resolution = replay.events.find((event) => event.record.kind === "resolution");
    assert.ok(
      receipt?.annotations.some((text) => text.includes("孤儿")),
      "孤儿 Receipt 标注"
    );
    assert.ok(
      resolution?.annotations.some((text) => text.includes("孤儿")),
      "孤儿 Resolution 标注"
    );
  } finally {
    cleanup();
  }
});

test("其他 Run 的记录不混入：runId 过滤是投影的第一域", () => {
  const { sessionsDir, sessionId, eventLog, cleanup } = makeEventLog();
  try {
    const runA = newRunId();
    const runB = newRunId();
    // 两个 Run 的记录在文件里交错（重开日志追加就会产生这种布局）
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runA, "turn.started", {}));
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runB, "turn.started", {}));
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runA, "run.ended", { messageCount: 1 }));
    eventLog.appendRuntimeEvent(runtimeEvent(sessionId, runB, "run.ended", { messageCount: 1 }));
    eventLog.close();

    const materialized = materializeSession(sessionsDir, sessionId);
    const replayA = buildRunReplay(materialized, runA);
    const replayB = buildRunReplay(materialized, runB);
    assert.deepEqual(
      replayA?.events.map((event) => event.record.kind),
      ["turn.started", "run.ended"]
    );
    assert.deepEqual(
      replayB?.events.map((event) => event.record.kind),
      ["turn.started", "run.ended"]
    );
  } finally {
    cleanup();
  }
});
