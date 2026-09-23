// 结构化记忆的存与挂（决策 132 / 133）：记忆是账本事实的跨会话视图；缓存按会话文件是否变动增量更新，可随时删除、
// 删后从账本重建，与账本不一致时以账本为准。同一文件、同一指纹的多条合并为一条并计数，以最近一次为准。
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildMemoryEntries,
  loadStructuredMemory,
  structuredMemoryCachePath,
} from "../memory/structured-store.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const FILES = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = helper;\n",
};

// 一步：改 a.ts 时把 b.ts 的类型弄坏（红），回炉一轮修好（绿）——一条类型检查的红转绿
const BREAK_AND_FIX: FakeReply[] = [
  edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
  finished(),
  edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
  finished("修好了"),
];

async function step(repo: MemoryRepo, replies: FakeReply[]): Promise<string> {
  const result = await runHeadless({
    task: "改 a.ts",
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig(["类型"]),
    repairRounds: 2,
    structuredMemory: { enabled: false },
  });
  return result.sessionId;
}

// 下一步开始前把 b.ts 恢复成坏之前的样子（上一步修好的写法不同，这里只为重现同一种摩擦）
function resetB(repo: MemoryRepo): void {
  repo.write("src/b.ts", "export const b = helper;\n");
  repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("reset");
}

test("缓存：按会话文件是否变动增量更新——未变的会话沿用、新会话才重算", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await step(repo, BREAK_AND_FIX);
    const first = loadStructuredMemory(repo.root);
    assert.equal(first.derived, 1);
    assert.equal(first.reused, 0);
    assert.equal(first.facts.length, 1);
    assert.ok(existsSync(structuredMemoryCachePath(repo.root)));
    const again = loadStructuredMemory(repo.root);
    assert.deepEqual([again.derived, again.reused], [0, 1]);
    assert.deepEqual(again.facts, first.facts);
    resetB(repo);
    await step(repo, BREAK_AND_FIX);
    const third = loadStructuredMemory(repo.root);
    assert.deepEqual([third.derived, third.reused], [1, 1]);
    assert.equal(third.facts.length, 2);
  } finally {
    repo.cleanup();
  }
});

test("缓存：删除后从账本重建，结果与删除前一致；损坏的缓存整份重建", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await step(repo, BREAK_AND_FIX);
    const before = loadStructuredMemory(repo.root);
    rmSync(structuredMemoryCachePath(repo.root));
    const rebuilt = loadStructuredMemory(repo.root);
    assert.equal(rebuilt.derived, 1);
    assert.deepEqual(rebuilt.facts, before.facts);
    writeFileSync(structuredMemoryCachePath(repo.root), "{ 坏的");
    const healed = loadStructuredMemory(repo.root);
    assert.equal(healed.derived, 1);
    assert.deepEqual(healed.facts, before.facts);
  } finally {
    repo.cleanup();
  }
});

test("缓存：与账本不一致时以账本为准——签名对不上的会话按账本重算、缓存里多出的会话丢掉", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const sessionId = await step(repo, BREAK_AND_FIX);
    const truth = loadStructuredMemory(repo.root);
    const cachePath = structuredMemoryCachePath(repo.root);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      sessions: Record<string, { size: number; mtimeMs: number; facts: unknown[] }>;
    };
    const entry = cache.sessions[sessionId];
    assert.ok(entry !== undefined);
    // 缓存里这个会话的事实被改掉、签名也对不上账本（如同账本在缓存写下之后又变过）
    entry.facts = [];
    entry.size += 1;
    // 缓存里还有一个账本里并不存在的会话
    cache.sessions["01ZZZZZZZZZZZZZZZZZZZZZZZZ"] = {
      size: 1,
      mtimeMs: 1,
      facts: [{ ...truth.facts[0], sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }],
    };
    writeFileSync(cachePath, JSON.stringify(cache));
    const reloaded = loadStructuredMemory(repo.root);
    assert.deepEqual(reloaded.facts, truth.facts);
    assert.equal(reloaded.derived, 1);
  } finally {
    repo.cleanup();
  }
});

test("合并与计数：同一文件、同一指纹的多条合并为一条，附出现次数，以最近一次为准；按锚点展开", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const firstSession = await step(repo, BREAK_AND_FIX);
    resetB(repo);
    const secondSession = await step(repo, BREAK_AND_FIX);
    const { facts } = loadStructuredMemory(repo.root);
    const entries = buildMemoryEntries(facts);
    // 一条事实挂在报错文件 b.ts、变红时改过的 a.ts 与 b.ts、回炉补改的 b.ts 上：两个锚点
    assert.deepEqual(entries.map((entry) => entry.anchor).sort(), ["src/a.ts", "src/b.ts"]);
    for (const entry of entries) {
      assert.equal(entry.count, 2);
      assert.deepEqual(entry.sessions, [firstSession, secondSession]);
      assert.equal(entry.latest.sessionId, secondSession);
      assert.equal(entry.fingerprint.code, "TS2304");
      assert.match(entry.id, /^mem_[0-9a-f]{12}$/);
    }
    // 编号稳定：同样的事实再算一遍编号不变
    assert.deepEqual(
      buildMemoryEntries(facts).map((entry) => entry.id),
      entries.map((entry) => entry.id)
    );
  } finally {
    repo.cleanup();
  }
});
