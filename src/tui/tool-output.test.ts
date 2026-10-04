// 决策 286 第 3 项：工具调用行下方显示结果，缺省收起（一行摘要与前几行），Ctrl+O 展开或收起全部；
// 编辑类工具显示 diff；结果很长时展开后也有上限并注明截断；非本次运行的迟到结果不进消息区。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newRunId, newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";
import { TOOL_EXPANDED_CHARS, toolResultBody } from "./tool-output.ts";

const CTRL_O = "\x0f";

async function withShell(
  body: (ctx: { term: MockTerminal; runtime: ScriptedRuntime }) => Promise<void>
): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-tools-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 40);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.autoResolve = false;
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    term.input("动手");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    await body({ term, runtime });
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
}

function toolCall(runtime: ScriptedRuntime, id: string, toolName: string, args: unknown): void {
  runtime.emit(RuntimeEventKind.ToolProposed, { toolCallId: id, toolName, args });
  runtime.emit(RuntimeEventKind.ToolSettled, { toolCallId: id, toolName, isError: false });
}

test("工具结果缺省收起：调用行下方前 3 行与剩余行数；Ctrl+O 展开全部、再按收起", async () => {
  await withShell(async ({ term, runtime }) => {
    toolCall(runtime, "tc1", "read_file", { path: "a.txt" });
    const text = Array.from({ length: 10 }, (_, index) => `内容行${index + 1}`).join("\n");
    runtime.toolResult({
      toolCallId: "tc1",
      toolName: "read_file",
      isError: false,
      text,
      details: {},
    });
    await settle();
    const lines = term.screen.contentLines();
    const call = lines.findIndex((line) => line.includes("$ read_file") && line.includes("-> ok"));
    assert.ok(call >= 0, screenText(term));
    assert.match(lines[call + 1] ?? "", /\| 内容行1$/);
    assert.match(lines[call + 3] ?? "", /\| 内容行3$/);
    assert.ok((lines[call + 4] ?? "").includes("... +7 lines (ctrl+o to expand)"));
    assert.ok(!screenText(term).includes("内容行10"));

    term.input(CTRL_O);
    await settle();
    assert.ok(screenText(term).includes("内容行10"), "展开后显示全部");
    assert.ok(screenText(term).includes("(ctrl+o to collapse)"));

    term.input(CTRL_O);
    await settle();
    assert.ok(!screenText(term).includes("内容行10"), "再按收起");
  });
});

test("编辑类工具显示 diff 而不是回执全文", async () => {
  await withShell(async ({ term, runtime }) => {
    toolCall(runtime, "tc2", "edit_file", { path: "b.ts" });
    runtime.toolResult({
      toolCallId: "tc2",
      toolName: "edit_file",
      isError: false,
      text: "已在 b.ts 应用 1 处替换（+1 −1 行）",
      details: { diff: "--- b.ts\n+++ b.ts\n-const x = 1;\n+const x = 2;" },
    });
    await settle();
    const shown = screenText(term);
    assert.ok(shown.includes("| --- b.ts"), shown);
    assert.ok(shown.includes("| +++ b.ts"), shown);
    assert.ok(shown.includes("| -const x = 1;"), shown);
    assert.ok(shown.includes("... +1 lines (ctrl+o to expand)"), "4 行 diff 收起时显示前 3 行");
    term.input(CTRL_O);
    await settle();
    assert.ok(screenText(term).includes("| +const x = 2;"));
  });
});

test("很长的结果展开后也有上限并注明截断；非本次运行的迟到结果不进消息区", async () => {
  await withShell(async ({ term, runtime }) => {
    toolCall(runtime, "tc3", "run_command", { command: "cat big.log" });
    const text = Array.from({ length: 500 }, (_, index) => `L${index + 1}`).join("\n");
    runtime.toolResult({
      toolCallId: "tc3",
      toolName: "run_command",
      isError: false,
      text,
      details: {},
    });
    runtime.toolResult({
      runId: newRunId(),
      toolCallId: "ghost",
      toolName: "read_file",
      isError: false,
      text: "幽灵结果",
      details: {},
    });
    term.input(CTRL_O);
    await settle();
    const lines = term.screen.contentLines();
    assert.ok(lines.some((line) => /\| L200$/.test(line)));
    assert.ok(!lines.some((line) => /\| L201$/.test(line)), "超过 200 行不显示");
    assert.ok(
      lines.some((line) => line.includes("... truncated: 300 more lines not shown")),
      "注明截断"
    );
    assert.ok(!screenText(term).includes("幽灵结果"));
  });
  // 字符上限：单行超长时截到上限并注明
  const body = toolResultBody({ isError: false, text: "x".repeat(TOOL_EXPANDED_CHARS + 50) }, true);
  assert.ok(body.includes("... truncated: 0 more lines not shown"));
  assert.ok(body.length < TOOL_EXPANDED_CHARS + 200);
  assert.equal(toolResultBody({ isError: false, text: "" }, false), "");
});
