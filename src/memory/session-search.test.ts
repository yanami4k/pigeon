// M5 S2（决策 038；决策 339 改进）：内容级 Session Search 扫描器测试——读新会话存储（决策 181 / 185），
// 任一关键词命中、按命中的不同关键词数排序再按新旧、大小写不敏感、元字符按字面；缺省只搜对话正文、工具输出显式打开、
// 检索工具自身的输出永不进检索、排除当前会话；角色过滤、创建时间范围、上限与总数；分支会话的复制段不重复命中、
// 会话根下的旧格式平铺文件不检索也不报错、读正被写入的文件不改文件。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFixtureSession,
  type FixtureSession,
  forkFixture,
  tearTail,
} from "../application/session-store-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import {
  createSessionSearch,
  DEFAULT_SNIPPET_CHARS,
  type SessionSearchHit,
  type SessionSearchResult,
} from "./session-search.ts";

const OLD = asSessionId("sess_01JAAAAAA10000000000000000");
const MID = asSessionId("sess_01JAAAAAA20000000000000000");
const NEW = asSessionId("sess_01JAAAAAA30000000000000000");

// 开一个会话，写完关闭，返回本会话各消息的条目号
async function seed(
  dir: string,
  sessionId: SessionId,
  write: (session: FixtureSession) => void
): Promise<string[]> {
  const session = createFixtureSession({ sessionsDir: dir, sessionId });
  write(session);
  await session.close();
  return (loadSessionView(dir, sessionId)?.messages ?? []).map((message) => message.entryId);
}

async function collect(result: Promise<SessionSearchResult>): Promise<SessionSearchHit[]> {
  return (await result).hits;
}

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-"));
  return run(join(root, ".pigeon", "state", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

test("决策 339 ④：任一关键词命中即列出，按命中的不同关键词数从多到少、同数从新到旧；大小写不敏感；命中标出关键词", () =>
  withDir(async (dir) => {
    const oldIds = await seed(dir, OLD, (s) => {
      s.startRun({ task: "Deploy the API gateway" });
      s.assistant({ text: "gateway 已部署" });
      s.endRun();
    });
    const midIds = await seed(dir, MID, (s) => {
      s.startRun({ task: "只提到 deploy" });
      s.endRun();
    });
    const newIds = await seed(dir, NEW, (s) => {
      s.startRun({ task: "DEPLOY 与 Gateway 都在" });
      s.endRun();
    });

    const hits = await collect(
      createSessionSearch(dir).search({ keywords: ["deploy", "GATEWAY", "无此词"] })
    );
    assert.deepEqual(
      hits.map((hit) => [hit.sessionId, hit.entryId, hit.runSeq, hit.role, hit.matchedKeywords]),
      [
        [NEW, newIds[0], 1, "user", ["deploy", "GATEWAY"]],
        [OLD, oldIds[0], 1, "user", ["deploy", "GATEWAY"]],
        [MID, midIds[0], 1, "user", ["deploy"]],
        [OLD, oldIds[1], 2, "assistant", ["GATEWAY"]],
      ]
    );
    assert.ok(hits[1]?.snippet.includes("Deploy the API gateway"));
    assert.equal(typeof hits[0]?.timestamp, "number");
  }));

test("决策 339 ④：同数时按消息时间从新到旧，不按会话先后（旧会话里后写的消息排在前）", () =>
  withDir(async (dir) => {
    // 条目时间是写入时刻：每段写完关闭、隔几毫秒再写下一段
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const old = createFixtureSession({ sessionsDir: dir, sessionId: OLD });
    old.startRun({ task: "needle 早" });
    old.endRun();
    const { path } = await old.close();
    await pause();
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "needle 中" });
      s.endRun();
    });
    await pause();
    const reopened = createFixtureSession({ sessionsDir: dir, sessionId: OLD, existingPath: path });
    reopened.startRun({ task: "needle 晚" });
    reopened.endRun();
    await reopened.close();
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["needle"] }));
    assert.deepEqual(
      hits.map((hit) => [hit.sessionId, hit.snippet]),
      [
        [OLD, "needle 晚"],
        [NEW, "needle 中"],
        [OLD, "needle 早"],
      ]
    );
  }));

