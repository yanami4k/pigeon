// EpisodeBuilder（M7 S2，决策 070 / 073；ROADMAP §M7）：
// - 同任务比对取尝试会话的首个 Run，恢复后追加的 Run 不计入；
// - 每侧只取一个进对比（成功侧取总轮数最少，失败侧取最早收尾），其余尝试只记在 others 里；放弃、基础设施错误与未知不进对比；
// - 全成功、全失败、凑不齐两侧时给出跳过原因；
// - 分叉取分叉点到叶子的路径，共享前缀单独产出、只算一次；
// - Run 内局部对只取理由来源为人写的拒绝，与域错误后紧跟的成功重试。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildForkGroup,
  buildTaskAttempt,
  collectLocalPairs,
  firstRunOf,
  selectContrast,
} from "./episode.ts";
import type { EventRecord } from "./event-log.ts";
import {
  newEntryId,
  newExecutionId,
  newRunId,
  newSessionId,
  type RunId,
  type SessionId,
} from "./ids.ts";
import { type MaterializedSession, materializeRecords } from "./materialize.ts";

const HASH = "0".repeat(64);

class Ledger {
  readonly sessionId: SessionId = newSessionId();
  readonly records: EventRecord[] = [];
  #clock = 0;

  add(record: Record<string, unknown>, runId?: RunId): void {
    this.#clock += 1;
    this.records.push({
      version: 11,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: this.#clock,
      ...record,
    } as EventRecord);
  }

  // 一次 Run：turns 轮，每轮一条 assistant 消息，第 1 条是用户任务；结尾可选验证与上限
  run(
    options: {
      turns?: number;
      stopReason?: string;
      verdict?: "pass" | "fail";
      limit?: boolean;
      endedAt?: number;
    } = {}
  ): RunId {
    const runId = newRunId();
    const turns = options.turns ?? 1;
    this.add({ kind: "entry", runSeq: 1, role: "user" }, runId);
    for (let turn = 1; turn <= turns; turn++) {
      this.add({ kind: "turn.started", payload: {} }, runId);
      this.add({ kind: "entry", runSeq: turn + 1, role: "assistant" }, runId);
      this.add(
        {
          kind: "turn.completed",
          payload: { stopReason: options.stopReason ?? "stop", syntheticFailure: false },
        },
        runId
      );
    }
    if (options.limit === true) {
      this.add({ kind: "run.limit-hit", payload: { limit: "turn-limit" } }, runId);
    }
    this.add({ kind: "run.ended", payload: { messageCount: turns + 1 } }, runId);
    if (options.endedAt !== undefined) {
      const ended = this.records.at(-1) as { timestamp: number };
      ended.timestamp = options.endedAt;
    }
    if (options.verdict !== undefined) {
      this.add({
        kind: "attempt.verified",
        target: { sessionId: this.sessionId, runId },
        command: ["node", "v.mjs"],
        exitCode: options.verdict === "pass" ? 0 : 1,
        timedOut: false,
        durationMs: 1,
        outputBytes: 0,
        outputHash: HASH,
        output: "",
        truncated: false,
        workspace: "/w",
        verdict: options.verdict,
        verifiedAt: 1,
      });
    }
    return runId;
  }

  session(): MaterializedSession {
    return materializeRecords({
      sessionId: this.sessionId,
      path: "x",
      records: this.records,
      tornTail: false,
    });
  }
}

test("同任务比对取尝试会话的首个 Run：恢复后追加的 Run 不计入条目范围与轮次", () => {
  const ledger = new Ledger();
  const first = ledger.run({ turns: 2, verdict: "fail" });
  ledger.run({ turns: 5 });
  const session = ledger.session();
  assert.equal(firstRunOf(session), first);
  const attempt = buildTaskAttempt({ governanceRoot: "/repo", session });
  assert.equal(attempt.runId, first);
  assert.deepEqual(attempt.entryRange, { from: 1, to: 3 });
  assert.equal(attempt.turns, 2);
  assert.equal(attempt.label, "Failed");
  assert.equal(attempt.verification?.sessionId, ledger.sessionId);
});

function attemptWith(options: Parameters<Ledger["run"]>[0]) {
  const ledger = new Ledger();
  ledger.run(options);
  return buildTaskAttempt({ governanceRoot: "/repo", session: ledger.session() });
}

