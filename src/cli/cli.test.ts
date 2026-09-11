// M3 切片 4 冒烟：Readable 模拟 stdin + fake streamFn 驱动真实 Agent，
// 覆盖 REPL 内联审批的拒绝（含理由逐字回模型）与批准（落盘）两条路径。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Type } from "typebox";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import { createAsker, runRepl } from "./repl.ts";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
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

test("REPL 内联审批冒烟：先拒绝（理由逐字进 toolResult、文件不动），再批准（落盘）", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const root = mkdtempSync(join(tmpdir(), "pigeon-cli-"));
  writeFileSync(join(root, "a.ts"), original);
  const outputs: string[] = [];
  try {
    const editArgs: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    };
    // stdin 剧本：任务1 → 拒绝 + 理由 → 任务2 → 批准 → 退出
    const input = Readable.from(
      ["把 beta 改成 BETA\n", "n\n", "会破坏现有逻辑\n", "再改一次\n", "y\n", ":quit\n"],
      { objectMode: false }
    );
    const write = (text: string) => outputs.push(text);
    const { ask, close } = createAsker(input, write);
    const adapter = new PiRuntimeAdapter({
      snapshot: {
        version: INJECTION_SNAPSHOT_VERSION,
        model: { provider: "fake-provider", id: "fake-model-1" },
        tools: {
          policy: { allow: ["edit_file"], deny: [], approvalMode: "prompt" },
          advertised: [],
        },
        context: { systemPrompt: "你是 Pigeon 测试助手。" },
        memory: [],
        skills: [],
        createdAt: 1700000000000,
      },
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改一下", toolCalls: [{ name: "edit_file", args: editArgs }] },
          { text: "好吧，那我不改了" },
          { text: "再试一次", toolCalls: [{ name: "edit_file", args: editArgs }] },
          { text: "已完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createReadFileTool(root), createEditFileTool(root)],
      approvalHandler: createCliApprovalHandler(ask, write),
    });

    await runRepl({ adapter, ask, write });
    close();

    const terminal = outputs.join("");
    // 审批提示出现两次，含工具名、参数与 diff 预览
    assert.equal(terminal.split("人工审批").length - 1, 2, terminal);
    assert.ok(terminal.includes("edit_file"), terminal);
    assert.ok(terminal.includes("-beta"), terminal);
    assert.ok(terminal.includes("+BETA"), terminal);
    // 两次 Run 的终态摘要都打印了
    assert.equal(terminal.split("终态").length - 1, 2, terminal);

    // 拒绝路径：execute 未发生，理由逐字进 toolResult，账本记 human rejected
    const toolResult = adapter.transcript().find((message) => message.role === "toolResult");
    const first = toolResult?.content[0];
    assert.ok(
      first?.type === "text" && first.text === "会破坏现有逻辑",
      JSON.stringify(toolResult)
    );
    const ledger = adapter.toolExecutions();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.decision?.outcome, "rejected");
    assert.equal(ledger[0]?.decision?.approvedBy, "human");
    assert.equal(ledger[0]?.decision?.reason, "会破坏现有逻辑");

    // 批准路径：落盘 + 账本记 human approved
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.equal(ledger[1]?.decision?.outcome, "approved");
    assert.equal(ledger[1]?.decision?.approvedBy, "human");
    assert.equal(ledger[1]?.state, "settled");

    await adapter.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D2 可见性：事件落盘失败（listenerErrors 非空）→ REPL 显式警告证据链不完整", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const root = mkdtempSync(join(tmpdir(), "pigeon-cli-"));
  writeFileSync(join(root, "a.ts"), original);
  const outputs: string[] = [];
  try {
    const editArgs: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    };
    const input = Readable.from(["改一下\n", ":quit\n"], { objectMode: false });
    const write = (text: string) => outputs.push(text);
    const { ask, close } = createAsker(input, write);
    // 故障注入：receipt 写盘即抛错（模拟磁盘故障）——listenerErrors 非空
    const sessionsDir = join(root, ".pigeon", "sessions");
    const eventLog = new JsonlEventLog(sessionsDir, newSessionId());
    const poison = {
      appendRuntimeEvent: eventLog.appendRuntimeEvent.bind(eventLog),
      appendEntry: eventLog.appendEntry.bind(eventLog),
      appendIntent: eventLog.appendIntent.bind(eventLog),
      appendDecision: eventLog.appendDecision.bind(eventLog),
      appendReceipt: () => {
        throw new Error("模拟磁盘写失败");
      },
      appendBreaker: eventLog.appendBreaker.bind(eventLog),
    };
    const adapter = new PiRuntimeAdapter({
      snapshot: {
        version: INJECTION_SNAPSHOT_VERSION,
        model: { provider: "fake-provider", id: "fake-model-1" },
        tools: {
          policy: { allow: ["edit_file"], deny: [], approvalMode: "yolo" },
          advertised: [],
        },
        context: { systemPrompt: "你是 Pigeon 测试助手。" },
        memory: [],
        skills: [],
        createdAt: 1700000000000,
      },
      streamFn: createFakeStreamFn({
        replies: [
          { text: "改一下", toolCalls: [{ name: "edit_file", args: editArgs }] },
          { text: "已完成" },
        ],
      }),
      registry: makeRegistry(),
      tools: [createEditFileTool(root)],
      sessionId: eventLog.sessionId,
      eventLog: poison,
    });

    await runRepl({ adapter, ask, write });
    close();
    eventLog.close();

    const terminal = outputs.join("");
    assert.ok(
      terminal.includes("证据链不完整"),
      `落盘失败必须显式警告（D2 可见降级）：${terminal}`
    );
    assert.ok(terminal.includes("1 条"), terminal);

    await adapter.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadStreamFn：加载默认导出函数的模块；坏路径与缺默认导出给清晰报错", async () => {
  const { loadStreamFn } = await import("./index.ts");
  const dir = mkdtempSync(join(tmpdir(), "pigeon-streamfn-"));
  try {
    writeFileSync(join(dir, "ok.mjs"), "export default function fakeStreamFn() {}\n");
    writeFileSync(join(dir, "no-default.mjs"), "export const x = 1;\n");
    const fn = await loadStreamFn(join(dir, "ok.mjs"));
    assert.equal(typeof fn, "function");
    await assert.rejects(() => loadStreamFn(join(dir, "不存在.mjs")), /无法加载 streamFn 模块/);
    await assert.rejects(() => loadStreamFn(join(dir, "no-default.mjs")), /没有默认导出函数/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
