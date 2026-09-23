// 退役记录种类：旧会话文件里的退役记录在读取边界、schema 校验之前跳过——任何版本都跳过，不算损坏，
// 不进记录集，因而也不出现在物化、trace、replay 与执行编号幂等索引里；旧会话文件不改写。
// - 决策 128：候选筛查、提炼跳过、固化升格、固化移除四种；
// - 决策 137 / 158：第一版学习闭环退役——候选提出、候选验证、候选决定、候选激活、审阅跳过、审阅结果不可解析六种。
// 夹具：每种各取首次引入时的旧版本一条与较新的一条（决策 128 四种取最后写入时的 v13，决策 137 六种取当前版本），
// 外加一条形状残缺的，与保留下来的记录混排在同一个会话文件里读回。
// 保留下来的记录里有一条带旧审阅配置字段的 v15 run.started：该字段已从 schema 删除（决策 137），
// run.started 载荷是非严格对象，读取不受影响。
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

// 候选提出内嵌的候选：v10 时为 v2 形状（产出会话字段还是旧名），之后为 v3 形状
function embeddedCandidate(version: number, sessionId: SessionId, runId: RunId): Fixture {
  const producer = newSessionId();
  return {
    version: version <= 10 ? 2 : 3,
    origin: "reviewer",
    kind: "skill",
    name: "read-before-edit",
    contentHash: HASH,
    bytes: 12,
    source: {
      sessionId,
      runId,
      ...(version <= 10 ? { reviewSessionId: producer } : { producerSessionId: producer }),
      entryRunSeqs: [1],
      contentDigest: HASH,
    },
    summary: "改之前先读",
    strength: 0.7,
    scan: { scannerVersion: "1", hits: [{ rule: "injection", detail: "命中" }] },
    createdAt: 2,
  };
}

// 每种退役记录的夹具（phantomRunId 是只在退役记录里出现的 Run）
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
  // 决策 137 / 158：第一版学习闭环六种。信封 Run 一律用只在退役记录里出现的 Run——
  // 读回后若它成了未收尾 Run 或出现在视图里，即说明退役记录漏进了记录集
  "candidate.proposed": (sessionId, _runId, phantomRunId) =>
    [10, EVENT_LOG_VERSION].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 14,
      kind: "candidate.proposed",
      candidate: embeddedCandidate(version, sessionId, phantomRunId),
      model: { provider: "p", id: "m" },
      usage: { turns: 1, totalTokens: 100 },
    })),
  "candidate.verified": (sessionId, _runId, phantomRunId) =>
    [12, EVENT_LOG_VERSION].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 15,
      kind: "candidate.verified",
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      conclusion: "passed",
      n: 5,
      effectThreshold: 0.4,
      positiveDelta: 0.6,
      negativeDelta: 0,
      arms: [
        {
          arm: "failed-with",
          runs: 5,
          passes: 4,
          passRate: 0.8,
          passAtK: [0.8, 1, 1, 1, 1],
          passPowK: [0.8, 0.6, 0.5, 0.4, 0.3],
          wilson: { low: 0.4, high: 0.9 },
        },
      ],
      runs: [
        {
          arm: "failed-with",
          index: 1,
          sessionId: newSessionId(),
          governanceRoot: "/w",
          verdict: "pass",
          status: "completed",
          turns: 3,
          totalTokens: 100,
          durationMs: 10,
        },
      ],
      environment: {
        model: { provider: "p", id: "m", thinkingLevel: "off" },
        harness: { commit: "abc1234", dirty: false },
        runtime: { node: "v24", platform: "win32" },
        budget: { maxTurns: 10 },
        verify: { command: "npm test", timeoutMs: 1000 },
        experienceSetHash: HASH,
        experiences: [
          {
            kind: "skill",
            name: "read-before-edit",
            contentHash: HASH,
            bytes: 12,
            candidate: true,
          },
        ],
      },
      verifiedAt: 15,
    })),
  "candidate.decided": (sessionId, _runId, phantomRunId) =>
    [12, EVENT_LOG_VERSION].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 16,
      kind: "candidate.decided",
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      action: "approve",
      reason: "回放通过",
      reasonSource: "human",
      verification: { recordId: newEntryId(), conclusion: "passed" },
      decidedAt: 16,
    })),
  "candidate.activated": (sessionId, _runId, phantomRunId) =>
    [12, EVENT_LOG_VERSION].map((version) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 17,
      kind: "candidate.activated",
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: HASH,
      path: ".pigeon/skills/read-before-edit/SKILL.md",
      activatedHash: HASH,
      unverified: false,
      decisionId: newEntryId(),
      activatedAt: 17,
    })),
  "review.skipped": (sessionId, _runId, phantomRunId) => [
    {
      version: 10,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 18,
      kind: "review.skipped",
      payload: { trigger: "turns" },
    },
    {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 18,
      kind: "review.skipped",
      payload: { trigger: "run-end", reason: "exit" },
    },
  ],
  "review.unparsable": (sessionId, _runId, phantomRunId) => [
    {
      version: 10,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 19,
      kind: "review.unparsable",
      payload: { reviewSessionId: newSessionId(), reason: "审阅没有交回结构化结果" },
    },
    {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId,
      runId: phantomRunId,
      timestamp: 19,
      kind: "review.unparsable",
      payload: { producerSessionId: newSessionId(), reason: "审阅没有交回结构化结果" },
    },
  ],
};

