// M4 S5：session list 命令层测试（D5：列表默认安静）。M2 S4：命令层自 cli/session.ts 归位 application/session-list.ts。
// 读新会话存储：覆盖安静行、从旧到新的顺序、过滤器（工具、Run 级失败分类、时间）、旧格式会话只给计数提示。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import { runSessionListCommand } from "./session-list.ts";
import { createFixtureSession, type FixtureSession } from "./session-store-fixtures.ts";

const FIRST = asSessionId("sess_01JAAAAAA10000000000000000");
const SECOND = asSessionId("sess_01JAAAAAA20000000000000000");

function makeRoot(): { root: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-cmd-"));
  return {
    root,
    sessionsDir: join(root, ".pigeon", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seed(
  sessionsDir: string,
  sessionId: SessionId,
  write: (session: FixtureSession) => void
): Promise<void> {
  const session = createFixtureSession({ sessionsDir, sessionId });
  write(session);
  await session.close();
}

// 会话列表行的时间：UTC ISO 切到分钟
function minute(sessionId: SessionId): string {
  return new Date(sessionCreatedAt(sessionId)).toISOString().slice(0, 16).replace("T", " ");
}

test("session list：一会话一行安静行（时间 + Run 数 + 会话 id），从旧到新，无突出行与徽章", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    // 先写新的、再写旧的：顺序按会话创建时间，不按写入先后
    await seed(sessionsDir, SECOND, (s) => {
      s.startRun({ task: "a" });
      s.toolTurn({ name: "edit_file" });
      s.endRun();
    });
    await seed(sessionsDir, FIRST, (s) => {
      s.startRun({ task: "b" });
      s.endRun();
      s.startRun({ task: "c" });
    });
    assert.equal(
      runSessionListCommand({ root }),
      `${minute(FIRST)}  2 个 Run  ${FIRST}\n${minute(SECOND)}  1 个 Run  ${SECOND}\n`
    );
  } finally {
    cleanup();
  }
});

test("session list：过滤器透传（tool / class / since / until）与空目录文案", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    assert.equal(runSessionListCommand({ root }), "尚无会话记录。\n");
    await seed(sessionsDir, FIRST, (s) => {
      s.startRun({ task: "a" });
      s.toolTurn({ name: "read_file" });
      s.assistant({ text: "", stopReason: "aborted" });
      s.endRun({ ending: "aborted" });
    });
    await seed(sessionsDir, SECOND, (s) => {
      s.startRun({ task: "b" });
      s.toolTurn({ name: "edit_file" });
      // 有开始无收尾：崩溃残留，分类为未知
    });

    const byTool = runSessionListCommand({ root, filters: { tool: "read_file" } });
    assert.ok(byTool.includes(FIRST) && !byTool.includes(SECOND));
    const cancelled = runSessionListCommand({ root, filters: { class: "cancelled" } });
    assert.ok(cancelled.includes(FIRST) && !cancelled.includes(SECOND));
    const unknown = runSessionListCommand({ root, filters: { class: "unknown" } });
    assert.ok(unknown.includes(SECOND) && !unknown.includes(FIRST));
    const until = runSessionListCommand({ root, filters: { until: sessionCreatedAt(FIRST) } });
    assert.ok(until.includes(FIRST) && !until.includes(SECOND));
    const sinceFuture = runSessionListCommand({
      root,
      filters: { since: Date.now() + 86_400_000 },
    });
    assert.equal(sinceFuture, "尚无会话记录。\n");
  } finally {
    cleanup();
  }
});

test("session list：旧格式会话（会话根下平铺的 sess_<ULID>.jsonl）不列出，末尾给一行计数提示", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    await seed(sessionsDir, SECOND, (s) => s.startRun({ task: "a" }));
    // 新存储里有同号文件的平铺文件不算旧格式会话；旁置文件名不合 sess_<ULID>.jsonl 的也不算
    writeFileSync(join(sessionsDir, `${SECOND}.jsonl`), "");
    writeFileSync(join(sessionsDir, `${FIRST}.jsonl`), "");
    writeFileSync(join(sessionsDir, `${FIRST}.messages.jsonl`), "");
    const notice =
      "另有 1 个旧格式会话（迁移之前创建）未列出；旧格式会话请用只读的旧版代码 455d88d 读取";
    assert.equal(
      runSessionListCommand({ root }),
      `${minute(SECOND)}  1 个 Run  ${SECOND}\n${notice}\n`
    );
    assert.equal(
      runSessionListCommand({ root, filters: { tool: "无此工具" } }),
      `尚无会话记录。\n${notice}\n`
    );
  } finally {
    cleanup();
  }
});
