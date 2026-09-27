// trace 的 worker 父子投影（M5.5 S4，决策 040）：父会话列出派出的 worker 与进入命令，未收尾如实标注，
// 孤立的收尾归异常项；worker 会话回指父会话。读新会话存储：派出与收尾是父会话里的 worker 条目，来历在子会话文件头。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runTraceCommand } from "./trace.ts";

test("trace：父会话列出 worker（已收尾给结果与进入命令、未收尾标注 resume 入口、孤立收尾归异常）；worker 会话回指父会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-workers-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const parent = createFixtureSession({ sessionsDir });
    parent.startRun({ task: "派活" });
    const done = spawnFixtureWorker(parent, { sessionsDir, name: "fix-a", task: "改" });
    done.startRun({ task: "改" });
    done.endRun();
    const { sessionId: doneId } = await done.close();
    parent.workerSettled({ childSessionId: doneId, name: "fix-a", turns: 2 });
    const hanging = spawnFixtureWorker(parent, { sessionsDir, name: "fix-b", task: "改" });
    const { sessionId: hangingId } = await hanging.close();
    const stray = newSessionId();
    parent.workerSettled({ childSessionId: stray, name: "ghost", status: "failed", turns: 0 });
    parent.endRun();
    const { sessionId: parentId } = await parent.close();

    const parentTrace = runTraceCommand({ root, sessionId: parentId });
    assert.ok(parentTrace.includes("派出的 worker（2）："), parentTrace);
    assert.ok(
      parentTrace.includes(
        `  fix-a（implementer）｜ 会话 ${doneId.slice(0, 13)}… ｜ completed ｜ 2 轮 ｜ 改动 0 个文件 ｜ 进入：trace ${doneId}`
      ),
      parentTrace
    );
    assert.ok(
      parentTrace.includes(
        `未收尾：有派出无收尾（进程中断可能；用 resume ${hangingId} 进入该 worker 会话）`
      ),
      parentTrace
    );
    assert.ok(
      parentTrace.includes(`  孤立的 worker 收尾：ghost（会话 ${stray.slice(0, 13)}…）无对应派出`),
      parentTrace
    );
    assert.ok(!parentTrace.includes("Receipt"), parentTrace);

    const workerTrace = runTraceCommand({ root, sessionId: doneId });
    assert.ok(
      workerTrace.includes(
        `worker 会话：fix-a（implementer）｜ 分支 fix-a ｜ 父会话 ${parentId}（查看：trace ${parentId}）`
      ),
      workerTrace
    );
    assert.equal(workerTrace.includes("派出的 worker"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
