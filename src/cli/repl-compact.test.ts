// 命令行对话里的上下文压缩（决策 189）：/compact [重点] 手动压缩，重点作为摘要的附加说明；每次压缩（自动或手动）
// 打印一行压缩前后的 token 数。用真实运行面与会话存储。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolGovernance } from "../application/governance.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { ContextCompactor, resolveCompactionConfig } from "../pi-runtime/compaction.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runRepl } from "./repl.ts";

const LONG_TASK = `请修好 a.ts 里的空指针，${"细节说明。".repeat(80)}`;
const LONG_REPLY = "我已经读完了相关文件，接下来开始修改。".repeat(3);

async function replWith(lines: string[], replies: FakeReply[], threshold: number) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-repl-compact-"));
  const sessionId = newSessionId();
  const store = openSessionStoreWriter({
    sessionsRoot: join(root, ".pigeon", "sessions"),
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  const streamFn = createFakeStreamFn({ replies });
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: { policy: { allow: [], deny: [], approvalMode: "yolo" }, advertised: [] },
      context: { systemPrompt: "你是测试助手。" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn,
    governance: createToolGovernance({ registry: new ToolRegistry() }),
    sessionId,
    sessionStore: store,
    compaction: new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: threshold, keepRecentTokens: 5 }),
      streamFn,
      model: {
        id: "fake-model-1",
        name: "fake-model-1",
        api: "anthropic-messages",
        provider: "fake-provider",
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 1024,
      },
    }),
  });
  const queue = [...lines];
  const outputs: string[] = [];
  try {
    await runRepl({
      adapter,
      ask: async () => queue.shift() ?? null,
      write: (text) => {
        outputs.push(text);
      },
    });
  } finally {
    await adapter.dispose();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
  return { terminal: outputs.join(""), streamFn };
}

test("自动压缩：下一条输入发出前压缩时打印一行压缩前后的 token 数", async () => {
  const { terminal } = await replWith(
    [LONG_TASK, "第二问", ":quit"],
    [
      { text: LONG_REPLY, contextTokens: 5000 },
      { text: "## Goal\n第一问" },
      { text: "第二问的回答", contextTokens: 300 },
    ],
    1000
  );
  assert.match(terminal, /上下文已压缩（自动，Run 开始前）：约 \d+ → \d+ token/);
});

test("/compact 重点：手动压缩，重点作为摘要的附加说明，打印一行压缩前后的 token 数", async () => {
  const { terminal, streamFn } = await replWith(
    [LONG_TASK, "第二问", "/compact 保留 a.ts 的改动", ":quit"],
    [
      { text: LONG_REPLY, contextTokens: 50 },
      { text: LONG_REPLY, contextTokens: 80 },
      { text: "## Goal\n手动" },
      { text: "## Turn\n前段" },
    ],
    900_000
  );
  assert.match(terminal, /上下文已压缩（手动）：约 \d+ → \d+ token/);
  assert.ok(
    streamFn.calls.some((call) =>
      JSON.stringify(call.context.messages).includes("Additional focus: 保留 a.ts 的改动")
    )
  );
});

test("/compact 没有可压缩的内容：说明原因，不调用模型", async () => {
  const { terminal, streamFn } = await replWith(
    ["/compact", ":quit"],
    [{ text: "不该出现" }],
    900_000
  );
  assert.ok(terminal.includes("没有可压缩的内容"), terminal);
  assert.equal(streamFn.calls.length, 0);
});
