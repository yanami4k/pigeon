// 思考不持久化（045）端到端：headless 运行打开该选项时，会话存储不存思考正文——历史与读原文提示
// "未持久化，N 字节"，检索搜不到思考正文；选项缺省时思考照存照显。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadSessionEntryTool } from "../memory/search-tools.ts";
import { createSessionSearch, type SessionSearchHit } from "../memory/session-search.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless.ts";
import { loadSessionHistory } from "./history.ts";
import type { McpSession } from "./mcp.ts";

const THINKING = "内心独白甲乙丙";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

async function run(persistThinking: boolean | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-e2e-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-thinking-home-"));
  const result = await runHeadless({
    task: "说一句",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: createFakeStreamFn({ replies: [{ thinking: THINKING, text: "好的" }] }),
    yolo: true,
    homeDir: home,
    startMcp: noMcp,
    ...(persistThinking !== undefined ? { persistThinking } : {}),
  });
  return {
    root,
    sessionId: result.sessionId,
    sessionsDir: join(root, ".pigeon", "state", "sessions"),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function hits(sessionsDir: string, keyword: string): Promise<SessionSearchHit[]> {
  const found: SessionSearchHit[] = [];
  for await (const hit of createSessionSearch(sessionsDir).search({ keywords: [keyword] })) {
    found.push(hit);
  }
  return found;
}

test("选项关闭：历史与读原文提示未持久化与字节数，检索搜不到思考正文", async () => {
  const t = await run(false);
  try {
    const bytes = Buffer.byteLength(THINKING);
    const history = loadSessionHistory(t.root, t.sessionId).map((line) => line.text);
    assert.deepEqual(history.slice(0, 3), [
      "> 说一句",
      `~ thinking（未持久化，${bytes} 字节）`,
      "好的",
    ]);
    const assistant = loadSessionView(t.sessionsDir, t.sessionId)?.messages[1];
    assert.ok(assistant !== undefined);
    const text = (
      await createReadSessionEntryTool({ sessionsDir: t.sessionsDir }).execute("t", {
        entryId: assistant.entryId,
      })
    ).content
      .map((block) => ("text" in block ? block.text : ""))
      .join("");
    assert.deepEqual(text.split("\n").slice(1), [
      "--- 正文 ---",
      `[thinking 未持久化，${bytes} 字节]`,
      "好的",
    ]);
    assert.equal(text.includes(THINKING), false);
    assert.deepEqual(await hits(t.sessionsDir, THINKING), []);
  } finally {
    t.cleanup();
  }
});

test("选项缺省：思考照存，历史与检索照常呈现思考正文", async () => {
  const t = await run(undefined);
  try {
    const history = loadSessionHistory(t.root, t.sessionId).map((line) => line.text);
    assert.equal(history[1], `~ ${THINKING}`);
    assert.equal((await hits(t.sessionsDir, THINKING)).length, 1);
  } finally {
    t.cleanup();
  }
});
