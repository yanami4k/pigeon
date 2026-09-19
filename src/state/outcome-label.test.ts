// 五个标签由账本现算（M7 S1，决策 072）：成功只认验证通过，验证结论压过运行终态；撞上限与熔断算失败；
// 人主动取消算放弃；基础设施错误取失败分类；缺运行结束、有悬账、验证未判定、无验证且正常完成一律未知。
// 纯函数，不落盘，口径同 065 的候选状态现算。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventRecord } from "./event-log.ts";
import { newEntryId, newExecutionId, newRunId, newSessionId, type RunId } from "./ids.ts";
import { materializeRecords } from "./materialize.ts";
import { type AttemptOutcomeFacts, attemptOutcomeFacts, labelAttempt } from "./outcome-label.ts";

const NORMAL: AttemptOutcomeFacts = {
  hasRunEnded: true,
  pendingCount: 0,
  failure: null,
  limitHit: false,
};

test("验证通过压过运行失败：业务失败、人主动取消、基础设施错误、撞上限的尝试验证通过都算成功", () => {
  assert.equal(labelAttempt({ ...NORMAL, verdict: "pass" }), "Passed");
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "business" }, verdict: "pass" }),
    "Passed"
  );
  assert.equal(
    labelAttempt({
      ...NORMAL,
      failure: { category: "cancelled", breaker: false },
      verdict: "pass",
    }),
    "Passed"
  );
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "infrastructure" }, verdict: "pass" }),
    "Passed"
  );
  assert.equal(
    labelAttempt({
      ...NORMAL,
      failure: { category: "cancelled", breaker: false },
      limitHit: true,
      verdict: "pass",
    }),
    "Passed"
  );
});

test("验证失败算失败，正常完成也一样", () => {
  assert.equal(labelAttempt({ ...NORMAL, verdict: "fail" }), "Failed");
});

test("撞上限算失败（上限中止在运行终态上表现为中止，不得落成放弃）", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false }, limitHit: true }),
    "Failed"
  );
});

test("熔断算失败，不算放弃", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: true } }),
    "Failed"
  );
});

test("人主动取消算放弃", () => {
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "cancelled", breaker: false } }),
    "Abandoned"
  );
});

test("无验证时：业务失败算失败，基础设施错误单列", () => {
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "business" } }), "Failed");
  assert.equal(
    labelAttempt({ ...NORMAL, failure: { category: "infrastructure" } }),
    "InfrastructureError"
  );
});

test("缺 run.ended 或有悬账算未知（即使验证通过也不下确定性结论）", () => {
  assert.equal(labelAttempt({ ...NORMAL, hasRunEnded: false }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, hasRunEnded: false, verdict: "pass" }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1 }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, pendingCount: 1, verdict: "fail" }), "Unknown");
});

test("无验证但正常完成算未知；验证未判定算未知；分类为未知的仍是未知", () => {
  assert.equal(labelAttempt(NORMAL), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, verdict: "undetermined" }), "Unknown");
  assert.equal(labelAttempt({ ...NORMAL, failure: { category: "unknown" } }), "Unknown");
});

// ---- 从账本现算事实 ----

function base(sessionId = newSessionId(), runId: RunId = newRunId()) {
  return (timestamp: number) => ({
    version: 11 as const,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp,
  });
}

