// 按覆盖位置补做（决策 295）与复盘模型（296）：
// - 以某会话为父、跑完了的各次复盘（压缩前、收尾、补做）覆盖到的最大条目之后仍有消息，就要补；补做仍给完整上下文，指令里写明
//   "第 N 条及之前已复盘，重点看之后的部分"，复盘记录记下此前的覆盖位置，新复盘的 covers 记到会话末尾；
// - 压缩前已复盘的会话，补做只看其后；补做过又被续聊的会话，补新增部分；
// - 配置里指定复盘模型后，日常使用中的压缩前、收尾、补做三种复盘都用它；未指定时压缩前与收尾复盘用会话本身的模型，补做用本次
//   启动的模型。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewBackfillDir } from "../persistence/review-backfill-store.ts";
import { applyReviewModelConfig, type LaunchFlags } from "./launch-flags.ts";
import { runReviewBackfill } from "./review-backfill.ts";
import {
  initRepo,
  type LoggedCall,
  mainEntries,
  openTuiSession,
  reviewsOf,
  routedModel,
  tempRoot,
  textOf,
} from "./tui-session-fixtures.ts";

const REVIEW_MODEL = { provider: "review-provider", modelId: "review-model" };

function launchedLongAgo(root: string): void {
  mkdirSync(reviewBackfillDir(root), { recursive: true });
  writeFileSync(join(reviewBackfillDir(root), "since.json"), '{"version":1,"since":0}\n');
}

function backfill(root: string, streamFn: Parameters<typeof runReviewBackfill>[0]["streamFn"]) {
  return runReviewBackfill({
    governanceRoot: root,
    streamFn,
    provider: "custom",
    modelId: "custom",
    homeDir: root,
  });
}

// 复盘请求里的指令（最后一条消息）
function instructionOf(call: LoggedCall | undefined): string {
  return textOf(call?.messages.at(-1) ?? {});
}

function lastMessage(root: string, sessionId: string): { id: string; seq: number } {
  const last = mainEntries(root, sessionId).findLast((entry) => entry.type === "message");
  assert.ok(last !== undefined);
  return { id: last.id, seq: last.seq };
}

// 触发一次轮间压缩的剧本：第一轮带足够多的上下文用量，第二轮回来即压缩（压缩前先复盘）
const COMPACTING_MAIN = [
  {
    text: "我先读一下文件。".repeat(20),
    toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
    contextTokens: 5000,
  },
  { text: "读完了", contextTokens: 300 },
];
const COMPACTION = { thresholdTokens: 1000, keepRecentTokens: 20 };
const LONG_TASK = `请读 a.txt。${"背景说明。".repeat(60)}`;

test("压缩前已复盘的会话：补做仍给完整上下文，指令写明第 N 条及之前已复盘；复盘记录记下此前的覆盖位置，covers 记到会话末尾", async () => {
  const { root, cleanup } = tempRoot("pigeon-coverage-precompact-");
  try {
    initRepo(root, { "a.txt": "内容\n" });
    launchedLongAgo(root);
    const { streamFn } = routedModel({ main: COMPACTING_MAIN });
    const session = await openTuiSession({
      root,
      streamFn,
      compaction: COMPACTION,
      task: LONG_TASK,
    });
    await session.run("再看一眼");
    await session.close();
    const [pre] = reviewsOf(root, session.sessionId);
    assert.equal(pre?.start.memoryReview?.kind, "pre-compaction");
    const preCovers = pre?.start.memoryReview?.covers;
    assert.ok(preCovers !== undefined);
    const model = routedModel({});
    const summary = await backfill(root, model.streamFn);
    assert.deepEqual(summary.completed, [session.sessionId]);
    const reviewCall = model.calls.find((call) => call.kind === "review");
    const instruction = instructionOf(reviewCall);
    const match = /\n\n第 (\d+) 条及之前已复盘，重点看之后的部分。\n\n/.exec(instruction);
    assert.ok(match !== null, instruction.slice(0, 200));
    assert.ok(instruction.startsWith("【复盘 v1】这次会话的工作已经结束。"));
    const n = Number(match[1]);
    // 第 N 条是已复盘的最后一条（压缩前的工具结果），其后第一条是压缩之后的"读完了"
    const context = reviewCall?.messages ?? [];
    assert.equal(textOf(context[n] ?? {}), "读完了");
    assert.notEqual(textOf(context[n - 1] ?? {}), "读完了");
    const backfilled = reviewsOf(root, session.sessionId).find(
      (review) => review.start.memoryReview?.backfill !== undefined
    );
    const last = lastMessage(root, session.sessionId);
    assert.deepEqual(backfilled?.start.memoryReview?.covers, { entryId: last.id, seq: last.seq });
    assert.deepEqual(backfilled?.start.memoryReview?.backfill?.priorCovers, {
      ...preCovers,
      messages: n,
    });
    // 补到末尾之后不再补
    const again = await backfill(root, routedModel({}).streamFn);
    assert.equal(again.planned, 0);
  } finally {
    cleanup();
  }
});

