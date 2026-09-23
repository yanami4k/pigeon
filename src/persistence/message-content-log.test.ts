// M5 S1（决策 037 / 044 / 045）：旁置内容文件与 Event Log v6 的存储层测试。
// 覆盖：写序先内容后 entry（崩溃点）、内容写失败 entry 照写并留缺口、哈希不符缺口、
// 内容文件撕裂尾巴容忍、会话列表不把内容文件当会话、v5 旧记录读路径、usage 与新观察族
// schema 往返、会话列表冷路径不读内容文件。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_LOG_VERSION, type EventRecord } from "../state/event-log.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { hashContentBlocks, sha256Hex } from "../state/message-content.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import {
  JsonlEventLog,
  listSessionIds,
  materializeSession,
  readEventLogFile,
  readMessageContentFileDetailed,
} from "./event-log.ts";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-content-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function envelope(
  sessionId: SessionId,
  runId: RunId,
  kind: string,
  payload: unknown
): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp: 1_757_000_000_000,
    kind,
    payload,
  };
}

// 写盘探针：按调用序计数，第 failOn 次写入抛错（模拟进程死于该次写盘，或磁盘写失败）
function faultyIo(failOn: number, mode: "crash-once" | "fail-once") {
  let calls = 0;
  let crashed = false;
  return {
    write(fd: number, data: string): void {
      calls += 1;
      if (crashed) {
        throw new Error("进程已死：崩溃后不再有任何写盘");
      }
      if (calls === failOn) {
        if (mode === "crash-once") {
          crashed = true;
        }
        throw new Error(`模拟第 ${failOn} 次写盘失败`);
      }
      appendFileSync(fd, data);
    },
  };
}

test("appendEntry 携带消息：内容文件与 entry 同键落盘，entry.contentHash 回指内容记录，Event Log 不含正文", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const entry = log.appendEntry({
      runSeq: 1,
      role: "user",
      runId,
      message: { role: "user", content: "你好，改一下 a.ts" },
    });
    log.close();

    assert.match(entry.contentHash ?? "", /^[0-9a-f]{64}$/);
    const contentPath = JsonlEventLog.contentFilePathFor(dir, sessionId);
    assert.equal(contentPath, join(dir, `${sessionId}.messages.jsonl`));
    const { records, tornTail } = readMessageContentFileDetailed(contentPath);
    assert.equal(tornTail, false);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record?.entryId, entry.id);
    assert.equal(record?.runId, runId);
    assert.equal(record?.runSeq, 1);
    assert.equal(record?.role, "user");
    assert.equal(record?.contentHash, entry.contentHash);
    assert.deepEqual(record?.blocks, [
      { type: "text", text: "你好，改一下 a.ts", truncated: false },
    ]);
    // 治理日志保持小：正文只在旁置内容文件里
    assert.ok(!readFileSync(log.path, "utf8").includes("改一下"));
    assert.deepEqual(materializeSession(dir, sessionId).contentGaps, []);
  });
});

test("写序先内容后 entry：死于两次写盘之间 → 内容在、entry 缺，冷侧不报正文缺失（颠倒写序变红）", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    // 第 1 次写 = 内容记录，第 2 次写 = entry：第 2 次写盘时进程死亡
    const log = new JsonlEventLog(dir, sessionId, { io: faultyIo(2, "crash-once") });
    assert.throws(() =>
      log.appendEntry({ runSeq: 1, role: "user", runId, message: { role: "user", content: "甲" } })
    );
    log.close();

    const content = readMessageContentFileDetailed(
      JsonlEventLog.contentFilePathFor(dir, sessionId)
    );
    assert.equal(content.records.length, 1, "内容记录必须先于 entry 落盘");
    assert.equal(readEventLogFile(log.path).length, 0);
    const materialized = materializeSession(dir, sessionId);
    // entry 缺失由 entry 断号判据负责；内容先行保证不会出现"entry 回指一条从未写出的正文"
    assert.deepEqual(materialized.contentGaps, []);
  });
});

test("内容写失败：entry 照写并回指，冷侧派生正文缺失缺口，写失败原样上抛（供 listenerErrors 留证）", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId, { io: faultyIo(1, "fail-once") });
    assert.throws(
      () =>
        log.appendEntry({
          runSeq: 1,
          role: "assistant",
          runId,
          message: { role: "assistant", content: [{ type: "text", text: "乙" }] },
        }),
      /模拟第 1 次写盘失败/
    );
    log.close();

    const entries = readEventLogFile(log.path).filter(
      (record): record is Extract<EventRecord, { kind: "entry" }> => record.kind === "entry"
    );
    assert.equal(entries.length, 1);
    assert.match(entries[0]?.contentHash ?? "", /^[0-9a-f]{64}$/);
    const materialized = materializeSession(dir, sessionId);
    assert.deepEqual(materialized.contentGaps, [
      { runId, entryId: entries[0]?.id, runSeq: 1, reason: "missing" },
    ]);
  });
});

test("正文被改动：内容记录在但重算哈希与 entry 回指不符 → 哈希不符缺口（去哈希比对变红）", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const entry = log.appendEntry({
      runSeq: 1,
      role: "user",
      runId,
      message: { role: "user", content: "原始正文" },
    });
    log.close();
    const contentPath = JsonlEventLog.contentFilePathFor(dir, sessionId);
    // 篡改正文但保留记录里的 contentHash 字段：只有重算才能识破
    writeFileSync(contentPath, readFileSync(contentPath, "utf8").replace("原始正文", "篡改正文"));

    assert.deepEqual(materializeSession(dir, sessionId).contentGaps, [
      { runId, entryId: entry.id, runSeq: 1, reason: "mismatch" },
    ]);
  });
});

