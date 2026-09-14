// M5 S2（决策 045）：cli trace 与 replay 的带正文开关——默认关（治理视图不变），
// 打开后正文与 thinking 按 entry 呈现，措辞与 TUI 历史投影同一份。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedToolRun } from "../application/history-fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace / replay 默认不带正文；--with-content 打开后呈现正文与 thinking", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-content-view-"));
  try {
    const sessionId = newSessionId();
    const runId = seedToolRun(join(root, ".pigeon", "sessions"), sessionId);

    const replayPlain = runReplayCommand({ root, runId, sessionId });
    assert.doesNotMatch(replayPlain, /我来改/);
    const replayContent = runReplayCommand({ root, runId, sessionId, withContent: true });
    assert.match(replayContent, /正文：我来改/);
    assert.match(replayContent, /正文：~ 先确认锚点/);
    assert.match(replayContent, /正文：\[result\] edit_file ok/);

    const tracePlain = runTraceCommand({ root, sessionId });
    assert.doesNotMatch(tracePlain, /改好了/);
    const traceContent = runTraceCommand({ root, sessionId, withContent: true });
    assert.match(traceContent, /正文：> 把 beta 改成大写/);
    assert.match(traceContent, /正文：改好了/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
