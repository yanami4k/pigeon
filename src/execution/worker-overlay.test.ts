// worker 结果叠加（决策 279）的硬性规则：只写 worker 改过的文件；主工作目录有未提交改动时仍能叠；冲突时不写入、
// worker 分支与工作树原样保留；worker 删除的文件不自动删；主工作目录已删的文件不写回；不动主仓库的暂存区。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { snapshotWorkdir } from "./workdir-snapshot.ts";
import { OverlayError, overlayWorkerChanges } from "./worker-overlay.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 12 行的文件内容：<前缀>1 到 <前缀>12，每行以换行结尾
const LINES = (prefix: string) =>
  Array.from({ length: 12 }, (_, index) => `${prefix}${index + 1}\n`).join("");

interface Fixture {
  main: string;
  worker: string;
  base: string;
  cleanup: () => void;
}

// 主仓库有一个提交；主工作目录带未提交改动（a.txt 改过、u.txt 未跟踪）后拍快照；worker 工作树从快照开出
function fixture(): Fixture {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-overlay-main-")));
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "pigeon@example.invalid");
  git(main, "config", "user.name", "pigeon-test");
  git(main, "config", "core.autocrlf", "false");
  writeFileSync(join(main, ".gitignore"), "*.log\n.pigeon/\n");
  writeFileSync(join(main, "a.txt"), LINES("a"));
  writeFileSync(join(main, "b.txt"), LINES("b"));
  writeFileSync(join(main, "c.txt"), LINES("c"));
  writeFileSync(join(main, "d.txt"), "to be deleted by worker\n");
  writeFileSync(join(main, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  // 主工作目录的未提交改动：a.txt 第 1 行、未跟踪的 u.txt
  writeFileSync(join(main, "a.txt"), LINES("a").replace("a1\n", "a1 main-before-snapshot\n"));
  writeFileSync(join(main, "u.txt"), "untracked in main\n");
  const snap = snapshotWorkdir({ repoRoot: main, ref: "refs/pigeon/worker-start/w" });
  assert.equal(snap.snapshot, true);
  const worker = join(main, ".pigeon", "state", "worktrees", "s-w");
  mkdirSync(join(main, ".pigeon", "state", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "pigeon/w", worker, snap.commit);
  return {
    main,
    worker,
    base: snap.commit,
    cleanup: () => rmSync(main, { recursive: true, force: true }),
  };
}

function snapshotOf(dir: string, files: string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    files.map((file) => [
      file,
      existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : undefined,
    ])
  );
}

// 主仓库暂存区与分支的指纹
function mainGitState(dir: string) {
  return {
    index: git(dir, "ls-files", "--stage"),
    staged: git(dir, "diff", "--cached"),
    head: git(dir, "rev-parse", "HEAD"),
    branch: git(dir, "symbolic-ref", "HEAD"),
  };
}

test("硬性规则：只写入 worker 改过的文件，worker 没碰的文件一律不动（worker 工作树里被忽略的文件也不带）", () => {
  const f = fixture();
  try {
    // worker：改 b.txt 末行、新建 n.txt 与子目录文件、删 d.txt、新建被忽略的 debug.log
    writeFileSync(join(f.worker, "b.txt"), LINES("b").replace("b12\n", "b12 worker\n"));
    writeFileSync(join(f.worker, "n.txt"), "new by worker\n");
    mkdirSync(join(f.worker, "deep", "er"), { recursive: true });
    writeFileSync(join(f.worker, "deep", "er", "x.txt"), "deep\n");
    rmSync(join(f.worker, "d.txt"));
    writeFileSync(join(f.worker, "debug.log"), "ignored\n");
    // 主工作目录在 worker 干活期间又改了 c.txt（未提交）
    writeFileSync(join(f.main, "c.txt"), LINES("c").replace("c5\n", "c5 main-later\n"));
    const untouched = ["a.txt", "c.txt", "u.txt", "d.txt", "bin.dat", ".gitignore"];
    const before = snapshotOf(f.main, untouched);
    const gitBefore = mainGitState(f.main);

    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, {
      applied: ["b.txt", "deep/er/x.txt", "n.txt"],
      unchanged: [],
      conflicts: [],
      deletedByWorker: ["d.txt"],
    });
    assert.equal(
      readFileSync(join(f.main, "b.txt"), "utf8"),
      LINES("b").replace("b12\n", "b12 worker\n")
    );
    assert.equal(readFileSync(join(f.main, "n.txt"), "utf8"), "new by worker\n");
    assert.equal(readFileSync(join(f.main, "deep", "er", "x.txt"), "utf8"), "deep\n");
    assert.deepEqual(snapshotOf(f.main, untouched), before, "worker 没碰的文件一律不动");
    assert.equal(existsSync(join(f.main, "d.txt")), true, "worker 删除的文件不自动删");
    assert.equal(existsSync(join(f.main, "debug.log")), false, "worker 工作树里被忽略的文件不带");
    assert.deepEqual(mainGitState(f.main), gitBefore, "不动主仓库的暂存区、分支与 HEAD");
  } finally {
    f.cleanup();
  }
});

