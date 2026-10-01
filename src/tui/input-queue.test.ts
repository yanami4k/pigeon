// 决策 286 第 4 项：运行中输入进队列、空闲后逐条自动发出；排队内容显示在输入框上方，Alt+Up（及 Alt+Q）退回输入框修改；
// Esc 中断时排队内容退回输入框、不再自动发出；只读类命令与 /cancel、/quit 运行中随时可用，改主会话状态或工作目录的
// 命令运行中被拒并说明原因。排队是独立的小接口（入队、取出、清空、退回输入框）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import { lookupSlashCommand, rejectWhileRunning, SLASH_COMMANDS } from "./command-table.ts";
import { InputQueue } from "./input-queue.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";

const ALT_UP = "\x1b[1;3A";

function makeShell(): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: ScriptedRuntime;
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-queue-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 40);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir: root,
    sessions: { root },
    search: { root },
  });
  return {
    shell,
    term,
    runtime,
    root,
    cleanup: () => {
      shell.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// 编辑器当前内容所在的屏幕行（输入框在状态栏上方、两条横线之间）
function editorText(term: MockTerminal): string {
  const lines = term.screen.contentLines();
  const bottom = lines.findLastIndex((line) => /^-+$/.test(line.trim()));
  const top = lines.slice(0, bottom).findLastIndex((line) => /^-+$/.test(line.trim()));
  return lines
    .slice(top + 1, bottom)
    .map((line) => line.trim())
    .join("\n");
}

test("Esc 中断：排队内容退回输入框（排队在前、草稿在后），中断后不自动发出", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  runtime.autoResolve = false;
  try {
    shell.start();
    await settle();
    term.input("长任务");
    term.input("\r");
    term.input("排队一");
    term.input("\r");
    term.input("排队二");
    term.input("\r");
    term.input("草稿");
    await settle();
    assert.ok(screenText(term).includes("queued: 排队一"));
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interrupts, 1);
    assert.equal(editorText(term), "排队一\n\n排队二\n\n草稿");
    assert.ok(!screenText(term).includes("queued:"));
    runtime.finishAll();
    await settle();
    assert.deepEqual(runtime.runs, ["长任务"], "中断后排队内容不自动发出");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["长任务", "排队一\n\n排队二\n\n草稿"]);
  } finally {
    cleanup();
  }
});

test("Alt+Up 随时把排队内容退回输入框修改，改好再排", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  runtime.autoResolve = false;
  try {
    shell.start();
    await settle();
    term.input("长任务");
    term.input("\r");
    term.input("写错了的排队");
    term.input("\r");
    await settle();
    term.input(ALT_UP);
    await settle();
    assert.equal(editorText(term), "写错了的排队");
    assert.ok(!screenText(term).includes("queued:"));
    term.input("\x03"); // 清掉，改成别的再排
    term.input("改好的排队");
    term.input("\r");
    runtime.finishAll();
    await settle();
    assert.deepEqual(runtime.runs, ["长任务", "改好的排队"]);
    assert.equal(runtime.interrupts, 0);
  } finally {
    cleanup();
  }
});

test("运行中只读命令照常执行，改状态的命令被拒并说明原因、留在输入框、不排队", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  runtime.autoResolve = false;
  try {
    shell.start();
    await settle();
    term.input("长任务");
    term.input("\r");
    await settle();
    term.input("/sessions");
    term.input("\r");
    await settle();
    assert.ok(screenFlat(term).includes("尚无会话记录"), "只读命令运行中照常执行");
    term.input("/compact");
    term.input("\r");
    await settle();
    assert.ok(
      screenFlat(term).includes("运行中不能用 /compact：它会改动主会话状态（压缩对话上下文）"),
      screenText(term)
    );
    assert.equal(editorText(term), "/compact", "被拒的命令留在输入框");
    assert.deepEqual(runtime.runs, ["长任务"], "命令不排队");
  } finally {
    cleanup();
  }
});

test("命令放行表：只读类与 /cancel、/quit 运行中可用，其余逐条说明原因", () => {
  const allowed = SLASH_COMMANDS.filter((spec) => spec.whileRunning.allow).map((spec) => spec.name);
  assert.deepEqual(allowed, [
    "quit",
    "sessions",
    "search",
    "grants",
    "cancel",
    "workers",
    "agents",
    "stop",
    "approve",
    "tasks",
    "orchestrate",
  ]);
  const rejected = SLASH_COMMANDS.filter((spec) => !spec.whileRunning.allow).map(
    (spec) => spec.name
  );
  assert.deepEqual(rejected, [
    "compact",
    "resume",
    "revoke",
    "grants save",
    "fork",
    "spawn",
    "take",
    "reload",
    "export",
  ]);
  for (const name of rejected) {
    const line = rejectWhileRunning(`/${name} x`);
    assert.ok(line?.startsWith(`运行中不能用 /${name}：`), line);
  }
  assert.equal(rejectWhileRunning("/grants"), undefined);
  assert.equal(rejectWhileRunning("/没有这个命令"), undefined, "未知命令交给分发如实说明");
  assert.equal(lookupSlashCommand(["grants", "save", "g1"])?.name, "grants save");
});

test("排队接口：入队、取出（先进先出）、清空、退回输入框", () => {
  const queue = new InputQueue();
  queue.enqueue("一");
  queue.enqueue("二\n第二行");
  assert.equal(queue.size(), 2);
  assert.deepEqual(queue.pending(), ["一", "二\n第二行"]);
  assert.equal(queue.take(), "一");
  queue.enqueue("三");
  assert.equal(queue.restoreInto("草稿"), "二\n第二行\n\n三\n\n草稿");
  assert.equal(queue.size(), 0);
  queue.enqueue("四");
  assert.deepEqual(queue.clear(), ["四"]);
  assert.equal(queue.take(), undefined);
  assert.equal(queue.restoreInto("  "), "");
});

test("壳的排队接口：空闲时入队立即发出，运行中入队等空闲", async () => {
  const { shell, runtime, cleanup } = makeShell();
  runtime.autoResolve = false;
  try {
    shell.start();
    await settle();
    shell.enqueueInput("外部一");
    await settle();
    assert.deepEqual(runtime.runs, ["外部一"]);
    shell.enqueueInput("外部二");
    assert.deepEqual(shell.queuedInputs(), ["外部二"]);
    runtime.finishAll();
    await settle();
    assert.deepEqual(runtime.runs, ["外部一", "外部二"]);
  } finally {
    cleanup();
  }
});
