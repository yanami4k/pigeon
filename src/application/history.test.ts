// M5 S2（决策 045）：历史投影——正文、thinking、工具行、轮次与 Run 标记按落盘时序交织；
// toolResult 默认折叠；单条渲染上限；安全上限默认 500 行，超出折叠为一行提示；
// M5 前会话与正文缺失如实提示。TUI 的 /resume 与 cli 的 --with-content 共用本投影。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { DEFAULT_HISTORY_LIMIT, type HistoryLine, loadSessionHistory } from "./history.ts";
import { seedToolRun } from "./history-fixtures.ts";

function withRoot(run: (root: string, sessionsDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-history-"));
  try {
    run(root, join(root, ".pigeon", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pairs = (lines: HistoryLine[]) => lines.map((line) => [line.kind, line.text]);

test("时序交织：正文、thinking、轮次标记、工具行、折叠的 toolResult、Run 结束标记", () => {
  withRoot((root, sessionsDir) => {
    const sessionId = newSessionId();
    seedToolRun(sessionsDir, sessionId);
    assert.deepEqual(pairs(loadSessionHistory(root, sessionId)), [
      ["user", "> 把 beta 改成大写"],
      ["thinking", "~ 先确认锚点"],
      ["assistant", "我来改"],
      ["marker", "-- turn: toolUse --"],
      ["tool", '$ edit_file {"path":"a.ts"} -> ok'],
      ["toolResult", "[result] edit_file ok（7 字符，已折叠）"],
      ["assistant", "改好了"],
      ["marker", "-- turn: stop --"],
      ["marker", "== run ended | 分类：正常 =="],
    ]);
  });
});

test("安全上限：默认 500 行；超出时最早部分折叠为一行提示（去上限变红）", () => {
  withRoot((root, sessionsDir) => {
    const sessionId = newSessionId();
    seedToolRun(sessionsDir, sessionId);
    assert.equal(DEFAULT_HISTORY_LIMIT, 500);
    const full = loadSessionHistory(root, sessionId);
    const folded = loadSessionHistory(root, sessionId, { limit: 3 });
    assert.equal(folded.length, 4);
    assert.deepEqual(folded[0], { kind: "notice", text: "[更早 6 条未展开，/search 可查]" });
    assert.deepEqual(folded.slice(1), full.slice(-3));
  });
});

test("单条渲染上限：超长正文折叠并标注已截断显示", () => {
  withRoot((root, sessionsDir) => {
    const sessionId = newSessionId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendEntry({
      runSeq: 1,
      role: "user",
      runId: newRunId(),
      message: { role: "user", content: "x".repeat(50) },
    });
    log.close();
    assert.deepEqual(pairs(loadSessionHistory(root, sessionId, { entryChars: 10 })), [
      ["user", `> ${"x".repeat(10)}…（已截断显示，共 50 字符）`],
    ]);
  });
});

test("M5 前会话头部提示无正文，治理投影照画；正文缺失与未持久化的 thinking 如实提示", () => {
  withRoot((root, sessionsDir) => {
    const legacy = newSessionId();
    seedToolRun(sessionsDir, legacy, { withContent: false });
    const legacyLines = loadSessionHistory(root, legacy);
    assert.deepEqual(legacyLines[0], {
      kind: "notice",
      text: "[M5 前会话，无正文：以下只有治理投影]",
    });
    assert.ok(legacyLines.some((line) => line.text === '$ edit_file {"path":"a.ts"} -> ok'));

    const gap = newSessionId();
    const log = new JsonlEventLog(sessionsDir, gap, { content: { persistThinking: false } });
    log.appendEntry({
      runSeq: 1,
      role: "assistant",
      runId: newRunId(),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "秘密" }] },
    });
    log.close();
    assert.deepEqual(pairs(loadSessionHistory(root, gap)), [
      ["thinking", "~ thinking（未持久化，6 字节）"],
    ]);
    rmSync(JsonlEventLog.contentFilePathFor(sessionsDir, gap));
    assert.deepEqual(pairs(loadSessionHistory(root, gap)), [
      ["notice", "[正文缺失] 第 1 条 assistant（内容文件无记录或哈希不符）"],
    ]);
  });
});
