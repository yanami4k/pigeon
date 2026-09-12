// 失败四分类判据表（M4 S2，D7）逐行单测 + 冷物化集成验证。
// 默认桶是「未知」而非「业务失败」：宁可标「不知道」不贴错标签——标签要喂 M6+ 蒸馏，贴错 = 毒信号。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  asExecutionId,
  newEntryId,
  newExecutionId,
  newReceiptId,
  newRunId,
  newSessionId,
} from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { classifyRunOutcome, classifyToolOutcome } from "./classification.ts";
import { JsonlEventLog, materializeSession } from "./event-log.ts";

// ---------- Run 级判据（D7 表左列） ----------

test("Run 级：正常收尾（stop/toolUse/deferred）不是失败 → null", () => {
  for (const stopReason of ["stop", "toolUse", "deferred"]) {
    assert.equal(
      classifyRunOutcome({
        stopReason,
        syntheticFailure: false,
        breakerTripped: false,
        hasTurnCompleted: true,
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
    }),
    { category: "infrastructure" }
  );
});

test("Run 级默认桶：崩溃残留（无 turn.completed）与非合成 error 都归「未知」", () => {
  assert.deepEqual(
    classifyRunOutcome({ syntheticFailure: false, breakerTripped: false, hasTurnCompleted: false }),
    { category: "unknown" }
  );
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "error",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
    }),
    { category: "unknown" }
  );
  assert.deepEqual(
    classifyRunOutcome({
      stopReason: "pending",
      syntheticFailure: false,
      breakerTripped: false,
      hasTurnCompleted: true,
    }),
    { category: "unknown" }
  );
});

// ---------- ToolExecution 级判据（D7 表右列） ----------

const baseTool = {
  rejected: false,
  hasReceipt: true,
  executed: true,
  isError: false,
  intercepted: false,
  runAborted: false,
  runBreakerTripped: false,
} as const;

test("Tool 级：成功执行与被拒绝都不是失败 → null", () => {
  assert.equal(classifyToolOutcome({ ...baseTool }), null);
  assert.equal(
    classifyToolOutcome({ ...baseTool, rejected: true, hasReceipt: false, executed: false }),
    null
  );
  // 哈希确证「已执行」同样销账非失败
  assert.equal(
    classifyToolOutcome({ ...baseTool, hasReceipt: false, executed: false, resolved: "executed" }),
    null
  );
});

test("Tool 级：执行中被 abort → 取消；被熔断切断的在途调用 → 治理熔断子类", () => {
  assert.deepEqual(classifyToolOutcome({ ...baseTool, isError: true, runAborted: true }), {
    category: "cancelled",
    breaker: false,
  });
  assert.deepEqual(
    classifyToolOutcome({ ...baseTool, isError: true, runAborted: true, runBreakerTripped: true }),
    { category: "cancelled", breaker: true }
  );
});

test("Tool 级：isError + 域错误 → 业务失败；isError + 环境异常 → 基础设施错误", () => {
  assert.deepEqual(classifyToolOutcome({ ...baseTool, isError: true, errorKind: "domain" }), {
    category: "business",
  });
  assert.deepEqual(classifyToolOutcome({ ...baseTool, isError: true, errorKind: "environment" }), {
    category: "infrastructure",
  });
});

test("Tool 级：上游拦截（无账本记录的错误 settled：参数校验失败/幽灵调用）→ 业务失败", () => {
  assert.deepEqual(
    classifyToolOutcome({
      ...baseTool,
      hasReceipt: false,
      executed: false,
      isError: true,
      intercepted: true,
    }),
    { category: "business" }
  );
});

test("Tool 级默认桶：悬账未确证 / 无法归类的错误 / 未执行确证但 Run 非中断 → 未知", () => {
  // intent 无 receipt 无 resolution（OutcomeUnknown 残留）
  assert.deepEqual(
    classifyToolOutcome({ ...baseTool, hasReceipt: false, executed: false, isError: false }),
    { category: "unknown" }
  );
  // isError 但错误归类缺失
  assert.deepEqual(classifyToolOutcome({ ...baseTool, isError: true }), { category: "unknown" });
  // 哈希确证「未执行」但 Run 不是被中断的 = 崩溃残留死于 intent/dispatch 窗口
  assert.deepEqual(
    classifyToolOutcome({
      ...baseTool,
      hasReceipt: false,
      executed: false,
      resolved: "not-executed",
    }),
    { category: "unknown" }
  );
  // executed=false 且 isError=false 且无 decision：不应出现的组合，落默认桶
  assert.deepEqual(classifyToolOutcome({ ...baseTool, executed: false, isError: false }), {
    category: "unknown",
  });
});

