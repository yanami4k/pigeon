// trace 与 replay 的 MCP 投影（M5.7 S3，决策 052 / 053）：trace 的 Run 头列出注解与配置冲突、不可用的 server
// 与工具清单变更通知；replay 的 receipt 行给出 mcp 块摘要（参数与返回哈希、server 证据）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION } from "../state/events.ts";
import { newEntryId, newExecutionId, newReceiptId, newRunId, newSessionId } from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace Run 头列出 MCP 冲突、不可用 server 与清单变更；replay 的 receipt 行带 mcp 块摘要", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-mcp-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    eventLog.appendObservation({
      kind: "run.started",
      runId,
      payload: {
        model: { provider: "fake-provider", id: "fake-model-1" },
        policy: { allow: ["mcp__fx__echo"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["mcp__fx__echo", "mcp__fx__peek", "mcp__fx__look"],
        systemPromptHash: "0".repeat(64),
        memory: [],
        skills: [],
        mcpTools: [
          {
            name: "mcp__fx__echo",
            server: "fx",
            tool: "echo",
            configuredTier: "write",
            effectiveTier: "write",
            declaredHint: { readOnlyHint: true },
            conflict: true,
          },
          {
            name: "mcp__fx__peek",
            server: "fx",
            tool: "peek",
            configuredTier: "read",
            effectiveTier: "write",
            declaredHint: { destructiveHint: true },
            conflict: true,
          },
          {
            name: "mcp__fx__look",
            server: "fx",
            tool: "look",
            configuredTier: "read",
            effectiveTier: "read",
            declaredHint: { readOnlyHint: true },
          },
        ],
        mcpServers: [
          {
            name: "fx",
            state: "unavailable",
            restarts: 2,
            error: "连接断开",
            listChanges: [{ list: "tools", at: 5 }],
          },
        ],
      },
    });
    eventLog.appendReceipt({
      receipt: {
        version: RECEIPT_VERSION,
        id: newReceiptId(),
        executionId: newExecutionId(),
        toolCallId: "toolu_note",
        approvedBy: "human",
        executed: true,
        isError: false,
        startedAt: 1,
        finishedAt: 2,
        summary: "mcp__fx__note 执行完成",
        mcp: {
          server: "fx",
          tool: "note",
          argsHash: "a".repeat(64),
          isError: false,
          resultSummary: "noted",
          resultHash: "b".repeat(64),
          resultBytes: 42,
          truncated: false,
          serverEvidence: {
            value: { path: "x" },
            bytes: 12,
            hash: "c".repeat(64),
            truncated: false,
          },
        },
      },
      runId,
    });
    eventLog.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 3,
      kind: "run.ended",
      payload: { messageCount: 0 },
    });
    eventLog.close();

    const trace = runTraceCommand({ root, sessionId });
    assert.ok(trace.includes("MCP 工具集冲突"), trace);
    assert.ok(trace.includes("mcp__fx__echo（声明只读，配置 write，按 write）"), trace);
    assert.ok(trace.includes("mcp__fx__peek（声明 destructive，配置 read，按 write）"), trace);
    assert.ok(!trace.includes("mcp__fx__look（"), trace);
    assert.ok(trace.includes("MCP server fx 不可用"), trace);
    assert.ok(trace.includes("工具清单变更通知"), trace);

    const replay = runReplayCommand({ root, runId, sessionId });
    assert.ok(replay.includes("MCP fx/note"), replay);
    assert.ok(replay.includes(`参数 ${"a".repeat(12)}`), replay);
    assert.ok(replay.includes(`返回 ${"b".repeat(12)}（42 字节）`), replay);
    assert.ok(replay.includes(`server 证据 ${"c".repeat(12)}`), replay);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