test("选对：每侧只取一个——成功侧取总轮数最少，失败侧取最早收尾；其余与不可比的尝试只进 others", () => {
  const slowPass = attemptWith({ turns: 6, verdict: "pass" });
  const fastPass = attemptWith({ turns: 2, verdict: "pass" });
  const lateFail = attemptWith({ turns: 1, verdict: "fail", endedAt: 900 });
  const earlyFail = attemptWith({ turns: 3, limit: true, stopReason: "aborted", endedAt: 100 });
  const abandoned = attemptWith({ stopReason: "aborted" });
  const unknown = attemptWith({});
  assert.equal(abandoned.label, "Abandoned");
  assert.equal(unknown.label, "Unknown");
  const selection = selectContrast([slowPass, lateFail, abandoned, fastPass, earlyFail, unknown]);
  assert.equal(selection.skip, undefined);
  assert.equal(selection.successful?.sessionId, fastPass.sessionId);
  assert.equal(selection.failed?.sessionId, earlyFail.sessionId);
  assert.deepEqual(
    selection.others.map((attempt) => attempt.sessionId).sort(),
    [slowPass, lateFail, abandoned, unknown].map((attempt) => attempt.sessionId).sort()
  );
});

test("全成功、全失败、凑不齐两侧：给出跳过原因，不选对", () => {
  const pass = () => attemptWith({ verdict: "pass" });
  const fail = () => attemptWith({ verdict: "fail" });
  assert.equal(selectContrast([pass(), pass()]).skip, "all-passed");
  assert.equal(selectContrast([fail(), fail()]).skip, "all-failed");
  assert.equal(
    selectContrast([attemptWith({}), attemptWith({ stopReason: "aborted" })]).skip,
    "no-contrast"
  );
  const allFailed = selectContrast([fail(), attemptWith({})]);
  assert.equal(allFailed.skip, "all-failed");
  assert.equal(allFailed.failed, undefined, "跳过时不选对");
});

test("分叉：共享前缀单独产出、只算一次；来源侧取分叉点之后到该 Run 结尾，分支侧取分支会话首个 Run", () => {
  const source = new Ledger();
  const sourceRun = source.run({ turns: 4, verdict: "fail", endedAt: 0 });
  const branches = [new Ledger(), new Ledger()];
  const checkpoint = { ref: "refs/pigeon/checkpoints/s/1", commit: "a".repeat(40) };
  for (const [index, branch] of branches.entries()) {
    branch.add({
      kind: "branch.header",
      sourceSessionId: source.sessionId,
      forkPoint: { runId: sourceRun, runSeq: 1 },
      checkpoint,
      workspace: { kind: "git-worktree", path: `/w${index}`, branch: `b${index}` },
      trigger: "retry-on-fail",
      startedAt: 1,
    });
    branch.run({ turns: index + 1, verdict: index === 0 ? "fail" : "pass" });
  }
  const group = buildForkGroup({
    governanceRoot: "/repo",
    source: source.session(),
    branches: branches.map((branch) => branch.session()),
  });
  assert.deepEqual(group.sharedPrefix, {
    sessionId: source.sessionId,
    runId: sourceRun,
    from: 1,
    to: 1,
  });
  assert.equal(group.attempts.length, 3);
  const [sourceSide, firstBranch, secondBranch] = group.attempts;
  assert.deepEqual(sourceSide?.entryRange, { from: 2, to: 5 }, "来源侧不含共享前缀");
  assert.equal(sourceSide?.label, "Failed");
  assert.deepEqual(firstBranch?.entryRange, { from: 1, to: 2 });
  assert.equal(secondBranch?.label, "Passed");
  const selection = selectContrast(group.attempts);
  assert.equal(selection.successful?.sessionId, branches[1]?.sessionId);
  assert.equal(selection.failed?.sessionId, source.sessionId, "失败侧取最早收尾（来源先收尾）");
});

test("分叉：分叉点是该 Run 最后一条时来源侧没有独有条目，不进组（不造出空区间）", () => {
  const source = new Ledger();
  const sourceRun = source.run({ turns: 4, verdict: "fail" });
  const branch = new Ledger();
  branch.add({
    kind: "branch.header",
    sourceSessionId: source.sessionId,
    forkPoint: { runId: sourceRun, runSeq: 5 },
    checkpoint: { ref: "refs/pigeon/checkpoints/s/1", commit: "a".repeat(40) },
    workspace: { kind: "git-worktree", path: "/w", branch: "b" },
    trigger: "manual",
    startedAt: 1,
  });
  branch.run({ turns: 1, verdict: "pass" });
  const group = buildForkGroup({
    governanceRoot: "/repo",
    source: source.session(),
    branches: [branch.session()],
  });
  assert.deepEqual(group.sharedPrefix, {
    sessionId: source.sessionId,
    runId: sourceRun,
    from: 1,
    to: 5,
  });
  assert.equal(group.attempts.length, 1, "只有分支侧进组");
  assert.equal(group.attempts[0]?.sessionId, branch.sessionId);
  assert.ok(
    group.attempts.every((attempt) => attempt.entryRange.to >= attempt.entryRange.from),
    "不产出空区间"
  );
});