test("内容文件撕裂尾巴与中段坏行：容忍不抛，坏行计数，对应 entry 落正文缺失缺口", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const first = log.appendEntry({
      runSeq: 1,
      role: "user",
      runId,
      message: { role: "user", content: "一" },
    });
    const second = log.appendEntry({
      runSeq: 2,
      role: "user",
      runId,
      message: { role: "user", content: "二" },
    });
    log.close();
    const contentPath = JsonlEventLog.contentFilePathFor(dir, sessionId);
    const lines = readFileSync(contentPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    // 第二条记录改成坏行（中段），末尾追加半截记录（撕裂写）
    writeFileSync(contentPath, `${lines[0]}\n{"version":1,"bad"\n{"version":1,"sessionId":"sess_`);

    const detailed = readMessageContentFileDetailed(contentPath);
    assert.equal(detailed.records.length, 1);
    assert.equal(detailed.records[0]?.entryId, first.id);
    assert.equal(detailed.tornTail, true);
    assert.equal(detailed.invalidLines, 1);
    assert.deepEqual(materializeSession(dir, sessionId).contentGaps, [
      { runId, entryId: second.id, runSeq: 2, reason: "missing" },
    ]);
  });
});

test("会话列表不把内容文件当会话；会话列表冷路径可跳过内容文件（content:false 不派生正文缺口）", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    log.appendEntry({ runSeq: 1, role: "user", runId, message: { role: "user", content: "丙" } });
    log.close();
    assert.deepEqual(listSessionIds(dir), [sessionId]);
    rmSync(JsonlEventLog.contentFilePathFor(dir, sessionId));
    assert.equal(materializeSession(dir, sessionId).contentGaps.length, 1);
    assert.deepEqual(materializeSession(dir, sessionId, { content: false }).contentGaps, []);
  });
});

test("v5 事件文件读路径迁移到 v6：无 contentHash 的 entry 合法（M5 前会话），不派生正文缺口", () => {
  withDir((dir) => {
    assert.equal(EVENT_LOG_VERSION, 15);
    const sessionId = newSessionId();
    const runId = newRunId();
    const v5Entry = {
      version: 5,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind: "entry",
      runSeq: 1,
      role: "user",
    };
    const v5Completed = {
      ...envelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
        stopReason: "stop",
        syntheticFailure: false,
      }),
      version: 5,
    };
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify(v5Entry)}\n${JSON.stringify(v5Completed)}\n`
    );
    const records = readEventLogFile(join(dir, `${sessionId}.jsonl`));
    assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
    const materialized = materializeSession(dir, sessionId);
    assert.equal(materialized.entries[0]?.contentHash, undefined);
    assert.deepEqual(materialized.contentGaps, []);
  });
});

test("turn.completed 携带 usage 往返；run.started / llm.request / skill.loaded 观察族 schema 往返并分拣", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    const usage = {
      input: 120,
      output: 30,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 250,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
    };
    log.appendRuntimeEvent(
      envelope(sessionId, runId, RuntimeEventKind.TurnCompleted, {
        stopReason: "stop",
        syntheticFailure: false,
        usage,
      })
    );
    const hash = sha256Hex("system prompt");
    const base = {
      version: EVENT_LOG_VERSION,
      sessionId,
      runId,
      timestamp: 1_757_000_000_001,
    } as const;
    log.appendRecord({
      ...base,
      id: newEntryId(),
      kind: "run.started",
      payload: {
        model: { provider: "kimi", id: "k2" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["read_file"],
        systemPromptHash: hash,
        memory: [
          { path: ".pigeon/memory/a.md", hash, bytes: 12, truncated: false, included: true },
        ],
        skills: [
          {
            name: "deploy",
            path: ".pigeon/skills/deploy",
            files: [{ path: "SKILL.md", hash, bytes: 30 }],
          },
        ],
      },
    });
    log.appendRecord({
      ...base,
      id: newEntryId(),
      kind: "llm.request",
      payload: {
        messageCount: 3,
        roleCounts: { user: 1, assistant: 1, toolResult: 1 },
        estimatedChars: 420,
        messagesHash: hashContentBlocks([]),
        systemPromptHash: hash,
      },
    });
    log.appendRecord({
      ...base,
      id: newEntryId(),
      kind: "skill.loaded",
      payload: { name: "deploy", resourcePath: "SKILL.md", hash, bytes: 30, truncated: false },
    });
    log.close();

    const materialized = materializeSession(dir, sessionId);
    const completed = materialized.runtimeEvents.find((event) => event.kind === "turn.completed");
    assert.deepEqual(
      completed?.kind === "turn.completed" ? completed.payload.usage : undefined,
      usage
    );
    assert.equal(materialized.runStarteds.length, 1);
    assert.equal(materialized.llmRequests.length, 1);
    assert.equal(materialized.skillLoadeds.length, 1);
    // 观察族不混入运行时事件分拣（分类判据只看五种归一化事件）
    assert.ok(
      materialized.runtimeEvents.every((event) =>
        ["turn.started", "turn.completed", "tool.proposed", "tool.settled", "run.ended"].includes(
          event.kind
        )
      )
    );
  });
});
