// 结构化记忆删除（决策 174）之前的旧会话：run.started 里带结构化记忆留痕与这一步起点，只存在于旧格式会话文件里。
// 新代码不读旧格式（187 / 211）：这类会话在会话列表里只计入提示行，trace 与 replay 说明它是旧格式会话并指向只读的
// 旧版代码，不报"会话不存在"
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionListCommand } from "../application/session-list.ts";
import { writeLegacySessionFile } from "../application/session-view-fixtures.ts";
import { newRunId } from "../state/ids.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

test("旧格式会话（带结构化记忆留痕的旧会话所在）：显示读者只给旧格式会话提示并指向旧版代码", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-legacy-memory-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = writeLegacySessionFile(sessionsDir);
    const runId = newRunId();

    assert.equal(
      runSessionListCommand({ root, filters: {} }),
      "尚无会话记录。\n另有 1 个旧格式会话（迁移之前创建）未列出；旧格式会话请用只读的旧版代码 455d88d 读取\n"
    );
    const hint = `会话 ${sessionId} 是旧格式会话（迁移之前创建），这里不读；旧格式会话请用只读的旧版代码 455d88d 读取`;
    assert.throws(
      () => runTraceCommand({ root, sessionId, withContent: false }),
      (error: unknown) => error instanceof Error && error.message === hint
    );
    assert.throws(
      () => runReplayCommand({ root, runId, sessionId, withContent: false }),
      (error: unknown) => error instanceof Error && error.message === hint
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
