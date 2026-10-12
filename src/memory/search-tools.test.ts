// M5 S2（决策 038；决策 339、384 改进）：三件 read 档工具——search_sessions（BM25 打分，结果按会话归并，
// 缺省 5 个会话、最多 10 个 + 总字节上限，超限提示收窄；工具输出缺省在范围内，conversationOnly 只搜对话正文；
// 不认识的参数报错）、read_session_entry（按条目号读原文：单次上限、给出总长度可按偏移续读、可选前后若干条）与
// list_sessions（会话目录：开始时间、第一句话、改动过的文件，可按时间与文件筛选、有上限并说明是否截断）；
// 读新会话存储（决策 185），检索与目录排除当前会话。agent 可见的说明与输出冻结，这里逐字核对；经真实 Adapter
// 调用时会话存储里只有这一次调用与它的工具结果（read 档自动放行，审批闸标记为策略放行）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import {
  createFixtureSession,
  type FixtureSession,
  spawnFixtureWorker,
} from "../application/session-store-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  createListSessionsTool,
  createReadSessionEntryTool,
  createSearchSessionsTool,
  DEFAULT_LIST_SESSIONS_LIMIT,
  LIST_SESSIONS_TOOL,
  MAX_READ_ENTRY_CHARS,
  READ_ENTRY_CHARS,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "./search-tools.ts";
import { DEFAULT_SESSION_LIMIT, GROUP_SNIPPET_HITS, MAX_SESSION_LIMIT } from "./session-search.ts";

const SESSION = asSessionId("sess_01JAAAAAA30000000000000000");

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-tools-"));
  return run(join(root, ".pigeon", "state", "sessions")).finally(() =>
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
}

const SCOPE =
  "What you can find: discussions in earlier sessions, approaches tried and their results, and what the user said (requests, preferences, corrections). " +
  "What you cannot find: the background of the current task (the current task's description is authoritative) and the latest code (code seen in earlier sessions may be out of date). " +
  "For the current state of the code, read the code directly; for its history, use git log and git blame.";

test("决策 339 ⑦、384：三件工具的说明逐字冻结——能找到的与找不到的、工具输出在范围内且可能过时、关键词写法、按会话归并与读原文分页", () => {
  const search = createSearchSessionsTool({ sessionsDir: "x" });
  const read = createReadSessionEntryTool({ sessionsDir: "x" });
  const list = createListSessionsTool({ sessionsDir: "x" });
  assert.equal(
    search.description,
    "Search the conversations in this project's earlier sessions (excluding the group of sessions the current session belongs to: " +
      "the top-level session and the workers and forks it spawned at every level, the current session included). " +
      SCOPE +
      " Earlier tool output (command output, contents of files that were read, and so on) is also searched: it may be out of date, so verify the current state before relying on it; " +
      "earlier tool calls were attempts at the time and do not represent the final result. To search only the conversation text (the user's words and the model's replies), pass conversationOnly: true. " +
      "For keywords, give a few exact words likely to appear in the earlier conversation (names, terms, words from error messages); " +
      'do not write whole sentences, meta words such as "discussion" or "yesterday", or new names that appear only in this task; ' +
      "at most 8 keywords; a session is listed if any keyword matches, and each hit shows which keywords it matched. " +
      "Matching is by word, case-insensitive, with no regular expressions: a code name can be matched by one of its parts (for example, config for parseConfig), " +
      "Chinese text is matched by pairs of adjacent characters, and a single character is matched as a substring; " +
      "a multi-word keyword is split into words that are scored separately, with extra score when the whole phrase appears. " +
      "Hits on rarer words rank higher, so choose distinctive words; " +
      "results are grouped by session: one item per session, with the number of matching entries and one or two snippets with their entry IDs; 5 sessions by default, at most 10. " +
      "Snippets are only leads: conclusions must be checked against the original text with read_session_entry by entryId; " +
      "to first browse which earlier sessions exist and which sessions changed a given file, use list_sessions."
  );
  assert.equal(
    read.description,
    "Read the original text of one message from an earlier session by entryId (including thinking and tool output). " +
      "At most 4000 characters per read (adjustable with maxChars, up to 8000); " +
      "the result gives the total length, and you can continue reading what was not shown with offset; pass before and after to also read some messages before and after it. " +
      "entryId comes from search_sessions hits; you can add sessionId to locate it faster. " +
      "The original text is a record from that time, and the code and file contents in it may be out of date: for the current state of the code, read the code directly; for its history, use git log and git blame."
  );
  assert.equal(
    list.description,
    "List this project's earlier sessions (excluding the group of sessions the current session belongs to: " +
      "the top-level session and the workers and forks it spawned at every level, the current session included), newest first. " +
      "Each shows the session ID, the start time (UTC), " +
      "the user's first message (truncated to 60 characters), and the files changed (writes by edit_file and file changes reported by run_command). " +
      "You can filter by start time (since, until; give YYYY-MM-DD or an ISO time; both ends inclusive) " +
      "or by file path (path: a session matches if a changed file's path contains this text; a prefix also works); " +
      "at most 20 sessions; when there are more, the total is stated. " +
      "Use it to first browse what was done before and which sessions touched a file, then search with search_sessions and read the original text with read_session_entry. " +
      SCOPE
  );
  assert.deepEqual(
    sessionToolRegistrations("x").map((registration) => [
      registration.name,
      registration.description,
      registration.tier,
    ]),
    [
      [
        SEARCH_SESSIONS_TOOL,
        "检索本项目以前会话（按会话归并，BM25 打分，工具输出也在范围内）",
        "read",
      ],
      [READ_SESSION_ENTRY_TOOL, "按 entryId 读取以前会话的消息原文（有上限，可分页续读）", "read"],
      [LIST_SESSIONS_TOOL, "列出本项目以前的会话（可按时间与改动过的文件筛选）", "read"],
    ]
  );
});

