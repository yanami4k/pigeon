// M5 S2（决策 038）：内容级 Session Search 扫描器测试——从新到旧逐会话流式扫内容文件，
// 多词与、大小写不敏感、元字符按字面、角色过滤、复用 SessionListFilters、上限即停、截断标记。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, type JsonlEventLogOptions } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION } from "../state/events.ts";
import { asSessionId, newEntryId, newRunId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import {
  createSessionSearch,
  DEFAULT_SNIPPET_CHARS,
  type SessionSearchHit,
} from "./session-search.ts";

const OLD = asSessionId("sess_01JAAAAAA10000000000000000");
const MID = asSessionId("sess_01JAAAAAA20000000000000000");
const NEW = asSessionId("sess_01JAAAAAA30000000000000000");

interface SeedMessage {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

function seed(
  dir: string,
  sessionId: SessionId,
  messages: SeedMessage[],
  options: { tools?: string[]; log?: JsonlEventLogOptions } = {}
): string[] {
  const log = new JsonlEventLog(dir, sessionId, options.log);
  const runId = newRunId();
  const entryIds: string[] = [];
  for (const [index, message] of messages.entries()) {
    entryIds.push(log.appendEntry({ runSeq: index + 1, role: message.role, runId, message }).id);
  }
  for (const toolName of options.tools ?? []) {
    log.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind: RuntimeEventKind.ToolProposed,
      payload: { toolCallId: `tc-${toolName}`, toolName, args: {} },
    });
  }
  log.close();
  return entryIds;
}

async function collect(iterable: AsyncIterable<SessionSearchHit>): Promise<SessionSearchHit[]> {
  const hits: SessionSearchHit[] = [];
  for await (const hit of iterable) {
    hits.push(hit);
  }
  return hits;
}

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-search-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("从新到旧逐会话；多词为与、大小写不敏感；命中带 entry 身份、时间与含关键词的片段", () =>
  withDir(async (dir) => {
    const oldIds = seed(dir, OLD, [
      { role: "user", content: "Deploy the API gateway" },
      { role: "assistant", content: [{ type: "text", text: "gateway 已部署" }] },
    ]);
    seed(dir, MID, [{ role: "user", content: "只提到 deploy" }]);
    const newIds = seed(dir, NEW, [{ role: "user", content: "DEPLOY 与 Gateway 都在" }]);

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
    assert.equal(hits[0]?.truncated, false);
  }));

test("角色过滤：只搜 toolResult 时命中带工具名", () =>
  withDir(async (dir) => {
    seed(dir, NEW, [
      { role: "user", content: "查一下 token" },
      {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "tc-1",
        isError: false,
        content: [{ type: "text", text: "token=abc" }],
      },
    ]);
    const hits = await collect(
      createSessionSearch(dir).search({ keywords: ["token"], roles: ["toolResult"] })
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.role, "toolResult");
    assert.equal(hits[0]?.toolName, "read_file");
  }));

test("元字符按字面匹配：a.b 不命中 axb，方括号与括号星号不抛（字面匹配改 RegExp 构造变红）", () =>
  withDir(async (dir) => {
    seed(dir, NEW, [
      { role: "user", content: "路径 a.b 在这里" },
      { role: "user", content: "只有 axb" },
      { role: "user", content: "表达式 f(x)*2 与数组 [0]" },
    ]);
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

test("截断记录的命中带 truncated 标记；片段是关键词附近约 200 字的窗口", () =>
  withDir(async (dir) => {
    const text = `${"甲".repeat(400)}needle${"乙".repeat(400)}`;
    seed(dir, NEW, [{ role: "user", content: text }], {
      log: { content: { blockLimitBytes: 2000 } },
    });
    const hits = await collect(createSessionSearch(dir).search({ keywords: ["needle"] }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.truncated, true);
    const snippet = hits[0]?.snippet ?? "";
    assert.ok(snippet.includes("needle"));
    assert.equal(DEFAULT_SNIPPET_CHARS, 200);
    assert.ok(snippet.length <= DEFAULT_SNIPPET_CHARS + 2, `片段过长：${snippet.length}`);
  }));

test("上限即停：给定 limit 后只产出 limit 条", () =>
  withDir(async (dir) => {
    seed(
      dir,
      NEW,
      Array.from({ length: 5 }, (_, index) => ({
        role: "user" as const,
        content: `match ${index}`,
      }))
    );
    const hits = await collect(
      createSessionSearch(dir).search({ keywords: ["match"] }, { limit: 3 })
    );
    assert.equal(hits.length, 3);
  }));

test("复用 SessionListFilters：tool 只搜用过该工具的会话，since 按会话创建时间", () =>
  withDir(async (dir) => {
    seed(dir, OLD, [{ role: "user", content: "alpha 老会话" }], { tools: ["read_file"] });
    seed(dir, NEW, [{ role: "user", content: "alpha 新会话" }]);
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

test("空关键词响亮拒绝；无会话目录返回零命中", () =>
  withDir(async (dir) => {
    const search = createSessionSearch(join(dir, "不存在"));
    await assert.rejects(collect(search.search({ keywords: ["  "] })), /至少需要一个关键词/);
    assert.deepEqual(await collect(search.search({ keywords: ["x"] })), []);
  }));
