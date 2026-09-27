// 执行端的"这一步起点"（决策 154②）：用一个在本机执行命令的假 docker CLI 驱动容器实现，对着真实的 git 仓库验证
// 记下起点与验证前按起点还原受保护的文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createContainerWorkspaceHost } from "./container-host.ts";
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

test("执行端不跟随符号引用：开工树引用被设成指向 main 的符号引用时，记起点只改这条引用、不改 main", async () => {
  const { base, root } = fixture();
  try {
    const start = git(root, "rev-parse", "HEAD");
    const docker = localDockerHost(root);
    try {
      // 当前分支（名字随本机 git 的缺省而定）
      const branch = git(root, "symbolic-ref", "HEAD");
      git(root, "symbolic-ref", "refs/pigeon/step-start/s/1", branch);
      const host = createContainerWorkspaceHost({
        container: "box",
        root: docker.containerRoot,
        docker: docker.docker,
        stepStartRef: "refs/pigeon/step-start/s/1",
      });
      put(root, { "a.txt": "changed before start\n" });
      const mark = await host.markStepStart?.();
      assert.equal(git(root, "rev-parse", branch), start, "当前分支未被改写");
      assert.ok(mark?.baseCommit !== undefined);
      assert.equal(git(root, "rev-parse", "refs/pigeon/step-start/s/1"), mark.baseCommit);
    } finally {
      docker.cleanup();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("执行端的 git 不读全局配置：agent 在全局配置里配 filter 驱动（配合工作区的 .gitattributes），记起点与验证前还原受保护文件都不执行它", async () => {
  const { base, root, host } = fixture();
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const marker = join(base, "ran").replace(/\\/g, "/");
    const evil = join(base, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    const globalCfg = join(base, "global.gitconfig");
    writeFileSync(globalCfg, `[filter "evil"]\n\tclean = ${evil.replace(/\\/g, "/")}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    put(root, { ".gitattributes": "*.txt filter=evil\n", "a.txt": "changed\n" });
    const mark = await host.markStepStart?.();
    put(root, { "a.txt": "agent\n" });
    if (mark !== undefined) await host.restoreProtectedFromStepStart?.(mark, (p) => p === "a.txt");
    assert.equal(existsSync(join(base, "ran")), false, "agent 的程序没被执行");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
