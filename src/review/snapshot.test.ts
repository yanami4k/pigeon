// Run 冻结快照（M6 S1，决策 064 子裁决 ⑤）：把被审的那一次 Run 物化成只读快照——
// 对话增量（上次审阅点之后的轮次加一小段前情）、Trace 投影、Receipt 摘要。
// 两级截断：单条工具结果超过 2,000 字符按头尾保留、中间标注省略字符数；
// 整份增量超过 24,000 字符从最早处丢弃并标注省略条数。省略处保留条目号，可按号回查原文。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { buildRunSnapshot, ENTRY_TEXT_MAX_CHARS, SNAPSHOT_TOTAL_MAX_CHARS } from "./snapshot.ts";

interface Fixture {
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  cleanup: () => void;
}

// 构造一个有轮次、工具调用与正文的会话；toolResultChars 控制单条工具结果的长度
function makeSession(options: { turns: number; toolResultChars: number }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-review-snapshot-"));
  const sessionsDir = join(dir, "sessions");
  const sessionId = newSessionId();
  const runId = newRunId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  let timestamp = 1;
  let runSeq = 0;
  for (let turn = 1; turn <= options.turns; turn += 1) {
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: timestamp++,
      kind: "turn.started",
      payload: {},
    });
    log.appendEntry({
      runId,
      runSeq: ++runSeq,
      role: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `第 ${turn} 轮的想法` }],
      },
    });
    const toolCallId = `tc-${turn}`;
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: timestamp++,
      kind: "tool.proposed",
      payload: { toolCallId, toolName: "read_file", args: { path: "a.ts" } },
    });
    log.appendEntry({
      runId,
      runSeq: ++runSeq,
      role: "toolResult",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "read_file",
        content: [{ type: "text", text: `T${turn}`.padEnd(options.toolResultChars, "x") }],
        isError: false,
      },
    });
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: timestamp++,
      kind: "tool.settled",
      payload: { toolCallId, toolName: "read_file", isError: false },
    });
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: timestamp++,
      kind: "turn.completed",
      payload: { stopReason: "toolUse", syntheticFailure: false },
    });
  }
  log.close();
  return {
    sessionsDir,
    sessionId,
    runId,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("冻结快照：含被审 Run 的对话条目、Trace 投影与 Receipt 摘要，条目号可回查", () => {
  const fixture = makeSession({ turns: 2, toolResultChars: 50 });
  try {
    const snapshot = buildRunSnapshot({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    assert.equal(snapshot.sessionId, fixture.sessionId);
    assert.equal(snapshot.runId, fixture.runId);
    assert.equal(snapshot.turns, 2, "轮次数取自 turn.completed");
    assert.equal(snapshot.entries.length, 4, "两轮各一条 assistant 与一条工具结果");
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.runSeq),
      [1, 2, 3, 4],
      "条目号即 Run 内的 runSeq，省略与回查都按它定位"
    );
    assert.equal(snapshot.toolCalls.length, 2, "Trace 投影给出本 Run 的工具调用");
    assert.equal(snapshot.toolCalls[0]?.toolName, "read_file");
    assert.equal(snapshot.omittedEntries, 0);
    assert.equal(snapshot.omittedChars, 0);
  } finally {
    fixture.cleanup();
  }
});

test("单条工具结果超限：头尾保留、中间标注省略字符数，条目号不变", () => {
  const oversize = ENTRY_TEXT_MAX_CHARS * 2;
  const fixture = makeSession({ turns: 1, toolResultChars: oversize });
  try {
    const snapshot = buildRunSnapshot({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    const toolEntry = snapshot.entries.find((entry) => entry.role === "toolResult");
    assert.ok(toolEntry, "工具结果条目在场");
    assert.equal(toolEntry.truncated, true);
    assert.ok(
      toolEntry.text.length <= ENTRY_TEXT_MAX_CHARS + 80,
      `截断后长度受控，实际 ${toolEntry.text.length}`
    );
    assert.ok(
      /省略 \d+ 字符/.test(toolEntry.text),
      `中间标注省略字符数，实际：${toolEntry.text.slice(0, 200)}`
    );
    assert.ok(toolEntry.text.startsWith("T1"), "头部保留");
    assert.ok(toolEntry.text.endsWith("x"), "尾部保留");
    assert.equal(toolEntry.runSeq, 2, "截断不改变条目号");
  } finally {
    fixture.cleanup();
  }
});

test("整份增量超限：从最早处丢弃并标注省略条数与字符数，保留最近的条目", () => {
  // 每轮两条正文，单条约 1,800 字符：约 14 轮即超过整份上限
  const fixture = makeSession({ turns: 20, toolResultChars: 1800 });
  try {
    const snapshot = buildRunSnapshot({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
    });
    const total = snapshot.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    assert.ok(
      total <= SNAPSHOT_TOTAL_MAX_CHARS,
      `整份增量受上限约束，实际 ${total} > ${SNAPSHOT_TOTAL_MAX_CHARS}`
    );
    assert.ok(snapshot.omittedEntries > 0, "从最早处丢弃的条数如实标注");
    assert.ok(snapshot.omittedChars > 0, "丢弃的字符数如实标注");
    const first = snapshot.entries[0];
    assert.ok(first && first.runSeq > 1, "丢弃的是最早的条目，保留最近的");
    assert.equal(snapshot.entries.at(-1)?.runSeq, 40, "最后一条仍是最新条目（20 轮 × 2 条）");
  } finally {
    fixture.cleanup();
  }
});

test("增量起点：只取上次审阅点之后的条目，另带一小段前情", () => {
  const fixture = makeSession({ turns: 6, toolResultChars: 40 });
  try {
    const snapshot = buildRunSnapshot({
      sessionsDir: fixture.sessionsDir,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      sinceRunSeq: 8,
    });
    assert.ok(
      snapshot.entries.every((entry) => entry.runSeq > 4),
      "上次审阅点之前的条目不进快照（前情除外）"
    );
    assert.ok(
      snapshot.entries.some((entry) => entry.runSeq <= 8),
      "带一小段前情：审阅点之前保留少量条目"
    );
    assert.equal(snapshot.sinceRunSeq, 8);
  } finally {
    fixture.cleanup();
  }
});
