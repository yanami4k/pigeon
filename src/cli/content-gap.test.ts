// M5 S1（决策 037，按 012 / 021 口径）：entry 有 contentHash 而正文缺失时，resume 如实标注，有缺口不说
// "证据链完整"。trace 与 replay 改读新会话存储后不再有正文缺口这一诊断（新存储存完整消息，181 去掉断号与缺口诊断）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runResumeFlow } from "../application/resume.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";

test("正文缺失缺口在 resume 可见", async () => {
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

    const written: string[] = [];
    await runResumeFlow({
      root,
      sessionId,
      ask: async () => null,
      write: (text) => written.push(text),
      enterRepl: async () => {},
    });
    const output = written.join("");
    assert.match(output, /消息正文缺失：1 条/);
    assert.doesNotMatch(output, /证据链完整/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
