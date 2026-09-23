// 在子目录执行的验证步骤（设计会话 2026-09-23 裁定）：分步配置每步可给执行目录 cwd（相对工作区根，加法式），
// 工具报出的相对路径统一换算成相对工作区根的路径，再与改动文件、锚点比对。
// 以及留痕：run.started 如实记下开局与每轮回炉实际给出的条目、与因用前核验没过被拦下的条目。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import { materializeSession } from "../persistence/event-log.ts";
import {
  loadVerifyConfig,
  VerifyConfigError,
  verifyConfigPath,
} from "../persistence/verify-config.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { VERIFY_CONFIG_VERSION } from "../state/attempt-config.ts";
import { runHeadless } from "./headless.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const SUBDIR_FILES = {
  "strands-py/src/pkg/mod.py": "VALUE = 1  # VALUE_OK\n",
  "strands-py/tests/test_mod.py":
    "# FAILS_UNLESS src/pkg/mod.py VALUE_OK test_value\ndef test_value():\n    pass\n",
};

async function step(
  repo: MemoryRepo,
  task: string,
  replies: FakeReply[],
  extra: Parameters<typeof runHeadless>[0]["structuredMemory"] = {},
  verifyNames: Parameters<typeof memoryVerifyConfig>[0] = [{ name: "子测试", cwd: "strands-py" }]
) {
  const result = await runHeadless({
    task,
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig(verifyNames),
    repairRounds: 2,
    structuredMemory: extra,
  });
  const session = materializeSession(join(repo.root, ".pigeon", "sessions"), result.sessionId, {
    content: false,
  });
  return { result, runStarteds: session.runStarteds, attemptVerifieds: session.attemptVerifieds };
}

test("子目录执行：pytest 步骤在 strands-py 下失败后修好，指纹与锚点带子目录前缀，核验在仓库里找得到文件、记忆照给", async () => {
  const repo = makeMemoryRepo(SUBDIR_FILES);
  try {
    const history = await step(repo, "以往的一步", [
      edits(["strands-py/src/pkg/mod.py", "  # VALUE_OK", ""]),
      finished(),
      edits(["strands-py/src/pkg/mod.py", "VALUE = 1", "VALUE = 1  # VALUE_OK again"]),
      finished("修好了"),
    ]);
    // 验证记录里记下了这一步的执行目录；工具报出的路径相对它
    assert.equal(history.attemptVerifieds[0]?.steps?.[0]?.cwd, "strands-py");
    assert.ok(history.attemptVerifieds[0]?.steps?.[0]?.output.includes("FAILED tests/test_mod.py"));
    repo.commit("落地");
    const { facts } = loadStructuredMemory(repo.root);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.fingerprint.tool, "pytest");
    assert.equal(facts[0]?.fingerprint.file, "strands-py/tests/test_mod.py");
    assert.deepEqual(facts[0]?.changedAtRed, ["strands-py/src/pkg/mod.py"]);
    const entries = buildMemoryEntries(facts);
    assert.deepEqual(entries.map((entry) => entry.anchor).sort(), [
      "strands-py/src/pkg/mod.py",
      "strands-py/tests/test_mod.py",
    ]);
    const onModule = entries.find((entry) => entry.anchor === "strands-py/src/pkg/mod.py");
    assert.ok(onModule !== undefined);
    // 新的一步：题面指到子目录里的源文件，记忆经核验（名字 test_value 在 strands-py/tests/test_mod.py 里）给出
    const next = await step(repo, "修改 strands-py/src/pkg/mod.py", [finished("看过了")]);
    assert.deepEqual(next.runStarteds[0]?.payload.structuredMemory?.opening, [onModule.id]);
    assert.equal(next.runStarteds[0]?.payload.structuredMemory?.openingBlocked, undefined);
  } finally {
    repo.cleanup();
  }
});

