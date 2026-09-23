// 评测跑批的回炉（决策 142 / 143）：runner 把验证命令与回炉轮数交给 headless；回炉开启时结果行带上
// 用了几轮、验证门的最终结论与是否撤回，回炉结束后任务源的判据照常判分；关闭时行形状与此前一致。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { localTaskSource } from "./local-source.ts";
import type { EvalResultLine } from "./results.ts";
import { runEval } from "./runner.ts";
import { loadEvalTasks } from "./task.ts";

const NODE = `"${process.execPath}"`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixture() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-runner-repair-repo-")));
  const out = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-runner-repair-out-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-runner-repair-home-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  // 这一步里的验证门：a.txt 为 done 时通过
  writeFileSync(
    join(repo, "gate.mjs"),
    'import { readFileSync } from "node:fs";\n' +
      'const content = readFileSync("a.txt", "utf8");\n' +
      'console.log("a.txt=" + content.trim());\n' +
      'process.exit(content === "done\\n" ? 0 : 1);\n'
  );
  git(repo, ["add", "a.txt", "gate.mjs"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const ref = git(repo, ["rev-parse", "HEAD"]).trim();
  const taskDir = join(repo, "eval", "tasks", "fix-a");
  mkdirSync(join(taskDir, "assets", "checks"), { recursive: true });
  writeFileSync(join(taskDir, "task.md"), "把 a.txt 改成 done\n");
  writeFileSync(join(taskDir, "README.md"), "测试夹具\n");
  writeFileSync(join(taskDir, "assets", "checks", "want.txt"), "done\n");
  writeFileSync(
    join(taskDir, "verify.mjs"),
    'import { readFileSync } from "node:fs";\n' +
      'const ok = readFileSync("a.txt", "utf8") === readFileSync("checks/want.txt", "utf8");\n' +
      "console.log(JSON.stringify({ ok }));\nprocess.exit(ok ? 0 : 1);\n"
  );
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      version: 1,
      id: "fix-a",
      instructions: "task.md",
      repo: { path: ".", ref },
      budget: { maxTurns: 10, wallClockMs: 120_000 },
      verifier: { command: ["node", "{TASK_DIR}/verify.mjs"], timeoutMs: 30_000 },
      assets: ["checks/want.txt"],
      tags: ["fixture"],
      holdout: false,
    })
  );
  return {
    repo,
    out,
    home,
    cleanup: () => {
      for (const dir of [repo, out, home]) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// 首次直接自报完成（验证门失败）；收到回炉反馈后才改文件
function fixOnFeedbackStreamFn(): StreamFn {
  const editFn = createFakeStreamFn({
    replies: [
      {
        text: "按反馈改",
        toolCalls: [
          { name: "edit_file", args: { path: "a.txt", old_string: "v1\n", new_string: "done\n" } },
        ],
      },
    ],
  });
  const doneFn = createFakeStreamFn({ replies: [{ text: "完成" }] });
  return (model, context, options) => {
    const last = context.messages[context.messages.length - 1];
    const text =
      last?.role === "user"
        ? typeof last.content === "string"
          ? last.content
          : last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
        : "";
    return text.includes("验证未通过")
      ? editFn(model, context, options)
      : doneFn(model, context, options);
  };
}

function rowsOf(out: string): EvalResultLine[] {
  return readFileSync(join(out, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EvalResultLine);
}

test("评测跑批开启回炉：结果行带回炉轮数、验证门最终结论与是否撤回，判据在回炉结束后照常判分", async () => {
  const fixture = makeFixture();
  try {
    const tasks = loadEvalTasks(join(fixture.repo, "eval", "tasks"));
    await runEval({
      source: localTaskSource(tasks),
      outDir: fixture.out,
      runs: 1,
      streamFn: fixOnFeedbackStreamFn(),
      yolo: true,
      homeDir: fixture.home,
      conditions: ["none"],
      editMode: "replace",
      verify: { command: `${NODE} gate.mjs`, timeoutMs: 30_000 },
      repairRounds: 3,
    });
    const [row] = rowsOf(fixture.out);
    assert.ok(row !== undefined);
    assert.deepEqual(row.repair, {
      rounds: 1,
      verdict: "pass",
      reverted: false,
      budgetExhausted: false,
    });
    assert.equal(row.verdict, "pass", "回炉修好后判据判通过");
    assert.equal(row.turns, 3, "轮次按整步汇总：首次 1 轮，回炉一轮 2 轮");
  } finally {
    fixture.cleanup();
  }
});

test("评测跑批回炉撤回：结果行记已撤回；误报按整步最后一个 Run 的自报完成判，不看首个 Run", async () => {
  const fixture = makeFixture();
  try {
    const tasks = loadEvalTasks(join(fixture.repo, "eval", "tasks"));
    await runEval({
      source: localTaskSource(tasks),
      outDir: fixture.out,
      runs: 1,
      // 首个 Run 以出错的工具结果收尾（不算自报完成）；回炉那一轮什么也不改、直接自报完成
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "试着改",
            toolCalls: [
              {
                name: "edit_file",
                args: { path: "a.txt", old_string: "不存在\n", new_string: "done\n" },
              },
            ],
          },
          { text: "完成" },
        ],
      }),
      yolo: true,
      homeDir: fixture.home,
      conditions: ["none"],
      editMode: "replace",
      verify: { command: `${NODE} gate.mjs`, timeoutMs: 30_000 },
      repairRounds: 1,
    });
    const [row] = rowsOf(fixture.out);
    assert.ok(row !== undefined);
    assert.deepEqual(row.repair, {
      rounds: 1,
      verdict: "fail",
      reverted: true,
      budgetExhausted: false,
    });
    assert.equal(row.verdict, "fail");
    assert.equal(row.falsePositive, true, "这一步最后一个 Run 自报完成而判据判失败，即误报");
    assert.equal(row.failureClass, null, "失败分类取最后一个 Run 的（正常收尾）");
  } finally {
    fixture.cleanup();
  }
});

test("评测跑批缺省关闭回炉：结果行不带回炉字段，首次失败即按判据判失败", async () => {
  const fixture = makeFixture();
  try {
    const tasks = loadEvalTasks(join(fixture.repo, "eval", "tasks"));
    await runEval({
      source: localTaskSource(tasks),
      outDir: fixture.out,
      runs: 1,
      streamFn: fixOnFeedbackStreamFn(),
      yolo: true,
      homeDir: fixture.home,
      conditions: ["none"],
      editMode: "replace",
    });
    const [row] = rowsOf(fixture.out);
    assert.ok(row !== undefined);
    assert.equal("repair" in row, false);
    assert.equal(row.verdict, "fail");
  } finally {
    fixture.cleanup();
  }
});
