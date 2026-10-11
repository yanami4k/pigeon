// M5 S2（决策 045）：cli trace 与 replay 的带正文开关——默认关，
// 打开后正文与 thinking 按消息呈现，措辞与 TUI 历史投影同一份。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { seedToolRun } from "../application/history-fixtures.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace / replay 默认不带正文；--with-content 打开后呈现正文与 thinking", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-content-view-"));
  try {
    const sessionId = newSessionId();
    const runId = await seedToolRun(join(root, ".pigeon", "state", "sessions"), sessionId);

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

test("工具结果里的图片块（决策 414）：trace 与 replay 带正文时照常折叠并注明图片张数，不出 base64", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-content-view-image-"));
  try {
    const sessionId = newSessionId();
    const session = createFixtureSession({
      sessionsDir: join(root, ".pigeon", "state", "sessions"),
      sessionId,
    });
    const runId = session.startRun({ task: "看图" });
    session.assistant({ toolCalls: [{ name: "read_file", args: { path: "a.png" }, id: "tc-1" }] });
    const data = Buffer.from("not really a png").toString("base64");
    session.toolResult({
      toolCallId: "tc-1",
      toolName: "read_file",
      text: "[a.png] 图片 PNG 3×2，16 字节",
      images: [{ data, mimeType: "image/png" }],
    });
    session.assistant({ text: "看到了" });
    session.endRun();
    await session.close();
    for (const out of [
      runReplayCommand({ root, runId, sessionId, withContent: true }),
      runTraceCommand({ root, sessionId, withContent: true }),
    ]) {
      assert.match(out, /\[result\] read_file ok（\d+ 字符，1 张图片，已折叠）/);
      assert.ok(!out.includes(data));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
