// M5 S5（决策 044）：usage 与快照摘要的投影——会话摘要算每会话总 token 与成本（会话列表呈现），
// trace 的 Run 头显示 run.started 摘要与模型请求次数，每轮显示 usage。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionListCommand } from "../application/session-list.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { summarizeSession } from "../state/session-summary.ts";
import { runTraceCommand } from "./trace.ts";

const HASH = "d".repeat(64);

function usage(input: number, output: number, cacheRead: number, total: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
  };
}

test("会话摘要合计 token 与成本并在会话列表呈现；trace Run 头显示启动快照，每轮显示 usage", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-usage-view-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    const event = (kind: string, payload: unknown): EventEnvelope => ({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind,
      payload,
    });
    log.appendObservation({
      kind: "run.started",
      runId,
      payload: {
        model: { provider: "kimi", id: "k2" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["read_file"],
        systemPromptHash: HASH,
        memory: [
          { path: ".pigeon/memory/a.md", hash: HASH, bytes: 3, truncated: false, included: true },
        ],
        skills: [],
      },
    });
    log.appendRuntimeEvent(event(RuntimeEventKind.TurnStarted, {}));
    log.appendObservation({
      kind: "llm.request",
      runId,
      payload: {
        messageCount: 1,
        roleCounts: { user: 1 },
        estimatedChars: 10,
        messagesHash: HASH,
        systemPromptHash: HASH,
      },
    });
    log.appendRuntimeEvent(
      event(RuntimeEventKind.TurnCompleted, {
        stopReason: "toolUse",
        syntheticFailure: false,
        usage: usage(120, 30, 100, 0.0031),
      })
    );
    log.appendRuntimeEvent(event(RuntimeEventKind.TurnStarted, {}));
    log.appendRuntimeEvent(
      event(RuntimeEventKind.TurnCompleted, {
        stopReason: "stop",
        syntheticFailure: false,
        usage: usage(200, 50, 0, 0.002),
      })
    );
    log.appendRuntimeEvent(event(RuntimeEventKind.RunEnded, { messageCount: 0 }));
    log.close();

    const summary = summarizeSession(
      materializeSession(sessionsDir, sessionId, { content: false })
    );
    assert.equal(summary.totalTokens, 500);
    assert.ok(Math.abs(summary.totalCost - 0.0051) < 1e-9);

    const list = runSessionListCommand({ root });
    assert.match(list, /500 tokens {2}\$0\.0051/);

    const trace = runTraceCommand({ root, sessionId });
    assert.match(
      trace,
      /启动快照：模型 kimi\/k2 ｜ 审批模式 prompt ｜ 工具 read_file ｜ Memory 1 个（注入 1） ｜ Skill 0 个 ｜ system prompt dddddddddddd ｜ 模型请求 1 次/
    );
    assert.match(
      trace,
      /第 1 轮 .*tokens 输入 120 \/ 输出 30 \/ 缓存读 100 \/ 缓存写 0 ｜ \$0\.0031/
    );
    assert.match(
      trace,
      /第 2 轮 .*tokens 输入 200 \/ 输出 50 \/ 缓存读 0 \/ 缓存写 0 ｜ \$0\.0020/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
