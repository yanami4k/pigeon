// 拒绝理由来源（决策 066）：决定记录新增可选的理由来源字段——人写 / 系统默认。
// 审批 handler 交回理由时标人写（TUI [r]、CLI 输入了理由）；不带理由的拒绝由治理层落默认文案
// 并标系统默认（TUI [n]、CLI 留空）；策略自动拒绝（deny 清单、无审批通道 fail-closed）同样是系统默认。
// 加法式可选字段，不升 Event Log 版本（口径同 052）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolGovernance } from "./governance.ts";

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
}): Promise<{ reason?: string; reasonSource?: string }> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-reason-source-"));
  writeFileSync(join(root, "a.ts"), ORIGINAL);
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const eventLog = new JsonlEventLog(sessionsDir, sessionId);
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
      eventLog,
    });
    await adapter.run("改文件");
    await adapter.dispose();
    eventLog.close();
    const decision = materializeSession(sessionsDir, sessionId, { content: false }).decisions[0];
    assert.ok(decision, "拒绝路径必须落 decision 记录");
    return {
      ...(decision.decision.reason !== undefined ? { reason: decision.decision.reason } : {}),
      ...(decision.decision.reasonSource !== undefined
        ? { reasonSource: decision.decision.reasonSource }
        : {}),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("人写理由：handler 交回理由并标人写，decision 记录逐字保留理由与来源", async () => {
  const recorded = await runRejected({
    approval: { approved: false, reason: "这个文件不该动", reasonSource: "human" },
  });
  assert.equal(recorded.reason, "这个文件不该动");
  assert.equal(recorded.reasonSource, "human");
});

test("系统默认：handler 不带理由（TUI [n] / CLI 留空）时落默认文案并标系统默认", async () => {
  const recorded = await runRejected({ approval: { approved: false } });
  assert.equal(recorded.reason, "人工拒绝");
  assert.equal(recorded.reasonSource, "system-default");
});

test("策略自动拒绝：deny 清单与无审批通道 fail-closed 的理由同样标系统默认", async () => {
  const denied = await runRejected({ deny: ["edit_file"] });
  assert.equal(denied.reasonSource, "system-default");
  const failClosed = await runRejected({});
  assert.equal(failClosed.reasonSource, "system-default");
});
