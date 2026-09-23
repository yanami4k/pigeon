// replay 的候选提出行（决策 128 复核）：候选筛查记录退役后，扫描器版本与命中项改由候选提出行
// 从内嵌的扫描结果呈现——补偿原先筛查行承担的可见性。有命中、无命中各一条。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import type { ReviewerCandidate } from "../state/candidate.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { runReplayCommand } from "./replay.ts";

type ScanHits = ReviewerCandidate["scan"]["hits"];

function candidate(
  sessionId: SessionId,
  runId: RunId,
  name: string,
  hits: ScanHits
): ReviewerCandidate {
  return {
    version: 3,
    origin: "reviewer",
    kind: "skill",
    name,
    contentHash: (name === "clean" ? "a" : "b").repeat(64),
    bytes: 12,
    source: {
      sessionId,
      runId,
      producerSessionId: newSessionId(),
      entryRunSeqs: [1],
      contentDigest: "c".repeat(64),
    },
    summary: "改之前先读",
    strength: 0.6,
    scan: { scannerVersion: "2", hits },
    createdAt: 1,
  };
}

// 写一个只含一条候选提出记录的会话，返回该 Run 的 replay 文本
function replayOf(name: string, hits: ScanHits): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replay-candidate-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    log.appendCandidateProposed({
      runId,
      candidate: candidate(sessionId, runId, name, hits),
      model: { provider: "p", id: "m" },
    });
    log.close();
    return runReplayCommand({ root, sessionId, runId });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("replay 候选提出行：无命中时显示扫描器版本与「无命中」", () => {
  const text = replayOf("clean", []);
  assert.match(text, /候选提出 ｜ skill\/clean ｜ .* ｜ 扫描器 v2 ｜ 无命中/);
  assert.ok(!text.includes("拒收"), text);
});

test("replay 候选提出行：有命中时显示命中项数、拒收与各条规则", () => {
  const text = replayOf("hidden", [
    { rule: "injection", detail: "忽略之前的指令" },
    { rule: "exfiltration", detail: "外发" },
  ]);
  assert.match(
    text,
    /候选提出 ｜ skill\/hidden ｜ .* ｜ 扫描器 v2 ｜ 命中 2 项（拒收）：injection、exfiltration/
  );
});
