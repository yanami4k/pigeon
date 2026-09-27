// M5 S1（决策 037，按 012 / 021 口径）：entry 有 contentHash 而正文缺失时，trace、replay 两处视图如实标注。
// 续跑不再汇总旧账本的落盘缺口（账本重构 183：续跑读新会话存储、还原对话上下文），原 resume 一处随之去掉。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("正文缺失缺口在 trace、replay 两处可见", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-content-gap-"));
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
    log.appendEntry({ runSeq: 1, role: "user", runId, message: { role: "user", content: "问" } });
    log.appendRuntimeEvent(event(RuntimeEventKind.TurnStarted, {}));
    log.appendEntry({
      runSeq: 2,
      role: "assistant",
      runId,
      message: { role: "assistant", content: [{ type: "text", text: "答" }] },
    });
    log.appendRuntimeEvent(
      event(RuntimeEventKind.TurnCompleted, { stopReason: "stop", syntheticFailure: false })
    );
    log.appendRuntimeEvent(event(RuntimeEventKind.RunEnded, { messageCount: 2 }));
    log.close();
    // 删掉第 2 条的内容记录：entry 仍回指，正文不在
    const contentPath = JsonlEventLog.contentFilePathFor(sessionsDir, sessionId);
    const [first] = readFileSync(contentPath, "utf8").split("\n");
    writeFileSync(contentPath, `${first}\n`);

    const trace = runTraceCommand({ root, sessionId });
    assert.match(trace, /消息正文缺失 1 条（第 2 条内容文件无记录）/);
    assert.match(trace, /落盘缺口 1 处/);

    const replay = runReplayCommand({ root, runId, sessionId });
    assert.match(replay, /标注：消息正文缺失：内容文件无该 entry 的记录/);
    assert.match(replay, /消息正文缺失 1 条（第 2 条内容文件无记录）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
