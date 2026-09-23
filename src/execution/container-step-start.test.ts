// 执行端的"回到这一步起点"（决策 154②）：用一个在本机执行命令的假 docker CLI 驱动容器实现，对着真实的 git 仓库验证
// 撤回规则——回到起点提交、删掉 agent 新建的一切（含被忽略的），开工时已被忽略的路径一概不动。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createContainerWorkspaceHost, StepStartLostError } from "./container-host.ts";

// 假 docker：exec 在本机执行（-w 给出的目录即容器内工作区），其余子命令直接成功
const LOCAL_DOCKER = `
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "exec") process.exit(0);
let i = 1;
let cwd = process.cwd();
let interactive = false;
for (;;) {
  if (args[i] === "-i") { interactive = true; i++; continue; }
  if (args[i] === "-w") { cwd = args[i + 1]; i += 2; continue; }
  if (args[i] === "-e") { i += 2; continue; }
  break;
}
const [program, ...rest] = args.slice(i + 1);
const r = spawnSync(program, rest, { cwd, stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"] });
process.exit(r.status ?? 1);
`;

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
  const script = join(base, "docker.mjs");
  writeFileSync(script, LOCAL_DOCKER);
  const host = createContainerWorkspaceHost({
    container: "box",
    root: root.replace(/\\/g, "/"),
    docker: [process.execPath, script],
  });
  return { base, root, host };
}

test("回到这一步起点：回到起点提交（agent 自己的提交也撤掉），删掉 agent 新建的一切含被忽略的，开工时已被忽略的不动", async () => {
  const { base, root, host } = fixture();
  try {
    const start = git(root, "rev-parse", "HEAD");
    assert.ok(host.markStepStart !== undefined && host.restoreStepStart !== undefined);
    const mark = await host.markStepStart();
    assert.equal(mark.commit, start);
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
    assert.equal(git(root, "status", "--porcelain"), "");
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