test("硬性规则：worker 删除的文件不自动删，只在结果里列出——主工作目录里没动过的与快照后又改过的都原样保留", () => {
  const f = fixture();
  try {
    rmSync(join(f.worker, "d.txt"));
    rmSync(join(f.worker, "c.txt"));
    // 主工作目录在快照之后又改了 c.txt
    const mainC = LINES("c").replace("c3\n", "c3 main-later\n");
    writeFileSync(join(f.main, "c.txt"), mainC);
    const gitBefore = mainGitState(f.main);
    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, {
      applied: [],
      unchanged: [],
      conflicts: [],
      deletedByWorker: ["c.txt", "d.txt"],
    });
    assert.equal(readFileSync(join(f.main, "d.txt"), "utf8"), "to be deleted by worker\n");
    assert.equal(readFileSync(join(f.main, "c.txt"), "utf8"), mainC);
    assert.deepEqual(mainGitState(f.main), gitBefore, "暂存区也不动（不做 git rm）");
  } finally {
    f.cleanup();
  }
});

test("硬性规则：主工作目录有未提交改动（含已暂存的）时仍能叠——同一文件不同处的改动三方合并", () => {
  const f = fixture();
  try {
    // worker 改 a.txt 末行；主工作目录在快照之后又改了 a.txt 首行并暂存了 b.txt 的一处改动
    writeFileSync(
      join(f.worker, "a.txt"),
      readFileSync(join(f.worker, "a.txt"), "utf8").replace("a12\n", "a12 worker\n")
    );
    writeFileSync(
      join(f.main, "a.txt"),
      LINES("a").replace("a1\n", "a1 main-before-snapshot\na1b main-after-snapshot\n")
    );
    writeFileSync(join(f.main, "b.txt"), LINES("b").replace("b3\n", "b3 staged\n"));
    git(f.main, "add", "b.txt");
    const gitBefore = mainGitState(f.main);
    assert.match(gitBefore.staged, /b3 staged/);

    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, {
      applied: ["a.txt"],
      unchanged: [],
      conflicts: [],
      deletedByWorker: [],
    });
    assert.equal(
      readFileSync(join(f.main, "a.txt"), "utf8"),
      LINES("a")
        .replace("a1\n", "a1 main-before-snapshot\na1b main-after-snapshot\n")
        .replace("a12\n", "a12 worker\n"),
      "双方的改动都在"
    );
    assert.deepEqual(mainGitState(f.main), gitBefore, "暂存区原样（b.txt 的暂存改动还在）");
    assert.equal(
      readFileSync(join(f.main, "b.txt"), "utf8"),
      LINES("b").replace("b3\n", "b3 staged\n")
    );
  } finally {
    f.cleanup();
  }
});

test("硬性规则：叠不上时列出冲突文件、不写入冲突的那部分；其余文件照叠；worker 分支与工作树原样保留", () => {
  const f = fixture();
  try {
    // 同一行双方各改：b.txt 第 6 行；worker 另改 c.txt（主没动）
    writeFileSync(join(f.worker, "b.txt"), LINES("b").replace("b6\n", "b6 worker\n"));
    writeFileSync(join(f.worker, "c.txt"), LINES("c").replace("c6\n", "c6 worker\n"));
    writeFileSync(join(f.main, "b.txt"), LINES("b").replace("b6\n", "b6 main\n"));
    // 双方各自新建了内容不同的同名文件；以及内容相同的同名文件
    writeFileSync(join(f.worker, "same.txt"), "identical\n");
    writeFileSync(join(f.main, "same.txt"), "identical\n");
    writeFileSync(join(f.worker, "both.txt"), "worker version\n");
    writeFileSync(join(f.main, "both.txt"), "main version\n");
    // 二进制文件双方都改
    writeFileSync(join(f.worker, "bin.dat"), Buffer.from([0, 9, 9]));
    writeFileSync(join(f.main, "bin.dat"), Buffer.from([0, 7, 7]));
    const workerBefore = {
      branch: git(f.main, "rev-parse", "pigeon/w"),
      status: git(f.worker, "status", "--porcelain=v1", "--untracked-files=all"),
      b: readFileSync(join(f.worker, "b.txt"), "utf8"),
    };

    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, {
      applied: ["c.txt"],
      unchanged: ["same.txt"],
      conflicts: ["b.txt", "bin.dat", "both.txt"],
      deletedByWorker: [],
    });
    assert.equal(
      readFileSync(join(f.main, "b.txt"), "utf8"),
      LINES("b").replace("b6\n", "b6 main\n"),
      "冲突文件未写入"
    );
    assert.equal(readFileSync(join(f.main, "both.txt"), "utf8"), "main version\n");
    assert.deepEqual(readFileSync(join(f.main, "bin.dat")), Buffer.from([0, 7, 7]));
    assert.equal(
      readFileSync(join(f.main, "c.txt"), "utf8"),
      LINES("c").replace("c6\n", "c6 worker\n"),
      "其余照叠"
    );
    assert.deepEqual(
      {
        branch: git(f.main, "rev-parse", "pigeon/w"),
        status: git(f.worker, "status", "--porcelain=v1", "--untracked-files=all"),
        b: readFileSync(join(f.worker, "b.txt"), "utf8"),
      },
      workerBefore,
      "worker 分支与工作树原样保留"
    );
  } finally {
    f.cleanup();
  }
});