test("search_sessions 典型输出逐字：按会话归并——会话行带命中条目数，命中带条目号、Run 第 N 条、角色与工具名、时间、命中的关键词；工具输出的命中带来历与过时标注", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "部署网关" });
      s.toolTurn({ name: "read_file", args: { path: "gw.yaml" }, result: "网关配置在 gw.yaml" });
      s.endRun();
    });
    const view = loadSessionView(dir, SESSION);
    const [user, , result] = view?.messages ?? [];
    assert.ok(user !== undefined && result !== undefined && view !== undefined);
    const runId = view.runs[0]?.runId;
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    // 缺省连同工具输出一起搜：一个会话两条命中（对话正文在前，工具输出带来历与过时标注）
    const found = await tool.execute("t1", { keywords: ["网关", "部署"] });
    const createdAt = found.details.groups[0]?.createdAt ?? 0;
    assert.equal(
      textOf(found),
      [
        "Matches in 1 session (keywords: 网关, 部署; scope: conversation text and tool output):",
        `- Session ${SESSION} | started ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")} | 2 matching entries`,
        `  ${user.entryId} | ${runId} #1 | user | ${new Date(user.timestamp).toISOString()} | matched: 网关, 部署`,
        "  部署网关",
        `  ${result.entryId} | ${runId} #3 | toolResult (read_file) | ${new Date(result.timestamp).toISOString()} | matched: 网关`,
        `  Earlier tool output, may be out of date (read_file | {"path":"gw.yaml"} | ${new Date(result.timestamp).toISOString()}):`,
        "  网关配置在 gw.yaml",
        "Snippets are only leads: read the original text with read_session_entry by entryId; conclusions must be checked against the original text.",
      ].join("\n")
    );
    // 只搜对话正文：工具输出那条不在
    const conversationOnly = textOf(
      await tool.execute("t2", { keywords: ["网关", "部署"], conversationOnly: true })
    );
    assert.match(conversationOnly, /scope: conversation text only/);
    assert.ok(!conversationOnly.includes("toolResult"), conversationOnly);
    assert.equal(
      textOf(await tool.execute("t3", { keywords: ["gw.yaml"], conversationOnly: true })),
      "No matches (keywords: gw.yaml; scope: conversation text only). Try synonyms or other wording, or drop conversationOnly to search tool output as well."
    );
    assert.equal(
      textOf(await tool.execute("t4", { keywords: ["无此词"] })),
      "No matches (keywords: 无此词; scope: conversation text and tool output). Try synonyms or other wording."
    );
  }));

