// pigeon migrate-config（决策 325）：7 个旧文件迁入设置各节（permissions 进项目个人，其余进项目共享）、去掉 version、
// web.json 的 key 不写进设置并给出环境变量名、旧文件挪进 .pigeon/state/migration-backup/（不进快照、不被提交）；旧位置的程序状态挪进 .pigeon/state/；worker 工作树经
// git worktree move 挪位后 git worktree list 指向新位置；重复执行无事可做；同一节内容冲突时报错且什么都不改；
// 锁被存活进程占用时拒绝。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { snapshotWorkdir } from "../execution/workdir-snapshot.ts";
import { findLegacyLayout } from "../persistence/legacy-layout.ts";
import { loadSettings } from "../persistence/settings.ts";
import {
  learnedDirOf,
  projectLocalSettingsPath,
  projectSettingsPath,
  promptHistoryPathOf,
  sessionsDirOf,
  worktreesDirOf,
} from "../state/paths.ts";
import { commandsConfigOf, configGrantRulesOf, webSectionOf } from "../state/settings.ts";
import { MigrationError, runMigrateConfig } from "./migrate-config.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-migrate-")));
  made.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const RULE = {
  tool: "edit_file",
  promotedFrom: {
    grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
    sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
    firstCall: { toolCallId: "t1", args: {} },
    promotedAt: 1,
  },
};

function legacyFiles(root: string): void {
  const pigeon = join(root, ".pigeon");
  write(join(pigeon, "mcp.json"), {
    version: 1,
    servers: { fx: { launch: { command: "node" }, defaultTier: "read" } },
  });
  write(join(pigeon, "grants.json"), { version: 1, grants: [RULE] });
  write(join(pigeon, "commands.json"), { version: 1, commands: { t: "npm test" } });
  write(join(pigeon, "orchestration.json"), { version: 1, maxConcurrent: 3 });
  write(join(pigeon, "web.json"), {
    version: 1,
    search: { backend: "zai", zai: { apiKey: "sk-secret-zai", baseUrl: "https://z.example" } },
  });
  write(join(pigeon, "sandbox.json"), { image: "python:3.12" });
  write(join(pigeon, "loop-guard.json"), { version: 1, stopAt: 30 });
}

test("7 个旧文件迁入设置各节：去掉 version；key 不进设置并给出环境变量名；旧文件挪进备份目录；重复执行无事可做", () => {
  const root = repo();
  legacyFiles(root);
  const result = runMigrateConfig(root);
  assert.equal(result.changed, true);
  const text = result.lines.join("\n");
  assert.match(text, /ZAI_API_KEY/);
  assert.ok(!text.includes("sk-secret-zai"), "不打印 key");
  const shared = readFileSync(projectSettingsPath(root), "utf8");
  const local = readFileSync(projectLocalSettingsPath(root), "utf8");
  assert.ok(!shared.includes("sk-secret-zai") && !local.includes("sk-secret-zai"), "key 不进设置");
  assert.deepEqual(Object.keys(JSON.parse(shared)).sort(), [
    "commands",
    "loopGuard",
    "mcp",
    "orchestration",
    "sandbox",
    "web",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(local)), ["permissions"]);
  for (const name of [
    "mcp",
    "grants",
    "commands",
    "orchestration",
    "web",
    "sandbox",
    "loop-guard",
  ]) {
    assert.ok(!existsSync(join(root, ".pigeon", `${name}.json`)), name);
    assert.ok(
      existsSync(join(root, ".pigeon", "state", "migration-backup", `${name}.json.bak`)),
      `${name}.bak`
    );
  }
  // 迁移后的设置能照常读出各节
  const home = mkdtempSync(join(tmpdir(), "pigeon-migrate-home-"));
  made.push(home);
  const snapshot = loadSettings(root, { homeDir: home });
  assert.deepEqual(commandsConfigOf(snapshot).commands, { t: "npm test" });
  assert.equal(configGrantRulesOf(snapshot).length, 1);
  assert.deepEqual(webSectionOf(snapshot), {
    search: { backend: "zai", zai: { baseUrl: "https://z.example" } },
  });
  assert.deepEqual(findLegacyLayout(root), []);
  const again = runMigrateConfig(root);
  assert.equal(again.changed, false);
  assert.match(again.lines.join("\n"), /没有要迁移的内容/);
});

