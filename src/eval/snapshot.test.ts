// Eval 快照准备（M6.5 S2，决策 057）：真实 git 仓库上验证——仓库根与治理根分开传，工作树从任务的 ref 开出、
// 放在治理根的 .pigeon/worktrees 下；worker 名 <taskId>-<condition>-<n> 使分支不撞名；每个工作树挂 node_modules
// 目录联接；跑完删除工作树与分支，联接目标（主仓库 node_modules）原样保留。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import { prepareTaskWorkspace } from "./snapshot.ts";
import { loadEvalTask } from "./task.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithTask(): {
  repo: string;
  out: string;
  taskDir: string;
  firstRef: string;
  cleanup: () => void;
} {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-eval-repo-")));
  const out = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-eval-out-")));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  git(repo, ["add", ".gitignore", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "one"]);
  const firstRef = git(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "a.txt"), "v2\n");
  git(repo, ["commit", "-q", "-am", "two"]);
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "marker.txt"), "m");

  const taskDir = join(repo, "eval", "tasks", "fix-a");
  mkdirSync(join(taskDir, "assets"), { recursive: true });
  writeFileSync(join(taskDir, "task.md"), "改 a.txt\n");
  writeFileSync(join(taskDir, "README.md"), "说明\n");
  writeFileSync(join(taskDir, "assets", "a.check"), "资产\n");
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      version: 1,
      id: "fix-a",
      instructions: "task.md",
      repo: { path: ".", ref: firstRef },
      budget: { maxTurns: 5, wallClockMs: 60000 },
      verifier: { command: ["node", "-e", "0"], timeoutMs: 10000 },
      assets: ["a.check"],
      tags: [],
      holdout: false,
    })
  );
  return {
    repo,
    out,
    taskDir,
    firstRef,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    },
  };
}

test("Eval 快照：仓库根取自任务的 repo（本仓库为主仓库根），工作树基于任务 ref 开在治理根下并挂 node_modules 联接", () => {
  const { repo, out, taskDir, cleanup } = makeRepoWithTask();
  try {
    const task = loadEvalTask(taskDir);
    assert.equal(realpathSync.native(task.repoRoot), repo);
    const prepared = prepareTaskWorkspace({
      task,
      governanceRoot: out,
      sessionId: newSessionId(),
      condition: "none",
      attempt: 1,
    });
    try {
      assert.equal(prepared.workspace.branch, "pigeon/fix-a-none-1");
      assert.ok(
        prepared.workspace.path.startsWith(join(out, ".pigeon", "worktrees")),
        prepared.workspace.path
      );
      // 基于任务 ref（第一个提交），而不是主仓库 HEAD
      assert.equal(readFileSync(join(prepared.workspace.path, "a.txt"), "utf8"), "v1\n");
      assert.equal(
        readFileSync(join(prepared.workspace.path, "node_modules", "marker.txt"), "utf8"),
        "m"
      );
      // 主仓库工作区不受影响
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v2\n");
    } finally {
      prepared.release();
    }
  } finally {
    cleanup();
  }
});

test("Eval 快照：同任务同条件跑两次分支不撞名；跑完工作树与分支都已清理，联接目标原样保留", () => {
  const { repo, out, taskDir, cleanup } = makeRepoWithTask();
  try {
    const task = loadEvalTask(taskDir);
    const first = prepareTaskWorkspace({
      task,
      governanceRoot: out,
      sessionId: newSessionId(),
      condition: "candidate",
      attempt: 1,
    });
    const second = prepareTaskWorkspace({
      task,
      governanceRoot: out,
      sessionId: newSessionId(),
      condition: "candidate",
      attempt: 2,
    });
    assert.notEqual(first.workspace.branch, second.workspace.branch);
    assert.ok(existsSync(first.workspace.path) && existsSync(second.workspace.path));
    first.release();
    second.release();
    for (const prepared of [first, second]) {
      assert.equal(existsSync(prepared.workspace.path), false, prepared.workspace.path);
      assert.equal(git(repo, ["branch", "--list", prepared.workspace.branch]).trim(), "");
    }
    assert.equal(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8"), "m");
  } finally {
    cleanup();
  }
});
