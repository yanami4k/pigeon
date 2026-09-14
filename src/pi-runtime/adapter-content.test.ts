// M5 S1（决策 037 / 044 / 045）：Adapter 在 message_end 把消息交给落盘口——三种角色加
// thinking 落进旁置内容文件、entry 回指哈希、turn.completed 携带 usage、thinking 持久化开关。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import { newSessionId } from "../state/ids.ts";
import { recomputeContentHash } from "../state/message-content.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function makeSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: ["edit_file"], deny: [], approvalMode: "yolo" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

test("三角色加 thinking 落盘：内容记录与 entry 逐条对齐、哈希相符、正文与 thinking 可读回", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-adapter-content-"));
  const original = "alpha\nbeta\ngamma\n";
  writeFileSync(join(root, "a.ts"), original);
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({
        replies: [
          {
            thinking: "先看锚点再改",
            text: "我来改",
            toolCalls: [{ name: "edit_file", args: editCall(original) }],
          },
          { text: "改完了" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId,
      eventLog,
    });
    const result = await adapter.run("把 beta 改成大写");
    assert.equal(result.status, "completed");
    await adapter.dispose();
    eventLog.close();

    const materialized = materializeSession(sessionsDir, sessionId);
    // M5 S5（决策 044）：内容文件首条是 system prompt 全文（runSeq 0，不对应 entry），逐条对齐只看消息记录
    const records = readMessageContentFileDetailed(
      JsonlEventLog.contentFilePathFor(sessionsDir, sessionId)
    ).records.filter((record) => record.role !== "system");
    assert.deepEqual(
      records.map((record) => [record.runSeq, record.role]),
      [
        [1, "user"],
        [2, "assistant"],
        [3, "toolResult"],
        [4, "assistant"],
      ]
    );
    for (const [index, record] of records.entries()) {
      const entry = materialized.entries[index];
      assert.equal(record.entryId, entry?.id);
      assert.equal(record.contentHash, entry?.contentHash);
      assert.equal(recomputeContentHash(record), record.contentHash);
    }
    assert.deepEqual(records[0]?.blocks, [
      { type: "text", text: "把 beta 改成大写", truncated: false },
    ]);
    assert.deepEqual(records[1]?.blocks, [
      { type: "thinking", thinking: "先看锚点再改", truncated: false },
      { type: "text", text: "我来改", truncated: false },
      { type: "toolCall", id: "tc-1-1", name: "edit_file" },
    ]);
    assert.equal(records[2]?.toolName, "edit_file");
    assert.equal(records[2]?.toolCallId, "tc-1-1");
    assert.equal(records[2]?.isError, false);
    assert.equal(records[2]?.blocks[0]?.type, "text");
    assert.deepEqual(materialized.contentGaps, []);
    assert.deepEqual(materialized.entryGaps, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn.completed 携带 usage：每轮的 token 与成本随归一化事件落盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-adapter-usage-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId);
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({ replies: [{ text: "你好" }] }),
      sessionId,
      eventLog,
    });
    await adapter.run("hi");
    await adapter.dispose();
    eventLog.close();

    const completed = materializeSession(sessionsDir, sessionId).runtimeEvents.find(
      (event) => event.kind === "turn.completed"
    );
    assert.ok(completed?.kind === "turn.completed");
    const usage = completed.payload.usage;
    assert.ok(usage !== undefined, "turn.completed 必须携带 usage");
    assert.ok(usage.output > 0);
    assert.equal(usage.totalTokens, usage.output);
    assert.deepEqual(Object.keys(usage.cost).sort(), [
      "cacheRead",
      "cacheWrite",
      "input",
      "output",
      "total",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thinking 持久化开关关闭：内容文件只留 thinking 的字节数与哈希，不存思维链正文", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-adapter-thinking-off-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(sessionsDir, sessionId, {
      content: { persistThinking: false },
    });
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(),
      streamFn: createFakeStreamFn({ replies: [{ thinking: "秘密推理", text: "结论" }] }),
      sessionId,
      eventLog,
    });
    await adapter.run("问");
    await adapter.dispose();
    eventLog.close();

    // 内容文件首条是 system prompt 全文记录（M5 S5），只看消息记录
    const records = readMessageContentFileDetailed(
      JsonlEventLog.contentFilePathFor(sessionsDir, sessionId)
    ).records.filter((record) => record.role !== "system");
    const thinking = records[1]?.blocks[0];
    assert.ok(thinking?.type === "thinking");
    assert.equal(thinking.omitted, true);
    assert.equal(thinking.thinking, "");
    assert.ok(!JSON.stringify(records).includes("秘密推理"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
