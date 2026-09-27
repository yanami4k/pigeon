// M5 S2（决策 045）：历史投影——正文、thinking、工具行、轮次与 Run 标记按会话文件里的顺序交织；
// toolResult 默认折叠；单条渲染上限；安全上限默认 500 行，超出折叠为一行提示。读新会话存储：
// 分支会话只画自己的部分；出错的工具调用、上游合成失败与未收尾如实呈现；双写之前的旧会话给提示。
// TUI 的 /resume 与 cli 的 --with-content 共用本投影。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import { DEFAULT_HISTORY_LIMIT, type HistoryLine, loadSessionHistory } from "./history.ts";
import { seedToolRun } from "./history-fixtures.ts";
import { createFixtureSession, forkFixture } from "./session-store-fixtures.ts";

async function withRoot(run: (root: string, sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-history-"));
  try {
    await run(root, join(root, ".pigeon", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pairs = (lines: HistoryLine[]) => lines.map((line) => [line.kind, line.text]);

test("时序交织：正文、thinking、轮次标记、工具行、折叠的 toolResult、Run 结束标记", () =>
  withRoot(async (root, sessionsDir) => {
    const sessionId = newSessionId();
    await seedToolRun(sessionsDir, sessionId);
    assert.deepEqual(pairs(loadSessionHistory(root, sessionId)), [
      ["user", "> 把 beta 改成大写"],
      ["thinking", "~ 先确认锚点"],
      ["assistant", "我来改"],
      ["marker", "-- turn: toolUse --"],
      ["tool", '$ edit_file {"path":"a.ts"} -> ok'],
      ["toolResult", "[result] edit_file ok（7 字符，已折叠）"],
      ["assistant", "改好了"],
      ["marker", "-- turn: stop --"],
      ["marker", "== run ended | 分类：正常 =="],
    ]);
  }));

test("安全上限：默认 500 行；超出时最早部分折叠为一行提示（去上限变红）", () =>
  withRoot(async (root, sessionsDir) => {
    const sessionId = newSessionId();
    await seedToolRun(sessionsDir, sessionId);
    assert.equal(DEFAULT_HISTORY_LIMIT, 500);
    const full = loadSessionHistory(root, sessionId);
    const folded = loadSessionHistory(root, sessionId, { limit: 3 });
    assert.equal(folded.length, 4);
    assert.deepEqual(folded[0], { kind: "notice", text: "[更早 6 条未展开，/search 可查]" });
    assert.deepEqual(folded.slice(1), full.slice(-3));
  }));

test("单条渲染上限：超长正文折叠并标注已截断显示", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "x".repeat(50) });
    const { sessionId } = await session.close();
    assert.deepEqual(pairs(loadSessionHistory(root, sessionId, { entryChars: 10 })), [
      ["user", `> ${"x".repeat(10)}…（已截断显示，共 50 字符）`],
    ]);
  }));

test("出错的工具调用、上游合成失败消息与撞上限收尾：工具行标 error，Run 标记带分类", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "改 a" });
    session.toolTurn({
      name: "edit_file",
      args: { path: "a" },
      result: "锚点不唯一",
      isError: true,
    });
    session.assistant({ text: "", stopReason: "error", errorMessage: "provider 故障" });
    session.endRun({ ending: "error" });
    session.startRun({ task: "再试" });
    session.assistant({ text: "", stopReason: "aborted" });
    session.endRun({ ending: "turn-limit" });
    const { sessionId } = await session.close();
    assert.deepEqual(pairs(loadSessionHistory(root, sessionId)), [
      ["user", "> 改 a"],
      ["marker", "-- turn: toolUse --"],
      ["tool", '$ edit_file {"path":"a"} -> error'],
      ["toolResult", "[result] edit_file error（5 字符，已折叠）"],
      ["marker", "-- turn: error --"],
      ["marker", "== run ended | 分类：基础设施错误 =="],
      ["user", "> 再试"],
      ["marker", "-- turn: aborted --"],
      ["marker", "== run ended | 分类：取消 =="],
    ]);
  }));

test("分支会话只画自己的部分；未收尾的 Run 没有结束标记；双写之前的旧会话给提示", () =>
  withRoot(async (root, sessionsDir) => {
    const source = createFixtureSession({ sessionsDir });
    const runId = source.startRun({ task: "来源任务" });
    source.assistant({ text: "来源回复" });
    source.endRun();
    const { sessionId: sourceId } = await source.close();
    const branch = await forkFixture({ sessionsDir, sourceSessionId: sourceId, runId, runSeq: 2 });
    branch.startRun({ task: "分支任务" });
    const { sessionId: branchId } = await branch.close();
    assert.deepEqual(pairs(loadSessionHistory(root, branchId)), [["user", "> 分支任务"]]);

    const legacy = newSessionId();
    writeFileSync(join(sessionsDir, `${legacy}.jsonl`), "");
    assert.deepEqual(pairs(loadSessionHistory(root, legacy)), [
      ["notice", "[该会话创建于新会话存储启用之前，只在旧账本里，这里不显示历史]"],
    ]);
  }));