test("search_sessions 缺省列 5 个会话、最多 10 个，超出提示收窄（去上限变红）", () =>
  withDir(async (dir) => {
    for (let index = 0; index < 7; index++) {
      const id = asSessionId(`sess_01JAAAAAA1${index}${"0".repeat(15)}`);
      await seed(
        dir,
        (s) => {
          s.startRun({ task: `match 第 ${index} 个会话` });
          s.endRun();
        },
        id
      );
    }
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    assert.equal(tool.name, SEARCH_SESSIONS_TOOL);
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.equal(DEFAULT_SESSION_LIMIT, 5);
    assert.equal(MAX_SESSION_LIMIT, 10);
    assert.equal(result.details.groups.length, 5);
    assert.equal(result.details.totalSessions, 7);
    assert.equal(result.details.totalHits, 7);
    assert.equal(result.details.limited, true);
    assert.match(
      textOf(result),
      /7 sessions matched; only the first 5 are listed\. Use more specific keywords to narrow the search\./
    );
    assert.match(textOf(result), /read_session_entry/);
    const ten = await tool.execute("t2", { keywords: ["match"], limit: 10 });
    assert.equal(ten.details.groups.length, 7);
    assert.equal(ten.details.limited, false);
    // 每个会话至多两段片段
    assert.ok(GROUP_SNIPPET_HITS === 2);
  }));

test("search_sessions 总字节上限：超出即停并提示收窄", () =>
  withDir(async (dir) => {
    for (let index = 0; index < 10; index++) {
      const id = asSessionId(`sess_01JAAAAAA2${index}${"0".repeat(15)}`);
      await seed(
        dir,
        (s) => {
          s.startRun({ task: `match ${"长".repeat(60)} ${index}` });
          s.endRun();
        },
        id
      );
    }
    const tool = createSearchSessionsTool({ sessionsDir: dir, maxBytes: 800 });
    const result = await tool.execute("t1", { keywords: ["match"] });
    assert.ok(result.details.groups.length > 0 && result.details.groups.length < 10);
    assert.equal(result.details.byteCapped, true);
    assert.match(textOf(result), /800-byte limit/);
  }));

test("决策 384：三件工具对不认识的参数报错说明（如 sessionId），不静默丢弃", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "needle" });
      s.endRun();
    });
    const search = createSearchSessionsTool({ sessionsDir: dir });
    await assert.rejects(
      search.execute("t1", { keywords: ["needle"], sessionId: "sess_x" } as never),
      /Unknown parameters for search_sessions: sessionId \(available: keywords, conversationOnly, limit\)/
    );
    const read = createReadSessionEntryTool({ sessionsDir: dir });
    await assert.rejects(
      read.execute("t2", { entryId: "e", keywords: ["x"] } as never),
      /Unknown parameters for read_session_entry: keywords/
    );
    const list = createListSessionsTool({ sessionsDir: dir });
    await assert.rejects(
      list.execute("t3", { sessionId: "sess_x" } as never),
      /Unknown parameters for list_sessions: sessionId/
    );
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
    const full = "[thinking] 先读文件\n我来改\n[toolCall] edit_file (tc-1)";
    assert.equal(
      textOf(read),
      [
        `[${assistant.entryId} | session ${SESSION} | ${runId} #2 | assistant | ${new Date(assistant.timestamp).toISOString()}]`,
        `--- Text (${full.length} characters in total, showing 0–${full.length}) ---`,
        full,
      ].join("\n")
    );
    assert.deepEqual(read.details, {
      sessionId: SESSION,
      entryId: assistant.entryId,
      runId,
      runSeq: 2,
      role: "assistant",
      totalChars: full.length,
      offset: 0,
      truncated: false,
    });
    const errorText = "失败：锚点不唯一";
    assert.equal(
      textOf(await tool.execute("t2", { entryId: result.entryId, sessionId: SESSION })),
      [
        `[${result.entryId} | session ${SESSION} | ${runId} #3 | toolResult (edit_file, error) | ${new Date(result.timestamp).toISOString()}]`,
        `--- Text (${errorText.length} characters in total, showing 0–${errorText.length}) ---`,
        errorText,
      ].join("\n")
    );
  }));

