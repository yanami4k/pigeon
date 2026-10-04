// trace 与 replay 显示上下文裁剪（决策 361）：各一行，带时机、裁了几条、前后的上下文 token 数与估算的节省
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("trace 与 replay：一次裁剪显示一行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-prune-display-"));
  try {
    const s = createFixtureSession({ sessionsDir: sessionsDirOf(root) });
    const runId = s.startRun({ task: "做事" });
    const item = {
      toolName: "read_file",
      reason: "large" as const,
      tokens: 9000,
      placeholder: "[已裁剪]",
    };
    s.writer.append({
      customType: SessionEntryType.Prune,
      data: {
        version: SESSION_ENTRY_VERSION,
        runId,
        trigger: "paid",
        items: [
          { ...item, toolCallId: "tc-1" },
          { ...item, toolCallId: "tc-2" },
        ],
        priceRatio: 10,
        horizonTurns: 20,
        prunedTokens: 18000,
        rewriteTokens: 30000,
        estimatedCost: 270000,
        estimatedSaving: 360000,
        tokensBefore: 50000,
        tokensAfter: 32000,
        prunedAt: 1,
      },
    });
    s.assistant({ text: "好" });
    s.endRun();
    const { sessionId } = await s.close();
    for (const output of [
      runTraceCommand({ root, sessionId }),
      runReplayCommand({ root, runId, sessionId }),
    ]) {
      const lines = output.split("\n");
      assert.equal(
        lines.filter((line) => /上下文裁剪（按价格比）.*2 条.*50000 → 32000.*360000/.test(line))
          .length,
        1,
        output
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
