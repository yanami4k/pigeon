// M7 S1 数据层（决策 069 / 071 / 075 / 077 / 078）：Event Log v11 加法式新增——派出记录的共享任务标识、
// 通用验证记录、分叉记录与分支会话头、工作区快照观察、撞上限观察、提炼跳过记录（决策 128 已退役）；
// 候选 v3 的对比来源块随候选提出记录一起退役（决策 137）。
// 旧记录（v10）逐字有效，经读路径迁移链升到当前版本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { EVENT_LOG_VERSION, EventRecordSchema, parseEventRecord } from "./event-log.ts";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";

const HASH = "c".repeat(64);
const COMMIT = "a".repeat(40);

function envelope(runId = newRunId()) {
  return {
    version: EVENT_LOG_VERSION,
    id: newEntryId(),
    sessionId: newSessionId(),
    runId,
    timestamp: 1,
  };
}

const LIMITS = { maxTurns: 10, wallClockMs: 1000 };
const POLICY = { allow: ["read_file"], deny: [], approvalMode: "prompt" };
const WORKTREE = { kind: "git-worktree", path: "/w", branch: "pigeon/w" };

test("Event Log 当前为 v16（v11 加法式新增 M7 各族，v14 退役四族，v15 加回炉轮数，v16 退役第一版学习闭环六族）", () => {
  assert.equal(EVENT_LOG_VERSION, 16);
});

test("069：派出记录可带共享任务标识；缺省仍合法（旧派出记录不受影响）", () => {
  const spawned = {
    ...envelope(),
    kind: "child.spawned",
    childSessionId: newSessionId(),
    name: "implementer-1",
    role: "implementer",
    task: "修复",
    policy: POLICY,
    limits: LIMITS,
    workspace: WORKTREE,
    spawnedAt: 1,
  };
  assert.ok(Value.Check(EventRecordSchema, spawned));
  assert.ok(Value.Check(EventRecordSchema, { ...spawned, taskKey: "task_01" }));
  assert.ok(!Value.Check(EventRecordSchema, { ...spawned, taskKey: "" }), "任务标识不得为空");
});

test("071：通用验证记录——三值结论、命令、退出码、耗时、所在工作区、对应的会话与 Run", () => {
  const verified = {
    ...envelope(),
    kind: "attempt.verified",
    target: { sessionId: newSessionId(), runId: newRunId() },
    command: ["npm", "test"],
    exitCode: 1,
    timedOut: false,
    durationMs: 12,
    outputBytes: 3,
    outputHash: HASH,
    output: "err",
    truncated: false,
    workspace: "/w",
    verdict: "fail",
    verifiedAt: 2,
  };
  assert.ok(Value.Check(EventRecordSchema, verified));
  const { runId: _runId, ...withoutRun } = verified;
  assert.ok(Value.Check(EventRecordSchema, withoutRun), "信封 Run 可缺省（父会话无活动 Run 时）");
  assert.ok(!Value.Check(EventRecordSchema, { ...verified, verdict: "maybe" }), "结论只有三值");
  assert.ok(
    !Value.Check(EventRecordSchema, { ...verified, target: { sessionId: newSessionId() } }),
    "对应的 Run 不得缺省"
  );
});

test("077：分叉记录——分叉点的 Run 与序号、新分支标识、分叉点快照引用；分支会话头指回来源", () => {
  const forkPoint = { runId: newRunId(), runSeq: 3 };
  const checkpoint = { ref: "refs/pigeon/checkpoints/s/1", commit: COMMIT };
  const forked = {
    ...envelope(),
    kind: "session.forked",
    forkPoint,
    branchSessionId: newSessionId(),
    checkpoint,
    trigger: "manual",
    forkedAt: 1,
  };
  assert.ok(Value.Check(EventRecordSchema, forked));
  assert.ok(Value.Check(EventRecordSchema, { ...forked, trigger: "retry-on-fail" }));
  assert.ok(!Value.Check(EventRecordSchema, { ...forked, forkPoint: { runId: newRunId() } }));
  assert.ok(!Value.Check(EventRecordSchema, { ...forked, checkpoint: { ref: "x" } }));
  const header = {
    ...envelope(),
    kind: "branch.header",
    sourceSessionId: newSessionId(),
    forkPoint,
    checkpoint,
    workspace: WORKTREE,
    trigger: "manual",
    startedAt: 1,
  };
  assert.ok(Value.Check(EventRecordSchema, header));
  assert.ok(
    !Value.Check(EventRecordSchema, { ...header, workspace: { kind: "none" } }),
    "分支续跑恒在独立工作树里"
  );
});