test("硬性规则：不回退主工作目录——主已删掉的文件 worker 改了不写回（列为冲突）；主没改的文件直接取 worker 版本（含二进制）", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.worker, "c.txt"), LINES("c").replace("c2\n", "c2 worker\n"));
    rmSync(join(f.main, "c.txt"));
    writeFileSync(join(f.worker, "bin.dat"), Buffer.from([0, 9, 9]));
    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, {
      applied: ["bin.dat"],
      unchanged: [],
      conflicts: ["c.txt"],
      deletedByWorker: [],
    });
    assert.equal(existsSync(join(f.main, "c.txt")), false, "主已删的文件不写回");
    assert.deepEqual(readFileSync(join(f.main, "bin.dat")), Buffer.from([0, 9, 9]));
  } finally {
    f.cleanup();
  }
});

test("worker 相对起点没有改动：三份清单全空，主工作目录一字不动", () => {
  const f = fixture();
  try {
    const before = snapshotOf(f.main, ["a.txt", "b.txt", "c.txt", "d.txt", "u.txt"]);
    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result, { applied: [], unchanged: [], conflicts: [], deletedByWorker: [] });
    assert.deepEqual(snapshotOf(f.main, ["a.txt", "b.txt", "c.txt", "d.txt", "u.txt"]), before);
  } finally {
    f.cleanup();
  }
});

test("主工作目录里该路径是目录或符号链接：不写、列为冲突；起点提交不存在即报错", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.worker, "n.txt"), "worker file\n");
    mkdirSync(join(f.main, "n.txt"));
    writeFileSync(join(f.worker, "c.txt"), LINES("c").replace("c2\n", "c2 worker\n"));
    let expectConflicts = ["n.txt"];
    if (process.platform !== "win32") {
      rmSync(join(f.main, "c.txt"));
      symlinkSync("a.txt", join(f.main, "c.txt"));
      expectConflicts = ["c.txt", "n.txt"];
    }
    const result = overlayWorkerChanges({ repoRoot: f.main, base: f.base, worktreePath: f.worker });
    assert.deepEqual(result.conflicts, expectConflicts);
    assert.ok(!result.applied.includes("n.txt"));
    assert.throws(
      () =>
        overlayWorkerChanges({
          repoRoot: f.main,
          base: "0123456789abcdef0123456789abcdef01234567",
          worktreePath: f.worker,
        }),
      OverlayError
    );
  } finally {
    f.cleanup();
  }
});

test("决策 325：worker 改了仓库已跟踪的 .pigeon/settings.json——作为项目内容照常叠加；个人设置与程序状态不带", () => {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-overlay-settings-")));
  try {
    git(main, "init", "-q", "-b", "main");
    git(main, "config", "user.email", "pigeon@example.invalid");
    git(main, "config", "user.name", "pigeon-test");
    git(main, "config", "core.autocrlf", "false");
    mkdirSync(join(main, ".pigeon"));
    writeFileSync(join(main, ".pigeon", ".gitignore"), "state/\nsettings.local.json\n");
    writeFileSync(join(main, ".pigeon", "settings.json"), "{}\n");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    const snap = snapshotWorkdir({ repoRoot: main, ref: "refs/pigeon/worker-start/w" });
    const worker = join(main, ".pigeon", "state", "worktrees", "s-w");
    mkdirSync(join(main, ".pigeon", "state", "worktrees"), { recursive: true });
    git(main, "worktree", "add", "-q", "-b", "pigeon/w", worker, snap.commit);
    writeFileSync(join(worker, ".pigeon", "settings.json"), '{"commands":{}}\n');
    writeFileSync(join(worker, ".pigeon", "settings.local.json"), "{}\n");
    mkdirSync(join(worker, ".pigeon", "state"), { recursive: true });
    writeFileSync(join(worker, ".pigeon", "state", "x.json"), "{}\n");
    const result = overlayWorkerChanges({
      repoRoot: main,
      base: snap.commit,
      worktreePath: worker,
    });
    assert.deepEqual(result.applied, [".pigeon/settings.json"]);
    assert.equal(readFileSync(join(main, ".pigeon", "settings.json"), "utf8"), '{"commands":{}}\n');
    assert.equal(existsSync(join(main, ".pigeon", "settings.local.json")), false);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});
