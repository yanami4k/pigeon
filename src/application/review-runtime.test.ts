// 后台审阅挂载（M6 S2，决策 064）：会话运行面在 cli / tui 主会话上挂审阅调度——配置冻结进注入快照并随
// run.started 落盘；触发后以无工作区的 reviewer worker 派出，派出与收尾复用 child.* 两族；Reviewer 的广告集
// 只有两个只读快照工具；Reviewer 崩溃不影响主 Run；Reviewer 自身会话永不被审；关闭审阅时不派出。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { createReviewGate } from "../review/scheduler.ts";
import { newSessionId } from "../state/ids.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";
import type { McpSession } from "./mcp.ts";
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

async function runMainWithReview(options: {
  enabled: boolean;
  everyTurns: number;
  reviewerStream: StreamFn;
  budget?: { maxTurns?: number; wallClockMs?: number; maxTokens?: number };
}) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-review-runtime-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-review-home-"));
  const sessionId = newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn: createFakeStreamFn({ replies: [{ text: "主会话做完了" }] }),
    flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
    startMcp: noMcp,
    homeDir: home,
    review: {
      enabled: options.enabled,
      everyTurns: options.everyTurns,
      gate: createReviewGate(),
      streamFn: options.reviewerStream,
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
    },
  });
  const result = await opened.bundle.adapter.run("做个小任务");
  await opened.review?.idle();
  const sessionsDir = join(root, ".pigeon", "sessions");
  return {
    root,
    home,
    sessionId,
    sessionsDir,
    opened,
    result,
    cleanup: async () => {
      await disposeRuntime(opened.bundle);
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("审阅配置冻结：注入快照与 run.started 都带审阅开关与轮次间隔", async () => {
  const run = await runMainWithReview({
    enabled: true,
    everyTurns: 8,
    reviewerStream: createFakeStreamFn({ replies: [{ text: '{"candidates":[]}' }] }),
  });
  try {
    assert.deepEqual(run.opened.bundle.adapter.snapshot().review, { enabled: true, everyTurns: 8 });
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.deepEqual(main.runStarteds[0]?.payload.review, { enabled: true, everyTurns: 8 });
  } finally {
    await run.cleanup();
  }
});

test("Run 结束补审：父会话记 reviewer 的 child.spawned（无工作区）与 child.settled，结构化结果随收尾带回", async () => {
  const run = await runMainWithReview({
    enabled: true,
    everyTurns: 8,
    reviewerStream: createFakeStreamFn({
      replies: [{ text: '{"candidates":[{"kind":"memory","name":"x"}]}' }],
    }),
  });
  try {
    assert.equal(run.result.status, "completed");
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.equal(main.childSpawneds.length, 1, "Run 结束固定补审一次");
    const spawned = main.childSpawneds[0];
    assert.equal(spawned?.role, "reviewer");
    assert.deepEqual(spawned?.workspace, { kind: "none" });
    assert.equal(
      spawned?.runId,
      run.result.runId,
      "派出记录回指被审的那一次 Run（trace 按 Run 挂载）"
    );
    const settled = main.childSettleds[0];
    assert.equal(settled?.status, "completed");
    assert.deepEqual(settled?.result?.structured, {
      candidates: [{ kind: "memory", name: "x" }],
    });

    // Reviewer 会话：广告集只有两个只读快照工具；它自己不再派出审阅
    const reviewerId = spawned?.childSessionId;
    assert.ok(reviewerId);
    const reviewer = materializeSession(run.sessionsDir, reviewerId, { content: false });
    assert.deepEqual(
      [...(reviewer.runStarteds[0]?.payload.advertisedTools ?? [])].sort(),
      [REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL].sort()
    );
    assert.equal(reviewer.childSpawneds.length, 0, "Reviewer 自身会话永不被审");
  } finally {
    await run.cleanup();
  }
});

test("Reviewer 崩溃不影响主 Run：主 Run 照常完成，审阅以失败收尾", async () => {
  const crashing: StreamFn = () => {
    throw new Error("审阅模型接入炸了");
  };
  const run = await runMainWithReview({ enabled: true, everyTurns: 8, reviewerStream: crashing });
  try {
    assert.equal(run.result.status, "completed", "主 Run 不受审阅崩溃影响");
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.equal(main.childSettleds[0]?.status === "completed", false, "审阅不得以完成收尾");
  } finally {
    await run.cleanup();
  }
});

test("关闭审阅：不派出任何 Reviewer", async () => {
  const run = await runMainWithReview({
    enabled: false,
    everyTurns: 8,
    reviewerStream: createFakeStreamFn({ replies: [{ text: "{}" }] }),
  });
  try {
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.equal(main.childSpawneds.length, 0);
  } finally {
    await run.cleanup();
  }
});

test("审阅完成：合法结构化结果落成候选文件，被审主会话记提出与筛查两族（模型与用量在场）", async () => {
  const candidate = {
    kind: "memory",
    name: "project-facts",
    summary: "测试命令是 node --test",
    strength: 0.6,
    content: "# 项目事实\n\n测试命令是 node --test。",
    sourceRunSeqs: [1],
  };
  const run = await runMainWithReview({
    enabled: true,
    everyTurns: 8,
    reviewerStream: createFakeStreamFn({
      replies: [{ text: JSON.stringify({ candidates: [candidate] }) }],
    }),
  });
  try {
    const memoryDir = join(run.root, ".pigeon", "candidates", "memory");
    assert.ok(existsSync(memoryDir), "候选落盘到暂存目录");
    assert.equal(readdirSync(memoryDir).length, 1);
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.equal(main.candidateProposeds.length, 1);
    assert.equal(
      main.candidateProposeds[0]?.candidate.source.producerSessionId,
      main.childSpawneds[0]?.childSessionId
    );
    assert.equal(main.candidateProposeds[0]?.model.provider, "custom");
    assert.equal(main.candidateProposeds[0]?.usage?.turns, 1);
    assert.equal(main.candidateScreeneds.length, 1);
  } finally {
    await run.cleanup();
  }
});

test("审阅超预算：以轮次上限收尾，不产出任何候选", async () => {
  const run = await runMainWithReview({
    enabled: true,
    everyTurns: 8,
    budget: { maxTurns: 1 },
    reviewerStream: createFakeStreamFn({
      replies: [
        { text: "先读快照", toolCalls: [{ name: REVIEW_SNAPSHOT_TOOL, args: {} }] },
        {
          text: '{"candidates":[{"kind":"memory","name":"late","summary":"x","strength":0.5,"content":"y","sourceRunSeqs":[1]}]}',
        },
      ],
    }),
  });
  try {
    const main = materializeSession(run.sessionsDir, run.sessionId, { content: false });
    assert.equal(main.childSettleds[0]?.status, "turn-limit");
    assert.equal(main.candidateProposeds.length, 0);
    assert.equal(existsSync(join(run.root, ".pigeon", "candidates")), false);
  } finally {
    await run.cleanup();
  }
});