test("Tool 级：哈希确证「未执行」+ Run 被中断 → 取消（死于审批后/dispatch 前窗口）", () => {
  assert.deepEqual(
    classifyToolOutcome({
      ...baseTool,
      hasReceipt: false,
      executed: false,
      resolved: "not-executed",
      runAborted: true,
    }),
    { category: "cancelled", breaker: false }
  );
});

// ---------- 冷物化集成：分类从事件日志现算 ----------

test("冷物化输出分类：熔断取消的 Run 与其在途错误调用都被归入治理熔断子类", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-classify-"));
  const sessionId = newSessionId();
  const runId = newRunId();
  try {
    const log = new JsonlEventLog(dir, sessionId);
    // Run：aborted + breaker 行 + 一个在途出错调用（intent+receipt isError，被熔断切断）
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1,
      kind: "turn.completed",
      payload: { stopReason: "aborted", syntheticFailure: false },
    });
    const executionId = newExecutionId();
    log.appendIntent({
      executionId,
      toolCallId: "toolu_x",
      toolName: "edit_file",
      rawArgs: { path: "a.ts" },
      decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 2 },
      at: 2,
      runId,
    });
    log.appendReceipt({
      receipt: {
        version: RECEIPT_VERSION,
        id: newReceiptId(),
        executionId,
        toolCallId: "toolu_x",
        approvedBy: "policy:yolo",
        executed: false,
        isError: true,
        startedAt: 2,
        finishedAt: 3,
        summary: "edit_file 未产生副作用（执行出错）",
      },
      runId,
    });
    log.appendBreaker({
      toolName: "edit_file",
      toolCallId: "toolu_x",
      scope: "tool",
      count: 3,
      threshold: 3,
      at: 4,
      runId,
    });
    log.close();

    const { classification } = materializeSession(dir, sessionId);
    assert.deepEqual(classification.runs, [
      { runId, failure: { category: "cancelled", breaker: true } },
    ]);
    assert.deepEqual(classification.toolExecutions, [
      {
        executionId,
        toolCallId: "toolu_x",
        toolName: "edit_file",
        failure: { category: "cancelled", breaker: true },
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("冷物化输出分类：域错误调用归业务失败；上游拦截调用归业务失败；崩溃残留 Run 归未知", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-classify-"));
  const sessionId = newSessionId();
  const runOk = newRunId();
  const runCrashed = newRunId();
  try {
    const log = new JsonlEventLog(dir, sessionId);
    const envelope = (runId: ReturnType<typeof newRunId>, timestamp: number) => ({
      version: 1 as const,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp,
    });
    // runOk：域错误调用（errorKind=domain）+ 上游拦截调用（无账本记录）+ 正常 stop 收尾
    const executionId = asExecutionId("exec_01J5Z7K8W9ABCDEFGHJKMNPQRS");
    log.appendIntent({
      executionId,
      toolCallId: "toolu_domain",
      toolName: "edit_file",
      rawArgs: {},
      decision: { outcome: "approved", approvedBy: "policy:yolo", decidedAt: 2 },
      at: 2,
      runId: runOk,
    });
    log.appendRuntimeEvent({
      ...envelope(runOk, 3),
      kind: "tool.settled",
      payload: {
        toolCallId: "toolu_domain",
        toolName: "edit_file",
        isError: true,
        errorKind: "domain",
      },
    });
    log.appendRuntimeEvent({
      ...envelope(runOk, 4),
      kind: "tool.settled",
      payload: { toolCallId: "toolu_ghost", toolName: "ghost_tool", isError: true },
    });
    log.appendReceipt({
      receipt: {
        version: RECEIPT_VERSION,
        id: newReceiptId(),
        executionId,
        toolCallId: "toolu_domain",
        approvedBy: "policy:yolo",
        executed: false,
        isError: true,
        startedAt: 2,
        finishedAt: 3,
        summary: "edit_file 未产生副作用（执行出错）",
      },
      runId: runOk,
    });
    log.appendRuntimeEvent({
      ...envelope(runOk, 5),
      kind: "turn.completed",
      payload: { stopReason: "stop", syntheticFailure: false },
    });
    // runCrashed：只有 run.ended，无任何 turn.completed（崩溃残留）
    log.appendRuntimeEvent({
      ...envelope(runCrashed, 6),
      kind: "run.ended",
      payload: { messageCount: 0 },
    });
    log.close();

    const { classification } = materializeSession(dir, sessionId);
    const domainCall = classification.toolExecutions.find((t) => t.toolCallId === "toolu_domain");
    assert.deepEqual(domainCall?.failure, { category: "business" });
    const ghostCall = classification.toolExecutions.find((t) => t.toolCallId === "toolu_ghost");
    assert.deepEqual(ghostCall?.failure, { category: "business" });
    assert.equal(ghostCall?.executionId, null);
    assert.deepEqual(classification.runs, [
      { runId: runOk, failure: null },
      { runId: runCrashed, failure: { category: "unknown" } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
