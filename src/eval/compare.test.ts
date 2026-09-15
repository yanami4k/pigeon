// 编辑模式对照报告（决策 061 S0）：两个 Eval 输出目录按编辑模式汇总与逐任务对比；旧结果行无 editMode 按 hashline 读，
// 无 process 的由会话账本复算补上；"已知局限"段自动写出 harness 版本、时间先后、模型与样本量。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { renderEditModeComparison } from "./compare.ts";

function usage(output: number) {
  return {
    input: 100,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100 + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function row(overrides: Record<string, unknown>) {
  return {
    taskId: "fix-a",
    condition: "none",
    attempt: 1,
    holdout: false,
    sessionId: newSessionId(),
    runId: newRunId(),
    status: "completed",
    verdict: "pass",
    falsePositive: false,
    turns: 10,
    toolCalls: 12,
    approvalsNeeded: 3,
    usage: usage(1500),
    durationMs: 60_000,
    failureClass: null,
    ...overrides,
  };
}

function writeRows(dir: string, rows: readonly Record<string, unknown>[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "results.jsonl"),
    rows.map((entry) => `${JSON.stringify(entry)}\n`).join("")
  );
}

// 基线里一行没有 process：用构造的会话账本复算（edit_file 3 次调用，锚点未命中与参数校验失败各 1 次报错）
function writeLedger(
  dir: string,
  sessionId: ReturnType<typeof newSessionId>,
  runId: ReturnType<typeof newRunId>
) {
  const sessionsDir = join(dir, ".pigeon", "sessions");
  const log = new JsonlEventLog(sessionsDir, sessionId);
  let timestamp = 1;
  let runSeq = 0;
  const event = (kind: string, payload: unknown) =>
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: timestamp++,
      kind,
      payload,
    });
  const call = (toolCallId: string, isError: boolean, text: string) => {
    event("tool.proposed", { toolCallId, toolName: "edit_file", args: {} });
    log.appendEntry({
      runId,
      runSeq: ++runSeq,
      role: "toolResult",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "edit_file",
        content: [{ type: "text", text }],
        isError,
      },
    });
    event("tool.settled", { toolCallId, toolName: "edit_file", isError });
  };
  event("turn.started", {});
  call(
    "tc-1",
    true,
    "edits[0] 的 anchor 未命中：第 3 行当前标签为 aaaa，锚点是 bbbb——文件可能已变化"
  );
  call(
    "tc-2",
    true,
    'Validation failed for tool "edit_file":\n  - edits.0.anchor: must match pattern'
  );
  call("tc-3", false, "已在 a.ts 应用 1 处编辑（+1 −1 行）。新快照 [a.ts#0123456789abcdef]");
  event("turn.completed", { stopReason: "stop", syntheticFailure: false });
  event("run.ended", { messageCount: 3 });
  log.close();
}

test("编辑模式对照报告：汇总表、逐任务表、报错分类，旧行按 hashline 读并由账本复算 process，已知局限自动写出", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compare-"));
  try {
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    const ledgerSession = newSessionId();
    const ledgerRun = newRunId();
    writeRows(baseline, [
      // 旧格式：无 editMode、无 harnessRef、无 process（由账本复算）
      row({ sessionId: ledgerSession, runId: ledgerRun, verdict: "fail", falsePositive: true }),
      row({
        attempt: 2,
        turns: 10,
        usage: usage(1500),
        process: {
          tools: { edit_file: { calls: 4, errors: 1 }, read_file: { calls: 5, errors: 0 } },
          outputLimitTurns: 1,
          editErrors: { "anchor-miss": 1 },
        },
      }),
      // 其他条件的行不进对照
      row({ condition: "candidate", attempt: 1 }),
    ]);
    writeLedger(baseline, ledgerSession, ledgerRun);
    writeRows(candidate, [
      row({
        editMode: "replace",
        harnessRef: { commit: "abc1234", dirty: true },
        turns: 8,
        usage: usage(900),
        durationMs: 45_000,
        process: {
          tools: { edit_file: { calls: 2, errors: 1 }, read_file: { calls: 3, errors: 0 } },
          outputLimitTurns: 0,
          editErrors: { "not-found": 1 },
        },
      }),
      row({
        attempt: 2,
        editMode: "replace",
        harnessRef: { commit: "abc1234", dirty: true },
        turns: 8,
        usage: usage(900),
        durationMs: 45_000,
        process: {
          tools: { edit_file: { calls: 2, errors: 0 }, read_file: { calls: 3, errors: 0 } },
          outputLimitTurns: 0,
          editErrors: {},
        },
      }),
    ]);

    const report = renderEditModeComparison({
      baselineDir: baseline,
      candidateDir: candidate,
      condition: "none",
    });
    assert.match(report, /^# 编辑模式对照/m);
    assert.match(report, /\| 指标 \| hashline（基线） \| replace（候选） \|/);
    assert.match(report, /\| 运行数 \| 2 \| 2 \|/);
    assert.match(report, /\| 成功率 \| 1\/2（50%） \| 2\/2（100%） \|/);
    assert.match(report, /\| 误报 \| 1 \| 0 \|/);
    assert.match(report, /\| 编辑调用数 \| 7 \| 4 \|/);
    assert.match(report, /\| 编辑报错数 \| 3 \| 1 \|/);
    assert.match(report, /\| 编辑报错率 \| 42\.9% \| 25\.0% \|/);
    assert.match(report, /\| 报错分类 \| 参数校验失败 1、锚点未命中 2 \| 原文未找到 1 \|/);
    assert.match(report, /\| 平均轮次 \| 10\.0 \| 8\.0 \|/);
    assert.match(report, /\| 平均输出 token \| 1500\.0 \| 900\.0 \|/);
    assert.match(report, /\| 撞输出上限次数 \| 1 \| 0 \|/);
    assert.match(report, /\| 平均耗时（秒） \| 60\.0 \| 45\.0 \|/);
    assert.match(
      report,
      /\| fix-a \| 1\/2 \| 2\/2 \| 7\/3 \| 4\/1 \| 10\.0 \| 8\.0 \| 1500\.0 \| 900\.0 \|/
    );
    assert.match(report, /## 已知局限/);
    assert.match(report, /harness 版本：基线 未记录；候选 abc1234（有未提交改动）/);
    assert.match(report, /两组 harness 版本不同/);
    assert.match(report, /样本量：基线 2 次、候选 2 次运行/);
    assert.match(report, /模型/);
    assert.match(report, /时间先后/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
