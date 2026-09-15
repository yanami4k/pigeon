// Eval 快照的崩溃残留清理（M6.5 S5 施工补充）：runner 进程死于一次运行中途时，输出目录下留有工作树、
// 其检出的 worker 分支与 node_modules 联接；续跑同一输出目录会以同名 worker 重开工作树而撞分支。
// runner 开跑前清理输出目录治理根下的残留工作树与分支，联接目标原样保留，同名 worker 随后可以重新准备。
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
import { newSessionId } from "../state/ids.ts";
import { prepareTaskWorkspace, releaseStaleWorkspaces } from "./snapshot.ts";
import { loadEvalTask } from "./task.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("Eval 快照残留清理：未释放的工作树、分支与联接被清掉，联接目标完好，同名 worker 可重新准备", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-stale-repo-")));
  const out = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-stale-out-")));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "a.txt"), "v1\n");
    git(repo, ["add", ".gitignore", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "one"]);
    const ref = git(repo, ["rev-parse", "HEAD"]).trim();
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "m");
    const taskDir = join(repo, "eval", "tasks", "fix-a");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.md"), "改 a.txt\n");
    writeFileSync(join(taskDir, "README.md"), "说明\n");
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({
        version: 1,
        id: "fix-a",
        instructions: "task.md",
        repo: { path: ".", ref },
        budget: { maxTurns: 5, wallClockMs: 60000 },
        verifier: { command: ["node", "-e", "0"], timeoutMs: 10000 },
        assets: [],
        tags: [],
        holdout: false,
      })
    );
    const task = loadEvalTask(taskDir);

    // 模拟进程死于运行中途：准备了工作树但没有释放
    const crashed = prepareTaskWorkspace({
      task,
      governanceRoot: out,
      sessionId: newSessionId(),
      condition: "none",
      attempt: 1,
    });
    assert.ok(existsSync(crashed.workspace.path));

    const cleaned = releaseStaleWorkspaces({ governanceRoot: out, repoRoot: task.repoRoot });
    assert.deepEqual(cleaned, ["fix-a-none-1"]);
    assert.equal(existsSync(crashed.workspace.path), false);
    assert.equal(readdirSync(join(out, ".pigeon", "worktrees")).length, 0);
    assert.equal(git(repo, ["branch", "--list", "pigeon/*"]).trim(), "");
    assert.equal(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8"), "m");

    // 续跑：同名 worker 重新准备不撞分支
    const again = prepareTaskWorkspace({
      task,
      governanceRoot: out,
      sessionId: newSessionId(),
      condition: "none",
      attempt: 1,
    });
    assert.equal(again.workspace.branch, "pigeon/fix-a-none-1");
    again.release();

    // 没有残留时是空操作
    assert.deepEqual(releaseStaleWorkspaces({ governanceRoot: out, repoRoot: task.repoRoot }), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
