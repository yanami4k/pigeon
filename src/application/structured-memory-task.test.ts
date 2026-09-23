// 题面测试的认定（决策 127 / 131）：题面测试文件取三者并集——本步改动过的文件、开工时已是脏状态的文件（首个快照的改前基线
// 相对 HEAD 的差异）、题面直接指到的文件（从账本里的题面原文按开局挑选的同一套规则解析）。跑批器在开工前把人写测试覆盖进
// 工作区、人先写好测试再跑，这些测试首轮不过、回炉修好都属正常工作，不记红转绿。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStructuredMemory, structuredMemoryCachePath } from "../memory/structured-store.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { SessionId } from "../state/ids.ts";
import { runHeadless } from "./headless.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const FILES = {
  "src/c.ts": "export const c = 1;\n",
  "src/d.ts": "export const d = 0;\n",
  "src/e.ts": "export const e = 0;\n",
  // 已提交进 HEAD、此刻就不过的测试（等着这一步去实现）
  "src/e.test.ts": "// FAILS_UNLESS src/e.ts DONE e works\n",
};

// 先动一个无关文件（留下快照与改前基线），再在回炉里把功能补上
function steps(target: string): FakeReply[] {
  return [
    edits(["src/c.ts", "= 1;", "= 2;"]),
    finished(),
    edits([target, "= 0;", "= 0; // DONE"]),
    finished("修好了"),
  ];
}

async function run(
  repo: MemoryRepo,
  task: string,
  replies: FakeReply[],
  governanceRoot: string = repo.root
) {
  const result = await runHeadless({
    task,
    governanceRoot,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig(["测试"]),
    repairRounds: 2,
    structuredMemory: { enabled: false },
  });
  assert.equal(result.repair?.verdict, "pass");
  return result;
}

// 首轮验证里测试步的输出（用来确认首轮确实因为这条测试变红）
function firstTestOutput(governanceRoot: string, sessionId: SessionId): string {
  const session = materializeSession(join(governanceRoot, ".pigeon", "sessions"), sessionId, {
    content: false,
  });
  return session.attemptVerifieds[0]?.steps?.[0]?.output ?? "";
}

test("题面测试：开工前预置在工作区、尚未提交的失败测试，回炉修好不记事实", async () => {
  const repo = makeMemoryRepo({ ...FILES, "src/e.test.ts": "// 这里不相关\n" });
  try {
    // 跑批器（或人）在开工前放进来、没有提交的测试；题面里也没有提到它
    repo.write("src/preset.test.ts", "// FAILS_UNLESS src/d.ts DONE preset works\n");
    const result = await run(repo, "把 d 的功能补上", steps("src/d.ts"));
    assert.ok(firstTestOutput(repo.root, result.sessionId).includes("✖ preset works"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
  }
});

test("题面测试：已提交进 HEAD、题面文本指到的失败测试，回炉修好不记事实", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const result = await run(repo, "让 src/e.test.ts 通过。", steps("src/e.ts"));
    assert.ok(firstTestOutput(repo.root, result.sessionId).includes("✖ e works"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
  }
});

test("题面测试：预置测试的文件名含非 ASCII 字符时照样认出（git 输出的路径不转义）", async () => {
  const repo = makeMemoryRepo({ ...FILES, "src/e.test.ts": "// 这里不相关\n" });
  try {
    repo.write("src/预置功能.test.ts", "// FAILS_UNLESS src/d.ts DONE preset works\n");
    const result = await run(repo, "把 d 的功能补上", steps("src/d.ts"));
    assert.ok(firstTestOutput(repo.root, result.sessionId).includes("src\\预置功能.test.ts"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
  }
});

test("工作区已不在：题面测试无从认定，测试步不记红转绿，这一会话也不写进缓存", async () => {
  const repo = makeMemoryRepo({ ...FILES, "src/e.test.ts": "// 这里不相关\n" });
  const governanceRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-memory-gov-")));
  try {
    repo.write("src/preset.test.ts", "// FAILS_UNLESS src/d.ts DONE preset works\n");
    const result = await run(repo, "把 d 的功能补上", steps("src/d.ts"), governanceRoot);
    repo.cleanup();
    const loaded = loadStructuredMemory(governanceRoot);
    assert.deepEqual(loaded.facts, []);
    const cache = JSON.parse(readFileSync(structuredMemoryCachePath(governanceRoot), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(cache.sessions[result.sessionId], undefined);
  } finally {
    repo.cleanup();
    rmSync(governanceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("对照：题面既没指到、开工时也不脏的他处测试被弄红后修好，照记", async () => {
  const repo = makeMemoryRepo({
    ...FILES,
    "src/e.test.ts": "// FAILS_UNLESS src/e.ts OK e works\n",
    "src/e.ts": "export const e = 0; // OK\n",
  });
  try {
    await run(repo, "调整 c", [
      edits(["src/c.ts", "= 1;", "= 2;"], ["src/e.ts", " // OK", ""]),
      finished(),
      edits(["src/e.ts", "= 0;", "= 0; // OK"]),
      finished("修好了"),
    ]);
    const { facts } = loadStructuredMemory(repo.root);
    assert.deepEqual(
      facts.map((fact) => [fact.kind, fact.fingerprint.test, fact.fingerprint.file]),
      [["regression", "e works", "src/e.test.ts"]]
    );
  } finally {
    repo.cleanup();
  }
});
