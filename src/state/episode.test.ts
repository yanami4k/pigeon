// EpisodeBuilder（M7 S2，决策 070；ROADMAP §M7）：一次尝试取尝试会话的首个 Run，恢复后追加的 Run 不计入。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskAttempt, firstRunOf } from "./episode.ts";
import type { EventRecord } from "./event-log.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "./ids.ts";
import { type MaterializedSession, materializeRecords } from "./materialize.ts";

const HASH = "0".repeat(64);

class Ledger {
  readonly sessionId: SessionId = newSessionId();
  readonly records: EventRecord[] = [];
  #clock = 0;

  add(record: Record<string, unknown>, runId?: RunId): void {
    this.#clock += 1;
    this.records.push({
      version: 16,
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
