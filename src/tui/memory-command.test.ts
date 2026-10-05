// 终端界面的 /memory（决策 331）：/memory 查看两层记忆；/memory edit project|user 编辑一层，结果落消息区；参数不对给出用法；
// 没接命令面时是未知命令；运行中可以查看，编辑被拒并说明原因；编辑时暂停界面、编辑器退出后恢复。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { MEMORY_COMMAND_USAGE, MEMORY_SAVE_WAITING_TEXT } from "../application/memory-command.ts";
import { newSessionId } from "../state/ids.ts";
import { rejectWhileRunning } from "./command-table.ts";
import { type CommandsHost, handleSlashCommand, type TuiMemoryFace } from "./commands.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function stubHost(memory: TuiMemoryFace | undefined) {
  const lines: string[] = [];
  const sessionId = newSessionId();
  const host: CommandsHost = {
    addSystem: (line) => lines.push(line),
    render: () => {},
    requestExit: () => {},
    sessionId: () => sessionId,
    grants: () => undefined,
    workers: () => undefined,
    sessionsRoot: () => undefined,
    searchRoot: () => undefined,
    resumeConfigured: () => false,
    spawnCommand: () => {},
    cancelCommand: () => {},
    workersStatusCommand: () => {},
    takeCommand: () => {},
    resumeCommand: () => {},
    compactCommand: () => {},
    memory: () => memory,
  };
  return { host, lines };
}

test("/memory 查看；/memory edit project|user 编辑那一层、结果落消息区；参数不对给出用法", async () => {
  const edited: string[] = [];
  const { host, lines } = stubHost({
    view: () => "两层记忆",
    edit: async (layer) => {
      edited.push(layer);
      return `已保存${layer}`;
    },
  });
  handleSlashCommand(host, "/memory");
  handleSlashCommand(host, "/memory edit project");
  handleSlashCommand(host, "/memory edit user");
  handleSlashCommand(host, "/memory edit");
  handleSlashCommand(host, "/memory edit team");
  handleSlashCommand(host, "/memory show");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(edited, ["project", "user"]);
  assert.deepEqual(lines, [
    "两层记忆",
    MEMORY_COMMAND_USAGE,
    MEMORY_COMMAND_USAGE,
    MEMORY_COMMAND_USAGE,
    "已保存project",
    "已保存user",
  ]);
  const none = stubHost(undefined);
  handleSlashCommand(none.host, "/memory");
  assert.match(none.lines[0] ?? "", /^未知命令：\/memory/);
});

test("运行中：/memory 可以查看，/memory edit 被拒并说明原因", () => {
  assert.equal(rejectWhileRunning("/memory"), undefined);
  assert.match(rejectWhileRunning("/memory edit project") ?? "", /暂停界面、打开编辑器/);
});

test("编辑时暂停界面：编辑器跑的时候终端已交还，结束后恢复界面并照常显示", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-memory-"));
  const term = new MockTerminal(80, 24);
  const sessionId = newSessionId();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
  });
  try {
    shell.start();
    await settle();
    let stoppedDuringWork: boolean | undefined;
    const result = shell.suspendFor(() => {
      stoppedDuringWork = term.stopped;
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(stoppedDuringWork, true, "编辑器跑的时候界面已停、终端交还");
    shell.addSystem("编辑之后的一行");
    await settle();
    assert.ok(screenText(term).includes("编辑之后的一行"));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("保存时排队：提示出现后按 Esc 即取消这次保存，结果照常落消息区", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-memory-"));
  const term = new MockTerminal(80, 24);
  const sessionId = newSessionId();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    memory: {
      view: () => "",
      // 一直排不到：提示在等，直到被取消
      edit: (_layer, hooks) =>
        new Promise((resolve) => {
          hooks?.onWaiting?.();
          hooks?.signal?.addEventListener("abort", () => resolve("取消了这次保存"));
        }),
    },
  });
  try {
    shell.start();
    await settle();
    term.input("/memory edit project");
    term.input("\r");
    await settle();
    assert.ok(screenText(term).includes(MEMORY_SAVE_WAITING_TEXT));
    term.input("\x1b");
    await settle();
    assert.ok(screenText(term).includes("取消了这次保存"));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