test("补做过又被续聊的会话：补新增部分，指令写明此前已复盘到第几条", async () => {
  const { root, cleanup } = tempRoot("pigeon-coverage-resume-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    launchedLongAgo(root);
    const { streamFn } = routedModel({});
    const first = await openTuiSession({ root, streamFn, task: "第一件事" });
    await first.close();
    const firstBackfill = routedModel({});
    assert.deepEqual((await backfill(root, firstBackfill.streamFn)).completed, [first.sessionId]);
    // 第一次补做没有此前的复盘：指令与模板逐字相同，不加那一句
    assert.ok(
      !instructionOf(firstBackfill.calls.find((c) => c.kind === "review")).includes("已复盘")
    );
    const firstCovers = reviewsOf(root, first.sessionId)[0]?.start.memoryReview?.covers;
    assert.ok(firstCovers !== undefined);
    // 续聊
    const resumed = await openTuiSession({
      root,
      streamFn,
      resume: first.sessionId,
      task: "第二件事",
    });
    await resumed.close();
    const secondBackfill = routedModel({});
    assert.deepEqual((await backfill(root, secondBackfill.streamFn)).completed, [first.sessionId]);
    const reviewCall = secondBackfill.calls.find((call) => call.kind === "review");
    const match = /第 (\d+) 条及之前已复盘，重点看之后的部分。/.exec(instructionOf(reviewCall));
    assert.ok(match !== null);
    const n = Number(match[1]);
    assert.equal(n, 2);
    assert.equal(textOf(reviewCall?.messages[n] ?? {}), "第二件事");
    const reviews = reviewsOf(root, first.sessionId);
    assert.equal(reviews.length, 2);
    const second = reviews.find(
      (review) => review.start.memoryReview?.backfill?.priorCovers !== undefined
    );
    assert.deepEqual(second?.start.memoryReview?.backfill?.priorCovers, {
      ...firstCovers,
      messages: 2,
    });
    const last = lastMessage(root, first.sessionId);
    assert.deepEqual(second?.start.memoryReview?.covers, { entryId: last.id, seq: last.seq });
    assert.equal((await backfill(root, routedModel({}).streamFn)).planned, 0);
  } finally {
    cleanup();
  }
});

test("复盘模型未指定：压缩前复盘用会话本身的模型，补做用本次启动的模型", async () => {
  const { root, cleanup } = tempRoot("pigeon-coverage-model-default-");
  try {
    initRepo(root, { "a.txt": "内容\n" });
    launchedLongAgo(root);
    const session = routedModel({ main: COMPACTING_MAIN });
    const handle = await openTuiSession({
      root,
      streamFn: session.streamFn,
      compaction: COMPACTION,
      task: LONG_TASK,
    });
    await handle.close();
    const pre = session.calls.filter((call) => call.kind === "review");
    assert.ok(pre.length > 0);
    assert.ok(pre.every((call) => call.model === "custom" && call.provider === "custom"));
    // 补做：本次启动的模型
    const launch = routedModel({});
    await runReviewBackfill({
      governanceRoot: root,
      streamFn: launch.streamFn,
      provider: "launch-provider",
      modelId: "launch-model",
      homeDir: root,
    });
    const reviews = launch.calls.filter((call) => call.kind === "review");
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((c) => c.model === "launch-model" && c.provider === "launch-provider"));
  } finally {
    cleanup();
  }
});

test("复盘模型指定后：压缩前复盘与补做都用它，干活的请求仍用会话本身的模型", async () => {
  const { root, cleanup } = tempRoot("pigeon-coverage-model-set-");
  try {
    initRepo(root, { "a.txt": "内容\n" });
    launchedLongAgo(root);
    const session = routedModel({ main: COMPACTING_MAIN });
    const handle = await openTuiSession({
      root,
      streamFn: session.streamFn,
      compaction: COMPACTION,
      task: LONG_TASK,
      reviewModel: REVIEW_MODEL,
    });
    await handle.close();
    const pre = session.calls.filter((call) => call.kind === "review");
    assert.ok(pre.length > 0);
    assert.ok(pre.every((c) => c.model === "review-model" && c.provider === "review-provider"));
    assert.ok(
      session.calls.filter((call) => call.kind === "main").every((c) => c.model === "custom")
    );
    const launch = routedModel({});
    await runReviewBackfill({
      governanceRoot: root,
      streamFn: launch.streamFn,
      provider: "launch-provider",
      modelId: "launch-model",
      reviewModel: REVIEW_MODEL,
      homeDir: root,
    });
    const reviews = launch.calls.filter((call) => call.kind === "review");
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((c) => c.model === "review-model" && c.provider === "review-provider"));
  } finally {
    cleanup();
  }
});

test("复盘模型的配置：.pigeon/memory-review.json 指定即填进启动参数，没有即不填，畸形响亮失败", () => {
  const { root, cleanup } = tempRoot("pigeon-coverage-model-config-");
  try {
    const flags = () => ({ provider: "custom", modelId: "custom" }) as unknown as LaunchFlags;
    const none = flags();
    applyReviewModelConfig(none, root);
    assert.equal(none.reviewModel, undefined);
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    const path = join(root, ".pigeon", "memory-review.json");
    writeFileSync(path, '{"version":1,"reviewModel":{"provider":"p","model":"m"}}\n');
    const set = flags();
    applyReviewModelConfig(set, root);
    assert.deepEqual(set.reviewModel, { provider: "p", modelId: "m" });
    writeFileSync(path, '{"version":1,"reviewModel":{"model":"m"}}\n');
    assert.throws(() => applyReviewModelConfig(flags(), root), /复盘配置校验失败/);
  } finally {
    cleanup();
  }
});
