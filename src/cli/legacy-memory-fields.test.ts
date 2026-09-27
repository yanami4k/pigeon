// 结构化记忆删除（决策 174）只停写、不改读：旧会话 run.started 里的结构化记忆留痕与这一步起点照常物化读出，
// 会话列表、trace 与 replay 照常出视图、不报错
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

test("旧会话里带结构化记忆留痕与这一步起点的 run.started：照常读出，会话列表、trace 与 replay 照常出视图", () => {
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

    // 视图里的编号截短显示：按前 12 个字符认
    const payload = materializeSession(sessionsDir, sessionId).runStarteds[0]?.payload;
    assert.deepEqual(payload?.structuredMemory, legacy);
    assert.deepEqual(payload?.stepStart, stepStart);
    assert.match(runSessionListCommand({ root, filters: {} }), new RegExp(sessionId.slice(0, 12)));
    assert.match(
      runTraceCommand({ root, sessionId, withContent: false }),
      new RegExp(runId.slice(0, 12))
    );
    assert.match(
      runReplayCommand({ root, runId, sessionId, withContent: false }),
      new RegExp(runId.slice(0, 12))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
