// 失败四分类的 Run 级判据表（M4 S2，D7）逐行单测；工具级判据的测试在 session-judge 与会话读者一侧。
// 默认桶是「未知」而非「业务失败」：宁可标「不知道」不贴错标签——标签要喂 M6+ 蒸馏，贴错 = 毒信号。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRunOutcome } from "./classification.ts";

// ---------- Run 级判据（D7 表左列） ----------

test("Run 级：正常收尾（stop/toolUse/deferred）不是失败 → null", () => {
  for (const stopReason of ["stop", "toolUse", "deferred"]) {
    assert.equal(
      classifyRunOutcome({
        stopReason,
        syntheticFailure: false,
        breakerTripped: false,
        hasTurnCompleted: true,
        hasRunEnded: true,
      }),
      null
    );
  }
});

test("Run 级：aborted 无熔断记录 → 取消（用户中断）", () => {
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "aborted",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "cancelled", breaker: false }
  );
});

test("Run 级：aborted 有熔断记录 → 取消的子类「治理熔断」", () => {
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "aborted",
      syntheticFailure: false,
      breakerTripped: true,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "cancelled", breaker: true }
  );
});

test("Run 级：length（输出截断）→ 业务失败", () => {
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "length",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "business" }
  );
});

test("Run 级：syntheticFailure（provider 侧故障的合成消息）→ 基础设施错误", () => {
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "error",
      syntheticFailure: true,
      breakerTripped: false,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "infrastructure" }
  );
});

test("Run 级默认桶：崩溃残留（无 turn.completed）与非合成 error 都归「未知」", () => {
  assert.deepEqual(
    classifyRunOutcome({
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: false,
      hasRunEnded: false,
    }),
    { category: "unknown" }
  );
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "error",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "unknown" }
  );
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "pending",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
      hasRunEnded: true,
    }),
    { category: "unknown" }
  );
});

test("Run 级：run.ended 缺失即崩溃残留 → 未知，优先于 stopReason（M4 验收 O-1）", () => {
  // 死于收尾轮的 Run：末条 turn.completed 是 toolUse / stop，但循环没有跑到 agent_end
  for (const stopReason of ["toolUse", "stop", "aborted"]) {
    assert.deepEqual(
      classifyRunOutcome({
        stopReason,
        syntheticFailure: false,
        breakerTripped: false,
        hasTurnCompleted: true,
        hasRunEnded: false,
      }),
      { category: "unknown" },
      `stopReason=${stopReason} 但无 run.ended 不得判正常/取消`
    );
  }
});

// ---------- ToolExecution 级判据（D7 表右列） ----------
