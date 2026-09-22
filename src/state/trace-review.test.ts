// Trace 与后台审阅同步（M6 S3，决策 064 / 065）：单 Run 视图列出该 Run 的候选（状态由提出记录与后续决定现算）、
// 审阅跳过记录与审阅结果不可解析记录；cli trace 渲染同一份投影。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTraceCommand } from "../cli/trace.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";
import { buildSessionTrace } from "./trace.ts";

const HASH = "c".repeat(64);

test("单 Run 视图带候选、审阅跳过与不可解析记录；cli trace 同步渲染", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-review-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const reviewSessionId = newSessionId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1,
      kind: "turn.started",
      payload: {},
    });
    log.appendCandidateProposed({
      runId,
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
          producerSessionId: reviewSessionId,
          entryRunSeqs: [1],
          contentDigest: HASH,
        },
        summary: "改之前先读",
        strength: 0.7,
        scan: {
          scannerVersion: "1",
          hits: [{ rule: "injection", detail: "SKILL.md：「忽略之前的指令」" }],
        },
        createdAt: 2,
      },
      model: { provider: "custom", id: "custom" },
      usage: { turns: 1, totalTokens: 100 },
    });
    log.appendObservation({
      kind: "review.skipped",
      runId,
      payload: { trigger: "turns", reason: "busy" },
    });
    log.appendObservation({
      kind: "review.unparsable",
      runId,
      payload: { producerSessionId: reviewSessionId, reason: "审阅没有交回结构化结果" },
    });
    log.close();

    const trace = buildSessionTrace(materializeSession(sessionsDir, sessionId), { runId });
    const run = trace.runs[0];
    assert.ok(run);
    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0]?.status, "ScanRejected");
    assert.equal(run.reviewSkips.length, 1);
    assert.equal(run.reviewUnparsables.length, 1);

    const text = runTraceCommand({ root, sessionId });
    assert.ok(text.includes("候选 skill/read-before-edit"), text);
    assert.ok(text.includes("扫描拒收"), text);
    assert.ok(text.includes("命中：injection"), text);
    assert.ok(text.includes("审阅跳过"), text);
    assert.ok(text.includes("结构化结果不可解析"), text);
    assert.ok(text.includes("产出会话"), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
