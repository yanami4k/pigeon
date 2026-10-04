// trace 与 replay 显示撞上限续跑与流式重复检测命中（决策 367）：各一行，带续跑次数与来由、判据、周期、重复次数与掐断与否
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace 与 replay：续跑与重复检测命中各显示一行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-runaway-display-"));
  try {
    const s = createFixtureSession({ sessionsDir: sessionsDirOf(root) });
    const runId = s.startRun({ task: "做事" });
    s.writer.append({
      customType: SessionEntryType.Repetition,
      data: {
        version: 1,
        runId,
        mode: "abort",
        criterion: "cycle",
        channel: "text",
        periodChars: 7,
        repeats: 41,
        startChar: 8,
        atChar: 300,
        detectedAt: 1,
      },
    });
    s.writer.append({
      customType: SessionEntryType.Continuation,
      data: { version: 1, runId, cause: "repetition", attempt: 1, consecutive: 1, continuedAt: 2 },
    });
    s.user("提示");
    s.assistant({ text: "改好了" });
    s.endRun();
    const { sessionId } = await s.close();
    for (const output of [
      runTraceCommand({ root, sessionId }),
      runReplayCommand({ root, runId, sessionId }),
    ]) {
      const lines = output.split("\n");
      assert.equal(lines.filter((line) => /续跑第 1 次：.*重复检测/.test(line)).length, 1);
      assert.equal(
        lines.filter((line) => /重复检测命中：逐字周期.*7.*41.*已掐断/.test(line)).length,
        1
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