test("read_session_entry：单次上限给出总长度、可按偏移续读（去上限或吃掉续读提示变红）；找不到条目响亮报错", () =>
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
    const first = await tool.execute("t1", { entryId });
    assert.equal(READ_ENTRY_CHARS, 4_000);
    assert.equal(MAX_READ_ENTRY_CHARS, 8_000);
    assert.equal(first.details.totalChars, long.length);
    assert.equal(first.details.truncated, true);
    const text = textOf(first);
    assert.ok(
      text.includes(
        `--- Text (${long.length} characters in total, showing 0–${READ_ENTRY_CHARS}) ---`
      ),
      text
    );
    assert.ok(text.includes(`(Not fully shown: continue with offset: ${READ_ENTRY_CHARS})`), text);
    assert.ok(!text.endsWith(long), "单次读出不得超过上限");
    // 续读：offset 接上，两段拼回原文；maxChars 可调
    const second = await tool.execute("t2", { entryId, offset: READ_ENTRY_CHARS, maxChars: 8_000 });
    assert.equal(second.details.offset, READ_ENTRY_CHARS);
    assert.equal(second.details.truncated, true);
    const secondSlice = textOf(second);
    assert.ok(
      secondSlice.includes(`showing ${READ_ENTRY_CHARS}–${READ_ENTRY_CHARS + 8_000})`),
      secondSlice
    );
    const tail = await tool.execute("t3", { entryId, offset: long.length - 10 });
    assert.ok(textOf(tail).endsWith(long.slice(-10)));
    await assert.rejects(
      tool.execute("t4", { entryId, offset: long.length + 1 }),
      /beyond the total text length/
    );
    await assert.rejects(
      tool.execute("t5", { entryId: "no-such-entry" }),
      /Entry no-such-entry not found/
    );
    await assert.rejects(tool.execute("t6", { entryId, sessionId: other }), /not found/);
  }));

test("read_session_entry：可选读前后若干条消息（各自截断，标注读全文的方法）", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => {
      s.startRun({ task: "第一条上下文" });
      s.assistant({ text: "中间那条 needle" });
      s.assistant({ text: `后一条 ${"长".repeat(2_000)}` });
      s.endRun();
    });
    const view = loadSessionView(dir, SESSION);
    const middle = view?.messages[1];
    assert.ok(middle !== undefined);
    const tool = createReadSessionEntryTool({ sessionsDir: dir });
    const result = await tool.execute("t1", { entryId: middle.entryId, before: 1, after: 1 });
    const text = textOf(result);
    assert.ok(text.includes("--- 1 message before ---"), text);
    assert.ok(text.includes("第一条上下文"), text);
    assert.ok(text.includes("--- 1 message after ---"), text);
    assert.ok(
      text.includes("(truncated; to read the full text, use read_session_entry with its entryId)"),
      text
    );
    // 主条不受前后条影响，详情照实
    assert.equal(result.details.entryId, middle.entryId);
    assert.equal(result.details.truncated, false);
    // 超出消息范围时按实际有的给
    const first = view?.messages[0];
    const edge = textOf(await tool.execute("t2", { entryId: first?.entryId ?? "", before: 3 }));
    assert.ok(!edge.includes(" before ---"), edge);
  }));

test("经真实 Adapter 调用 search_sessions：read 档自动放行，会话存储里只有这一次调用与它的工具结果", () =>
  withDir(async (dir) => {
    await seed(dir, (s) => s.startRun({ task: "上周部署过网关" }));

    const sessionId = newSessionId();
    // 运行面写入的消息收在内存里（不落进被检索的会话根，免得检索到本次运行自己）
    const written: AgentMessage[] = [];
    const sessionStore = {
      appendMessage: (message: AgentMessage) => written.push(message),
      append: () => undefined,
    };
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
      sessionStore,
    });
    const result = await adapter.run("我们以前部署过什么");
    assert.equal(result.status, "completed");
    await adapter.dispose();
    assert.match(outputs[0] ?? "", /^Matches in 1 session /);

    // 工具调用只有一次、工具结果只有一条：都是 search_sessions，结果未出错，审批闸标记为策略自动放行
    const calls = written.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
        : []
    );
    assert.deepEqual(calls, [SEARCH_SESSIONS_TOOL]);
    const results = written.filter((message) => message.role === "toolResult");
    assert.deepEqual(
      results.map((message) => [message.toolName, message.isError]),
      [[SEARCH_SESSIONS_TOOL, false]]
    );
    assert.deepEqual(toolResultMark(results[0] as unknown as StoreMessage), {
      gate: { outcome: "approved", approvedBy: "policy:auto" },
    });
    assert.equal(result.toolExecutions[0]?.decision?.approvedBy, "policy:auto");
  }));

