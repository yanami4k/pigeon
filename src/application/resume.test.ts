// 续跑（决策 183）：运行面打开会话文件后用 pi 的 buildSessionContext 还原对话上下文接着跑；末条助手消息里悬空的工具调用
// 各补一条"进程在执行途中中断、结果未知、请自行核实"的工具结果（写进会话、交给 Agent），由 agent 自行核对；不再按文件哈希
// 对账、不再逐条问人。迁移之前的旧格式会话（会话根下的平铺文件）不能续跑，明确报错并指向只读的旧版代码。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEGACY_READER_HINT } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import {
  INTERRUPTED_TOOL_RESULT_MARK,
  INTERRUPTED_TOOL_RESULT_TEXT,
  storeAttemptFacts,
} from "../state/session-judge.ts";
import type { McpSession } from "./mcp.ts";
import { describeResume, runResumeFlow } from "./resume.ts";
import { disposeRuntime } from "./runtime.ts";
import { type OpenedSessionRuntime, openSessionRuntime } from "./session-runtime.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { writeLegacySessionFile } from "./session-view-fixtures.ts";
import { isStatusText } from "./status-fixtures.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function workspace() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-resume-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-resume-home-"));
  return {
    dir,
    home,
    sessionsDir: join(dir, ".pigeon", "state", "sessions"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const FLAGS = { yolo: true, provider: "custom", modelId: "custom", persistThinking: true };

type Block = { type: string; text?: string };
// 决策 363：开工状态块与状态追加不是对话的一部分，比对角色时去掉
function isStatusMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>)
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .join("")
        : "";
  return isStatusText(text);
}
const roles = (messages: ReadonlyArray<{ role: string; content?: unknown }>) =>
  messages.filter((m) => !isStatusMessage(m)).map((m) => m.role);

test("续跑：进程死在工具执行途中——还原上下文，悬空调用补“结果未知”的工具结果写进会话并交给模型，接着跑", async () => {
  const { dir, home, sessionsDir, cleanup } = workspace();
  try {
    const crashed = createFixtureSession({ sessionsDir, cwd: dir });
    const firstRun = crashed.startRun({ task: "把 a.txt 改成 new" });
    const [callId] = crashed.assistant({
      text: "先改文件",
      toolCalls: [{ name: "edit_file", args: { path: "a.txt" } }],
    });
    const { sessionId } = await crashed.close();

    const written: string[] = [];
    const model = createFakeStreamFn({ replies: [{ text: "我先核对了 a.txt，已经改好" }] });
    let opened: OpenedSessionRuntime | undefined;
    await runResumeFlow({
      root: dir,
      sessionId,
      write: (text) => written.push(text),
      enterRepl: async () => {
        opened = await openSessionRuntime({
          governanceRoot: dir,
          sessionId,
          streamFn: model,
          flags: FLAGS,
          resume: true,
          startMcp: noMcp,
          homeDir: home,
        });
        try {
          await opened.bundle.adapter.run("继续");
        } finally {
          await disposeRuntime(opened.bundle);
        }
      },
    });
    const report = written.join("");
    assert.match(report, /还原对话上下文 2 条消息/);
    assert.match(report, /1 个 Run 没有收尾记录/);
    assert.match(report, /1 个工具调用没有结果（edit_file）/);
    assert.deepEqual(opened?.restored, { messages: 2, interrupted: 1 });

    // 交给模型的上下文：原任务、带调用的助手消息、补的工具结果、续跑输入
    const context = model.calls[0]?.context.messages ?? [];
    assert.deepEqual(roles(context), ["user", "assistant", "toolResult", "user"]);
    const patched = context[2] as { toolCallId?: string; content?: Block[]; isError?: boolean };
    assert.equal(patched.toolCallId, callId);
    assert.equal(patched.content?.[0]?.text, INTERRUPTED_TOOL_RESULT_TEXT);

    // 会话文件：补的工具结果紧接在原 Run 的消息之后、续跑的 Run 开始之前，带标记
    const loaded = loadStoreSession(sessionsDir, sessionId);
    assert.ok(loaded !== undefined);
    const [original, resumed] = loaded.view.runs;
    assert.equal(original?.runId, firstRun);
    assert.deepEqual(roles((original?.messages ?? []).map((ref) => ref.message)), [
      "user",
      "assistant",
      "toolResult",
    ]);
    const stored = original?.messages[2]?.message;
    assert.equal(stored?.toolCallId, callId);
    assert.deepEqual(stored?.details, { [INTERRUPTED_TOOL_RESULT_MARK]: true });
    assert.equal(original?.end, undefined);
    assert.equal(resumed?.end?.ending, "completed");
    // 原 Run 结果不明：补了结果仍算悬账，无收尾
    assert.equal(storeAttemptFacts(loaded.view, firstRun).pendingCount, 1);
  } finally {
    cleanup();
  }
});

test("续跑：正常收尾的会话还原全部对话、不补结果；以中止收尾的助手消息里的调用不算悬空", async () => {
  const { dir, home, sessionsDir, cleanup } = workspace();
  try {
    const session = createFixtureSession({ sessionsDir, cwd: dir });
    session.startRun({ task: "第一个问题" });
    session.assistant({ text: "第一个回答" });
    session.endRun();
    session.startRun({ task: "第二个问题" });
    session.assistant({
      text: "",
      toolCalls: [{ name: "edit_file", args: { path: "a.txt" } }],
      stopReason: "aborted",
    });
    session.endRun({ ending: "aborted" });
    const { sessionId } = await session.close();

    const lines = describeResume(dir, sessionId);
    assert.deepEqual(lines, [`会话 ${sessionId} 续跑：还原对话上下文 4 条消息。`]);
    const model = createFakeStreamFn({ replies: [{ text: "第三个回答" }] });
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: model,
      flags: FLAGS,
      resume: true,
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      assert.deepEqual(opened.restored, { messages: 4, interrupted: 0 });
      await opened.bundle.adapter.run("第三个问题");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const context = model.calls[0]?.context.messages ?? [];
    assert.deepEqual(roles(context), ["user", "assistant", "user", "assistant", "user"]);
    assert.equal(loadStoreSession(sessionsDir, sessionId)?.view.runs.length, 3);
  } finally {
    cleanup();
  }
});

test("续跑：旧格式会话明确报错、不进入续会话；不存在的会话列出已有会话", async () => {
  const { dir, sessionsDir, cleanup } = workspace();
  try {
    const legacyId = writeLegacySessionFile(sessionsDir);
    let entered = false;
    await assert.rejects(
      runResumeFlow({
        root: dir,
        sessionId: legacyId,
        write: () => {},
        enterRepl: async () => {
          entered = true;
        },
      }),
      (error: Error) =>
        error.message ===
        `会话 ${legacyId} 是旧格式会话（迁移之前创建），不能续跑；${LEGACY_READER_HINT}`
    );
    assert.equal(LEGACY_READER_HINT, "旧格式会话请用只读的旧版代码 455d88d 读取");
    assert.equal(entered, false);

    const present = createFixtureSession({ sessionsDir, cwd: dir });
    present.startRun({ task: "在" });
    const { sessionId } = await present.close();
    assert.throws(
      () => describeResume(dir, newSessionId()),
      (error: Error) => error.message.includes("会话不存在") && error.message.includes(sessionId)
    );
  } finally {
    cleanup();
  }
});
