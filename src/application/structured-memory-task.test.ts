// 题面测试的认定（决策 127 / 131）：题面测试文件取三者并集——本步改动过的文件、开工时已是脏状态的文件（首个快照的改前基线
// 相对 HEAD 的差异）、题面直接指到的文件（从账本里的题面原文按开局挑选的同一套规则解析）。跑批器在开工前把人写测试覆盖进
// 工作区、人先写好测试再跑，这些测试首轮不过、回炉修好都属正常工作，不记红转绿。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("题面测试：题面点名的测试文件事后被改名、不再受跟踪，全量重算时仍算题面、不记事实", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await run(repo, "让 src/e.test.ts 通过。", steps("src/e.ts"));
    repo.commit("落地");
    repo.git(["mv", "src/e.test.ts", "src/e-renamed.test.ts"]);
    repo.commit("改名");
    rmSync(structuredMemoryCachePath(repo.root), { force: true });
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
  } finally {
    repo.cleanup();
  }
});

// 按外部开关文件判定的测试步：开关不在时报 src/ext.test.ts 里的"外部测试"失败（node:test spec 汇总）
const FLAG_SCRIPT = [
  'import { existsSync } from "node:fs";',
  "if (existsSync(process.argv[2])) {",
  '  process.stdout.write("一切正常\\n");',
  "  process.exit(0);",
  "}",
  'process.stdout.write("✖ failing tests:\\n\\ntest at src\\\\ext.test.ts:1:1\\n✖ 外部测试 (1ms)\\n");',
  "process.exit(1);",
].join("\n");

test("没有改前基线（这一步一次文件都没改）：题面测试无从认定，测试步不记红转绿，也不写进缓存", async () => {
  const repo = makeMemoryRepo({
    ...FILES,
    "flag.mjs": FLAG_SCRIPT,
    "src/ext.test.ts": "// 外部测试\n",
  });
  const flag = join(repo.home, "flag");
  try {
    const inner = createFakeStreamFn({ replies: [finished("看过了"), finished("环境好了")] });
    // 第二次模型调用（回炉那一轮）时把外部开关放好：整步没有任何文件改动、没有快照
    const streamFn: typeof inner = Object.assign(
      (...args: Parameters<typeof inner>) => {
        if (inner.calls.length === 1) {
          writeFileSync(flag, "on");
        }
        return inner(...args);
      },
      { calls: inner.calls }
    );
    const result = await runHeadless({
      task: "看看测试",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: {
        command: "[测试] flag",
        steps: [{ name: "测试", command: `"${process.execPath}" flag.mjs "${flag}"` }],
        timeoutMs: 60_000,
      },
      repairRounds: 2,
      structuredMemory: { enabled: false },
    });
    assert.equal(result.repair?.verdict, "pass");
    assert.ok(firstTestOutput(repo.root, result.sessionId).includes("✖ 外部测试"));
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
    const cache = JSON.parse(readFileSync(structuredMemoryCachePath(repo.root), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(cache.sessions[result.sessionId], undefined);
  } finally {
    repo.cleanup();
  }
});

test("git 取不到开工时的脏文件（改前基线已被回收）：测试步不记红转绿，也不写进缓存", async () => {
  const repo = makeMemoryRepo({
    ...FILES,
    "src/e.test.ts": "// FAILS_UNLESS src/e.ts OK e works\n",
    "src/e.ts": "export const e = 0; // OK\n",
  });
  try {
    const result = await run(repo, "调整 c", [
      edits(["src/c.ts", "= 1;", "= 2;"], ["src/e.ts", " // OK", ""]),
      finished(),
      edits(["src/e.ts", "= 0;", "= 0; // OK"]),
      finished("修好了"),
    ]);
    // 删掉快照 ref 并回收：改前基线提交不复存在
    for (const ref of repo
      .git(["for-each-ref", "--format=%(refname)", "refs/pigeon/"])
      .split(/\r?\n/)
      .filter((line) => line !== "")) {
      repo.git(["update-ref", "-d", ref]);
    }
    repo.git(["reflog", "expire", "--expire=now", "--all"]);
    repo.git(["gc", "--prune=now", "-q"]);
    assert.deepEqual(loadStructuredMemory(repo.root).facts, []);
    const cache = JSON.parse(readFileSync(structuredMemoryCachePath(repo.root), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(cache.sessions[result.sessionId], undefined);
  } finally {
    repo.cleanup();
  }
});

test("工作区是仓库的子目录：开工时脏文件的路径按工作区相对（--relative），预置测试照样认出", async () => {
  const repo = makeMemoryRepo({
    "pkg/src/c.ts": "export const c = 1;\n",
    "pkg/src/d.ts": "export const d = 0;\n",
  });
  const workspace = join(repo.root, "pkg");
  try {
    repo.write("pkg/src/preset.test.ts", "// FAILS_UNLESS src/d.ts DONE preset works\n");
    const result = await runHeadless({
      task: "把 d 的功能补上",
      governanceRoot: workspace,
      workspaceRoot: workspace,
      streamFn: createFakeStreamFn({ replies: steps("src/d.ts") }),
      yolo: true,
      homeDir: repo.home,
      // 脚本在仓库根，步骤在工作区（pkg）里执行
      verify: memoryVerifyConfig([{ name: "测试", cwd: "." }]),
      repairRounds: 2,
      structuredMemory: { enabled: false },
    });
    assert.equal(result.repair?.verdict, "pass");
    assert.ok(firstTestOutput(workspace, result.sessionId).includes("✖ preset works"));
    assert.deepEqual(loadStructuredMemory(workspace).facts, []);
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
