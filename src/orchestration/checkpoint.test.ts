// 工作区快照（M7 S5，决策 078）：只在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交
// （临时 GIT_INDEX_FILE → write-tree → commit-tree → update-ref），挂到 refs/pigeon/checkpoints/<会话>/。
// 必须不触碰用户的工作区、暂存区、当前分支与 HEAD；治理目录 .pigeon 不进快照；非 git 工作区不打快照。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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
import {
  CHECKPOINT_REF_PREFIX,
  createCheckpointer,
  isGitWorkspace,
  NotGitWorkspaceError,
} from "./checkpoint.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-checkpoint-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 用户侧三件事的指纹：工作区状态（含未跟踪）、暂存区内容、当前分支与 HEAD
function userState(dir: string) {
  return {
    status: git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: git(dir, ["diff", "--cached"]),
    index: git(dir, ["ls-files", "--stage"]),
    head: git(dir, ["rev-parse", "HEAD"]),
    branch: git(dir, ["symbolic-ref", "HEAD"]),
  };
}

test("文件确实改变后生成快照提交并挂 ref；用户工作区、暂存区、当前分支与 HEAD 均不受影响", async () => {
  const { dir, cleanup } = repo();
  try {
    // 用户自己的状态：一处已暂存、一处未暂存、一个未跟踪文件
    writeFileSync(join(dir, "b.txt"), "staged by user\n");
    git(dir, ["add", "b.txt"]);
    writeFileSync(join(dir, "b.txt"), "staged by user\nplus unstaged\n");
    writeFileSync(join(dir, "notes.txt"), "untracked\n");
    const sessionId = newSessionId();
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId });
    const before = userState(dir);

    await checkpointer.beforeChange();
    assert.deepEqual(userState(dir), before, "记基线不碰用户状态");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const beforeSnapshot = { ...userState(dir) };
    const first = await checkpointer.afterChange();
    assert.ok(first !== undefined, "文件改变后生成快照");
    assert.deepEqual(userState(dir), beforeSnapshot, "打快照不碰工作区、暂存区、分支与 HEAD");
    assert.equal(first.ref, `${CHECKPOINT_REF_PREFIX}${sessionId}/1`);
    assert.equal(git(dir, ["rev-parse", first.ref]).trim(), first.commit);
    assert.equal(git(dir, ["show", `${first.commit}:a.txt`]), "two\n", "快照含工具改动");
    assert.equal(
      git(dir, ["show", `${first.commit}:b.txt`]),
      "staged by user\nplus unstaged\n",
      "快照是工作区的真实文件状态"
    );
    assert.equal(git(dir, ["show", `${first.commit}:notes.txt`]), "untracked\n");
    assert.ok(first.baseCommit !== undefined, "首个快照带改前基线");
    assert.equal(
      git(dir, ["show", `${first.baseCommit}:a.txt`]),
      "one\n",
      "基线是首次改动之前的状态"
    );
    assert.equal(git(dir, ["rev-parse", `${first.commit}^`]).trim(), first.baseCommit);

    // 没有改动：不生成快照
    await checkpointer.beforeChange();
    assert.equal(await checkpointer.afterChange(), undefined);

    await checkpointer.beforeChange();
    writeFileSync(join(dir, "a.txt"), "three\n");
    const second = await checkpointer.afterChange();
    assert.ok(second !== undefined);
    assert.equal(second.ref, `${CHECKPOINT_REF_PREFIX}${sessionId}/2`);
    assert.equal(second.baseCommit, undefined, "只有首个快照带基线");
    assert.equal(git(dir, ["rev-parse", `${second.commit}^`]).trim(), first.commit, "快照成链");
    assert.equal(git(dir, ["symbolic-ref", "HEAD"]).trim(), "refs/heads/main");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "staged by user\nplus unstaged\n");
  } finally {
    cleanup();
  }
});

test("治理目录 .pigeon 不进快照：只有会话文件在变时不算文件改变", async () => {
  const { dir, cleanup } = repo();
  try {
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    mkdirSync(join(dir, ".pigeon", "state", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pigeon", "state", "sessions", "x.jsonl"), "{}\n");
    assert.equal(await checkpointer.afterChange(), undefined);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined);
    assert.throws(() => git(dir, ["show", `${snapshot.commit}:.pigeon/state/sessions/x.jsonl`]));
  } finally {
    cleanup();
  }
});

test("决策 325：仓库已跟踪的 .pigeon/settings.json 与 .pigeon/skills 是项目内容——快照里照常在、改动照进；个人设置不进", async () => {
  const { dir, cleanup } = repo();
  try {
    mkdirSync(join(dir, ".pigeon", "skills", "s"), { recursive: true });
    writeFileSync(join(dir, ".pigeon", "settings.json"), "{}\n");
    writeFileSync(join(dir, ".pigeon", "skills", "s", "SKILL.md"), "skill\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "track settings"]);
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    writeFileSync(join(dir, ".pigeon", "settings.local.json"), "{}\n");
    assert.equal(await checkpointer.afterChange(), undefined, "只动了个人设置不算文件改变");
    writeFileSync(join(dir, ".pigeon", "settings.json"), '{"commands":{}}\n');
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined);
    assert.equal(
      git(dir, ["show", `${snapshot.commit}:.pigeon/settings.json`]),
      '{"commands":{}}\n'
    );
    assert.equal(git(dir, ["show", `${snapshot.commit}:.pigeon/skills/s/SKILL.md`]), "skill\n");
    assert.throws(() => git(dir, ["show", `${snapshot.commit}:.pigeon/settings.local.json`]));
  } finally {
    cleanup();
  }
});

test(".pigeon 已被 .gitignore 忽略的仓库：照常生成快照（不因忽略项报错）", async () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-q", "-m", "ignore"]);
    mkdirSync(join(dir, ".pigeon", "state", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pigeon", "state", "sessions", "x.jsonl"), "{}\n");
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined);
    assert.equal(git(dir, ["show", `${snapshot.commit}:a.txt`]), "changed\n");
  } finally {
    cleanup();
  }
});

test("现状快照：分叉时没有任何快照也能给出当前文件状态的提交（同样不碰用户状态）", async () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    const before = userState(dir);
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    const current = await checkpointer.snapshotNow();
    assert.deepEqual(userState(dir), before);
    assert.equal(git(dir, ["show", `${current.commit}:a.txt`]), "dirty\n");
    assert.equal(git(dir, ["rev-parse", current.ref]).trim(), current.commit);
  } finally {
    cleanup();
  }
});

test("非 git 工作区：判定为否，构造快照器明确报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-nogit-"));
  try {
    assert.equal(isGitWorkspace(dir), false);
    assert.throws(
      () => createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() }),
      NotGitWorkspaceError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
