// Eval runner（M6.5 S4，决策 059 / 060 含修订）：每任务每条件跑 N 次，三个条件由 skillRoots 决定（空 / 只含候选 /
// 只含已批准），memoryRoots 一律为空；每次一个新会话，治理根为输出目录；收工后回填并跑验证器；
// 每次运行一行 results.jsonl，最后生成 report.md；工作树与分支每次运行后清理；重跑同一输出目录跳过已有的行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { asSessionId } from "../state/ids.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { localTaskSource } from "./local-source.ts";
import { EVAL_RESULT_FIELDS, runEval } from "./runner.ts";
import { loadEvalTasks } from "./task.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixture() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-runner-repo-")));
  const out = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-runner-out-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-runner-home-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  git(repo, ["add", "a.txt"]);
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
      budget: { maxTurns: 6, wallClockMs: 60_000 },
      verifier: { command: ["node", "{TASK_DIR}/verify.mjs"], timeoutMs: 30_000 },
      assets: ["checks/want.txt"],
      tags: ["fixture"],
      holdout: false,
    })
  );
  const skillDir = join(repo, "eval", "skills", "pitfalls");
  for (const stage of ["candidate", "approved"]) {
    mkdirSync(join(skillDir, stage), { recursive: true });
    writeFileSync(
      join(skillDir, stage, "SKILL.md"),
      "---\nname: pitfalls\ndescription: 真实踩过的坑\n---\n改完文件再收工\n"
    );
  }
  return {
    repo,
    out,
    home,
    skillDir,
    cleanup: () => {
      for (const dir of [repo, out, home]) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// 有 Skill 目录段时按 Skill 改文件，没有时直接自报完成：三个条件的判决因此不同
function skillSensitiveStreamFn(): StreamFn {
  const edit = createFakeStreamFn({
    replies: [
      {
        text: "按 Skill 先改文件",
        toolCalls: [
          {
            name: "edit_file",
            args: {
              path: "a.txt",
              snapshot: snapshotTag("v1\n"),
              edits: [{ op: "replace", anchor: `1#${lineTag("v1")}`, lines: ["done"] }],
            },
          },
        ],
      },
    ],
  });
  const done = createFakeStreamFn({ replies: [{ text: "完成" }] });
  return (model, context, options) => {
    const last = context.messages[context.messages.length - 1];
    if (last?.role === "toolResult") {
      return done(model, context, options);
    }
    return (context.systemPrompt ?? "").includes("## Skill 目录")
      ? edit(model, context, options)
      : done(model, context, options);
  };
}

test("Eval runner：三个条件与 skillRoots 一一对应，results 行字段齐全，report 生成，工作树与分支清理，重跑跳过已有行", async () => {
  const { repo, out, home, skillDir, cleanup } = makeFixture();
  try {
    const tasks = loadEvalTasks(join(repo, "eval", "tasks"));
    const options = {
      source: localTaskSource(tasks),
      skill: {
        candidate: { path: join(skillDir, "candidate"), label: "eval/skills/pitfalls/candidate" },
        approved: { path: join(skillDir, "approved"), label: "eval/skills/pitfalls/approved" },
      },
      outDir: out,
      runs: 2,
      streamFn: skillSensitiveStreamFn(),
      yolo: true,
      homeDir: home,
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      editMode: "hashline" as const,
    };
    const first = await runEval(options);
    assert.equal(first.ran, 6);
    assert.equal(first.skipped, 0);
    assert.equal(first.lines.length, 6);

    const resultsFile = join(out, "results.jsonl");
    const rows = readFileSync(resultsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 6);
    for (const row of rows) {
      for (const field of EVAL_RESULT_FIELDS) {
        assert.ok(field in row, `results 行缺字段 ${field}：${JSON.stringify(row)}`);
      }
      assert.equal(typeof row.sessionId, "string");
    }

    const sessionsDir = join(out, ".pigeon", "sessions");
    const expectedSkillPaths: Record<string, string[]> = {
      none: [],
      candidate: ["eval/skills/pitfalls/candidate"],
      approved: ["eval/skills/pitfalls/approved"],
    };
    for (const row of rows) {
      const session = materializeSession(sessionsDir, asSessionId(String(row.sessionId)));
      const started = session.runStarteds[0]?.payload;
      assert.deepEqual(
        started?.skills.map((skill) => skill.path),
        expectedSkillPaths[String(row.condition)],
        `条件 ${String(row.condition)} 的 Skill 清单`
      );
      assert.deepEqual(started?.memory, []);
      assert.equal(session.evalVerifieds.length, 1);
      const expectedVerdict = row.condition === "none" ? "fail" : "pass";
      assert.equal(row.verdict, expectedVerdict);
      assert.equal(row.falsePositive, row.condition === "none");
    }
    assert.deepEqual(rows.map((row) => `${String(row.condition)}-${String(row.attempt)}`).sort(), [
      "approved-1",
      "approved-2",
      "candidate-1",
      "candidate-2",
      "none-1",
      "none-2",
    ]);

    const report = readFileSync(join(out, "report.md"), "utf8");
    assert.match(report, /\| fix-a \| 0\/2（0%） \| 2\/2（100%） \| 2\/2（100%） \|/);
    // 标题带题源名（runner 把任务源的 name 递给报告）
    assert.match(report, /^# Eval 报告：local（3 条件对照：none \/ candidate \/ approved）$/m);

    const worktrees = join(out, ".pigeon", "worktrees");
    assert.equal(existsSync(worktrees) ? readdirSync(worktrees).length : 0, 0);
    assert.equal(git(repo, ["branch", "--list", "pigeon/*"]).trim(), "");

    const second = await runEval(options);
    assert.equal(second.ran, 0);
    assert.equal(second.skipped, 6);
    assert.equal(readFileSync(resultsFile, "utf8").trim().split("\n").length, 6);
  } finally {
    cleanup();
  }
});

test("Eval runner 续跑：错误行不占键会被补跑，成功行被跳过；错误行原样保留，报告按最后一条非错误行", async () => {
  const { repo, out, home, skillDir, cleanup } = makeFixture();
  try {
    const tasks = loadEvalTasks(join(repo, "eval", "tasks"));
    const resultsFile = join(out, "results.jsonl");
    const seed = (condition: string, status: string, verdict: string, error?: string) =>
      JSON.stringify({
        taskId: "fix-a",
        condition,
        editMode: "hashline",
        attempt: 1,
        holdout: false,
        sessionId: `sess_seed_${condition}`,
        runId: null,
        status,
        verdict,
        falsePositive: false,
        turns: 0,
        toolCalls: 0,
        approvalsNeeded: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        durationMs: 0,
        failureClass: status === "error" ? "unknown" : null,
        harnessRef: { commit: "seed", dirty: false },
        process: {},
        ...(error !== undefined ? { error } : {}),
      });
    const errorRow = seed("candidate", "error", "undetermined", "准备快照失败：抽风");
    const okRow = seed("approved", "completed", "fail");
    writeFileSync(resultsFile, `${errorRow}\n${okRow}\n`);
    const options = {
      source: localTaskSource(tasks),
      skill: {
        candidate: { path: join(skillDir, "candidate"), label: "eval/skills/pitfalls/candidate" },
        approved: { path: join(skillDir, "approved"), label: "eval/skills/pitfalls/approved" },
      },
      outDir: out,
      runs: 1,
      streamFn: skillSensitiveStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "hashline" as const,
      conditions: ["candidate", "approved"] as const,
    };
    const summary = await runEval(options);
    // 错误行的键补跑一次；非错误行（哪怕判决是失败）的键跳过
    assert.equal(summary.ran, 1);
    assert.equal(summary.skipped, 1);
    const rows = readFileSync(resultsFile, "utf8").trim().split("\n");
    assert.equal(rows.length, 3);
    // 错误行不删不改，仍在原位
    assert.equal(rows[0], errorRow);
    assert.equal(rows[1], okRow);
    const rerun = JSON.parse(rows[2] as string) as Record<string, unknown>;
    assert.equal(rerun.condition, "candidate");
    assert.equal(rerun.status, "completed");
    assert.equal(rerun.verdict, "pass");
    // 报告：candidate 取补跑的通过行（1/1），错误行不进分母；approved 取种子行（0/1）；只列在场的两个条件
    const report = readFileSync(join(out, "report.md"), "utf8");
    assert.match(report, /^\| fix-a \| 1\/1（100%） \| 0\/1（0%） \|$/m);
    // 再跑一次：两个键都已有非错误行，全部跳过
    const again = await runEval(options);
    assert.equal(again.ran, 0);
    assert.equal(again.skipped, 2);
    assert.equal(readFileSync(resultsFile, "utf8").trim().split("\n").length, 3);
  } finally {
    cleanup();
  }
});