test("决策 339 ①：search_sessions 与 list_sessions 排除当前会话；read_session_entry 照常读当前会话的条目", () =>
  withDir(async (dir) => {
    const current = newSessionId();
    await seed(dir, (s) => {
      s.startRun({ task: "needle 以前的会话" });
      s.endRun();
    });
    await seed(
      dir,
      (s) => {
        s.startRun({ task: "needle 当前会话" });
        s.endRun();
      },
      current
    );
    const options = { sessionsDir: dir, current: { sessionId: current } };
    const search = await createSearchSessionsTool(options).execute("t1", { keywords: ["needle"] });
    assert.deepEqual(
      search.details.groups.map((group) => group.sessionId),
      [SESSION]
    );
    const list = await createListSessionsTool(options).execute("t2", {});
    assert.deepEqual(
      list.details.sessions.map((info) => info.sessionId),
      [SESSION]
    );
    const entryId = loadSessionView(dir, current)?.messages[0]?.entryId ?? "";
    assert.match(
      textOf(await createReadSessionEntryTool(options).execute("t3", { entryId })),
      /needle 当前会话/
    );
  }));

test("决策 339 ⑤：list_sessions 典型输出逐字——从新到旧，会话号、开始时间、第一句话（截断）、改动过的文件（edit_file 成功写入与 run_command 文件变化）", () =>
  withDir(async (dir) => {
    const older = asSessionId("sess_01JAAAAAA10000000000000000");
    await seed(
      dir,
      (s) => {
        s.startRun({ task: "早先的会话" });
        s.endRun();
      },
      older
    );
    await seed(dir, (s) => {
      s.startRun({ task: `把登录页的超时改成 30 秒，${"并且".repeat(40)}` });
      s.toolTurn({ name: "edit_file", args: { path: "src/login.ts" }, result: "ok" });
      s.toolTurn({
        name: "edit_file",
        args: { path: "src/failed.ts" },
        result: "失败",
        isError: true,
      });
      s.toolTurn({
        name: "run_command",
        result: "退出码：0",
        details: {
          fileChanges: {
            added: ["src/new.ts"],
            removed: ["src/old.ts"],
            modified: ["./src/login.ts", "package.json"],
            truncated: false,
          },
        },
      });
      s.toolTurn({ name: "read_file", args: { path: "src/read-only.ts" }, result: "x" });
      s.endRun();
    });
    const tool = createListSessionsTool({ sessionsDir: dir });
    assert.equal(tool.name, LIST_SESSIONS_TOOL);
    const result = await tool.execute("t1", {});
    const minute = (sessionId: SessionId) =>
      new Date(sessionCreatedAt(sessionId)).toISOString().slice(0, 16).replace("T", " ");
    assert.equal(
      textOf(result),
      [
        "Earlier sessions: 2 (newest first, times in UTC):",
        `- ${SESSION} | ${minute(SESSION)} | first message: 把登录页的超时改成 30 秒，${"并且".repeat(22)}并…`,
        "  changed files: src/login.ts, src/new.ts, package.json, src/old.ts",
        `- ${older} | ${minute(older)} | first message: 早先的会话`,
        "  changed files: (none)",
        "Not truncated: all matching sessions are listed.",
      ].join("\n")
    );
    assert.equal(result.details.total, 2);
    // details 与给模型的文本同样截断
    assert.deepEqual(result.details.sessions[0], {
      sessionId: SESSION,
      createdAt: sessionCreatedAt(SESSION),
      firstUserText: `把登录页的超时改成 30 秒，${"并且".repeat(22)}并…`,
      changedFiles: ["src/login.ts", "src/new.ts", "package.json", "src/old.ts"],
      changedFileCount: 4,
    });
    assert.equal(result.details.limited, false);
  }));

