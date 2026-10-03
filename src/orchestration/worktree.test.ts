// worker 工作树管理（M5.5 S1，决策 040）：真实 git 仓库上验证目录布局、分支命名、清单、
// 隔离写入与移除；名字先校验再进 git 参数。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import {
  addWorktree,
  deleteBranch,
  listWorktrees,
  removeWorktree,
  WorktreeError,
  workerStartRefFor,
  worktreePathFor,
} from "./worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): { repo: string; cleanup: () => void } {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-")));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  // 夹具不受本机全局换行转换配置影响（检出内容逐字节可比）
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test("工作树：目录在 .pigeon/state/worktrees/<会话>-<名字>、分支 pigeon/<名字>，隔离写入，移除后清单不再列出", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const sessionId = newSessionId();
    const handle = addWorktree({ repoRoot: repo, sessionId, name: "fix-a" });
    assert.equal(handle.path, join(repo, ".pigeon", "state", "worktrees", `${sessionId}-fix-a`));
    assert.equal(handle.branch, "pigeon/fix-a");
    assert.equal(readFileSync(join(handle.path, "a.txt"), "utf8"), "alpha\n");
    assert.equal(git(handle.path, ["branch", "--show-current"]).trim(), "pigeon/fix-a");

    const listed = listWorktrees(repo).find((entry) => resolve(entry.path) === handle.path);
    assert.ok(listed, JSON.stringify(listWorktrees(repo)));
    assert.equal(listed.branch, "pigeon/fix-a");

    // 工作树内改文件：主工作区已跟踪文件零改动
    writeFileSync(join(handle.path, "a.txt"), "changed in worker\n");
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "alpha\n");
    assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=no"]), "");

    removeWorktree({ repoRoot: repo, path: handle.path, force: true });
    assert.equal(existsSync(handle.path), false);
    assert.equal(
      listWorktrees(repo).some((entry) => resolve(entry.path) === handle.path),
      false
    );
  } finally {
    cleanup();
  }
});

test("工作树：目录名带会话编号，两个会话同名 worker 目录不撞；同名分支由 git 响亮拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const first = newSessionId();
    const second = newSessionId();
    assert.notEqual(worktreePathFor(repo, first, "x"), worktreePathFor(repo, second, "x"));
    addWorktree({ repoRoot: repo, sessionId: first, name: "x" });
    assert.throws(
      () => addWorktree({ repoRoot: repo, sessionId: second, name: "x" }),
      (error: unknown) => error instanceof WorktreeError && /pigeon\/x/.test(error.message)
    );
  } finally {
    cleanup();
  }
});

test("工作树：非法名字在调用 git 之前拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    for (const name of ["", "../evil", "-f", "a b", "A", "x/y", "a".repeat(41)]) {
      assert.throws(
        () => addWorktree({ repoRoot: repo, sessionId: newSessionId(), name }),
        WorktreeError,
        name
      );
    }
    assert.equal(existsSync(join(repo, ".pigeon")), false);
  } finally {
    cleanup();
  }
});

// 决策 279：worker 起点快照的引用与分支同名，随分支一并删除
test("起点引用 refs/pigeon/worker-start/<名>：删分支时一并删除；没有引用的分支照删；非法名字拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const ref = workerStartRefFor("fix-a");
    assert.equal(ref, "refs/pigeon/worker-start/fix-a");
    git(repo, ["update-ref", ref, head]);
    const first = addWorktree({
      repoRoot: repo,
      sessionId: newSessionId(),
      name: "fix-a",
      baseRef: head,
    });
    removeWorktree({ repoRoot: repo, path: first.path, force: true });
    deleteBranch({ repoRoot: repo, branch: "pigeon/fix-a" });
    assert.equal(git(repo, ["for-each-ref", "refs/pigeon/worker-start/"]).trim(), "", "引用已删");
    assert.equal(git(repo, ["for-each-ref", "refs/heads/pigeon/"]).trim(), "", "分支已删");

    const second = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fix-b" });
    removeWorktree({ repoRoot: repo, path: second.path, force: true });
    deleteBranch({ repoRoot: repo, branch: "pigeon/fix-b" });
    assert.equal(git(repo, ["for-each-ref", "refs/heads/pigeon/"]).trim(), "");
    assert.throws(() => workerStartRefFor("../x"), WorktreeError);
  } finally {
    cleanup();
  }
});
