// 执行端的"回到这一步起点"（决策 154②）：用一个在本机执行命令的假 docker CLI 驱动容器实现，对着真实的 git 仓库验证
// 撤回规则——回到起点提交、删掉 agent 新建的一切（含被忽略的），开工时已被忽略的路径一概不动。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { StepStartLostError } from "./container-host.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function put(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "pigeon-step-start-"));
  const root = join(base, "testbed");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  put(root, { ".gitignore": "build/\n*.log\ntmp/\n", "a.txt": "one\n", "src/keep.py": "x = 1\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  // 开工时已被忽略的：整个 build/ 目录与一个 .log 文件
  put(root, { "build/keep.o": "obj\n", "pre.log": "old log\n" });
  const { host } = localDockerHost(root);
  return { base, root, host };
}

test("回到这一步起点：回到起点提交（agent 自己的提交也撤掉），删掉 agent 新建的一切含被忽略的，开工时已被忽略的不动", async () => {
  const { base, root, host } = fixture();
  try {
    const start = git(root, "rev-parse", "HEAD");
    assert.ok(host.markStepStart !== undefined && host.restoreStepStart !== undefined);
    // 开工时已有未提交的改动（跑批器预置的人写测试）：起点另记一个"开工时的树"挂在 HEAD 下的提交，
    // 它与 HEAD 之差即开工时的脏文件（结构化记忆认定题面测试用）
    put(root, { "tests/preset.test.py": "def test_x():\n    pass\n" });
    const mark = await host.markStepStart();
    assert.equal(mark.commit, start);
    assert.equal(git(root, "rev-parse", `${mark.baseCommit}^`), start);
    assert.equal(
      git(
        root,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--root",
        mark.baseCommit ?? ""
      ),
      "tests/preset.test.py"
    );
    assert.equal(git(root, "status", "--porcelain"), "?? tests/", "记起点不动工作区与索引");
    assert.deepEqual([...mark.ignored].sort(), ["build/", "pre.log"]);
    // agent 在这一步里：改已跟踪文件并自己提交，再改一次不提交；新建未跟踪文件与目录；新建被忽略的文件与目录；
    // 往开工时已被忽略的目录里加文件；删掉一个已跟踪文件
    put(root, { "a.txt": "two\n" });
    git(root, "commit", "-q", "-am", "agent wip");
    put(root, {
      "a.txt": "three\n",
      "new.txt": "n\n",
      "src/added/x.py": "y = 2\n",
      "new.log": "agent log\n",
      "tmp/cache.bin": "c\n",
      "build/more.o": "obj2\n",
    });
    rmSync(join(root, "src/keep.py"));
    await host.restoreStepStart(mark);
    assert.equal(git(root, "rev-parse", "HEAD"), start);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(root, "src/keep.py"), "utf8"), "x = 1\n");
    for (const gone of ["new.txt", "src/added", "new.log", "tmp"]) {
      assert.ok(!existsSync(join(root, gone)), `${gone} 应被删掉`);
    }
    // 开工时已被忽略的路径（含其下后来多出的文件）一概不动
    assert.equal(readFileSync(join(root, "pre.log"), "utf8"), "old log\n");
    assert.ok(existsSync(join(root, "build/keep.o")));
    assert.ok(existsSync(join(root, "build/more.o")));
    // 开工时预置、尚未提交的文件回到开工时的样子（未跟踪）
    assert.equal(
      readFileSync(join(root, "tests/preset.test.py"), "utf8"),
      "def test_x():\n    pass\n"
    );
    assert.equal(git(root, "status", "--porcelain"), "?? tests/");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("回到这一步起点：起点提交已不在库里即报错，不做部分恢复", async () => {
  const { base, root, host } = fixture();
  try {
    assert.ok(host.restoreStepStart !== undefined);
    put(root, { "a.txt": "changed\n" });
    await assert.rejects(
      host.restoreStepStart({ commit: "0".repeat(40), ignored: [] }),
      StepStartLostError
    );
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "changed\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("验证前还原受保护的文件：改动、删除、改名、换成目录、换成符号链接，以及设了 skip-worktree 或 assume-unchanged 的改动一律还原成开工时的版本；不执行 agent 放进 .git/hooks 的钩子", async () => {
  const { base, root, host } = fixture();
  try {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    put(root, Object.fromEntries(names.map((n) => [`tests/test_${n}.py`, `human ${n}\n`])));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "human tests");
    assert.ok(host.markStepStart !== undefined && host.restoreProtectedFromStepStart !== undefined);
    const mark = await host.markStepStart();
    // agent 的各种改法
    put(root, { "tests/test_a.py": "agent a\n" });
    rmSync(join(root, "tests", "test_b.py"));
    execFileSync("git", ["mv", "tests/test_c.py", "tests/test_c2.py"], { cwd: root });
    const symlinks = process.platform !== "win32";
    if (symlinks) {
      rmSync(join(root, "tests", "test_d.py"));
      execFileSync("ln", ["-s", "../a.txt", "tests/test_d.py"], { cwd: root });
    }
    rmSync(join(root, "tests", "test_e.py"));
    put(root, { "tests/test_e.py/inner.py": "x\n" });
    git(root, "update-index", "--skip-worktree", "tests/test_f.py");
    put(root, { "tests/test_f.py": "agent f\n" });
    git(root, "update-index", "--assume-unchanged", "tests/test_g.py");
    put(root, { "tests/test_g.py": "agent g\n" });
    // agent 放进 .git/hooks 的钩子：还原时若被执行就会留下标记
    const hooks = join(root, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const hook of ["post-checkout", "post-index-change", "reference-transaction"]) {
      writeFileSync(
        join(hooks, hook),
        `#!/bin/sh\ntouch "${join(base, "hook-ran").replace(/\\/g, "/")}"\n`,
        {
          mode: 0o755,
        }
      );
    }
    const restored = await host.restoreProtectedFromStepStart(mark, (p) => p.startsWith("tests/"));
    const expected = names.filter((n) => symlinks || n !== "d").map((n) => `tests/test_${n}.py`);
    assert.deepEqual(
      [...restored].filter((p) => expected.includes(p)).sort(),
      expected,
      `还原清单：${restored.join(", ")}`
    );
    for (const n of names) {
      if (!symlinks && n === "d") continue;
      assert.equal(
        readFileSync(join(root, "tests", `test_${n}.py`), "utf8"),
        `human ${n}\n`,
        `test_${n}`
      );
    }
    assert.equal(existsSync(join(base, "hook-ran")), false, "agent 的钩子没有被执行");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("验证前还原受保护的文件：agent 留下未解决的合并冲突也照样还原，不报错", async () => {
  const { base, root, host } = fixture();
  try {
    put(root, { "tests/test_a.py": "human a\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "human tests");
    assert.ok(host.markStepStart !== undefined && host.restoreProtectedFromStepStart !== undefined);
    const mark = await host.markStepStart();
    git(root, "checkout", "-q", "-b", "side");
    put(root, { "tests/test_a.py": "side\n" });
    git(root, "commit", "-qam", "side");
    git(root, "checkout", "-q", "-");
    put(root, { "tests/test_a.py": "main\n" });
    git(root, "commit", "-qam", "main");
    try {
      git(root, "merge", "-q", "side");
    } catch {
      // 冲突即非零退出
    }
    assert.ok(existsSync(join(root, ".git", "MERGE_HEAD")), "确有进行中的合并");
    const restored = await host.restoreProtectedFromStepStart(mark, (p) => p.startsWith("tests/"));
    assert.deepEqual(restored, ["tests/test_a.py"]);
    assert.equal(readFileSync(join(root, "tests", "test_a.py"), "utf8"), "human a\n");
    assert.equal(existsSync(join(root, ".git", "MERGE_HEAD")), false, "合并状态已清");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
