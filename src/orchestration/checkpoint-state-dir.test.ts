// 快照不进 Pigeon 自己的程序状态（决策 350）：快照在后台拍时，会话存储在同一工作区的 .pigeon/state 下不断建删临时锁文件。
// 快照的 add 带一个临时 core.excludesFile（用户原有的全局忽略文件加上本工作区前缀下的 .pigeon/state 与
// .pigeon/settings.local.json），这两处在任何仓库里都算被忽略，git 不进去；成败只看退出码。
// 工作区在仓库根或子目录、程序状态没被忽略 / 只忽略程序状态 / 整个 .pigeon 被忽略，快照都成功且不含程序状态，
// 仓库已跟踪的 .pigeon/settings.json 照常进快照；用户原有的全局忽略规则照常生效，读不到它时照样成功。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { createCheckpointer } from "./checkpoint.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// 仓库与其中的工作区（仓库根或子目录 sub）：工作区里有程序状态目录、已跟踪的 .pigeon/settings.json 与 a.txt
function repo(where: "root" | "sub", gitignore?: string): { dir: string; ws: string } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-state-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  const ws = where === "root" ? dir : join(dir, "sub");
  mkdirSync(join(ws, ".pigeon", "state", "sessions"), { recursive: true });
  if (gitignore !== undefined) {
    writeFileSync(join(ws, ".gitignore"), gitignore);
  }
  writeFileSync(join(ws, ".pigeon", "settings.json"), "{}\n");
  writeFileSync(join(ws, "a.txt"), "v0\n");
  git(dir, ["add", "-f", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return { dir, ws };
}

// 快照里的程序状态（路径相对仓库根）
const stateFiles = (dir: string, commit: string) =>
  git(dir, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter(
      (name) => name.includes(".pigeon/state") || name.endsWith(".pigeon/settings.local.json")
    );

const canLockDirs = process.platform !== "win32" && process.getuid?.() !== 0;

for (const where of ["root", "sub"] as const) {
  for (const [ignoreName, gitignore] of [
    ["程序状态没被忽略", undefined],
    ["只忽略程序状态", ".pigeon/state/\n.pigeon/settings.local.json\n"],
    ["整个 .pigeon 被忽略", ".pigeon/\n"],
  ] as const) {
    test(`工作区在${where === "root" ? "仓库根" : "子目录"}、${ignoreName}：快照成功，不含程序状态，已跟踪的 .pigeon/settings.json 照常进快照${canLockDirs ? "；程序状态里读不到的目录不碍事" : ""}`, async () => {
      const { dir, ws } = repo(where, gitignore);
      const locked = join(ws, ".pigeon", "state", "sessions");
      writeFileSync(join(locked, "s.jsonl"), "{}\n");
      try {
        if (canLockDirs) {
          // 列得出条目、读不到条目属性的目录：git 若进去就报 unable to stat 并整次失败
          chmodSync(locked, 0o600);
        }
        const checkpointer = createCheckpointer({ workspaceRoot: ws, sessionId: newSessionId() });
        await checkpointer.beforeChange();
        writeFileSync(join(ws, "a.txt"), "v1\n");
        writeFileSync(join(ws, ".pigeon", "settings.json"), '{"a":1}\n');
        writeFileSync(join(ws, ".pigeon", "settings.local.json"), "{}\n");
        const snapshot = await checkpointer.afterChange();
        assert.ok(snapshot !== undefined);
        const at = where === "root" ? "" : "sub/";
        assert.equal(git(dir, ["show", `${snapshot.commit}:${at}a.txt`]), "v1\n");
        assert.equal(
          git(dir, ["show", `${snapshot.commit}:${at}.pigeon/settings.json`]),
          '{"a":1}\n'
        );
        assert.deepEqual(stateFiles(dir, snapshot.commit), []);
        await checkpointer.close();
      } finally {
        chmodSync(locked, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test("快照期间 .pigeon/state 下不断建删临时文件：每次快照都成功，快照里不含程序状态", async () => {
  const { dir } = repo("root");
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

test("用户原有的全局忽略规则照常生效；配置的全局忽略文件读不到时快照照样成功、照样不含程序状态", async () => {
  for (const readable of [true, false]) {
    const { dir } = repo("root");
    const excludes = join(dir, "..", `${dir.split(/[\\/]/).at(-1)}-global-ignore`);
    try {
      if (readable) {
        writeFileSync(excludes, "*.log\n");
      }
      git(dir, ["config", "core.excludesFile", excludes]);
      const checkpointer = createCheckpointer({ workspaceRoot: dir, sessionId: newSessionId() });
      await checkpointer.beforeChange();
      writeFileSync(join(dir, "debug.log"), "noise\n");
      writeFileSync(join(dir, ".pigeon", "state", "sessions", "s.jsonl"), "{}\n");
      writeFileSync(join(dir, "a.txt"), "v1\n");
      const snapshot = await checkpointer.afterChange();
      assert.ok(snapshot !== undefined);
      const names = git(dir, ["ls-tree", "-r", "--name-only", snapshot.commit]).split("\n");
      assert.equal(
        names.includes("debug.log"),
        !readable,
        "全局忽略的文件只在读得到规则时不进快照"
      );
      assert.deepEqual(stateFiles(dir, snapshot.commit), []);
      await checkpointer.close();
    } finally {
      rmSync(excludes, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
