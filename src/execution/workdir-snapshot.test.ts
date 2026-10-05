// 工作目录快照（决策 278、279 共用）：临时索引上把工作目录写成以 HEAD 为父的提交并挂 refs/pigeon/ 下的引用；
// 不碰用户的工作目录、暂存区、当前分支与 HEAD；.gitignore 里的文件不带；治理目录 .pigeon 保持 HEAD 的样子；
// 没有未提交改动时直接用 HEAD。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  deleteSnapshotRef,
  readSnapshotRef,
  snapshotWorkdir,
  WorkdirSnapshotError,
} from "./workdir-snapshot.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-workdir-snapshot-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "pigeon@example.invalid");
  git(dir, "config", "user.name", "pigeon-test");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), "*.log\n.pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "base\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.txt"), "c\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 用户侧的指纹：工作目录状态（含未跟踪）、暂存区、当前分支与 HEAD
function userState(dir: string) {
  return {
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
    staged: git(dir, "diff", "--cached"),
    index: git(dir, "ls-files", "--stage"),
    head: git(dir, "rev-parse", "HEAD"),
    branch: git(dir, "symbolic-ref", "HEAD"),
  };
}

const REF = "refs/pigeon/test-start/s1";

test("有未提交改动：快照提交以 HEAD 为父、含改动与新建文件、挂引用；用户的工作目录、暂存区、分支与 HEAD 不变", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "two\n");
    // 一处已暂存、再改成未暂存的样子：快照取工作目录的当前内容
    writeFileSync(join(dir, "b.txt"), "staged\n");
    git(dir, "add", "b.txt");
    writeFileSync(join(dir, "b.txt"), "staged\nplus\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    mkdirSync(join(dir, "dir"));
    writeFileSync(join(dir, "dir", "deep.txt"), "deep\n");
    rmSync(join(dir, "sub", "c.txt"));
    const before = userState(dir);

    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.equal(snap.snapshot, true);
    assert.equal(snap.ref, REF);
    assert.equal(snap.head, before.head);
    assert.notEqual(snap.commit, before.head);
    assert.equal(git(dir, "rev-parse", `${snap.commit}^`), before.head, "父提交是 HEAD");
    assert.equal(git(dir, "rev-parse", REF), snap.commit, "引用指向快照提交");
    assert.deepEqual(snap.files, ["a.txt", "b.txt", "dir/deep.txt", "new.txt", "sub/c.txt"]);
    assert.equal(git(dir, "show", `${snap.commit}:a.txt`), "two");
    assert.equal(git(dir, "show", `${snap.commit}:b.txt`), "staged\nplus");
    assert.equal(git(dir, "show", `${snap.commit}:new.txt`), "new");
    assert.equal(git(dir, "show", `${snap.commit}:dir/deep.txt`), "deep");
    assert.equal(
      git(dir, "ls-tree", "--name-only", snap.commit, "sub/"),
      "",
      "删除的文件不在快照里"
    );
    assert.deepEqual(userState(dir), before, "快照不碰用户状态");
  } finally {
    cleanup();
  }
});

test("同一秒内改过且大小不变的文件（racy git）也带进快照：临时索引保留原索引的时间戳", () => {
  const { dir, cleanup } = repo();
  try {
    // 把"索引写入的同一刻文件又被改了"做成确定性的：文件的 mtime 定在一个整秒（索引里记下的纳秒为 0），提交后把内容换成
    // 同样大小的字节、mtime 调回同一刻，索引文件的 mtime 也调到这一刻；只比对 mtime 与大小（不看 ctime）。
    // 这时索引里的 stat 与文件完全一致，git 只有靠 racy 判定（改动时间不早于索引写入时间）重新读内容才能发现改动
    git(dir, "config", "core.trustctime", "false");
    const indexFile = join(dir, ".git", "index");
    const moment = new Date("2024-01-01T00:00:00Z");
    writeFileSync(join(dir, "a.txt"), "two\n");
    utimesSync(join(dir, "a.txt"), moment, moment);
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "two");
    assert.equal(statSync(join(dir, "a.txt")).mtime.getTime(), moment.getTime());
    writeFileSync(join(dir, "a.txt"), "one\n");
    utimesSync(join(dir, "a.txt"), moment, moment);
    utimesSync(indexFile, moment, moment);
    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.equal(snap.snapshot, true, "同一刻的改动被漏掉");
    assert.deepEqual(snap.files, ["a.txt"]);
    assert.equal(git(dir, "show", `${snap.commit}:a.txt`), "one");
  } finally {
    cleanup();
  }
});

