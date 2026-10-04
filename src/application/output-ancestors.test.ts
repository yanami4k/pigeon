// 命令输出虚拟路径的可读来源（决策 356）：来源取自会话存储的文件头——分支的分支一路往上都认（续接的分支会话不靠调用方
// 传入的来源）；worker 会话不认派出方；本会话的文件还没写出时用调用方给的来源。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunId, SessionId } from "../state/ids.ts";
import { outputAncestors } from "./output-ancestors.ts";
import { createFixtureSession, forkFixture, spawnFixtureWorker } from "./session-store-fixtures.ts";

async function withSessions(run: (sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-output-ancestors-"));
  try {
    await run(join(root, ".pigeon", "state", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 在来源会话那个 Run 的第 2 条消息处分叉，分支里再跑一个 Run
async function forkOf(
  sessionsDir: string,
  source: { sessionId: SessionId; runId: RunId }
): Promise<{ sessionId: SessionId; runId: RunId }> {
  const branch = await forkFixture({
    sessionsDir,
    sourceSessionId: source.sessionId,
    runId: source.runId,
    runSeq: 2,
  });
  const runId = branch.startRun({ task: "分支任务" });
  branch.assistant({ text: "分支回复" });
  branch.endRun();
  await branch.close();
  return { sessionId: branch.sessionId, runId };
}

test("续接的分支会话：不给来源也认分叉来源一路往上", () =>
  withSessions(async (sessionsDir) => {
    const origin = createFixtureSession({ sessionsDir });
    const runId = origin.startRun({ task: "来源任务" });
    origin.assistant({ text: "来源回复" });
    origin.endRun();
    await origin.close();
    const branch = await forkOf(sessionsDir, { sessionId: origin.sessionId, runId });
    const grandchild = await forkOf(sessionsDir, branch);
    assert.deepEqual(outputAncestors(sessionsDir, grandchild.sessionId), [
      branch.sessionId,
      origin.sessionId,
    ]);
    assert.deepEqual(outputAncestors(sessionsDir, origin.sessionId), []);
  }));

test("worker 会话不认派出方；本会话的文件还没写出时用调用方给的来源", () =>
  withSessions(async (sessionsDir) => {
    const parent = createFixtureSession({ sessionsDir });
    parent.startRun({ task: "派出" });
    const worker = spawnFixtureWorker(parent, { sessionsDir, name: "w1", task: "干活" });
    worker.startRun({ task: "干活" });
    worker.endRun();
    await worker.close();
    parent.endRun();
    await parent.close();
    assert.deepEqual(outputAncestors(sessionsDir, worker.sessionId), []);
    assert.deepEqual(outputAncestors(sessionsDir, "not-written-yet", parent.sessionId), [
      parent.sessionId,
    ]);
    // 来源指回自己的不算
    assert.deepEqual(outputAncestors(sessionsDir, "not-written-yet", "not-written-yet"), []);
  }));
