// worker 命令层（M5.5 S4，决策 040）：/spawn 解析、收尾摘要、/cancel 定位（/workers 的排版随编排面板移到终端界面，决策 301）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import {
  parseSpawnCommand,
  renderWorkerOutcome,
  resolveWorkerRef,
  WorkerCommandError,
  type WorkerStatus,
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
  assert.deepEqual(parseSpawnCommand("tester “跑一遍测试”"), {
    role: "tester",
    task: "跑一遍测试",
  });
  assert.throws(() => parseSpawnCommand(""), WorkerCommandError);
  assert.throws(() => parseSpawnCommand("implementer"), WorkerCommandError);
  assert.throws(() => parseSpawnCommand('implementer ""'), WorkerCommandError);
  assert.throws(() => parseSpawnCommand("--name x 任务"), WorkerCommandError);
});

test("收尾摘要：状态、分支、改动文件、自述与工作树位置；失败带原因", () => {
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
      summary: "改好了",
      summaryTruncated: true,
    },
  });
  assert.ok(
    text.includes(`== worker fix-a（implementer）收尾：完成 ｜ 2 轮 ｜ 会话 ${sessionId} ==`),
    text
  );
  assert.ok(text.includes("分支 pigeon/fix-a ｜ 改动 2 个文件：a.ts、b.ts\n"), text);
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

// M7（决策 069）：并行派发同一任务的多个尝试（共享任务标识）
test("/spawn --attempts <N>：解析尝试次数（至少 2），可与 --name 以外的写法共存；非法取值报用法", () => {
  assert.deepEqual(parseSpawnCommand('implementer --attempts 2 "把 a.txt 改成 new"'), {
    role: "implementer",
    task: "把 a.txt 改成 new",
    attempts: 2,
  });
  assert.throws(() => parseSpawnCommand('implementer --attempts 1 "x"'), /--attempts/);
  assert.throws(() => parseSpawnCommand('implementer --attempts abc "x"'), /--attempts/);
  assert.throws(
    () => parseSpawnCommand('implementer --attempts 2 --name a "x"'),
    /--attempts/,
    "多个尝试不能共用一个名字"
  );
});
