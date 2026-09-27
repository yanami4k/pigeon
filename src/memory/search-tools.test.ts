// M5 S2（决策 038）：两个 read 档工具——search_sessions（默认 20 条 + 总字节上限，超限提示收窄）
// 与 read_session_entry（按条目号取一条消息的完整内容块）；读新会话存储（决策 185）。agent 可见的说明与输出冻结，
// 这里逐字核对；经真实 Adapter 调用时只留 tool.proposed / tool.settled 事件级记录（read 档自动放行）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolGovernance } from "../application/governance.ts";
import {
  createFixtureSession,
  type FixtureSession,
} from "../application/session-store-fixtures.ts";
import { markLegacyEventFile } from "../application/session-view-fixtures.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  createReadSessionEntryTool,
  createSearchSessionsTool,
  DEFAULT_SEARCH_TOOL_LIMIT,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "./search-tools.ts";

const SESSION = asSessionId("sess_01JAAAAAA30000000000000000");

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-tools-"));
  return run(join(root, ".pigeon", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

async function seed(
  dir: string,
  write: (session: FixtureSession) => void,
  sessionId: SessionId = SESSION
): Promise<void> {
  const session = createFixtureSession({ sessionsDir: dir, sessionId });
  write(session);
  await session.close();
  markLegacyEventFile(dir, sessionId);
}

test("两个工具的说明逐字冻结：只去掉了治理记录与审批回执状态的字句", () => {
  const search = createSearchSessionsTool({ sessionsDir: "x" });
  const read = createReadSessionEntryTool({ sessionsDir: "x" });
  assert.equal(
    search.description,
    "检索本项目历史会话的消息正文（用户输入、模型回复与思维链、工具输出）。关键词大小写不敏感、" +
      "按字面子串匹配、多个关键词须同时出现；不支持正则。结果从新到旧，最多 20 条。" +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文。"
  );
  assert.equal(
    read.description,
    "按 entryId 读取历史会话里一条消息的完整原文（含思维链与工具输出）。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。"
  );
  assert.deepEqual(
    sessionToolRegistrations("x").map((registration) => registration.description),
    ["检索本项目历史会话的消息正文（关键词字面匹配）", "按 entryId 读取历史消息原文"]
  );
});

test("search_sessions 典型输出逐字：命中行带条目号、会话、Run 第 N 条、角色与工具名、时间，末行提示回查原文", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "部署网关" });
      s.toolTurn({ name: "read_file", result: "网关配置在 gw.yaml" });
      s.endRun();
    });
    const view = loadSessionView(dir, SESSION);
    const [user, , result] = view?.messages ?? [];
    assert.ok(user !== undefined && result !== undefined && view !== undefined);
    const runId = view.runs[0]?.runId;
    const text = textOf(
      await createSearchSessionsTool({ sessionsDir: dir }).execute("t1", { keywords: ["网关"] })
    );
    assert.equal(
      text,
      [
        "命中 2 条（关键词：网关；从新到旧）：",
        `- ${user.entryId}｜会话 ${SESSION}｜${runId} 第 1 条｜user｜${new Date(user.timestamp).toISOString()}`,
        "  部署网关",
        `- ${result.entryId}｜会话 ${SESSION}｜${runId} 第 3 条｜toolResult（read_file）｜${new Date(result.timestamp).toISOString()}`,
        "  网关配置在 gw.yaml",
        "片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。",
      ].join("\n")
    );
    assert.equal(
      textOf(
        await createSearchSessionsTool({ sessionsDir: dir }).execute("t2", { keywords: ["无此词"] })
      ),
      "没有命中（关键词：无此词）。可以换同义词或减少关键词再试。"
    );
  }));

test("search_sessions 默认 20 条上限并提示收窄（去上限变红）", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "match 第 1 条" });
      for (let index = 2; index <= 25; index++) {
        s.user(`match 第 ${index} 条`);
      }
      s.endRun();
    });
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    assert.equal(tool.name, SEARCH_SESSIONS_TOOL);
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.equal(DEFAULT_SEARCH_TOOL_LIMIT, 20);
    assert.equal(result.details.hits.length, 20);
    assert.equal(result.details.limited, true);
    assert.match(textOf(result), /已达 20 条上限，结果可能不全；请增加关键词或加 role 过滤收窄。/);
    assert.match(textOf(result), /read_session_entry/);
  }));

test("search_sessions 总字节上限：超出即停并提示收窄", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: `match ${"长".repeat(60)} 1` });
      for (let index = 2; index <= 10; index++) {
        s.user(`match ${"长".repeat(60)} ${index}`);
      }
      s.endRun();
    });
    const tool = createSearchSessionsTool({ sessionsDir: dir, maxBytes: 800 });
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.ok(result.details.hits.length > 0 && result.details.hits.length < 10);
    assert.equal(result.details.byteCapped, true);
    assert.match(textOf(result), /字节上限/);
  }));

