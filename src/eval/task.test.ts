// Eval 任务目录（M6.5 S2，决策 057）：task.json schema 与加载器——一任务一目录，说明、验证资产、README 齐全；
// holdout 标记被读取；目录形态不合法响亮失败。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvalTaskError, loadEvalTask, loadEvalTasks } from "./task.ts";

function writeTask(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {},
  options: { readme?: boolean; asset?: boolean } = {}
): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "assets", "src"), { recursive: true });
  writeFileSync(join(dir, "task.md"), `任务 ${id}\n`);
  if (options.readme !== false) {
    writeFileSync(join(dir, "README.md"), "测什么、来源与许可\n");
  }
  if (options.asset !== false) {
    writeFileSync(join(dir, "assets", "src", "a.eval.test.ts"), "// 验证资产\n");
  }
  writeFileSync(join(dir, "verify.mjs"), "process.exit(0);\n");
  writeFileSync(
    join(dir, "task.json"),
    JSON.stringify({
      version: 1,
      id,
      instructions: "task.md",
      repo: { path: root, ref: "0123456789abcdef0123456789abcdef01234567" },
      budget: { maxTurns: 30, wallClockMs: 600000 },
      verifier: { command: ["node", "{TASK_DIR}/verify.mjs"], timeoutMs: 120000 },
      assets: ["src/a.eval.test.ts"],
      tags: ["tools"],
      holdout: false,
      ...overrides,
    })
  );
  return dir;
}

test("Eval 任务：加载单个任务目录，字段、说明正文、仓库根与 holdout 标记齐全", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-eval-task-"));
  try {
    const dir = writeTask(root, "fix-paths", {
      holdout: true,
      budget: { maxTurns: 20, wallClockMs: 300000, maxTokens: 400000 },
    });
    const task = loadEvalTask(dir);
    assert.equal(task.spec.id, "fix-paths");
    assert.equal(task.spec.holdout, true);
    assert.equal(task.spec.budget.maxTokens, 400000);
    assert.deepEqual(task.spec.tags, ["tools"]);
    assert.deepEqual(task.spec.assets, ["src/a.eval.test.ts"]);
    assert.equal(task.instructions, "任务 fix-paths\n");
    assert.equal(task.repoRoot, root);
    assert.equal(task.dir, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Eval 任务：任务集目录按 id 排序加载，holdout 逐个读取；指向单个任务目录时只加载它", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-eval-task-"));
  try {
    writeTask(root, "b-task", { holdout: true });
    writeTask(root, "a-task");
    const tasks = loadEvalTasks(root);
    assert.deepEqual(
      tasks.map((task) => [task.spec.id, task.spec.holdout]),
      [
        ["a-task", false],
        ["b-task", true],
      ]
    );
    assert.deepEqual(
      loadEvalTasks(join(root, "b-task")).map((task) => task.spec.id),
      ["b-task"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Eval 任务：缺 README、id 与目录名不符、验证资产缺失、schema 不符、第二层反向断言字段形状错误一律响亮失败", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-eval-task-"));
  try {
    assert.throws(
      () => loadEvalTask(writeTask(root, "no-readme", {}, { readme: false })),
      EvalTaskError
    );
    assert.throws(() => loadEvalTask(writeTask(root, "wrong-id", { id: "other" })), EvalTaskError);
    assert.throws(
      () => loadEvalTask(writeTask(root, "no-asset", {}, { asset: false })),
      EvalTaskError
    );
    assert.throws(() => loadEvalTask(writeTask(root, "bad-budget", { budget: {} })), EvalTaskError);
    assert.throws(
      () => loadEvalTask(writeTask(root, "bad-reverse", { reverseAssertions: { command: [] } })),
      EvalTaskError
    );
    // 第二层接口（M6.5 只留字段不执行）：形状正确时照常加载
    const reverse = loadEvalTask(
      writeTask(root, "with-reverse", {
        reverseAssertions: { command: ["node", "{TASK_DIR}/reverse.mjs"], timeoutMs: 1000 },
      })
    );
    assert.deepEqual(reverse.spec.reverseAssertions?.command, ["node", "{TASK_DIR}/reverse.mjs"]);
    // 资产路径越出工作区根拒绝
    assert.throws(
      () => loadEvalTask(writeTask(root, "escape-asset", { assets: ["../x.ts"] })),
      EvalTaskError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
