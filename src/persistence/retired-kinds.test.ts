// 退役记录种类（决策 128）：候选筛查、提炼跳过、固化升格、固化移除四种记录停写并移出记录并集。
// 旧会话文件里的这四种记录在读取边界、schema 校验之前跳过——任何版本都跳过，不算损坏，
// 不进记录集，因而也不出现在物化、trace、replay 与执行编号幂等索引里。
// 夹具：每种各取首次引入时的版本与最后写入时的 v13 各一条，外加一条形状残缺的，
// 与保留下来的记录混排在同一个会话文件里读回。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReplayCommand } from "../cli/replay.ts";
import { runTraceCommand } from "../cli/trace.ts";
import { EVENT_LOG_VERSION, RETIRED_EVENT_KINDS } from "../state/event-log.ts";
import {
  newEntryId,
  newGrantId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { JsonlEventLog, materializeSession, readEventLogFile } from "./event-log.ts";

const HASH = "a".repeat(64);

type Fixture = Record<string, unknown>;

// 每种退役记录的夹具：首次引入时的版本一条、v13 一条（phantomRunId 是只在退役记录里出现的 Run）
const RETIRED_FIXTURES: Record<
  string,
  (sessionId: SessionId, runId: RunId, phantomRunId: RunId) => Fixture[]
> = {
  "grant.promoted": (sessionId, _runId, phantomRunId) =>
    [5, 13].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 10,
      kind: "grant.promoted",
      grantId: newGrantId(),
      tool: "edit_file",
      pathPrefix: "src",
      promotedAt: 10,
    })),
  "grant.config-removed": (sessionId, _runId, phantomRunId) =>
    [5, 13].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 11,
      kind: "grant.config-removed",
      grantId: newGrantId(),
      tool: "edit_file",
      index: 0,
      removedAt: 11,
    })),
  // 筛查记录带命中项，而候选提出内嵌的扫描无命中：状态若读了它会变成扫描拒收
  "candidate.screened": (sessionId, runId) =>
    [10, 13].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 12,
      kind: "candidate.screened",
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      scannerVersion: "1",
      hits: [{ rule: "injection", detail: "命中" }],
    })),
  "distill.skipped": (sessionId, _runId, phantomRunId) =>
    [11, 13].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 13,
      kind: "distill.skipped",
      taskKey: "task_01",
      reason: "all-failed",
      attempts: [{ sessionId, runId: phantomRunId, label: "Failed" }],
    })),
};

// 保留下来的记录：一个完整 Run（开始、候选提出、结束）
function keptRecords(sessionId: SessionId, runId: RunId): Fixture[] {
  const envelope = (timestamp: number) => ({
    version: EVENT_LOG_VERSION,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp,
  });
  return [
    { ...envelope(1), kind: "turn.started", payload: {} },
    {
      ...envelope(2),
      kind: "candidate.proposed",
      candidate: {
        version: 3,
        origin: "reviewer",
        kind: "skill",
        name: "read-before-edit",
        contentHash: HASH,
        bytes: 12,
        source: {
          sessionId,
          runId,
          producerSessionId: newSessionId(),
          entryRunSeqs: [1],
          contentDigest: HASH,
        },
        summary: "改之前先读",
        strength: 0.7,
        scan: { scannerVersion: "1", hits: [] },
        createdAt: 2,
      },
      model: { provider: "p", id: "m" },
    },
    { ...envelope(3), kind: "run.ended", payload: { reason: "completed", messageCount: 0 } },
  ];
}

interface SessionFile {
  root: string;
  sessionsDir: string;
  sessionId: SessionId;
  runId: RunId;
  phantomRunId: RunId;
  cleanup: () => void;
}

// 写一个会话文件：保留记录与给定种类的退役夹具交错排布，另加一条形状残缺的退役记录
function writeSessionFile(kinds: readonly string[]): SessionFile {
  const root = mkdtempSync(join(tmpdir(), "pigeon-retired-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = newSessionId();
  const runId = newRunId();
  const phantomRunId = newRunId();
  const [started, proposed, ended] = keptRecords(sessionId, runId);
  const retired = kinds.flatMap((kind) => {
    const build = RETIRED_FIXTURES[kind];
    assert.ok(build !== undefined, `缺少 ${kind} 的夹具`);
    return [...build(sessionId, runId, phantomRunId), { version: 99, kind, broken: true }];
  });
  const lines = [started, ...retired, proposed, ended];
  writeFileSync(
    join(sessionsDir, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return {
    root,
    sessionsDir,
    sessionId,
    runId,
    phantomRunId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("退役清单恰为决策 128 的四种", () => {
  assert.deepEqual([...RETIRED_EVENT_KINDS].sort(), [
    "candidate.screened",
    "distill.skipped",
    "grant.config-removed",
    "grant.promoted",
  ]);
});

for (const kind of Object.keys(RETIRED_FIXTURES)) {
  test(`退役种类 ${kind}：旧版本与 v13 的记录读回即跳过，不算损坏，不进记录集`, () => {
    const file = writeSessionFile([kind]);
    try {
      const records = readEventLogFile(join(file.sessionsDir, `${file.sessionId}.jsonl`));
      assert.deepEqual(
        records.map((record) => record.kind),
        ["turn.started", "candidate.proposed", "run.ended"]
      );
      assert.ok(records.every((record) => record.version === EVENT_LOG_VERSION));
      const session = materializeSession(file.sessionsDir, file.sessionId);
      assert.deepEqual(session.unfinishedRuns, [], "退役记录里的 Run 不凭空成为未收尾 Run");
      // 会话仍可重新打开续写（幂等索引恢复不因退役记录失败）
      const log = new JsonlEventLog(file.sessionsDir, file.sessionId);
      log.close();
    } finally {
      file.cleanup();
    }
  });
}

test("退役记录不出现在任何视图里：trace 与 replay 都只读保留下来的记录", () => {
  const file = writeSessionFile(Object.keys(RETIRED_FIXTURES));
  try {
    const trace = runTraceCommand({ root: file.root, sessionId: file.sessionId });
    assert.ok(!trace.includes("命中"), trace);
    assert.ok(!trace.includes(file.phantomRunId), trace);
    const replay = runReplayCommand({
      root: file.root,
      sessionId: file.sessionId,
      runId: file.runId,
    });
    for (const text of ["候选筛查", "提炼跳过", "固化升格", "固化移除", "拒收"]) {
      assert.ok(!replay.includes(text), `replay 不应出现「${text}」：\n${replay}`);
    }
    assert.throws(
      () =>
        runReplayCommand({
          root: file.root,
          sessionId: file.sessionId,
          runId: file.phantomRunId,
        }),
      /该会话无 Run/
    );
  } finally {
    file.cleanup();
  }
});
