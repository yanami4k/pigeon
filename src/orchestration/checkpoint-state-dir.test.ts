// 快照不进 Pigeon 自己的程序状态（决策 350）：快照在后台拍时，会话存储在同一工作区的 .pigeon/state 下不断建删临时锁文件；
// add 带排除路径，git 不进 .pigeon/state 与 .pigeon/settings.local.json，扫不到一闪而过的文件，快照照样成功、也不含这两处。
// 这些路径已被 .gitignore 忽略（只忽略 state，或整个 .pigeon）时照样成功，仓库已跟踪的 .pigeon/settings.json 照常进快照。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { newSessionId } from "../state/ids.ts";
import { createCheckpointer, onlyIgnoredOwnedPaths } from "./checkpoint.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(gitignore?: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-state-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  if (gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), gitignore);
  }
  mkdirSync(join(dir, ".pigeon", "state", "sessions"), { recursive: true });
  writeFileSync(join(dir, ".pigeon", "settings.json"), "{}\n");
  writeFileSync(join(dir, "a.txt"), "v0\n");
  git(dir, ["add", "-f", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const stateFiles = (dir: string, commit: string) =>
  git(dir, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter((name) => name.startsWith(".pigeon/state") || name === ".pigeon/settings.local.json");

test("快照期间 .pigeon/state 下不断建删临时文件：每次快照都成功，快照里不含程序状态", async () => {
  const dir = repo();
  // 另起进程不停建删临时文件（模拟会话存储写锁文件）
  const churn = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs = require('node:fs');",
        "const base = process.argv[1];",
        "let n = 0;",
        "for (;;) { const f = base + '/s.jsonl.lock.' + (n++ % 8) + '.tmp';",
        "  try { fs.writeFileSync(f, 'x'); fs.unlinkSync(f); } catch {} }",
      ].join("\n"),
      join(dir, ".pigeon", "state", "sessions"),
    ],
    { stdio: "ignore" }
  );
  try {
    await delay(100);
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    for (let k = 1; k <= 30; k++) {
      writeFileSync(join(dir, "a.txt"), `v${k}\n`);
      writeFileSync(join(dir, ".pigeon", "settings.local.json"), `{"k":${k}}\n`);
      const snapshot = await checkpointer.afterChange();
      assert.ok(snapshot !== undefined, `第 ${k} 次改动拍到快照`);
      assert.equal(git(dir, ["show", `${snapshot.commit}:a.txt`]), `v${k}\n`);
      assert.deepEqual(stateFiles(dir, snapshot.commit), [], "快照里没有程序状态");
    }
    await checkpointer.close();
  } finally {
    churn.kill("SIGKILL");
    await new Promise((resolve) => churn.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".pigeon/state 下有读不到的目录：git 不进去，快照照样成功", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const dir = repo();
  const locked = join(dir, ".pigeon", "state", "sessions");
  writeFileSync(join(locked, "s.jsonl"), "{}\n");
  try {
    chmodSync(locked, 0o600);
    const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
    await checkpointer.beforeChange();
    writeFileSync(join(dir, "a.txt"), "v1\n");
    const snapshot = await checkpointer.afterChange();
    assert.ok(snapshot !== undefined);
    assert.equal(git(dir, ["show", `${snapshot.commit}:a.txt`]), "v1\n");
    await checkpointer.close();
  } finally {
    chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, gitignore] of [
  ["只忽略程序状态", ".pigeon/state/\n.pigeon/settings.local.json\n"],
  ["整个 .pigeon 被忽略", ".pigeon/\n"],
] as const) {
  test(`程序状态已被 .gitignore 忽略（${name}）：快照照样成功，已跟踪的 .pigeon/settings.json 照常进快照`, async () => {
    const dir = repo(gitignore);
    try {
      const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
      await checkpointer.beforeChange();
      writeFileSync(join(dir, ".pigeon", "state", "sessions", "s.jsonl"), "{}\n");
      writeFileSync(join(dir, ".pigeon", "settings.json"), '{"a":1}\n');
      writeFileSync(join(dir, "a.txt"), "v1\n");
      const snapshot = await checkpointer.afterChange();
      assert.ok(snapshot !== undefined);
      assert.equal(git(dir, ["show", `${snapshot.commit}:.pigeon/settings.json`]), '{"a":1}\n');
      assert.deepEqual(stateFiles(dir, snapshot.commit), []);
      await checkpointer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("路径被忽略的提示：只认列出的都是被排除的程序状态路径或其上级目录", () => {
  const notice = "The following paths are ignored by one of your .gitignore files:";
  assert.equal(
    onlyIgnoredOwnedPaths(`${notice}\n.pigeon/settings.local.json\n.pigeon/state\n`),
    true
  );
  assert.equal(onlyIgnoredOwnedPaths(`${notice}\n.pigeon\n`), true);
  assert.equal(onlyIgnoredOwnedPaths(`${notice}\n.pigeon/state\nsrc/build\n`), false);
  assert.equal(onlyIgnoredOwnedPaths(`${notice}\n`), false);
  assert.equal(
    onlyIgnoredOwnedPaths("fatal: unable to stat '.pigeon/state/x': No such file"),
    false
  );
});