test("目标设置已有同一节且内容不同：报错停下，什么都不改；内容相同则照常合并", () => {
  const root = repo();
  write(join(root, ".pigeon", "commands.json"), { version: 1, commands: { t: "npm test" } });
  write(join(root, ".pigeon", "loop-guard.json"), { version: 1, stopAt: 30 });
  write(projectSettingsPath(root), { commands: { commands: { t: "other" } } });
  mkdirSync(join(root, ".pigeon", "sessions"), { recursive: true });
  assert.throws(
    () => runMigrateConfig(root),
    (error: unknown) => {
      return error instanceof MigrationError && /commands 一节.*不同/.test(error.message);
    }
  );
  assert.ok(existsSync(join(root, ".pigeon", "commands.json")), "旧文件原样");
  assert.ok(existsSync(join(root, ".pigeon", "loop-guard.json")), "别的旧文件也原样");
  assert.ok(existsSync(join(root, ".pigeon", "sessions")), "状态原样");
  assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath(root), "utf8")), {
    commands: { commands: { t: "other" } },
  });
  // 内容相同：合并进去
  write(projectSettingsPath(root), { commands: { commands: { t: "npm test" } }, $schema: "x" });
  runMigrateConfig(root);
  assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath(root), "utf8")), {
    commands: { commands: { t: "npm test" } },
    $schema: "x",
    loopGuard: { stopAt: 30 },
  });
});

test("旧位置的程序状态挪进 .pigeon/state/；worker 工作树经 git worktree move 挪位，git worktree list 指向新位置", () => {
  const root = repo();
  write(join(root, ".pigeon", "sessions", "enc", "s.jsonl"), "{}\n");
  write(join(root, ".pigeon", "learned", "MEMORY.md"), "- x\n");
  write(join(root, ".pigeon", "tui-history.json"), '{"version":1,"entries":[]}');
  const legacyTree = join(root, ".pigeon", "worktrees", "sess-w1");
  git(root, "worktree", "add", "-q", "-b", "pigeon/w1", legacyTree);
  runMigrateConfig(root);
  assert.ok(existsSync(join(sessionsDirOf(root), "enc", "s.jsonl")));
  assert.ok(existsSync(join(learnedDirOf(root), "MEMORY.md")));
  assert.ok(existsSync(promptHistoryPathOf(root)));
  const moved = join(worktreesDirOf(root), "sess-w1");
  assert.ok(existsSync(join(moved, "a.txt")));
  assert.ok(!existsSync(join(root, ".pigeon", "worktrees")), "空的旧目录删掉");
  const listed = git(root, "worktree", "list", "--porcelain");
  assert.ok(listed.includes(`worktree ${moved}`), listed);
  assert.ok(!listed.includes(`worktree ${legacyTree}`), listed);
  assert.equal(git(moved, "rev-parse", "--abbrev-ref", "HEAD"), "pigeon/w1");
  assert.equal(
    readFileSync(join(root, ".pigeon", ".gitignore"), "utf8"),
    "state/\nsettings.local.json\n"
  );
  assert.deepEqual(findLegacyLayout(root), []);
});

test("锁被存活进程占用（有会话或 worker 正在运行）或工作树被锁定：拒绝并说明，什么都不改", () => {
  const root = repo();
  write(
    join(root, ".pigeon", "sessions", "enc", "s.jsonl.lock"),
    JSON.stringify({ pid: process.pid })
  );
  assert.throws(() => runMigrateConfig(root), /锁正被占用/);
  assert.ok(existsSync(join(root, ".pigeon", "sessions")));
  rmSync(join(root, ".pigeon", "sessions"), { recursive: true });
  const legacyTree = join(root, ".pigeon", "worktrees", "sess-w2");
  git(root, "worktree", "add", "-q", "-b", "pigeon/w2", legacyTree);
  git(root, "worktree", "lock", legacyTree);
  assert.throws(() => runMigrateConfig(root), /工作树被锁定/);
  assert.ok(existsSync(legacyTree));
});

test("迁移备份不进快照、不被提交：只迁项目共享层的 web.json 时也写 .pigeon/.gitignore，备份与 key 不出现在快照提交与 git status 里", () => {
  const root = repo();
  write(join(root, ".pigeon", "web.json"), {
    version: 1,
    search: { backend: "tavily", tavily: { apiKey: "tvly-secret" } },
  });
  runMigrateConfig(root);
  assert.equal(
    readFileSync(join(root, ".pigeon", ".gitignore"), "utf8"),
    "state/\nsettings.local.json\n"
  );
  const status = git(root, "status", "--porcelain", "--untracked-files=all");
  assert.ok(!status.includes("migration-backup") && !status.includes("web.json"), status);
  assert.match(status, /\.pigeon\/settings\.json/);
  const snap = snapshotWorkdir({ repoRoot: root, ref: "refs/pigeon/worker-start/t" });
  const tree = git(root, "ls-tree", "-r", "--name-only", snap.commit);
  assert.ok(!tree.includes("migration-backup") && !tree.includes("web.json"), tree);
  // git grep 找不到时退出码为 1
  assert.throws(() => git(root, "grep", "-I", "-l", "tvly-secret", snap.commit), "快照里没有 key");
});
