// trace 的 worker 父子投影（M5.5 S4，决策 040）：父会话列出派出的 worker 与进入命令，未收尾如实标注，
// 孤立 settled 归异常项；worker 会话回指父会话。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newReceiptId, newSessionId } from "../state/ids.ts";
import { runTraceCommand } from "./trace.ts";

test("trace：父会话列出 worker（已收尾给结果与进入命令、未收尾标注 resume 入口、孤立 settled 归异常）；worker 会话回指父会话", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-workers-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const parentId = newSessionId();
    const done = newSessionId();
    const hanging = newSessionId();
    const stray = newSessionId();
    const workspace = (name: string) => ({
      kind: "git-worktree" as const,
      path: `/repo/.pigeon/worktrees/x-${name}`,
      branch: `pigeon/${name}`,
    });
    const parent = new JsonlEventLog(sessionsDir, parentId);
    for (const [id, name] of [
      [done, "fix-a"],
      [hanging, "fix-b"],
    ] as const) {
      parent.appendChildSpawned({
        childSessionId: id,
        name,
        role: "implementer",
        task: "改",
        policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
        limits: { maxTurns: 5, wallClockMs: 1000 },
        workspace: workspace(name),
        spawnedAt: 1,
      });
    }
    parent.appendChildSettled({
      childSessionId: done,
      name: "fix-a",
      status: "completed",
      turns: 2,
      settledAt: 2,
      result: {
        branch: "pigeon/fix-a",
        changedFiles: ["a.ts"],
        receiptIds: [newReceiptId()],
        summary: "好了",
        summaryTruncated: false,
      },
    });
    parent.appendChildSettled({
      childSessionId: stray,
      name: "ghost",
      status: "failed",
      turns: 0,
      settledAt: 3,
    });
    parent.close();

    const worker = new JsonlEventLog(sessionsDir, done);
    worker.appendSessionHeader({
      parentSessionId: parentId,
      worker: { name: "fix-a", role: "implementer" },
      workspace: workspace("fix-a"),
      startedAt: 1,
    });
    worker.close();

    const parentTrace = runTraceCommand({ root, sessionId: parentId });
    assert.ok(parentTrace.includes("派出的 worker（2）："), parentTrace);
    assert.ok(
      parentTrace.includes(`fix-a（implementer）｜ 会话 `) &&
        parentTrace.includes(
          `completed ｜ 2 轮 ｜ 改动 1 个文件 ｜ Receipt 1 条 ｜ 进入：trace ${done}`
        ),
      parentTrace
    );
    assert.ok(
      parentTrace.includes(
        `未收尾：有 child.spawned 无 child.settled（进程中断可能；用 resume ${hanging} 进入该 worker 会话对账）`
      ),
      parentTrace
    );
    assert.ok(parentTrace.includes("孤立 child.settled：ghost"), parentTrace);

    const workerTrace = runTraceCommand({ root, sessionId: done });
    assert.ok(
      workerTrace.includes(
        `worker 会话：fix-a（implementer）｜ 分支 pigeon/fix-a ｜ 父会话 ${parentId}（查看：trace ${parentId}）`
      ),
      workerTrace
    );
    assert.equal(workerTrace.includes("派出的 worker"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
