// M4 S5：session list 命令层测试（D5：列表默认安静、仅待对账突出）。
// M2 S1（决策 025）：resume 流程测试随流程迁入 application/resume.test.ts。
// M2 S4：命令层自 cli/session.ts 归位 application/session-list.ts（同决策 030 方向），
// 测试随命令层迁入；渲染口径不变。
// 覆盖：列表渲染（安静行 + 待对账突出行 + 过滤器）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import type { IntentInput } from "../state/event-log.ts";
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
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { runSessionListCommand } from "./session-list.ts";

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-cmd-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runtimeEnvelope(
  sessionId: SessionId,
  runId: RunId,
  kind: EventEnvelope["kind"],
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

function makeIntentInput(
  runId: RunId,
  toolName: string,
  executionId: ExecutionId,
  contentHashes?: IntentInput["contentHashes"]
): IntentInput {
  return {
    executionId,
    toolCallId: `toolu_${toolName}`,
    toolName,
    rawArgs: { path: "a.ts" },
    decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    runId,
    ...(contentHashes !== undefined ? { contentHashes } : {}),
  };
}

function makeReceipt(executionId: ExecutionId): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId: "toolu_x",
    approvedBy: "policy:yolo",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_001,
    finishedAt: 1_757_000_000_002,
    summary: "完成",
  };
}

// 健康会话：一轮正常工具调用（turn 起讫 + intent/receipt 配对 + run.ended）
function writeHealthySession(sessionsDir: string, toolName: string): SessionId {
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const runId = newRunId();
  const executionId = newExecutionId();
  log.appendRuntimeEvent(runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnStarted, {}));
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
    })
  );
  log.appendIntent(makeIntentInput(runId, toolName, executionId));
  log.appendReceipt({ receipt: makeReceipt(executionId), runId });
  log.appendRuntimeEvent(
    runtimeEnvelope(sessionId, runId, RuntimeEventKind.RunEnded, { messageCount: 0 })
  );
  log.close();
  return sessionId;
}

// 崩溃残留会话：intent 落盘后进程死亡（无 receipt）→ 待对账
function writeCrashedSession(
  sessionsDir: string,
  toolName: string,
  contentHashes?: IntentInput["contentHashes"]
): { sessionId: SessionId; executionId: ExecutionId } {
  const sessionId = newSessionId();
  const executionId = newExecutionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  log.appendIntent(makeIntentInput(newRunId(), toolName, executionId, contentHashes));
  log.close();
  return { sessionId, executionId };
}

test("session list：安静行（时间 + Run 数 + 会话 id），仅待对账会话有突出行，无徽章图标", () => {
  const { root, cleanup } = makeRoot();
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const crashed = writeCrashedSession(sessionsDir, "read_file");

    const output = runSessionListCommand({ root });
    // 两个会话各一行安静行（UTC 时间 + Run 数 + 短会话 id 不强制——完整 id 便于 resume 取用）
    assert.ok(output.includes(healthy));
    assert.ok(output.includes(crashed.sessionId));
    assert.match(output, /1 个 Run/);
    // 待对账突出行：逐字措辞（D5 人话 + 动作提示），且只出现在崩溃会话那一行附近
    assert.ok(output.includes("1 条待对账（上次会话异常中断，用 resume 处理）"));
    const pendingLine = output.split("\n").find((line) => line.includes("条待对账"));
    assert.ok(pendingLine !== undefined);
    assert.ok(
      !pendingLine.includes("✔") && !pendingLine.includes("⚠") && !pendingLine.includes("✖")
    );
    // 健康会话行不带待对账措辞
    const healthyLine = output.split("\n").find((line) => line.includes(healthy));
    assert.ok(healthyLine !== undefined && !healthyLine.includes("待对账"));
  } finally {
    cleanup();
  }
});

test("session list：过滤器透传（tool / class / since / until）与空目录文案", () => {
  const { root, cleanup } = makeRoot();
  try {
    const empty = runSessionListCommand({ root });
    assert.ok(empty.includes("尚无会话记录"));

    const sessionsDir = join(root, ".pigeon", "sessions");
    const healthy = writeHealthySession(sessionsDir, "edit_file");
    const crashed = writeCrashedSession(sessionsDir, "read_file");

    const byTool = runSessionListCommand({ root, filters: { tool: "read_file" } });
    assert.ok(byTool.includes(crashed.sessionId) && !byTool.includes(healthy));
    const byClass = runSessionListCommand({ root, filters: { class: "unknown" } });
    assert.ok(byClass.includes(crashed.sessionId));
    assert.ok(byClass.includes("1 条待对账"));
    const sinceFuture = runSessionListCommand({
      root,
      filters: { since: Date.now() + 86_400_000 },
    });
    assert.ok(sinceFuture.includes("尚无会话记录"));
  } finally {
    cleanup();
  }
});
