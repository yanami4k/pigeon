// 结构化记忆删除（决策 174）只停写、不改读：旧会话 run.started 里的结构化记忆留痕与这一步起点照常物化读出。
// 会话列表、trace 与 replay 改读新会话存储后不读旧格式（187）：这类旧会话在列表里只计入提示行，trace 与 replay
// 说明它只在旧账本里，不报"会话不存在"
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionListCommand } from "../application/session-list.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("旧会话里带结构化记忆留痕与这一步起点的 run.started：照常物化读出；显示读者只给旧会话提示", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-legacy-memory-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const legacy = {
      enabled: true,
      selection: "auto" as const,
      opening: ["mem_1"],
      openingBlocked: ["mem_9"],
      repair: ["mem_2"],
    };
    const stepStart = { commit: "a".repeat(40), baseCommit: "b".repeat(40) };
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendObservation({
      kind: "run.started",
      runId,
      payload: {
        model: { provider: "p", id: "m", thinkingLevel: "off" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "yolo" },
        advertisedTools: ["read_file"],
        systemPromptHash: "c".repeat(64),
        memory: [],
        skills: [],
        structuredMemory: legacy,
        stepStart,
      },
    });
    log.appendEntry({
      runId,
      runSeq: 1,
      role: "user",
      message: { role: "user", content: "修好它" },
    });
    log.close();

    const payload = materializeSession(sessionsDir, sessionId).runStarteds[0]?.payload;
    assert.deepEqual(payload?.structuredMemory, legacy);
    assert.deepEqual(payload?.stepStart, stepStart);
    assert.match(
      runSessionListCommand({ root, filters: {} }),
      /另有 1 个会话创建于新会话存储启用之前/
    );
    assert.throws(
      () => runTraceCommand({ root, sessionId, withContent: false }),
      /创建于新会话存储启用之前，只在旧账本里/
    );
    assert.throws(
      () => runReplayCommand({ root, runId, sessionId, withContent: false }),
      /创建于新会话存储启用之前，只在旧账本里/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
