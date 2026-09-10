import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { newReceiptId } from "./ids.ts";
import {
  advanceToolExecution,
  proposeToolExecution,
  recordDecision,
  TOOL_EXECUTION_VERSION,
  type ToolExecution,
  ToolExecutionSchema,
  ToolExecutionTransitionError,
} from "./tool-execution.ts";

const T0 = 1_757_000_000_000;

function makeProposal(): ToolExecution {
  return proposeToolExecution({
    toolCallId: "toolu_01ABC",
    toolName: "read_file",
    rawArgs: { path: "src/index.ts" },
    at: T0,
  });
}

// 走完批准路径到指定状态
function approvedAt(state: "dispatch" | "execution" | "settled" | "verification"): ToolExecution {
  let exec = advanceToolExecution(makeProposal(), "approval", T0 + 1);
  exec = recordDecision(exec, {
    outcome: "approved",
    approvedBy: "human",
    decidedAt: T0 + 2,
  });
  if (state === "dispatch") {
    return advanceToolExecution(exec, "dispatch", T0 + 3);
  }
  exec = advanceToolExecution(exec, "dispatch", T0 + 3);
  if (state === "execution") {
    return advanceToolExecution(exec, "execution", T0 + 4);
  }
  exec = advanceToolExecution(exec, "execution", T0 + 4);
  if (state === "settled") {
    return advanceToolExecution(exec, "settled", T0 + 5);
  }
  exec = advanceToolExecution(exec, "settled", T0 + 5);
  return advanceToolExecution(exec, "verification", T0 + 6);
}

test("ToolExecution JSON 往返后深度相等且校验通过（走完完整生命周期）", () => {
  const exec = { ...approvedAt("verification"), receiptId: newReceiptId() };
  const revived: unknown = JSON.parse(JSON.stringify(exec));
  assert.ok(Value.Check(ToolExecutionSchema, revived));
  assert.deepStrictEqual(revived, exec);
});

test("version 不符被拒绝", () => {
  const bad = { ...makeProposal(), version: TOOL_EXECUTION_VERSION + 1 };
  assert.ok(!Value.Check(ToolExecutionSchema, bad));
});

test("合法生命周期全程：proposal→approval→dispatch→execution→settled→verification，时间戳逐阶段盖章", () => {
  const exec = approvedAt("verification");
  assert.equal(exec.state, "verification");
  assert.equal(exec.proposedAt, T0);
  assert.equal(exec.decision?.decidedAt, T0 + 2);
  assert.equal(exec.dispatchedAt, T0 + 3);
  assert.equal(exec.executionStartedAt, T0 + 4);
  assert.equal(exec.settledAt, T0 + 5);
  assert.equal(exec.verifiedAt, T0 + 6);
  assert.ok(Value.Check(ToolExecutionSchema, exec));
});

test("非法迁移被拒绝：proposal 直接 settled", () => {
  assert.throws(
    () => advanceToolExecution(makeProposal(), "settled", T0 + 1),
    ToolExecutionTransitionError
  );
});

test("非法迁移被拒绝：不能跳过阶段（proposal→execution、dispatch→settled）", () => {
  assert.throws(
    () => advanceToolExecution(makeProposal(), "execution", T0 + 1),
    ToolExecutionTransitionError
  );
  assert.throws(
    () => advanceToolExecution(approvedAt("dispatch"), "settled", T0 + 4),
    ToolExecutionTransitionError
  );
});

test("终态 verification 不可再迁移", () => {
  const exec = approvedAt("verification");
  assert.throws(() => advanceToolExecution(exec, "settled", T0 + 7), ToolExecutionTransitionError);
});

test("无决定离开 approval 被拒绝：批准前不得 dispatch", () => {
  const exec = advanceToolExecution(makeProposal(), "approval", T0 + 1);
  assert.throws(() => advanceToolExecution(exec, "dispatch", T0 + 2), ToolExecutionTransitionError);
  assert.throws(() => advanceToolExecution(exec, "settled", T0 + 2), ToolExecutionTransitionError);
});

test("决定与去向不一致被拒绝：rejected 决定不能进 dispatch，approved 决定不能进 settled", () => {
  let exec = advanceToolExecution(makeProposal(), "approval", T0 + 1);
  const rejected = recordDecision(exec, {
    outcome: "rejected",
    approvedBy: "human",
    reason: "路径越界",
    decidedAt: T0 + 2,
  });
  assert.throws(
    () => advanceToolExecution(rejected, "dispatch", T0 + 3),
    ToolExecutionTransitionError
  );

  exec = advanceToolExecution(makeProposal(), "approval", T0 + 1);
  const approved = recordDecision(exec, {
    outcome: "approved",
    approvedBy: "policy:yolo",
    decidedAt: T0 + 2,
  });
  assert.throws(
    () => advanceToolExecution(approved, "settled", T0 + 3),
    ToolExecutionTransitionError
  );
});

test("拒绝路径：approval→settled（rejected），副作用未发生也可进 verification 对账", () => {
  let exec = advanceToolExecution(makeProposal(), "approval", T0 + 1);
  exec = recordDecision(exec, {
    outcome: "rejected",
    approvedBy: "policy:deny",
    reason: "deny 清单精确匹配",
    decidedAt: T0 + 2,
  });
  exec = advanceToolExecution(exec, "settled", T0 + 3);
  assert.equal(exec.state, "settled");
  assert.equal(exec.settledAt, T0 + 3);
  assert.equal(exec.dispatchedAt, undefined);
  assert.equal(exec.executionStartedAt, undefined);
  exec = advanceToolExecution(exec, "verification", T0 + 4);
  assert.ok(Value.Check(ToolExecutionSchema, exec));
});

test("只能在 approval 状态记录决定，且决定不可改判", () => {
  const proposal = makeProposal();
  const decision = { outcome: "approved", approvedBy: "human", decidedAt: T0 + 1 } as const;
  assert.throws(() => recordDecision(proposal, decision), ToolExecutionTransitionError);

  const inApproval = advanceToolExecution(proposal, "approval", T0 + 1);
  const decided = recordDecision(inApproval, { ...decision, decidedAt: T0 + 2 });
  assert.throws(
    () => recordDecision(decided, { outcome: "rejected", approvedBy: "human", decidedAt: T0 + 3 }),
    ToolExecutionTransitionError
  );
});

test("approvedBy 枚举之外的值被 schema 拒绝（防止伪造批准来源）", () => {
  const exec = approvedAt("settled");
  const bad = { ...exec, decision: { ...exec.decision, approvedBy: "robot" } };
  assert.ok(!Value.Check(ToolExecutionSchema, bad));
});

test("settled 后关联 receiptId：合法 rcpt_ 标识通过，坏标识被拒绝", () => {
  const exec = approvedAt("settled");
  const linked = { ...exec, receiptId: newReceiptId() };
  assert.ok(Value.Check(ToolExecutionSchema, linked));
  const bad = { ...exec, receiptId: "not-a-receipt-id" };
  assert.ok(!Value.Check(ToolExecutionSchema, bad));
});
