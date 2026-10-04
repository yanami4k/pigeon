// 快照的拍摄标记在 trace 与 replay 里（决策 350）：没拍成的快照——标了失败的、只有"拍摄中"没有下文的（进程中断）——
// 在对应的工具调用下（trace）与时间线上（replay）各显示一行；拍成的、文件没变的标记不占行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace 与 replay：失败的、拍摄中断的快照各显示一行，拍成与文件没变的不显示", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cp-marks-"));
  try {
    const s = createFixtureSession({ sessionsDir: join(root, ".pigeon", "state", "sessions") });
    const runId = s.startRun({ task: "改" });
    const mark = (toolCallId: string, runSeq: number, state: string, reason?: string) =>
      s.append({
        customType: SessionEntryType.CheckpointMark,
        data: {
          version: SESSION_ENTRY_VERSION,
          runId,
          toolCallId,
          runSeq,
          state: state as "shooting",
          ...(reason !== undefined ? { reason } : {}),
        },
      });
    // 条目号：任务 1；每次调用占助手消息与工具结果两条
    const done = s.toolTurn({ name: "run_command" });
    mark(done, 3, "shooting");
    mark(done, 3, "unchanged");
    const failed = s.toolTurn({ name: "run_command" });
    mark(failed, 5, "shooting");
    mark(failed, 5, "failed", "快照等待超时");
    const crashed = s.toolTurn({ name: "edit_file" });
    mark(crashed, 7, "shooting");
    s.endRun();
    const { sessionId } = await s.close();

    const trace = runTraceCommand({ root, sessionId });
    const traceLines = trace.split("\n").filter((line) => line.includes("代码快照："));
    assert.equal(traceLines.length, 2, trace);
    assert.match(traceLines[0] ?? "", /没有拍成.*快照等待超时/);
    assert.match(traceLines[1] ?? "", /拍摄中断/);
    // 各挂在自己的工具调用下
    assert.ok(trace.indexOf(failed) < trace.indexOf(traceLines[0] ?? ""), trace);
    assert.ok(trace.indexOf(crashed) < trace.indexOf(traceLines[1] ?? ""), trace);

    const replay = runReplayCommand({ root, runId, sessionId });
    const replayLines = replay
      .split("\n")
      .filter((line) => line.includes("pigeon.checkpoint-mark"));
    assert.equal(replayLines.length, 2, replay);
    assert.match(replayLines[0] ?? "", new RegExp(`没有拍成.*${failed}`));
    assert.match(replayLines[1] ?? "", new RegExp(`拍摄中断.*${crashed}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
