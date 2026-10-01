// 思考不持久化（045）在新存储的写者上生效：选项关闭时助手消息里的思考块在写入前剥去，只在消息上留"略去的思考"标记
// （原位置、字节数、全文哈希、是否被编辑），与旧账本同样的信息量；续跑时 pi 还原的上下文里没有思考，与旧账本的投影一致。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSessionContext } from "@earendil-works/pi-agent-core";
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import { OMITTED_THINKING_KEY } from "../state/thinking-omission.ts";
import type { AgentMessage } from "./index.ts";
import { createSessionRepo, openSessionStoreWriter } from "./session-store.ts";

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先想想", thinkingSignature: "sig" },
      { type: "text", text: "我来改" },
      { type: "thinking", thinking: "机密", redacted: true },
      { type: "toolCall", id: "tc-1", name: "edit_file", arguments: { path: "a" } },
    ],
    api: "anthropic-messages",
    provider: "p",
    model: "m",
    usage: ZERO,
    stopReason: "toolUse",
    timestamp: 1,
  } as unknown as AgentMessage;
}

async function writeOne(persistThinking: boolean | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-"));
  const sessions = join(root, ".pigeon", "state", "sessions");
  const writer = openSessionStoreWriter({
    sessionsRoot: sessions,
    sessionId: "sess_T",
    cwd: root,
    ...(persistThinking !== undefined ? { persistThinking } : {}),
  });
  const original = assistant();
  const before = structuredClone(original);
  writer.appendMessage({ role: "user", content: "改 a", timestamp: 0 } as unknown as AgentMessage);
  writer.appendMessage(original);
  await writer.close();
  const path = locateSessionFile(sessions, "sess_T")?.path ?? "";
  return {
    root,
    sessions,
    path,
    stored: readSessionFile(path)?.entries.map((entry) => entry.message) ?? [],
    unchanged: JSON.stringify(original) === JSON.stringify(before),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("选项关闭：思考块在写入前剥去，消息上留原位置、字节数、全文哈希与编辑标记；其余块与其余消息原样", async () => {
  const run = await writeOne(false);
  try {
    const [user, stored] = run.stored as Array<Record<string, unknown>>;
    assert.deepEqual(user, { role: "user", content: "改 a", timestamp: 0 });
    assert.deepEqual(stored?.content, [
      { type: "text", text: "我来改" },
      { type: "toolCall", id: "tc-1", name: "edit_file", arguments: { path: "a" } },
    ]);
    assert.deepEqual(stored?.[OMITTED_THINKING_KEY], [
      { index: 0, bytes: Buffer.byteLength("先想想"), hash: sha("先想想") },
      { index: 2, bytes: Buffer.byteLength("机密"), hash: sha("机密"), redacted: true },
    ]);
    assert.equal(stored?.stopReason, "toolUse");
    assert.ok(run.unchanged, "运行面手里的消息不被改动");
  } finally {
    run.cleanup();
  }
});

test("选项缺省或打开：思考照存、不加标记", async () => {
  for (const option of [undefined, true]) {
    const run = await writeOne(option);
    try {
      const stored = run.stored[1] as Record<string, unknown>;
      assert.deepEqual(stored.content, (assistant() as unknown as Record<string, unknown>).content);
      assert.equal(OMITTED_THINKING_KEY in stored, false);
    } finally {
      run.cleanup();
    }
  }
});

test("续跑：pi 按会话文件还原的上下文里没有思考块，其余块照旧（同旧账本的投影）", async () => {
  const run = await writeOne(false);
  try {
    const session = await createSessionRepo(run.sessions).open({
      id: "sess_T",
      path: run.path,
    } as never);
    const leaf = await session.getLeafId();
    assert.ok(leaf !== null);
    const context = buildSessionContext(
      await session.findEntriesOnBranch({ start: leaf, order: "oldestFirst" })
    );
    const restored = context.messages[1] as unknown as { content: Array<{ type: string }> };
    assert.deepEqual(
      restored.content.map((block) => block.type),
      ["text", "toolCall"]
    );
  } finally {
    run.cleanup();
  }
});