test("硬性规则：.gitignore 里的文件不带进快照", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "debug.log"), "ignored\n");
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "out.log"), "ignored too\n");
    writeFileSync(join(dir, "kept.txt"), "kept\n");
    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.equal(snap.snapshot, true);
    assert.deepEqual(snap.files, ["kept.txt"]);
    const listed = git(dir, "ls-tree", "-r", "--name-only", snap.commit).split("\n");
    assert.ok(!listed.includes("debug.log"), listed.join(","));
    assert.ok(!listed.includes("build/out.log"), listed.join(","));
    assert.ok(listed.includes("kept.txt"));
  } finally {
    cleanup();
  }
});

test("治理目录 .pigeon 不算改动：被忽略时不进快照；只有 .pigeon 在变时视作没有未提交改动", () => {
  const { dir, cleanup } = repo();
  try {
    mkdirSync(join(dir, ".pigeon", "state", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pigeon", "state", "sessions", "s.json"), "{}\n");
    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.equal(snap.snapshot, false);
    assert.equal(snap.commit, git(dir, "rev-parse", "HEAD"));
  } finally {
    cleanup();
  }
});

test("决策 325：受跟踪的 .pigeon/settings.json 是项目内容，改动照进快照；程序状态与个人设置不进快照", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, ".pigeon"));
    writeFileSync(join(dir, ".pigeon", "settings.json"), "{}\n");
    writeFileSync(join(dir, ".pigeon", "verify.json"), "{}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "track governance");
    writeFileSync(join(dir, ".pigeon", "settings.json"), '{"changed":1}\n');
    mkdirSync(join(dir, ".pigeon", "state", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".pigeon", "state", "sessions", "s.jsonl"), "{}\n");
    writeFileSync(join(dir, ".pigeon", "settings.local.json"), "{}\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.equal(snap.snapshot, true);
    assert.deepEqual(snap.files, [".pigeon/settings.json", "a.txt"]);
    assert.equal(git(dir, "show", `${snap.commit}:.pigeon/settings.json`), '{"changed":1}');
    assert.equal(git(dir, "show", `${snap.commit}:.pigeon/verify.json`), "{}");
    assert.equal(git(dir, "ls-tree", "-r", "--name-only", snap.commit, ".pigeon/state"), "");
    assert.equal(
      git(dir, "ls-tree", "--name-only", snap.commit, ".pigeon/settings.local.json"),
      ""
    );
  } finally {
    cleanup();
  }
});

test(".pigeon/.gitignore：仓库没跟踪（程序写出的）不进快照；仓库跟踪着的改动照进快照", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, ".pigeon"));
    writeFileSync(join(dir, ".pigeon", ".gitignore"), "state/\nsettings.local.json\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const untracked = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.deepEqual(untracked.files, [".gitignore", "a.txt"]);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "track .pigeon/.gitignore");
    writeFileSync(join(dir, ".pigeon", ".gitignore"), "state/\n");
    const tracked = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.deepEqual(tracked.files, [".pigeon/.gitignore"]);
    assert.equal(git(dir, "show", `${tracked.commit}:.pigeon/.gitignore`), "state/");
  } finally {
    cleanup();
  }
});

