// 工作树改动清单（M5.5 S2，决策 040 结构化结果）：修改、新增（未跟踪）、改名都按工作树相对路径列出。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newSessionId } from "../state/ids.ts";
import { addWorktree, changedFiles } from "./worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("改动清单：修改、未跟踪新增、暂存改名按相对路径升序列出；干净工作树为空", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-changes-")));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "old.txt"), "old\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const handle = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "w" });
    assert.deepEqual(changedFiles(handle.path), []);

    writeFileSync(join(handle.path, "a.txt"), "changed\n");
    writeFileSync(join(handle.path, "新文件.txt"), "new\n");
    git(handle.path, ["mv", "old.txt", "renamed.txt"]);
    assert.deepEqual(changedFiles(handle.path), ["a.txt", "renamed.txt", "新文件.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
