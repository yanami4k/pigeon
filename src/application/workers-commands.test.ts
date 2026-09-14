// worker 命令层（M5.5 S4，决策 040）：/spawn 解析、/workers 与状态栏排版、收尾摘要、/cancel 定位。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newReceiptId, newSessionId } from "../state/ids.ts";
import {
  parseSpawnCommand,
  renderWorkerOutcome,
  renderWorkersStatus,
  resolveWorkerRef,
  WorkerCommandError,
  type WorkerStatus,
  workerStatusBar,
} from "./workers-commands.ts";

function status(name: string, state: WorkerStatus["state"], turns = 0): WorkerStatus {
  return {
    sessionId: newSessionId(),
    name,
    role: "implementer",
    state,
    turns,
    branch: `pigeon/${name}`,
    startedAt: 0,
    workspace: {
      kind: "git-worktree",
      path: `/repo/.pigeon/worktrees/x-${name}`,
      branch: `pigeon/${name}`,
    },
  };
}

test("/spawn 解析：角色 + 可选 --name + 带引号或不带引号的任务；缺角色或任务报用法", () => {
  assert.deepEqual(parseSpawnCommand(' implementer "修复 a.ts 的空指针"'), {
    role: "implementer",
    task: "修复 a.ts 的空指针",
  });
  assert.deepEqual(parseSpawnCommand("explorer --name look 看看目录结构"), {
    role: "explorer",
    task: "看看目录结构",
    name: "look",
  });
  assert.deepEqual(parseSpawnCommand("reviewer “审一遍改动”"), {
    role: "reviewer",
    task: "审一遍改动",
  });
  assert.throws(() => parseSpawnCommand(""), WorkerCommandError);
  assert.throws(() => parseSpawnCommand("implementer"), WorkerCommandError);
  assert.throws(() => parseSpawnCommand('implementer ""'), WorkerCommandError);
  assert.throws(() => parseSpawnCommand("--name x 任务"), WorkerCommandError);
});

test("/workers 与状态栏：人读清单列出状态、轮次、分支、会话；状态栏纯 ASCII，无 worker 为空串", () => {
  assert.equal(renderWorkersStatus([]), "本会话尚未派出 worker（用 /spawn 派出）");
  const running = status("fix-a", "running", 3);
  const done = status("fix-b", "turn-limit", 40);
  const text = renderWorkersStatus([running, done]);
  assert.ok(
    text.includes(
      `fix-a（implementer）｜ 进行中 ｜ 3 轮 ｜ 分支 pigeon/fix-a ｜ 会话 ${running.sessionId}`
    ),
    text
  );
  assert.ok(text.includes("fix-b（implementer）｜ 达到轮次上限 ｜ 40 轮"), text);
  assert.equal(workerStatusBar([]), "");
  const bar = workerStatusBar([running, done]);
  assert.equal(bar, "workers: fix-a running 3t | fix-b turn-limit");
  assert.ok(/^[\x20-\x7e]*$/.test(bar), "状态栏纯 ASCII");
});

test("收尾摘要：状态、分支、改动文件、Receipt 数、自述与工作树位置；失败带原因", () => {
  const sessionId = newSessionId();
  const text = renderWorkerOutcome({
    sessionId,
    name: "fix-a",
    role: "implementer",
    status: "completed",
    turns: 2,
    workspace: {
      kind: "git-worktree",
      path: "/repo/.pigeon/worktrees/x-fix-a",
      branch: "pigeon/fix-a",
    },
    result: {
      branch: "pigeon/fix-a",
      changedFiles: ["a.ts", "b.ts"],
      receiptIds: [newReceiptId()],
      summary: "改好了",
      summaryTruncated: true,
    },
  });
  assert.ok(
    text.includes(`== worker fix-a（implementer）收尾：完成 ｜ 2 轮 ｜ 会话 ${sessionId} ==`),
    text
  );
  assert.ok(text.includes("分支 pigeon/fix-a ｜ 改动 2 个文件：a.ts、b.ts ｜ Receipt 1 条"), text);
  assert.ok(text.includes("自述：改好了（已截断，全文见 worker 会话）"), text);
  assert.ok(text.includes("工作树 /repo/.pigeon/worktrees/x-fix-a"), text);

  const failed = renderWorkerOutcome({
    sessionId,
    name: "fix-a",
    role: "implementer",
    status: "spawn-failed",
    error: "工作树建不起来",
    turns: 0,
    workspace: { kind: "git-worktree", path: "/w", branch: "pigeon/fix-a" },
  });
  assert.ok(failed.includes("收尾：派出失败"), failed);
  assert.ok(failed.includes("原因：工作树建不起来"), failed);
});

test("/cancel 定位：按名或会话 id；未知报错", () => {
  const worker = status("fix-a", "running");
  assert.equal(resolveWorkerRef([worker], "fix-a"), worker);
  assert.equal(resolveWorkerRef([worker], worker.sessionId), worker);
  assert.throws(() => resolveWorkerRef([worker], "nope"), WorkerCommandError);
});