test("没有未提交改动：起点就是 HEAD，不建提交、不留引用（上次残留的同名引用被删）", () => {
  const { dir, cleanup } = repo();
  try {
    const stale = git(dir, "commit-tree", git(dir, "rev-parse", "HEAD^{tree}"), "-m", "stale");
    git(dir, "update-ref", REF, stale);
    const before = userState(dir);
    const snap = snapshotWorkdir({ repoRoot: dir, ref: REF });
    assert.deepEqual(snap, {
      commit: before.head,
      head: before.head,
      snapshot: false,
      files: [],
      skipped: [],
    });
    assert.equal(readSnapshotRef(dir, REF), undefined, "残留引用已删");
    assert.deepEqual(userState(dir), before);
  } finally {
    cleanup();
  }
});

test("从仓库子目录发起：快照覆盖整个仓库；删除引用后 readSnapshotRef 为空，重复删除不报错", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "top-level change\n");
    const snap = snapshotWorkdir({ repoRoot: join(dir, "sub"), ref: REF });
    assert.equal(snap.snapshot, true);
    assert.deepEqual(snap.files, ["a.txt"]);
    assert.equal(readSnapshotRef(dir, REF), snap.commit);
    deleteSnapshotRef(dir, REF);
    assert.equal(readSnapshotRef(dir, REF), undefined);
    deleteSnapshotRef(dir, REF);
    // 引用删了，提交本身仍在对象库里（由调用方的分支或容器引用着）
    assert.equal(git(dir, "cat-file", "-t", snap.commit), "commit");
  } finally {
    cleanup();
  }
});

test("不是 git 工作区、仓库没有提交、引用不在 refs/pigeon/ 下：明确报错", () => {
  const plain = mkdtempSync(join(tmpdir(), "pigeon-workdir-plain-"));
  const empty = mkdtempSync(join(tmpdir(), "pigeon-workdir-empty-"));
  try {
    assert.throws(
      () => snapshotWorkdir({ repoRoot: plain, ref: REF }),
      (error: unknown) =>
        error instanceof WorkdirSnapshotError && /不是 git 工作区/.test(error.message)
    );
    git(empty, "init", "-q", "-b", "main");
    assert.throws(
      () => snapshotWorkdir({ repoRoot: empty, ref: REF }),
      (error: unknown) => error instanceof WorkdirSnapshotError && /还没有提交/.test(error.message)
    );
    assert.throws(
      () => snapshotWorkdir({ repoRoot: empty, ref: "refs/heads/main" }),
      (error: unknown) =>
        error instanceof WorkdirSnapshotError && /refs\/pigeon\//.test(error.message)
    );
    assert.throws(() => deleteSnapshotRef(empty, "refs/heads/main"), WorkdirSnapshotError);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

// 决策 381：未跟踪的大文件按上限跳过并列出；已跟踪的大文件照收；文件名里的通配字符按字面排除
test("未跟踪文件超过单个上限的跳过、合计超限时从大到小跳过；已跟踪的大文件照进快照", () => {
  const { dir, cleanup } = repo();
  try {
    writeFileSync(join(dir, "b.txt"), "x".repeat(5000));
    writeFileSync(join(dir, "huge[1].bin"), "h".repeat(3000));
    writeFileSync(join(dir, "mid.bin"), "m".repeat(800));
    writeFileSync(join(dir, "small.txt"), "s".repeat(300));
    writeFileSync(join(dir, "tiny.txt"), "t");
    const before = userState(dir);
    const snap = snapshotWorkdir({
      repoRoot: dir,
      ref: REF,
      limits: { fileMaxBytes: 1000, totalMaxBytes: 500 },
    });
    assert.deepEqual(snap.skipped, [
      { path: "huge[1].bin", bytes: 3000 },
      { path: "mid.bin", bytes: 800 },
    ]);
    const tree = git(dir, "ls-tree", "-r", "--name-only", snap.commit).split("\n");
    assert.ok(tree.includes("small.txt") && tree.includes("tiny.txt"), tree.join(","));
    assert.ok(!tree.includes("huge[1].bin") && !tree.includes("mid.bin"), tree.join(","));
    assert.equal(git(dir, "show", `${snap.commit}:b.txt`).length, 5000, "已跟踪的大文件照收");
    assert.deepEqual(userState(dir), before);
  } finally {
    cleanup();
  }
});
