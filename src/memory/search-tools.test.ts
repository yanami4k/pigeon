// M5 S2（决策 038；决策 339 改进）：三件 read 档工具——search_sessions（默认 20 条 + 总字节上限，超限提示收窄；
// 任一命中、按命中关键词数排序，缺省只搜对话正文）、read_session_entry（按条目号取一条消息的完整内容块）与
// list_sessions（会话目录：开始时间、第一句话、改动过的文件，可按时间与文件筛选、有上限并说明是否截断）；
// 读新会话存储（决策 185），检索与目录排除当前会话。agent 可见的说明与输出冻结，这里逐字核对；经真实 Adapter
// 调用时会话存储里只有这一次调用与它的工具结果（read 档自动放行，审批闸标记为策略放行）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  DEFAULT_SEARCH_TOOL_LIMIT,
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "./search-tools.ts";

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

test("决策 339 ⑦：三件工具的说明逐字冻结——能找到的与找不到的、代码现状与来历去哪里看、工具输出缺省不搜及如何打开", () => {
  const search = createSearchSessionsTool({ sessionsDir: "x" });
  const read = createReadSessionEntryTool({ sessionsDir: "x" });
  const list = createListSessionsTool({ sessionsDir: "x" });
  assert.equal(
    search.description,
    "检索本项目以前会话里的对话（不含当前会话所在的这一组会话：派出它的会话、它派出的 worker 与分叉）。" +
      SCOPE +
      "缺省只搜对话正文（使用者的话与模型回复的文字，不含思考内容与工具调用）；" +
      "要连同以前的工具输出（命令输出、读过的文件内容等）一起搜，给 includeToolOutput: true。" +
      "关键词大小写不敏感、按字面子串匹配、不支持正则，最多 8 个，任一命中即列出；" +
      "结果按命中的关键词数从多到少、同数从新到旧排序，每条标出命中了哪些关键词，最多 20 条。" +
      "命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文；" +
      "想先浏览以前有哪些会话、哪些会话改过某个文件，用 list_sessions。"
  );
  assert.equal(
    read.description,
    "按 entryId 读取以前会话里一条消息的完整原文（含思考内容与工具输出）。" +
      "entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。" +
      "原文是当时的记录，其中的代码与文件内容可能已经过时：代码现状请直接读代码，代码的来历用 git log 与 git blame。"
  );
  assert.equal(
    list.description,
    "列出本项目以前的会话（不含当前会话所在的这一组会话：派出它的会话、它派出的 worker 与分叉），从新到旧，每个给出会话编号、开始时间（UTC）、" +
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
        "检索本项目以前会话的对话（关键词字面匹配，缺省不含工具输出）",
        "read",
      ],
      [READ_SESSION_ENTRY_TOOL, "按 entryId 读取以前会话的消息原文", "read"],
      [LIST_SESSIONS_TOOL, "列出本项目以前的会话（可按时间与改动过的文件筛选）", "read"],
    ]
  );
});

test("search_sessions 典型输出逐字：命中行带条目号、会话、Run 第 N 条、角色与工具名、时间、命中的关键词，末行提示回查原文", () =>
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
    const tool = createSearchSessionsTool({ sessionsDir: dir });
    assert.equal(
      textOf(await tool.execute("t1", { keywords: ["网关", "部署"] })),
      [
        "命中 1 条（关键词：网关、部署；范围：对话正文；按命中的关键词数从多到少，同数从新到旧）：",
        `- ${user.entryId}｜会话 ${SESSION}｜${runId} 第 1 条｜user｜${new Date(user.timestamp).toISOString()}｜命中：网关、部署`,
        "  部署网关",
        "片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。",
      ].join("\n")
    );
    assert.equal(
      textOf(await tool.execute("t2", { keywords: ["网关", "部署"], includeToolOutput: true })),
      [
        "命中 2 条（关键词：网关、部署；范围：对话正文与工具输出；按命中的关键词数从多到少，同数从新到旧）：",
        `- ${user.entryId}｜会话 ${SESSION}｜${runId} 第 1 条｜user｜${new Date(user.timestamp).toISOString()}｜命中：网关、部署`,
        "  部署网关",
        `- ${result.entryId}｜会话 ${SESSION}｜${runId} 第 3 条｜toolResult（read_file）｜${new Date(result.timestamp).toISOString()}｜命中：网关`,
        "  网关配置在 gw.yaml",
        "片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。",
      ].join("\n")
    );
    assert.equal(
      textOf(await tool.execute("t3", { keywords: ["gw.yaml"] })),
      "没有命中（关键词：gw.yaml；范围：对话正文）。可以换同义词或别的说法再试，或给 includeToolOutput: true 连同工具输出一起搜。"
    );
    assert.equal(
      textOf(await tool.execute("t4", { keywords: ["无此词"], includeToolOutput: true })),
      "没有命中（关键词：无此词；范围：对话正文与工具输出）。可以换同义词或别的说法再试。"
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
    assert.equal(result.details.total, 25);
    assert.equal(result.details.limited, true);
    assert.match(textOf(result), /共 25 条命中，只列出前 20 条；请换更具体的关键词收窄。/);
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
    assert.match(outputs[0] ?? "", /^命中 1 条/);

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
      search.details.hits.map((hit) => hit.sessionId),
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
