// 手动补审与候选列表（M6 S4，决策 064 / 065 子裁决 ⑤）：
// - pigeon review <sessionId> [--run <runId>]：对冷会话补审，与自动审阅同一派发器；派出与收尾记进被审会话，
//   完成后照常落盘候选；缺省审该会话最后一个 Run；Reviewer 自身会话拒审。
// - pigeon candidates [--all]：跨会话由账本现算候选并列出（种类、名字、哈希前缀、状态、来源与时间），缺省隐藏扫描拒收。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runCandidatesCommand } from "./candidates-list.ts";
import type { McpSession } from "./mcp.ts";
import { runManualReview } from "./review-command.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

async function coldSession(root: string, home: string) {
  const sessionId = newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn: createFakeStreamFn({ replies: [{ text: "主会话做完了" }] }),
    flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
    startMcp: noMcp,
    homeDir: home,
    review: { enabled: false, everyTurns: 8 },
  });
  const result = await opened.bundle.adapter.run("做个小任务");
  await disposeRuntime(opened.bundle);
  return { sessionId, runId: result.runId };
}

const candidateJson = (name: string, content: string) =>
  JSON.stringify({
    candidates: [
      { kind: "memory", name, summary: `${name} 摘要`, strength: 0.6, content, sourceRunSeqs: [1] },
    ],
  });

test("手动补审冷会话：派出与收尾记进被审会话，完成后落盘候选；缺省审最后一个 Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-manual-review-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-manual-review-home-"));
  try {
    const cold = await coldSession(root, home);
    const summary = await runManualReview({
      governanceRoot: root,
      sessionId: cold.sessionId,
      streamFn: createFakeStreamFn({
        replies: [{ text: candidateJson("project-facts", "# 事实\n\n用 node --test。") }],
      }),
      provider: "custom",
      modelId: "custom",
      homeDir: home,
    });
    assert.equal(summary.status, "completed");
    assert.equal(summary.runId, cold.runId, "缺省审最后一个 Run");
    assert.equal(summary.candidatesWritten, 1);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const target = materializeSession(sessionsDir, cold.sessionId, { content: false });
    assert.equal(target.childSpawneds[0]?.role, "reviewer");
    assert.equal(target.childSettleds[0]?.status, "completed");
    assert.equal(target.candidateProposeds.length, 1);

    // Reviewer 自身会话拒审
    const reviewerId = target.childSpawneds[0]?.childSessionId;
    assert.ok(reviewerId);
    await assert.rejects(
      () =>
        runManualReview({
          governanceRoot: root,
          sessionId: reviewerId,
          streamFn: createFakeStreamFn({ replies: [{ text: "{}" }] }),
          provider: "custom",
          modelId: "custom",
          homeDir: home,
        }),
      /审阅会话/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("候选列表：跨会话列出种类、名字、哈希前缀、状态、来源与时间；缺省隐藏扫描拒收，--all 全部列出", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-candidates-list-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-candidates-list-home-"));
  try {
    assert.ok(runCandidatesCommand({ root }).includes("尚无候选"));
    const cold = await coldSession(root, home);
    await runManualReview({
      governanceRoot: root,
      sessionId: cold.sessionId,
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: JSON.stringify({
              candidates: [
                {
                  kind: "memory",
                  name: "clean-note",
                  summary: "干净",
                  strength: 0.6,
                  content: "先读后改",
                  sourceRunSeqs: [1],
                },
                {
                  kind: "memory",
                  name: "hidden-note",
                  summary: "带零宽字符",
                  strength: 0.6,
                  content: "先读​后改",
                  sourceRunSeqs: [1],
                },
              ],
            }),
          },
        ],
      }),
      provider: "custom",
      modelId: "custom",
      homeDir: home,
    });
    const visible = runCandidatesCommand({ root });
    assert.ok(visible.includes("memory"), visible);
    assert.ok(visible.includes("clean-note"), visible);
    assert.ok(visible.includes("已扫描"), visible);
    assert.ok(visible.includes(cold.sessionId), "来源会话在场");
    assert.equal(visible.includes("hidden-note"), false, "缺省隐藏扫描拒收项");
    const all = runCandidatesCommand({ root, all: true });
    assert.ok(all.includes("hidden-note"), all);
    assert.ok(all.includes("扫描拒收"), all);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