test("078：快照观察——ref、提交、树、改前基线、所在工具调用与对应条目号", () => {
  const checkpoint = {
    ...envelope(),
    kind: "workspace.checkpoint",
    payload: {
      ref: "refs/pigeon/checkpoints/s/1",
      commit: COMMIT,
      tree: "b".repeat(40),
      baseCommit: "d".repeat(40),
      toolCallId: "tc-1",
      afterRunSeq: 4,
    },
  };
  assert.ok(Value.Check(EventRecordSchema, checkpoint));
  const { baseCommit: _base, ...withoutBase } = checkpoint.payload;
  assert.ok(Value.Check(EventRecordSchema, { ...checkpoint, payload: withoutBase }));
  assert.ok(
    !Value.Check(EventRecordSchema, {
      ...checkpoint,
      payload: { ...checkpoint.payload, afterRunSeq: 0 },
    }),
    "条目号从 1 起"
  );
});

test("072 依据：撞上限观察；提炼跳过已退役（决策 128）", () => {
  assert.ok(
    Value.Check(EventRecordSchema, {
      ...envelope(),
      kind: "run.limit-hit",
      payload: { limit: "token-limit" },
    })
  );
  assert.ok(
    !Value.Check(EventRecordSchema, {
      ...envelope(),
      kind: "run.limit-hit",
      payload: { limit: "cancelled" },
    })
  );
  const skipped = {
    ...envelope(),
    kind: "distill.skipped",
    taskKey: "task_01",
    reason: "all-passed",
    attempts: [{ sessionId: newSessionId(), runId: newRunId(), label: "Passed" }],
  };
  // 决策 128：提炼跳过已退役，不在当前记录并集里（旧文件里的这种记录由读取边界跳过）
  assert.ok(!Value.Check(EventRecordSchema, skipped));
});

test("v10 记录经迁移链升到当前版本：派出记录不带任务标识，v10 → v11 是纯版本推进", () => {
  const v10 = {
    version: 10,
    id: newEntryId(),
    sessionId: newSessionId(),
    timestamp: 1,
    kind: "child.spawned",
    childSessionId: newSessionId(),
    name: "implementer-1",
    role: "implementer",
    task: "修复",
    policy: POLICY,
    limits: LIMITS,
    workspace: WORKTREE,
    spawnedAt: 1,
  };
  const spawned = parseEventRecord(structuredClone(v10));
  assert.deepEqual(spawned, { ...v10, version: EVENT_LOG_VERSION });
});

// 决策 128 / 137：v13 → v14 与 v15 → v16 只退役若干族（由读取边界跳过），保留下来的记录纯版本推进、正文逐字不变
test("v13 记录经迁移链升到当前版本：v14、v15、v16 都是纯版本推进，其余字段逐字不变", () => {
  const v13 = {
    version: 13,
    id: newEntryId(),
    sessionId: newSessionId(),
    runId: newRunId(),
    timestamp: 1,
    kind: "run.limit-hit",
    payload: { limit: "token-limit" },
  };
  const record = parseEventRecord(structuredClone(v13));
  assert.equal(EVENT_LOG_VERSION, 16);
  assert.deepEqual(record, { ...v13, version: EVENT_LOG_VERSION });
});
