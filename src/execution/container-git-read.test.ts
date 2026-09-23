// 执行端的只读 git 查询（结构化记忆核验用）：列出受跟踪的文件、追踪一个文件跨改名的历史。容器以在本机执行命令的
// 假 docker CLI 代替，工作区是真实的 git 仓库
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "./local-docker-fixtures.ts";

test("执行端的 git 查询：受跟踪的文件（不含未跟踪与被忽略的）；文件历史跨改名追踪，给出每个提交上当时的路径", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-git-read-"));
  const root = join(base, "testbed");
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const { host, cleanup } = localDockerHost(root);
  try {
    git("init", "-q");
    git("config", "user.name", "t");
    git("config", "user.email", "t@example.invalid");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "src", "old name.py"), "x = 1\ny = 2\nz = 3\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add");
    const c1 = git("rev-parse", "HEAD");
    git("mv", "src/old name.py", "src/new.py");
    git("commit", "-q", "-m", "rename");
    const c2 = git("rev-parse", "HEAD");
    writeFileSync(join(root, "src", "new.py"), "x = 1\ny = 2\nz = 4\n");
    git("commit", "-q", "-am", "edit");
    const c3 = git("rev-parse", "HEAD");
    writeFileSync(join(root, "untracked.txt"), "u\n");
    writeFileSync(join(root, "run.log"), "l\n");
    assert.ok(host.listTracked !== undefined && host.fileHistory !== undefined);
    assert.deepEqual(await host.listTracked(), [".gitignore", "src/new.py"]);
    assert.deepEqual(await host.fileHistory("src/new.py"), [
      { commit: c3, path: "src/new.py" },
      { commit: c2, path: "src/new.py" },
      { commit: c1, path: "src/old name.py" },
    ]);
    assert.deepEqual(await host.fileHistory("src/new.py", 1), [{ commit: c3, path: "src/new.py" }]);
    assert.deepEqual(await host.fileHistory("nope.py"), []);
    // 同步执行（结构化记忆的探针是同步的）：在工作区根执行，退出码与标准输出原样带回
    assert.ok(host.runSync !== undefined);
    const listed = host.runSync(["git", "ls-files"], 30_000);
    assert.equal(listed.exitCode, 0);
    assert.equal(listed.timedOut, false);
    assert.deepEqual(listed.stdout.toString("utf8").trim().split("\n"), [
      ".gitignore",
      "src/new.py",
    ]);
    assert.equal(host.runSync(["test", "-f", "run.log"], 30_000).exitCode, 0);
    assert.equal(host.runSync(["test", "-f", "missing"], 30_000).exitCode, 1);
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});