test("read_session_entry 典型输出逐字：头行、正文分隔、thinking 与工具调用块；不再有正文哈希与治理邻居", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "把 a.ts 的 beta 改成大写" });
      s.assistant({
        thinking: "先读文件",
        text: "我来改",
        toolCalls: [{ name: "edit_file", args: { path: "a.ts" } }],
      });
      s.toolResult({
        toolCallId: "tc-1",
        toolName: "edit_file",
        text: "失败：锚点不唯一",
        isError: true,
      });
      s.endRun();
    });
    const view = loadSessionView(dir, SESSION);
    const [, assistant, result] = view?.messages ?? [];
    assert.ok(assistant !== undefined && result !== undefined && view !== undefined);
    const runId = view.runs[0]?.runId;
    const tool = createReadSessionEntryTool({ sessionsDir: dir });
    assert.equal(tool.name, READ_SESSION_ENTRY_TOOL);
    const read = await tool.execute("t1", { entryId: assistant.entryId });
    assert.equal(
      textOf(read),
      [
        `[${assistant.entryId}｜会话 ${SESSION}｜${runId} 第 2 条｜assistant｜${new Date(assistant.timestamp).toISOString()}]`,
        "--- 正文 ---",
        "[thinking] 先读文件",
        "我来改",
        "[toolCall] edit_file（tc-1）",
      ].join("\n")
    );
    assert.deepEqual(read.details, {
      sessionId: SESSION,
      entryId: assistant.entryId,
      runId,
      runSeq: 2,
      role: "assistant",
    });
    assert.equal(
      textOf(await tool.execute("t2", { entryId: result.entryId, sessionId: SESSION })),
      [
        `[${result.entryId}｜会话 ${SESSION}｜${runId} 第 3 条｜toolResult（edit_file，出错）｜${new Date(result.timestamp).toISOString()}]`,
        "--- 正文 ---",
        "失败：锚点不唯一",
      ].join("\n")
    );
  }));

test("read_session_entry：完整原文不截断；找不到条目响亮报错；给错会话号也找不到", () =>
  withDir(async (dir) => {
    const long = "很长的工具输出".repeat(20_000);
    await seed(dir, (s) => {
      s.startRun({ task: "读一下" });
      s.toolTurn({ name: "read_file", result: long });
      s.endRun();
    });
    const other = newSessionId();
    await seed(dir, (s) => s.startRun({ task: "另一个会话" }), other);
    const entryId = loadSessionView(dir, SESSION)?.messages[2]?.entryId ?? "";
    const tool = createReadSessionEntryTool({ sessionsDir: dir });
    const text = textOf(await tool.execute("t1", { entryId }));
    assert.ok(text.endsWith(long));
    await assert.rejects(
      tool.execute("t2", { entryId: "no-such-entry" }),
      /未找到 entry no-such-entry/
    );
    await assert.rejects(tool.execute("t3", { entryId, sessionId: other }), /未找到 entry/);
  }));

test("经真实 Adapter 调用 search_sessions：read 档自动放行，只留 tool.proposed / tool.settled", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => s.startRun({ task: "上周部署过网关" }));

    const sessionId = newSessionId();
    const eventLog = new JsonlEventLog(dir, sessionId);
    const registry = new ToolRegistry();
    for (const registration of sessionToolRegistrations(dir)) {
      registry.register(registration);
    }
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    const outputs: string[] = [];
    const adapter = new PiRuntimeAdapter({
      snapshot: {
        version: INJECTION_SNAPSHOT_VERSION,
        model: { provider: "fake-provider", id: "fake-model-1" },
        tools: {
          policy: { allow: [SEARCH_SESSIONS_TOOL], deny: [], approvalMode: "prompt" },
          advertised: [SEARCH_SESSIONS_TOOL],
        },
        context: { systemPrompt: "测试" },
        memory: [],
        skills: [],
        createdAt: 1,
      },
      streamFn: createFakeStreamFn({
        replies: [
          { text: "", toolCalls: [{ name: SEARCH_SESSIONS_TOOL, args: { keywords: ["部署"] } }] },
          { text: "查到了" },
        ],
      }),
      governance: createToolGovernance({
        registry,
      }),
      tools: [
        {
          ...tool,
          execute: async (id, params) => {
            const result = await tool.execute(id, params as { keywords: string[] });
            outputs.push(textOf(result));
            return result;
          },
        },
      ],
      sessionId,
      eventLog,
    });
    const result = await adapter.run("我们以前部署过什么");
    assert.equal(result.status, "completed");
    await adapter.dispose();
    eventLog.close();
    assert.match(outputs[0] ?? "", /^命中 1 条/);

    const materialized = materializeSession(dir, sessionId);
    const kinds = materialized.runtimeEvents
      .filter((event) => event.kind === "tool.proposed" || event.kind === "tool.settled")
      .map((event) => [event.kind, (event.payload as { toolName: string }).toolName]);
    assert.deepEqual(kinds, [
      ["tool.proposed", SEARCH_SESSIONS_TOOL],
      ["tool.settled", SEARCH_SESSIONS_TOOL],
    ]);
    const settled = materialized.runtimeEvents.find((event) => event.kind === "tool.settled");
    assert.ok(settled?.kind === "tool.settled");
    assert.equal(settled.payload.isError, false);
    assert.equal(materialized.intents.length, 0);
    assert.equal(materialized.decisions.length, 0);
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "policy:auto");
  }));
