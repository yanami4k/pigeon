// M5 S2（决策 038）：内容级 Session Search 扫描器测试——从新到旧逐会话读新会话存储（决策 181 / 185），
// 多词与、大小写不敏感、元字符按字面、角色过滤、复用 SessionListFilters、上限即停；分支会话的复制段不重复命中、
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

async function collect(iterable: AsyncIterable<SessionSearchHit>): Promise<SessionSearchHit[]> {
  const hits: SessionSearchHit[] = [];
  for await (const hit of iterable) {
    hits.push(hit);
  }
  return hits;
}

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-"));
  return run(join(root, ".pigeon", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

test("从新到旧逐会话；多词为与、大小写不敏感；命中带条目号、Run 内序号、时间与含关键词的片段", () =>
  withDir(async (dir) => {
    const oldIds = await seed(dir, OLD, (s) => {
      s.startRun({ task: "Deploy the API gateway" });
      s.assistant({ text: "gateway 已部署" });
      s.endRun();
    });
    await seed(dir, MID, (s) => {
      s.startRun({ task: "只提到 deploy" });
      s.endRun();
    });
    const newIds = await seed(dir, NEW, (s) => {
      s.startRun({ task: "DEPLOY 与 Gateway 都在" });
      s.endRun();
    });

    const hits = await collect(
      createSessionSearch(dir).search({ keywords: ["deploy", "GATEWAY"] })
    );
    assert.deepEqual(
      hits.map((hit) => [hit.sessionId, hit.entryId, hit.runSeq, hit.role]),
      [
        [NEW, newIds[0], 1, "user"],
        [OLD, oldIds[0], 1, "user"],
      ]
    );
    assert.ok(hits[1]?.snippet.includes("Deploy the API gateway"));
    assert.equal(typeof hits[0]?.timestamp, "number");
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
        [runs[1]?.runId, 1, "user"],
        [runs[1]?.runId, 2, "assistant"],
      ]
    );
  }));

test("角色过滤：只搜 toolResult 时命中带工具名；thinking 与工具调用名可检索", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "查一下 token" });
      s.assistant({ thinking: "先想想 token 在哪", toolCalls: [{ name: "read_file" }] });
      s.toolResult({ toolCallId: "tc-1", toolName: "read_file", text: "token=abc" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    const results = await collect(search.search({ keywords: ["token"], roles: ["toolResult"] }));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.role, "toolResult");
    assert.equal(results[0]?.toolName, "read_file");
    assert.deepEqual(
      (await collect(search.search({ keywords: ["read_file"], roles: ["assistant"] }))).map(
        (hit) => hit.runSeq
      ),
      [2]
    );
    assert.deepEqual(
      (await collect(search.search({ keywords: ["先想想"] }))).map((hit) => hit.role),
      ["assistant"]
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

test("上限即停：给定 limit 后只产出 limit 条", () =>
  withDir(async (dir) => {
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "match 0" });
      for (let index = 1; index < 5; index++) {
        s.user(`match ${index}`);
      }
      s.endRun();
    });
    const hits = await collect(
      createSessionSearch(dir).search({ keywords: ["match"] }, { limit: 3 })
    );
    assert.equal(hits.length, 3);
  }));

test("复用 SessionListFilters：tool 只搜用过该工具的会话，since 按会话创建时间", () =>
  withDir(async (dir) => {
    await seed(dir, OLD, (s) => {
      s.startRun({ task: "alpha 老会话" });
      s.toolTurn({ name: "read_file" });
      s.endRun();
    });
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "alpha 新会话" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (await collect(search.search({ keywords: ["alpha"], filters: { tool: "read_file" } }))).map(
        (hit) => hit.sessionId
      ),
      [OLD]
    );
    assert.deepEqual(
      (
        await collect(
          search.search({ keywords: ["alpha"], filters: { since: sessionCreatedAt(NEW) } })
        )
      ).map((hit) => hit.sessionId),
      [NEW]
    );
  }));

test("复用 SessionListFilters：class 按工具级失败分类过滤（工具结果上的环境异常标记）", () =>
  withDir(async (dir) => {
    await seed(dir, OLD, (s) => {
      s.startRun({ task: "alpha 环境异常" });
      const [id = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
      s.toolResult({
        toolCallId: id,
        toolName: "edit_file",
        text: "EACCES",
        isError: true,
        details: {
          pigeon: {
            errorKind: "environment",
            gate: { outcome: "approved", approvedBy: "policy:yolo" },
          },
        },
      });
      s.assistant({ text: "改不了" });
      s.endRun();
    });
    await seed(dir, NEW, (s) => {
      s.startRun({ task: "alpha 正常" });
      s.toolTurn({ name: "edit_file" });
      s.endRun();
    });
    const search = createSessionSearch(dir);
    assert.deepEqual(
      (
        await collect(search.search({ keywords: ["alpha"], filters: { class: "infrastructure" } }))
      ).map((hit) => hit.sessionId),
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
