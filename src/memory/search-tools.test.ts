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
  "能找到的：以前会话里的讨论、试过的做法及其结果、使用者说过的话（要求、偏好、纠正）。" +
  "找不到的：当前任务的背景（以当前任务的说明为准）、最新的代码（以前会话里看到的代码可能已经过时）。" +
  "代码现状请直接读代码，代码的来历用 git log 与 git blame。";

test("决策 339 ⑦、384：三件工具的说明逐字冻结——能找到的与找不到的、工具输出在范围内且可能过时、关键词写法、按会话归并与读原文分页", () => {
  const search = createSearchSessionsTool({ sessionsDir: "x" });
  const read = createReadSessionEntryTool({ sessionsDir: "x" });
  const list = createListSessionsTool({ sessionsDir: "x" });
  assert.equal(
    search.description,
    "检索本项目以前会话里的对话（不含当前会话所在的这一组会话：最上层的会话及其派出的各级 worker 与分叉，当前会话也在其中）。" +
      SCOPE +
      "以前的工具输出（命令输出、读过的文件内容等）也在检索范围内：可能已过时，依赖之前先核实现状；" +
      "以前的工具调用是当时的尝试，不代表最终结果。只搜对话正文（使用者的话与模型回复）给 conversationOnly: true。" +
      "关键词写几个以前对话里会出现的原词（名字、术语、报错里的词），不写整句，不写“讨论”“昨天”这类元词，不写本次任务才出现的新名字；" +
      "最多 8 个，任一命中即列出，每条标出命中了哪些关键词。" +
      "按词匹配、不分大小写、不支持正则：代码名可以用其中一段命中（如 parseConfig 用 config），中文按相邻两字匹配，单个字按子串匹配；" +
      "多词的关键词拆成词分别计分，整段出现另加分。" +
      "越少见的词命中排得越前，挑有辨识度的词；" +
      "结果按会话归并：每个会话一条，带命中条目数与一两段片段及其条目编号，缺省 5 个会话、最多 10 个。" +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文；" +
      "想先浏览以前有哪些会话、哪些会话改过某个文件，用 list_sessions。"
  );
  assert.equal(
    read.description,
    "按 entryId 读取以前会话里一条消息的原文（含思考内容与工具输出）。" +
      "单次最多 4000 字（可用 maxChars 调、上限 8000），" +
      "返回里给出总长度，没显示完的用 offset 续读；可给 before、after 连同前后若干条消息一起读。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。" +
      "原文是当时的记录，其中的代码与文件内容可能已经过时：代码现状请直接读代码，代码的来历用 git log 与 git blame。"
  );
  assert.equal(
    list.description,
    "列出本项目以前的会话（不含当前会话所在的这一组会话：最上层的会话及其派出的各级 worker 与分叉，当前会话也在其中），从新到旧，每个给出会话编号、开始时间（UTC）、" +
      "第一句使用者的话（截断到 60 字）与改动过的文件（edit_file 的写入与 run_command 报告的文件变化）。" +
      "可按开始时间筛选（since、until，写 YYYY-MM-DD 或 ISO 时间，含两端），" +
      "也可按文件路径筛选（path：改动过的文件路径里含这一段即算，写前缀亦可）；" +
      "最多 20 个，超出时说明共有多少个。" +
      "用来先浏览以前做过什么、哪些会话动过某个文件，再用 search_sessions 检索、read_session_entry 读原文。" +
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
        "命中 1 个会话（关键词：网关、部署；范围：对话正文与工具输出）：",
        `- 会话 ${SESSION}｜开始 ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")}｜命中 2 条`,
        `  ${user.entryId}｜${runId} 第 1 条｜user｜${new Date(user.timestamp).toISOString()}｜命中：网关、部署`,
        "  部署网关",
        `  ${result.entryId}｜${runId} 第 3 条｜toolResult（read_file）｜${new Date(result.timestamp).toISOString()}｜命中：网关`,
        `  以前的工具输出，可能已过时（read_file｜{"path":"gw.yaml"}｜${new Date(result.timestamp).toISOString()}）：`,
        "  网关配置在 gw.yaml",
        "片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。",
      ].join("\n")
    );
    // 只搜对话正文：工具输出那条不在
    const conversationOnly = textOf(
      await tool.execute("t2", { keywords: ["网关", "部署"], conversationOnly: true })
    );
    assert.match(conversationOnly, /范围：仅对话正文/);
    assert.ok(!conversationOnly.includes("toolResult"), conversationOnly);
    assert.equal(
      textOf(await tool.execute("t3", { keywords: ["gw.yaml"], conversationOnly: true })),
      "没有命中（关键词：gw.yaml；范围：仅对话正文）。可以换同义词或别的说法再试，或去掉 conversationOnly 连同工具输出一起搜。"
    );
    assert.equal(
      textOf(await tool.execute("t4", { keywords: ["无此词"] })),
      "没有命中（关键词：无此词；范围：对话正文与工具输出）。可以换同义词或别的说法再试。"
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
    assert.match(textOf(result), /共 7 个会话命中，只列出前 5 个；请换更具体的关键词收窄。/);
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
    assert.match(textOf(result), /字节上限/);
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
      /search_sessions 不认识的参数：sessionId（可用：keywords、conversationOnly、limit）/
    );
    const read = createReadSessionEntryTool({ sessionsDir: dir });
    await assert.rejects(
      read.execute("t2", { entryId: "e", keywords: ["x"] } as never),
      /read_session_entry 不认识的参数：keywords/
    );
    const list = createListSessionsTool({ sessionsDir: dir });
    await assert.rejects(
      list.execute("t3", { sessionId: "sess_x" } as never),
      /list_sessions 不认识的参数：sessionId/
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
    const full = "[thinking] 先读文件\n我来改\n[toolCall] edit_file（tc-1）";
    assert.equal(
      textOf(read),
      [
        `[${assistant.entryId}｜会话 ${SESSION}｜${runId} 第 2 条｜assistant｜${new Date(assistant.timestamp).toISOString()}]`,
        `--- 正文（共 ${full.length} 字，显示第 0–${full.length} 字）---`,
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
        `[${result.entryId}｜会话 ${SESSION}｜${runId} 第 3 条｜toolResult（edit_file，出错）｜${new Date(result.timestamp).toISOString()}]`,
        `--- 正文（共 ${errorText.length} 字，显示第 0–${errorText.length} 字）---`,
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
      text.includes(`--- 正文（共 ${long.length} 字，显示第 0–${READ_ENTRY_CHARS} 字）---`),
      text
    );
    assert.ok(text.includes(`（未显示完：用 offset: ${READ_ENTRY_CHARS} 续读）`), text);
    assert.ok(!text.endsWith(long), "单次读出不得超过上限");
    // 续读：offset 接上，两段拼回原文；maxChars 可调
    const second = await tool.execute("t2", { entryId, offset: READ_ENTRY_CHARS, maxChars: 8_000 });
    assert.equal(second.details.offset, READ_ENTRY_CHARS);
    assert.equal(second.details.truncated, true);
    const secondSlice = textOf(second);
    assert.ok(
      secondSlice.includes(`显示第 ${READ_ENTRY_CHARS}–${READ_ENTRY_CHARS + 8_000} 字`),
      secondSlice
    );
    const tail = await tool.execute("t3", { entryId, offset: long.length - 10 });
    assert.ok(textOf(tail).endsWith(long.slice(-10)));
    await assert.rejects(
      tool.execute("t4", { entryId, offset: long.length + 1 }),
      /超出正文总长度/
    );
    await assert.rejects(
      tool.execute("t5", { entryId: "no-such-entry" }),
      /未找到 entry no-such-entry/
    );
    await assert.rejects(tool.execute("t6", { entryId, sessionId: other }), /未找到 entry/);
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
    assert.ok(text.includes("--- 前 1 条 ---"), text);
    assert.ok(text.includes("第一条上下文"), text);
    assert.ok(text.includes("--- 后 1 条 ---"), text);
    assert.ok(text.includes("截断；读全文用 entryId 加 read_session_entry"), text);
    // 主条不受前后条影响，详情照实
    assert.equal(result.details.entryId, middle.entryId);
    assert.equal(result.details.truncated, false);
    // 超出消息范围时按实际有的给
    const first = view?.messages[0];
    const edge = textOf(await tool.execute("t2", { entryId: first?.entryId ?? "", before: 3 }));
    assert.ok(!edge.includes("--- 前"), edge);
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
    assert.match(outputs[0] ?? "", /^命中 1 个会话/);

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
        "以前的会话 2 个（从新到旧，时间为 UTC）：",
        `- ${SESSION}｜${minute(SESSION)}｜第一句：把登录页的超时改成 30 秒，${"并且".repeat(22)}并…`,
        "  改动文件：src/login.ts、src/new.ts、package.json、src/old.ts",
        `- ${older}｜${minute(older)}｜第一句：早先的会话`,
        "  改动文件：（无）",
        "未截断：符合条件的会话已全部列出。",
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
      /已截断：共 3 个符合条件，只列出最新的 2 个；可用 since、until 或 path 收窄。$/
    );
    assert.equal(
      textOf(await tool.execute("t", { path: "nowhere" })),
      "没有符合条件的以前会话（条件：path 含 nowhere）。"
    );
    assert.equal(DEFAULT_LIST_SESSIONS_LIMIT, 20);
    await assert.rejects(tool.execute("t", { since: "上周" }), /无法识别的时间：上周/);
    // 规范化后为空的路径（只写了 ./）报错，不当作不筛选
    await assert.rejects(tool.execute("t", { path: "./" }), /path 规范化后为空：\.\//);
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
    assert.match(textOf(result), /src\/f9\.ts 等 12 个\n/);
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
