// 决策 286 第 1 项：输入框改用 pi-tui Editor——多行输入与换行键、粘贴保留换行、大段粘贴折成标记并在发送时展开、
// ↑↓ 翻历史且历史跨启动保留、按项目分开。虚拟屏测不到真实终端的按键差异（Windows 下的 Shift+Enter），
// 这里按各换行键在终端里送来的字节断言：Ctrl+J = "\n"、Alt+Enter = ESC CR、行末反斜杠再回车。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { promptHistoryStore } from "../application/prompt-history.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function makeShell(root?: string): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: ScriptedRuntime;
  cleanup: () => void;
} {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-editor-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    ...(root !== undefined ? { promptHistory: promptHistoryStore(root) } : {}),
  });
  return {
    shell,
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("多行输入：Ctrl+J、Alt+Enter 与行末反斜杠回车都换行，Enter 发送整段（换行保留）", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("第一行");
    term.input("\n"); // Ctrl+J
    term.input("第二行");
    term.input("\x1b\r"); // Alt+Enter
    term.input("第三行\\");
    term.input("\r"); // 行末反斜杠：删掉反斜杠换行，不发送
    term.input("第四行");
    await settle();
    assert.deepEqual(runtime.runs, [], "换行键不得发送");
    const editing = screenText(term);
    for (const line of ["第一行", "第二行", "第三行", "第四行"]) {
      assert.ok(editing.includes(line), editing);
    }
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["第一行\n第二行\n第三行\n第四行"]);
  } finally {
    cleanup();
  }
});

test("粘贴保留换行（含 CRLF）；Ctrl+C 清空多行输入框", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input(`${PASTE_START}const a = 1;\r\nconst b = 2;\nreturn a + b;${PASTE_END}`);
    await settle();
    assert.deepEqual(runtime.runs, [], "粘贴里的换行不得触发发送");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["const a = 1;\nconst b = 2;\nreturn a + b;"]);

    term.input(`${PASTE_START}甲\n乙${PASTE_END}`);
    term.input("\x03");
    await settle();
    term.input("\r");
    await settle();
    assert.equal(runtime.runs.length, 1, "清空后回车不发送");
  } finally {
    cleanup();
  }
});

test("大段粘贴折成标记显示，发送时展开为原文", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    const lines = Array.from({ length: 15 }, (_, index) => `日志第${index + 1}行`);
    term.input("看看这段：");
    term.input(`${PASTE_START}${lines.join("\n")}${PASTE_END}`);
    await settle();
    const shown = screenText(term);
    assert.ok(shown.includes("[paste #1 +15 lines]"), shown);
    assert.ok(!shown.includes("日志第15行"), "折叠期间原文不进输入框显示");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [`看看这段：${lines.join("\n")}`]);
    assert.ok(screenText(term).includes("日志第15行"), "回显的是展开后的原文");
  } finally {
    cleanup();
  }
});

test("↑↓ 翻历史；历史跨启动保留、按项目分开（存在各自项目的 .pigeon 下）", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "pigeon-history-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "pigeon-history-b-"));
  try {
    const first = makeShell(rootA);
    try {
      first.shell.start();
      await settle();
      first.term.input("甲项目任务一");
      first.term.input("\r");
      first.term.input("甲项目任务二\n第二行");
      first.term.input("\r");
      await settle();
      // 本次启动内 ↑ 取回上一条（多行原样）
      first.term.input("\x1b[A");
      await settle();
      first.term.input("\r");
      await settle();
      assert.deepEqual(first.runtime.runs, [
        "甲项目任务一",
        "甲项目任务二\n第二行",
        "甲项目任务二\n第二行",
      ]);
    } finally {
      first.cleanup();
    }
    const stored = join(rootA, ".pigeon", "state", "tui-history.json");
    assert.ok(existsSync(stored), "历史写在项目的 .pigeon 下");
    assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")).entries, [
      "甲项目任务一",
      "甲项目任务二\n第二行",
    ]);

    // 同一项目再启动：↑↑ 取回更早的一条
    const second = makeShell(rootA);
    try {
      second.shell.start();
      await settle();
      second.term.input("\x1b[A");
      second.term.input("\x1b[A");
      await settle();
      second.term.input("\r");
      await settle();
      assert.deepEqual(second.runtime.runs, ["甲项目任务一"]);
    } finally {
      second.cleanup();
    }

    // 另一个项目：没有甲项目的历史
    const other = makeShell(rootB);
    try {
      other.shell.start();
      await settle();
      other.term.input("\x1b[A");
      await settle();
      other.term.input("\r");
      await settle();
      assert.deepEqual(other.runtime.runs, [], "别的项目的历史不串过来");
      assert.equal(existsSync(join(rootB, ".pigeon", "state", "tui-history.json")), false);
    } finally {
      other.cleanup();
    }
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("输入历史存储：条数上限 100、连续重复只记一次、畸形文件按空历史处理", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-history-store-"));
  try {
    const store = promptHistoryStore(root);
    for (let index = 0; index < 105; index++) store.add(`第${index}条`);
    store.add("第104条");
    const loaded = store.load();
    assert.equal(loaded.length, 100);
    assert.equal(loaded[0], "第5条");
    assert.equal(loaded.at(-1), "第104条");
    const path = join(root, ".pigeon", "state", "tui-history.json");
    rmSync(path);
    writeFileSync(path, "{不是 JSON");
    assert.deepEqual(promptHistoryStore(root).load(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