// 保留下来的记录：一个完整 Run（v15 的 run.started 带旧审阅配置字段、开始一轮、结束）
function keptRecords(sessionId: SessionId, runId: RunId): Fixture[] {
  const envelope = (timestamp: number, version = EVENT_LOG_VERSION) => ({
    version,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp,
  });
  return [
    {
      ...envelope(1, 15),
      kind: "run.started",
      payload: {
        model: { provider: "p", id: "m", thinkingLevel: "off" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["read_file"],
        systemPromptHash: HASH,
        memory: [],
        skills: [],
        review: { enabled: true, everyTurns: 4 },
      },
    },
    { ...envelope(2), kind: "turn.started", payload: {} },
    { ...envelope(3), kind: "run.ended", payload: { reason: "completed", messageCount: 0 } },
  ];
}

const KEPT_KINDS = ["run.started", "turn.started", "run.ended"];

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
  const [started, turn, ended] = keptRecords(sessionId, runId);
  const retired = kinds.flatMap((kind) => {
    const build = RETIRED_FIXTURES[kind];
    assert.ok(build !== undefined, `缺少 ${kind} 的夹具`);
    return [...build(sessionId, runId, phantomRunId), { version: 99, kind, broken: true }];
  });
  const lines = [started, ...retired, turn, ended];
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

test("退役清单恰为决策 128 的四种加决策 137 的六种", () => {
  assert.deepEqual([...RETIRED_EVENT_KINDS].sort(), [
    "candidate.activated",
    "candidate.decided",
    "candidate.proposed",
    "candidate.screened",
    "candidate.verified",
    "distill.skipped",
    "grant.config-removed",
    "grant.promoted",
    "review.skipped",
    "review.unparsable",
  ]);
  assert.deepEqual(
    Object.keys(RETIRED_FIXTURES).sort(),
    [...RETIRED_EVENT_KINDS].sort(),
    "每种退役记录都有夹具"
  );
});

for (const kind of Object.keys(RETIRED_FIXTURES)) {
  test(`退役种类 ${kind}：旧版本与较新版本的记录读回即跳过，不算损坏，不进记录集`, () => {
    const file = writeSessionFile([kind]);
    try {
      const records = readEventLogFile(join(file.sessionsDir, `${file.sessionId}.jsonl`));
      assert.deepEqual(
        records.map((record) => record.kind),
        KEPT_KINDS
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

test("run.started 的审阅配置字段已删除：带该字段的旧记录照常读回，模型、策略等其余字段不变", () => {
  const file = writeSessionFile([]);
  try {
    const session = materializeSession(file.sessionsDir, file.sessionId);
    const started = session.runStarteds[0];
    assert.ok(started !== undefined, "v15 的 run.started 读回");
    assert.equal(started.version, EVENT_LOG_VERSION);
    assert.equal(started.payload.model.id, "m");
    assert.deepEqual(started.payload.policy.allow, ["read_file"]);
  } finally {
    file.cleanup();
  }
});

test("退役记录不出现在任何视图里：trace 与 replay 都只读保留下来的记录", () => {
  const file = writeSessionFile(Object.keys(RETIRED_FIXTURES));
  try {
    const trace = runTraceCommand({ root: file.root, sessionId: file.sessionId });
    for (const text of ["命中", "候选", "审阅", "不可解析", file.phantomRunId]) {
      assert.ok(!trace.includes(text), `trace 不应出现「${text}」：\n${trace}`);
    }
    const replay = runReplayCommand({
      root: file.root,
      sessionId: file.sessionId,
      runId: file.runId,
    });
    for (const text of [
      "候选筛查",
      "提炼跳过",
      "固化升格",
      "固化移除",
      "拒收",
      "候选提出",
      "候选验证",
      "候选决定",
      "候选激活",
      "审阅跳过",
      "不可解析",
    ]) {
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