test("分步执行目录：读出时规范为相对工作区根的正斜杠路径；绝对路径或越出工作区响亮失败；缺省即工作区根", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-verify-cwd-"));
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  const write = (body: unknown) => writeFileSync(verifyConfigPath(dir), JSON.stringify(body));
  write({
    version: VERIFY_CONFIG_VERSION,
    steps: [
      { name: "lint", command: "ruff check", cwd: "./strands-py/" },
      { name: "root", command: "npm test", cwd: "." },
    ],
  });
  assert.deepEqual(loadVerifyConfig(dir)?.steps, [
    { name: "lint", command: "ruff check", cwd: "strands-py" },
    { name: "root", command: "npm test" },
  ]);
  for (const cwd of ["/abs", "C:/abs", "../outside", "a/../../b"]) {
    write({ version: VERIFY_CONFIG_VERSION, steps: [{ name: "x", command: "y", cwd }] });
    assert.throws(() => loadVerifyConfig(dir), VerifyConfigError, cwd);
  }
});

test("strands 的验证配置样例：ruff、mypy、pytest 三步，都在 strands-py 子目录下执行", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const dir = mkdtempSync(join(tmpdir(), "pigeon-verify-strands-"));
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  writeFileSync(
    verifyConfigPath(dir),
    readFileSync(join(repoRoot, "docs", "samples", "verify.strands.json"), "utf8")
  );
  assert.deepEqual(loadVerifyConfig(dir)?.steps, [
    { name: "代码检查", command: "ruff check", cwd: "strands-py" },
    { name: "类型", command: "mypy ./src ./tests_typing", cwd: "strands-py" },
    { name: "测试", command: "pytest tests", cwd: "strands-py" },
  ]);
});

test("留痕：run.started 如实记下开局与每轮回炉实际给出的条目，以及因用前核验没过被拦下的条目", async () => {
  const repo = makeMemoryRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = helper;\n",
  });
  try {
    await step(
      repo,
      "以往的一步",
      [
        edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
        finished("修好了"),
      ],
      { enabled: false },
      ["类型"]
    );
    const entries = buildMemoryEntries(loadStructuredMemory(repo.root).facts);
    const onA = entries.find((entry) => entry.anchor === "src/a.ts");
    const onB = entries.find((entry) => entry.anchor === "src/b.ts");
    assert.ok(onA !== undefined && onB !== undefined);
    // 名字 helper 从报错所在的 b.ts 里消失：两条都核验不过
    repo.write("src/b.ts", "export const b = 0;\n");
    repo.commit("改写 b.ts");
    const breakAndFix: FakeReply[] = [
      edits(["src/a.ts", "= 2;", "= 3; // TYPE_BAD:other"]),
      finished(),
      edits(["src/a.ts", " // TYPE_BAD:other", ""]),
      finished("修好了"),
    ];
    // 正式挑选：题面指到 a.ts，挑出 a.ts 上那条，被核验拦下
    const auto = await step(repo, "改 src/a.ts", breakAndFix, {}, ["类型"]);
    assert.deepEqual(auto.runStarteds[0]?.payload.structuredMemory, {
      enabled: true,
      selection: "auto",
      opening: [],
      openingBlocked: [onA.id],
    });
    // 固定挑选：开局与回炉各指定一条，都被拦下；回炉 Run 的 run.started 记下这一轮被拦下的
    repo.write("src/a.ts", "export const a = 2;\n");
    repo.commit("复位");
    const fixed = await step(
      repo,
      "调整",
      breakAndFix,
      { fixed: { opening: [onA.id], repair: [onB.id] } },
      ["类型"]
    );
    assert.deepEqual(fixed.runStarteds[0]?.payload.structuredMemory?.openingBlocked, [onA.id]);
    assert.deepEqual(fixed.runStarteds[1]?.payload.structuredMemory?.repair, []);
    assert.deepEqual(fixed.runStarteds[1]?.payload.structuredMemory?.repairBlocked, [onB.id]);
    assert.deepEqual(fixed.result.structuredMemory, {
      opening: [],
      openingBlocked: [onA.id],
      repair: [[]],
      repairBlocked: [[onB.id]],
    });
  } finally {
    repo.cleanup();
  }
});