test("分叉：分支来自不同分叉点时拒绝成组（共享前缀必须唯一）", () => {
  const source = new Ledger();
  const run = source.run({ turns: 3 });
  const branch = (runSeq: number) => {
    const ledger = new Ledger();
    ledger.add({
      kind: "branch.header",
      sourceSessionId: source.sessionId,
      forkPoint: { runId: run, runSeq },
      checkpoint: { ref: "r", commit: "a".repeat(40) },
      workspace: { kind: "git-worktree", path: "/w", branch: "b" },
      trigger: "manual",
      startedAt: 1,
    });
    ledger.run({});
    return ledger.session();
  };
  assert.throws(
    () =>
      buildForkGroup({
        governanceRoot: "/repo",
        source: source.session(),
        branches: [branch(1), branch(2)],
      }),
    /分叉点/
  );
});

// ---- Run 内局部对（决策 073）----

function decision(
  ledger: Ledger,
  runId: RunId,
  toolCallId: string,
  decisionBody: Record<string, unknown>
): void {
  ledger.add(
    {
      kind: "decision",
      executionId: newExecutionId(),
      toolCallId,
      toolName: "edit_file",
      rawArgs: {},
      decision: { outcome: "rejected", decidedAt: 1, ...decisionBody },
      at: 1,
    },
    runId
  );
}

function settled(
  ledger: Ledger,
  runId: RunId,
  toolCallId: string,
  toolName: string,
  isError: boolean,
  errorKind?: "domain" | "environment"
): void {
  ledger.add({ kind: "tool.proposed", payload: { toolCallId, toolName, args: {} } }, runId);
  ledger.add(
    {
      kind: "tool.settled",
      payload: { toolCallId, toolName, isError, ...(errorKind !== undefined ? { errorKind } : {}) },
    },
    runId
  );
}

test("Run 内局部对：只取人写理由的拒绝；系统默认文案、策略拒绝、无来源字段的旧记录不用", () => {
  const ledger = new Ledger();
  const runId = newRunId();
  decision(ledger, runId, "tc-human", {
    approvedBy: "human",
    reason: "别改生成文件，改源模板",
    reasonSource: "human",
  });
  decision(ledger, runId, "tc-default", {
    approvedBy: "human",
    reason: "用户拒绝",
    reasonSource: "system-default",
  });
  decision(ledger, runId, "tc-policy", {
    approvedBy: "policy:deny",
    reason: "策略禁止",
    reasonSource: "system-default",
  });
  decision(ledger, runId, "tc-legacy", { approvedBy: "human", reason: "旧记录没有来源字段" });
  const pairs = collectLocalPairs(ledger.session(), runId, new Map([["tc-human", 4]]));
  assert.deepEqual(pairs, [
    {
      kind: "human-rejection",
      toolCallId: "tc-human",
      toolName: "edit_file",
      reason: "别改生成文件，改源模板",
      runSeq: 4,
    },
  ]);
});

test("Run 内局部对：只取域错误后紧跟的同工具成功重试；环境异常、中间隔了别的调用、缺错误归类的旧记录不用", () => {
  const ledger = new Ledger();
  const runId = newRunId();
  settled(ledger, runId, "a1", "edit_file", true, "domain");
  settled(ledger, runId, "a2", "edit_file", false);
  settled(ledger, runId, "b1", "run_command", true, "environment");
  settled(ledger, runId, "b2", "run_command", false);
  settled(ledger, runId, "c1", "edit_file", true, "domain");
  settled(ledger, runId, "c2", "read_file", false);
  settled(ledger, runId, "c3", "edit_file", false);
  settled(ledger, runId, "d1", "edit_file", true);
  settled(ledger, runId, "d2", "edit_file", false);
  const seqs = new Map([
    ["a1", 3],
    ["a2", 5],
  ]);
  assert.deepEqual(collectLocalPairs(ledger.session(), runId, seqs), [
    {
      kind: "domain-error-retry",
      toolCallId: "a2",
      failedToolCallId: "a1",
      toolName: "edit_file",
      failedRunSeq: 3,
      runSeq: 5,
    },
  ]);
});
