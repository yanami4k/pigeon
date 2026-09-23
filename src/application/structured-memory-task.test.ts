// 题面测试的认定（决策 127 / 131）：题面测试文件取三者并集——本步改动过的文件、开工时已是脏状态的文件（首个快照的改前基线
// 相对 HEAD 的差异）、题面直接指到的文件（从账本里的题面原文按开局挑选的同一套规则解析）。跑批器在开工前把人写测试覆盖进
// 工作区、人先写好测试再跑，这些测试首轮不过、回炉修好都属正常工作，不记红转绿。
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStructuredMemory } from "../memory/structured-store.ts";
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

async function run(repo: MemoryRepo, task: string, replies: FakeReply[]) {
  const result = await runHeadless({
    task,
    governanceRoot: repo.root,
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

test("题面测试：开工前预置在工作区、尚未提交的失败测试，回炉修好不记事实", async () => {
  const repo = makeMemoryRepo({ ...FILES, "src/e.test.ts": "// 这里不相关\n" });
  try {
    // 跑批器（或人）在开工前放进来、没有提交的测试；题面里也没有提到它
    repo.write("src/preset.test.ts", "// FAILS_UNLESS src/d.ts DONE preset works\n");
    await run(repo, "把 d 的功能补上", steps("src/d.ts"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
  }
});

test("题面测试：已提交进 HEAD、题面文本指到的失败测试，回炉修好不记事实", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await run(repo, "让 src/e.test.ts 通过。", steps("src/e.ts"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
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