test("决策 339 ⑤：list_sessions 按时间范围与文件路径（子串、前缀）筛选；超过上限时截断并说明总数；时间写错响亮报错", () =>
  withDir(async (dir) => {
    const ids = [
      asSessionId("sess_01JAAAAAA10000000000000000"),
      asSessionId("sess_01JAAAAAA20000000000000000"),
      asSessionId("sess_01JAAAAAA30000000000000000"),
    ];
    for (const [index, id] of ids.entries()) {
      await seed(
        dir,
        (s) => {
          s.startRun({ task: `第 ${index} 个` });
          s.toolTurn({ name: "edit_file", args: { path: `src/mod${index}/file.ts` } });
          s.endRun();
        },
        id
      );
    }
    const tool = createListSessionsTool({ sessionsDir: dir });
    const listed = async (params: Record<string, unknown>) =>
      (await tool.execute("t", params as never)).details.sessions.map((info) => info.sessionId);
    assert.deepEqual(await listed({ path: "mod1" }), [ids[1]]);
    assert.deepEqual(await listed({ path: "src/mod" }), [ids[2], ids[1], ids[0]]);
    assert.deepEqual(await listed({ path: "nowhere" }), []);
    const at = (id: SessionId) => new Date(sessionCreatedAt(id)).toISOString();
    assert.deepEqual(await listed({ since: at(ids[1] as SessionId) }), [ids[2], ids[1]]);
    assert.deepEqual(await listed({ until: at(ids[1] as SessionId) }), [ids[1], ids[0]]);
    // 日期写法：until 含当天全天
    const day = at(ids[0] as SessionId).slice(0, 10);
    assert.deepEqual(await listed({ since: day, until: day }), [ids[2], ids[1], ids[0]]);

    const capped = await tool.execute("t", { limit: 2 });
    assert.deepEqual(
      capped.details.sessions.map((info) => info.sessionId),
      [ids[2], ids[1]]
    );
    assert.equal(capped.details.limited, true);
    assert.match(
      textOf(capped),
      /Truncated: 3 sessions match; only the newest 2 are listed\. Narrow the list with since, until, or path\.$/
    );
    assert.equal(
      textOf(await tool.execute("t", { path: "nowhere" })),
      "No earlier sessions match (filters: path contains nowhere)."
    );
    assert.equal(DEFAULT_LIST_SESSIONS_LIMIT, 20);
    await assert.rejects(tool.execute("t", { since: "上周" }), /Unrecognized time: 上周/);
    // 规范化后为空的路径（只写了 ./）报错，不当作不筛选
    await assert.rejects(
      tool.execute("t", { path: "./" }),
      /path is empty after normalization: \.\//
    );
  }));

test("list_sessions：改动文件超过 10 个时文本与 details 都只带前 10 个与总数；路径筛选词与存储同一规范化（./ 与反斜杠）", () =>
  withDir(async (dir) => {
    const files = Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`);
    await seed(dir, (s) => {
      s.startRun({ task: "改很多文件" });
      for (const file of files) {
        s.toolTurn({ name: "edit_file", args: { path: `./${file}` } });
      }
      s.endRun();
    });
    const tool = createListSessionsTool({ sessionsDir: dir });
    const result = await tool.execute("t1", {});
    assert.deepEqual(result.details.sessions[0]?.changedFiles, files.slice(0, 10));
    assert.equal(result.details.sessions[0]?.changedFileCount, 12);
    assert.match(textOf(result), /src\/f9\.ts \(12 files in total\)\n/);
    for (const path of ["./src/f11.ts", "src\\f11.ts", ".\\src\\f11", "src/f11.ts"]) {
      assert.deepEqual(
        (await tool.execute("t2", { path })).details.sessions.map((info) => info.sessionId),
        [SESSION],
        path
      );
    }
  }));

test("决策 339 ①：list_sessions 不列当前会话所在的这一组会话（父会话里列不出它派出的 worker，worker 里列不出父会话与兄弟）", () =>
  withDir(async (dir) => {
    const parent = createFixtureSession({ sessionsDir: dir, sessionId: SESSION });
    parent.startRun({ task: "主会话" });
    const children: string[] = [];
    for (const name of ["w1", "w2"]) {
      const child = spawnFixtureWorker(parent, { sessionsDir: dir, name, task: `${name} 的活` });
      child.startRun({ task: `${name} 的活` });
      child.endRun();
      children.push((await child.close()).sessionId);
    }
    parent.endRun();
    await parent.close();
    const other = asSessionId("sess_01JAAAAAA10000000000000000");
    await seed(
      dir,
      (s) => {
        s.startRun({ task: "不相干" });
        s.endRun();
      },
      other
    );
    for (const current of [SESSION, ...children]) {
      const listed = await createListSessionsTool({
        sessionsDir: dir,
        current: { sessionId: current },
      }).execute("t", {});
      assert.deepEqual(
        listed.details.sessions.map((info) => info.sessionId),
        [other],
        current
      );
    }
  }));