test("决策 339 ①：排除当前会话；其余会话照常命中", () =>
  withDir(async (dir) => {
    await seed(dir, OLD, (s) => {
      s.startRun({ task: "needle 以前" });
      s.endRun();
    });
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "needle 当前" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (await collect(search.search({ keywords: ["needle"], excludeSessionId: NEW }))).map(
        (hit) => hit.sessionId
      ),
      [OLD]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["needle"] }))).map((hit) => hit.sessionId),
      [NEW, OLD]
    );
  }));

test("Run 内序号由 Run 开始条目现算：第二个 Run 的消息从 1 起数", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "第一个 Run" });
      s.assistant({ text: "好" });
      s.endRun();
      s.startRun({ task: "第二个 Run 里的 needle" });
      s.assistant({ text: "回复 needle" });
      s.endRun();
    });
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["needle"] }));
    const runs = loadSessionView(dir, NEW)?.runs ?? [];
    assert.deepEqual(
      hits.map((hit) => [hit.runId, hit.runSeq, hit.role]),
      [
        [runs[1]?.runId, 2, "assistant"],
        [runs[1]?.runId, 1, "user"],
      ]
    );
  }));

test("决策 339 ②：缺省只搜对话正文——思考、工具调用名与参数、工具输出都不搜；工具输出显式打开或按 toolResult 角色过滤才搜", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "查一下 token" });
      s.assistant({
        thinking: "先想想 secret 在哪",
        text: "我来读",
        toolCalls: [{ name: "read_file", args: { path: "argpath.ts" } }],
      });
      s.toolResult({ toolCallId: "tc-1", toolName: "read_file", text: "token=abc output-only" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    for (const keyword of ["secret", "read_file", "argpath", "output-only"]) {
      assert.deepEqual(await collect(search.search({ keywords: [keyword] })), [], keyword);
    }
    assert.deepEqual(
      (await collect(search.search({ keywords: ["token"] }))).map((hit) => hit.role),
      ["user"]
    );
    const opened = await collect(search.search({ keywords: ["token"], includeToolOutput: true }));
    assert.deepEqual(
      opened.map((hit) => [hit.role, hit.toolName]),
      [
        ["toolResult", "read_file"],
        ["user", undefined],
      ]
    );
    const byRole = await collect(search.search({ keywords: ["token"], roles: ["toolResult"] }));
    assert.deepEqual(
      byRole.map((hit) => hit.role),
      ["toolResult"]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["我来读"], roles: ["assistant"] }))).map(
        (hit) => hit.runSeq
      ),
      [2]
    );
  }));

test("决策 339 ③：三件检索工具自身的输出永不进检索，打开工具输出时也不进；它们的调用参数也不进", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "开始" });
      for (const name of ["search_sessions", "read_session_entry", "list_sessions"]) {
        s.toolTurn({ name, args: { keywords: ["echo-arg"] }, result: `echo-out ${name}` });
      }
      s.toolTurn({ name: "run_command", result: "echo-out run_command" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (await collect(search.search({ keywords: ["echo-out"], includeToolOutput: true }))).map(
        (hit) => hit.toolName
      ),
      ["run_command"]
    );
    assert.deepEqual(
      await collect(search.search({ keywords: ["echo-arg"], includeToolOutput: true })),
      []
    );
  }));

test("元字符按字面匹配：a.b 不命中 axb，方括号与括号星号不抛（字面匹配改 RegExp 构造变红）", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "路径 a.b 在这里" });
      s.user("只有 axb");
      s.user("表达式 f(x)*2 与数组 [0]");
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (await collect(search.search({ keywords: ["a.b"] }))).map((hit) => hit.runSeq),
      [1]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["f(x)*"] }))).map((hit) => hit.runSeq),
      [3]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["["] }))).map((hit) => hit.runSeq),
      [3]
    );
  }));