test("账本现算：撞上限观察、熔断、悬账、验证记录（取最后一条）与 Eval 判决都进事实", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const at = base(sessionId, runId);
  const records = [
    { ...at(1), kind: "turn.started", payload: {} },
    {
      ...at(2),
      kind: "turn.completed",
      payload: { stopReason: "aborted", syntheticFailure: false },
    },
    { ...at(3), kind: "run.limit-hit", payload: { limit: "turn-limit" } },
    { ...at(4), kind: "run.ended", payload: { messageCount: 1 } },
  ] as EventRecord[];
  const session = materializeRecords({ sessionId, path: "x", records, tornTail: false });
  const facts = attemptOutcomeFacts(session, runId);
  assert.equal(facts.limitHit, true);
  assert.equal(labelAttempt(facts), "Failed");

  const verified = (verdict: "pass" | "fail", timestamp: number) =>
    ({
      version: 11,
      id: newEntryId(),
      sessionId,
      timestamp,
      kind: "attempt.verified",
      target: { sessionId, runId },
      command: ["node", "v.mjs"],
      exitCode: verdict === "pass" ? 0 : 1,
      timedOut: false,
      durationMs: 1,
      outputBytes: 0,
      outputHash: "0".repeat(64),
      output: "",
      truncated: false,
      workspace: "/w",
      verdict,
      verifiedAt: timestamp,
    }) as EventRecord;
  const withVerify = materializeRecords({
    sessionId,
    path: "x",
    records: [...records, verified("fail", 5), verified("pass", 6)],
    tornTail: false,
  });
  assert.equal(
    labelAttempt(attemptOutcomeFacts(withVerify, runId)),
    "Passed",
    "取最后一条验证记录"
  );

  const pending = materializeRecords({
    sessionId,
    path: "x",
    records: [
      ...records,
      {
        ...at(7),
        kind: "intent",
        executionId: newExecutionId(),
        toolCallId: "tc-1",
        toolName: "edit_file",
        rawArgs: {},
        decision: { outcome: "approved", approvedBy: "human", decidedAt: 1 },
        at: 7,
      } as EventRecord,
    ],
    tornTail: false,
  });
  assert.equal(attemptOutcomeFacts(pending, runId).pendingCount, 1);
  assert.equal(labelAttempt(attemptOutcomeFacts(pending, runId)), "Unknown");
});

test("账本现算：验证记录可来自另一个会话文件（worker 尝试的验证落在父会话里），按目标会话与 Run 匹配", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const at = base(sessionId, runId);
  const session = materializeRecords({
    sessionId,
    path: "x",
    records: [
      {
        ...at(1),
        kind: "turn.completed",
        payload: { stopReason: "stop", syntheticFailure: false },
      },
      { ...at(2), kind: "run.ended", payload: { messageCount: 1 } },
    ] as EventRecord[],
    tornTail: false,
  });
  const parentId = newSessionId();
  const parent = materializeRecords({
    sessionId: parentId,
    path: "p",
    records: [
      {
        version: 11,
        id: newEntryId(),
        sessionId: parentId,
        timestamp: 3,
        kind: "attempt.verified",
        target: { sessionId, runId },
        command: ["node", "v.mjs"],
        exitCode: 1,
        timedOut: false,
        durationMs: 1,
        outputBytes: 0,
        outputHash: "0".repeat(64),
        output: "",
        truncated: false,
        workspace: "/w",
        verdict: "fail",
        verifiedAt: 3,
      },
    ] as EventRecord[],
    tornTail: false,
  });
  assert.equal(labelAttempt(attemptOutcomeFacts(session, runId)), "Unknown");
  assert.equal(
    labelAttempt(attemptOutcomeFacts(session, runId, { verificationSources: [parent] })),
    "Failed"
  );
});

test("账本现算：Eval 的 eval.verified 同样是验证结论", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const at = base(sessionId, runId);
  const session = materializeRecords({
    sessionId,
    path: "x",
    records: [
      {
        ...at(1),
        kind: "turn.completed",
        payload: { stopReason: "stop", syntheticFailure: false },
      },
      { ...at(2), kind: "run.ended", payload: { messageCount: 1 } },
      {
        ...at(3),
        kind: "eval.verified",
        payload: {
          taskId: "fix-a",
          command: ["node", "v.mjs"],
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          outputBytes: 0,
          outputHash: "0".repeat(64),
          output: "",
          truncated: false,
          verdict: "pass",
          assets: [],
          selfReportedDone: true,
          falsePositive: false,
        },
      },
    ] as EventRecord[],
    tornTail: false,
  });
  assert.equal(labelAttempt(attemptOutcomeFacts(session, runId)), "Passed");
});
