// 决策 279（271 修订）：worker 收尾文字末尾写明起点快照与只取其自身改动的取用方式——spawn_worker 的返回、/spawn 的收尾摘要
// 同一口径；快照起点写带入的未提交文件数，HEAD 起点写明派出时没有未提交的文件；agent 的取用入口是 take_worker，人的是 /take。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkerOutcome, WorkerStartPoint } from "../orchestration/workers.ts";
import { newSessionId } from "../state/ids.ts";
import { SPAWN_WORKER_TEXTS, workerOutcomeText } from "./spawn-worker-tool.ts";
import { renderWorkerOutcome, workerStartLine } from "./workers-commands.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
// 快照起点：带入 3 个未提交的文件
const SNAPSHOT_START: WorkerStartPoint = {
  commit: COMMIT,
  snapshot: true,
  files: ["a.ts", "new.ts", "sub/c.ts"],
};
// HEAD 起点：派出时没有未提交的文件
const HEAD_START: WorkerStartPoint = { commit: COMMIT, snapshot: false, files: [] };

function outcome(overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    sessionId: newSessionId(),
    name: "fix-a",
    role: "implementer",
    status: "completed",
    turns: 2,
    workspace: {
      kind: "git-worktree",
      path: "/repo/.pigeon/state/worktrees/x-fix-a",
      branch: "pigeon/fix-a",
      baseCommit: COMMIT,
    },
    result: {
      branch: "pigeon/fix-a",
      changedFiles: ["a.ts"],
      summary: "改好了",
      summaryTruncated: false,
    },
    start: SNAPSHOT_START,
    ...overrides,
  };
}

test("起点一行：快照起点写带入的未提交文件数，HEAD 起点写明派出时没有未提交的文件；取用方式由调用方给", () => {
  assert.equal(
    workerStartLine(
      { commit: COMMIT, snapshot: true, files: ["a", "b"] },
      "调用 take_worker（worker=fix-a）"
    ),
    "起点：快照 0123456789ab（含派出时 2 个未提交的文件）；要把它的改动叠进你的工作目录，调用 take_worker（worker=fix-a）。"
  );
  assert.equal(
    workerStartLine({ commit: COMMIT, snapshot: false, files: [] }, "用 /take fix-a"),
    "起点：提交 0123456789ab（派出时没有未提交的文件）；要把它的改动叠进你的工作目录，用 /take fix-a。"
  );
});

test("spawn_worker 的返回：完成、撞上限、取消、失败各情形都另起一行写起点与 take_worker 的调法；额度用完的文字不加；没有起点不加", () => {
  // 起点行的格式在上一条核对；这里只看它随各情形另起一行接在末尾，取用方式写 take_worker 的调法
  const takeHint = "调用 take_worker（worker=fix-a）";
  const line = `\n${workerStartLine(SNAPSHOT_START, takeHint)}`;
  assert.equal(
    workerOutcomeText(outcome()),
    `worker fix-a（implementer）已完成。分支：pigeon/fix-a。改动的文件（1）：a.ts。摘要：改好了${line}`
  );
  assert.equal(
    workerOutcomeText(outcome({ status: "turn-limit" })),
    `worker fix-a（implementer）撞上轮数上限，没有做完。分支：pigeon/fix-a。已改动的文件（1）：a.ts。摘要：改好了${line}`
  );
  assert.equal(
    workerOutcomeText(outcome({ status: "cancelled" })),
    `worker fix-a（implementer）被取消。分支 pigeon/fix-a 上可能有部分改动。${line}`
  );
  assert.equal(
    workerOutcomeText(outcome({ status: "failed", error: "炸了" })),
    `worker fix-a（implementer）失败：炸了。分支 pigeon/fix-a 上可能有部分改动。${line}`
  );
  // 摘要截断的补句在起点行之前
  const truncated = outcome({
    result: { branch: "pigeon/fix-a", changedFiles: [], summary: "长", summaryTruncated: true },
  });
  assert.ok(
    workerOutcomeText(truncated).endsWith(
      `${SPAWN_WORKER_TEXTS.truncated(truncated.sessionId)}${line}`
    )
  );
  assert.equal(
    workerOutcomeText(outcome({ status: "cancelled" }), true),
    SPAWN_WORKER_TEXTS.budgetExhausted
  );
  const plain = outcome();
  delete plain.start;
  assert.ok(!workerOutcomeText(plain).includes("起点："));
  // HEAD 起点
  assert.ok(
    workerOutcomeText(outcome({ start: HEAD_START })).endsWith(
      `\n${workerStartLine(HEAD_START, takeHint)}`
    )
  );
});

// 决策 377：只读的 explorer 只交回摘要；决策 381：worker 新建却过大的文件另起一行列出
test("explorer 的交回不提分支、改动与起点；没收进交回的大文件列在 spawn_worker 与 /spawn 的交回里", () => {
  const explorer = outcome({
    role: "explorer",
    workspace: { kind: "shared", path: "/repo" },
    result: { summary: "查清了", summaryTruncated: false },
  });
  delete explorer.start;
  assert.equal(workerOutcomeText(explorer), "worker fix-a（explorer）已完成。摘要：查清了");
  const withSkipped = outcome({
    result: {
      branch: "pigeon/fix-a",
      changedFiles: [],
      summary: "改好了",
      summaryTruncated: false,
      skippedFiles: [{ path: "dump.bin", bytes: 30 * 1024 * 1024 }],
    },
  });
  assert.ok(workerOutcomeText(withSkipped).includes("dump.bin（30.0 MiB）"));
  assert.ok(renderWorkerOutcome(withSkipped).includes("dump.bin（30.0 MiB）"));
});

test("/spawn 的收尾摘要：同样加起点一行，取用方式写 /take <名>；没有起点不加", () => {
  const text = renderWorkerOutcome(outcome());
  assert.ok(text.endsWith(`\n  ${workerStartLine(SNAPSHOT_START, "用 /take fix-a")}`), text);
  const plain = outcome();
  delete plain.start;
  assert.ok(!renderWorkerOutcome(plain).includes("起点："));
});