test("完整存储不截断：64 KiB 之后的内容也可命中；片段是关键词附近约 200 字的窗口", () =>
  withDir(async (dir) => {
    const text = `${"甲".repeat(40_000)}needle${"乙".repeat(400)}`;
    await seed(dir, NEW, (s) => {
      s.startRun({ task: text });
      s.endRun();
    });
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["needle"] }));
    assert.equal(hits.length, 1);
    const snippet = hits[0]?.snippet ?? "";
    assert.ok(snippet.includes("needle"));
    assert.equal(DEFAULT_SNIPPET_CHARS, 200);
    assert.ok(snippet.length <= DEFAULT_SNIPPET_CHARS + 2, `片段过长：${snippet.length}`);
  }));

test("上限：给定 limit 后只给出排序后的前 limit 条，总数照实", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "match 0" });
      for (let index = 1; index < 5; index++) {
        s.user(`match ${index}`);
      }
      s.endRun();
    });
    const result = await createSessionSearch(dir).search({ keywords: ["match"] }, { limit: 3 });
    assert.equal(result.hits.length, 3);
    assert.equal(result.total, 5);
  }));

test("创建时间范围：since 与 until 按会话创建时间（含两端）", () =>
  withDir(async (dir) => {
    await seed(dir, OLD, (s) => {
      s.startRun({ task: "alpha 老会话" });
      s.endRun();
    });
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "alpha 新会话" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (await collect(search.search({ keywords: ["alpha"], since: sessionCreatedAt(NEW) }))).map(
        (hit) => hit.sessionId
      ),
      [NEW]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["alpha"], until: sessionCreatedAt(OLD) }))).map(
        (hit) => hit.sessionId
      ),
      [OLD]
    );
  }));

test("分支会话开头从来源复制的历史不重复命中，分支自己的消息照常命中", () =>
  withDir(async (dir) => {
    const source = createFixtureSession({ sessionsDir: dir, sessionId: OLD });
    const runId = source.startRun({ task: "来源里的 needle" });
    source.assistant({ text: "来源回复" });
    source.endRun();
    await source.close();
    const branch = await forkFixture({ sessionsDir: dir, sourceSessionId: OLD, runId, runSeq: 2 });
    branch.startRun({ task: "分支里的 needle" });
    branch.endRun();
    const { sessionId: branchId } = await branch.close();

    const hits = await collect(createSessionSearch(dir).search({ keywords: ["needle"] }));
    assert.deepEqual(
      hits.map((hit) => [hit.sessionId, hit.runSeq]),
      [
        [branchId, 1],
        [OLD, 1],
      ]
    );
  }));

test("会话根下的旧格式平铺会话文件（迁移之前的会话）不检索、不报错，新存储里的会话照常命中", () =>
  withDir(async (dir) => {
    await seed(dir, OLD, (s) => {
      s.startRun({ task: "clue 新存储里的会话" });
      s.endRun();
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${MID}.jsonl`),
      `${JSON.stringify({ v: 17, kind: "session.header", text: "clue 旧格式" })}\n`
    );
    writeFileSync(join(dir, `${MID}.messages.jsonl`), "clue 旧格式正文\n");
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["clue"] }));
    assert.deepEqual(
      hits.map((hit) => hit.sessionId),
      [OLD]
    );
  }));

test("读正被写入的会话：撕裂的末行不产出命中，文件一个字节都不改", () =>
  withDir(async (dir) => {
    const session = createFixtureSession({ sessionsDir: dir, sessionId: NEW });
    session.startRun({ task: "clue 已落盘" });
    const { path } = await session.close();
    tearTail(
      path,
      '{"kind":"entry","lane":"main","type":"message","message":{"role":"user","content":"clue 半截'
    );
    const before = readFileSync(path);
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["clue"] }));
    assert.deepEqual(
      hits.map((hit) => hit.runSeq),
      [1]
    );
    assert.deepEqual(readFileSync(path), before);
  }));

test("空关键词响亮拒绝；无会话目录返回零命中", () =>
  withDir(async (dir) => {
    const search = createSessionSearch(join(dir, "不存在"));
    await assert.rejects(collect(search.search({ keywords: ["  "] })), /至少需要一个关键词/);
    assert.deepEqual(await collect(search.search({ keywords: ["x"] })), []);
  }));
