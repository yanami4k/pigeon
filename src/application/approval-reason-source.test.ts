// 拒绝理由（决策 066）：审批 handler 交回的理由逐字反馈给模型，作为被拒调用的工具结果正文记进会话存储；
// 不带理由的拒绝（TUI [n]、CLI 留空）由治理层落默认文案。审批决定（人工拒绝）挂在该工具结果的运行面标记上。
// 理由来源（人写 / 系统默认）原只记在旧决定记录里，随旧账本停写，会话存储不再记这一项。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { loadStoreSession } from "../persistence/session-view.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolGovernance } from "./governance.ts";
import { openSessionStore } from "./session-store.ts";

const ORIGINAL = "alpha\nbeta\n";

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

function makeSnapshot(deny: string[] = []): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: ["edit_file"], deny, approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1_700_000_000_000,
  };
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

async function runRejected(options: {
  deny?: string[];
  approval?: { approved: false; reason?: string; reasonSource?: "human" | "system-default" };
}): Promise<{ text: string; gate: unknown }> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-reason-source-"));
  writeFileSync(join(root, "a.ts"), ORIGINAL);
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const sessionId = newSessionId();
  const faults: unknown[] = [];
  const sessionStore = openSessionStore({
    sessionsDir,
    sessionId,
    cwd: root,
    onFault: (fault) => faults.push(fault),
  });
  try {
    const adapter = new PiRuntimeAdapter({
      snapshot: makeSnapshot(options.deny ?? []),
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改", toolCalls: [{ name: "edit_file", args: editCall(ORIGINAL) }] },
          { text: "好" },
        ],
      }),
      governance: createToolGovernance({
        registry: makeRegistry(),
        ...(options.approval !== undefined
          ? { approvalHandler: async () => options.approval as never }
          : {}),
      }),
      tools: [createEditFileTool(root)],
      sessionId,
      sessionStore,
    });
    await adapter.run("改文件");
    await adapter.dispose();
    await sessionStore.close();
    assert.deepEqual(faults, []);
    // 被拒调用的工具结果：只有这一条，是错误，文件未被改动
    const loaded = loadStoreSession(sessionsDir, sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    const results = (loaded.view.runs[0]?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1, "拒绝路径必须留下一条工具结果");
    const result = results[0] as StoreMessage;
    assert.equal(result.isError, true);
    const text = Array.isArray(result.content)
      ? (result.content as Array<{ type: string; text?: string }>)
          .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
          .join("")
      : "";
    return { text, gate: toolResultMark(result)?.gate };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("默认文案：handler 不带理由（TUI [n] / CLI 留空）时工具结果正文是默认文案", async () => {
  const recorded = await runRejected({ approval: { approved: false } });
  assert.equal(recorded.text, "人工拒绝");
  assert.deepEqual(recorded.gate, { outcome: "rejected", approvedBy: "human" });
});
