// 打转检测在复盘上（决策 307）：收尾复盘与补做打转即叫停，已写入的记忆保留，同类只告警一次，补做视同跑完（覆盖判定照常推进）。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { memoryFileOf } from "../memory/learned-store.ts";
import { reviewBackfillDir } from "../persistence/review-backfill-store.ts";
import type { FakeReply } from "../pi-runtime/fixtures.ts";
import { DEFAULT_LOOP_GUARD_SETTINGS } from "../state/loop-guard-config.ts";
import { runHeadless } from "./headless.ts";
import { type ReviewOutcome, reviewWarner } from "./memory-review.ts";
import { runReviewBackfill } from "./review-backfill.ts";
import {
  customOf,
  initRepo,
  mainEntries,
  openTuiSession,
  reviewsOf,
  routedModel,
  tempRoot,
} from "./tui-session-fixtures.ts";

// 复盘先记一条，然后每轮读同一个文件（回复用完即重复最后一条）
const LOOPING_REVIEW: FakeReply[] = [
  {
    text: "先记一条",
    toolCalls: [
      {
        name: "update_memory",
        args: { action: "add", fact: "打转之前记下的事实", refs: ["a.txt"], reason: "复盘看到" },
      },
    ],
  },
  { text: "再看看", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
];

test("收尾复盘打转：第 20 轮叫停，已写入的记忆保留，这一步的结果不受影响；告警只说一次", async () => {
  const { root, cleanup } = tempRoot("pigeon-loop-review-");
  try {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const { streamFn } = routedModel({ main: [{ text: "干完了" }], review: LOOPING_REVIEW });
    const warned: string[] = [];
    const result = await runHeadless({
      task: "看一眼",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: root,
      skillRoots: [],
      memoryRoots: [],
      pushedMemory: true,
      warn: (line) => warned.push(line),
      loopGuard: DEFAULT_LOOP_GUARD_SETTINGS,
    });
    assert.equal(result.status, "completed");
    const [review] = result.reviews ?? [];
    assert.equal(review?.status, "looping");
    assert.equal(review?.hitLimit, true);
    // 第 1 轮记记忆、第 2 轮起读文件：计到 20 在第 22 轮
    assert.ok((review?.turns ?? 0) <= 23, `turns=${review?.turns}`);
    assert.ok(readFileSync(memoryFileOf(root), "utf8").includes("打转之前记下的事实"));
    assert.deepEqual(warned, ["收尾复盘因打转被叫停：已写入的记忆照常保留，这一步的结果不受影响"]);
    // 复盘会话的 Run 收尾记结束方式为打转
    assert.ok(review?.sessionId !== undefined);
    const ends = customOf<{ ending: string }>(
      mainEntries(root, review.sessionId),
      "pigeon.run-end"
    );
    assert.equal(ends.at(-1)?.ending, "looping");
  } finally {
    cleanup();
  }
});

test("复盘告警：同类只说一次（两次打转叫停只告警一次）", () => {
  const lines: string[] = [];
  const warn = reviewWarner((line) => lines.push(line));
  const outcome: ReviewOutcome = {
    kind: "pre-compaction",
    status: "looping",
    turns: 21,
    tokens: 0,
    wallMs: 1,
    hitLimit: true,
  };
  warn(outcome);
  warn(outcome);
  assert.deepEqual(lines, ["压缩前复盘因打转被叫停：已写入的记忆照常保留，这一步的结果不受影响"]);
});

test("补做打转：叫停后视同跑完——不记失败、覆盖到会话末尾不再补；已写入的记忆保留；告警只说一次", async () => {
  const { root, cleanup } = tempRoot("pigeon-loop-backfill-");
  try {
    initRepo(root, { "a.txt": "内容\n" });
    mkdirSync(reviewBackfillDir(root), { recursive: true });
    writeFileSync(join(reviewBackfillDir(root), "since.json"), '{"version":1,"since":0}\n');
    const sessions: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await openTuiSession({
        root,
        streamFn: routedModel({ main: [{ text: "好了" }] }).streamFn,
        task: `看一眼 ${index}`,
      });
      await session.close();
      sessions.push(session.sessionId);
    }
    const warned: string[] = [];
    const model = routedModel({ review: LOOPING_REVIEW });
    const summary = await runReviewBackfill({
      governanceRoot: root,
      streamFn: model.streamFn,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      warn: (line) => warned.push(line),
      loopGuard: DEFAULT_LOOP_GUARD_SETTINGS,
    });
    assert.deepEqual([...summary.completed].sort(), [...sessions].sort());
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(warned, ["补做复盘因打转被叫停：已写入的记忆照常保留，这个会话视同已复盘"]);
    for (const sessionId of sessions) {
      const backfilled = reviewsOf(root, sessionId).find(
        (review) => review.start.memoryReview?.backfill !== undefined
      );
      assert.equal(
        customOf<{ ending: string }>(backfilled?.entries ?? [], "pigeon.run-end").at(-1)?.ending,
        "looping"
      );
    }
    assert.ok(readFileSync(memoryFileOf(root), "utf8").includes("打转之前记下的事实"));
    // 视同跑完：覆盖判定照常推进，下次启动不再补
    const again = await runReviewBackfill({
      governanceRoot: root,
      streamFn: routedModel({}).streamFn,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      loopGuard: DEFAULT_LOOP_GUARD_SETTINGS,
    });
    assert.equal(again.planned, 0);
  } finally {
    cleanup();
  }
});
