// pigeon migrate-config（决策 325）：7 个旧文件迁入设置各节（permissions 进项目个人，其余进项目共享）、去掉 version、
// web.json 的 key 不写进设置并给出环境变量名、旧文件挪出仓库到用户级本项目的备份目录（决策 341，迁移结束打印位置）；
// 旧位置的程序状态挪进 .pigeon/state/；worker 工作树经
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
import { migrationBackupLocation } from "../persistence/migration-backup.ts";
import { loadSettings } from "../persistence/settings.ts";
import {
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

// 用户主目录一律指到临时目录：迁移备份写在那里
function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-migrate-home-")));
  made.push(dir);
  return dir;
}

function migrate(root: string, homeDir: string = home()) {
  return runMigrateConfig(root, { homeDir });
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

test("7 个旧文件迁入设置各节：去掉 version；key 不进设置并给出环境变量名；旧文件挪进用户级备份目录并打印位置；重复执行无事可做", () => {
  const root = repo();
  const homeDir = home();
  legacyFiles(root);
  const originals = new Map(
    ["mcp", "grants", "commands", "orchestration", "web", "sandbox", "loop-guard"].map((name) => [
      name,
      readFileSync(join(root, ".pigeon", `${name}.json`), "utf8"),
    ])
  );
  const result = migrate(root, homeDir);
  const backupDir = migrationBackupLocation(root, homeDir);
  assert.equal(result.changed, true);
  const text = result.lines.join("\n");
  assert.match(text, /ZAI_API_KEY/);
  assert.ok(!text.includes("sk-secret-zai"), "不打印 key");
  assert.equal(
    result.lines.at(-1),
    `迁移挪走的旧文件原文备份在 ${backupDir}`,
    "迁移结束打印备份位置"
  );
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
    assert.equal(
      readFileSync(join(backupDir, `${name}.json`), "utf8"),
      originals.get(name),
      `${name} 的原文在备份目录里`
    );
  }
  assert.ok(!existsSync(join(root, ".pigeon", "state", "migration-backup")), "仓库里没有备份");
  // 迁移后的设置能照常读出各节
  const snapshot = loadSettings(root, { homeDir });
  assert.deepEqual(commandsConfigOf(snapshot).commands, { t: "npm test" });
  assert.equal(configGrantRulesOf(snapshot).length, 1);
  assert.deepEqual(webSectionOf(snapshot), {
    search: { backend: "zai", zai: { baseUrl: "https://z.example" } },
  });
  assert.deepEqual(findLegacyLayout(root), []);
  const again = migrate(root, homeDir);
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
    () => migrate(root),
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
  migrate(root);
  assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath(root), "utf8")), {
    commands: { commands: { t: "npm test" } },
    $schema: "x",
    loopGuard: { stopAt: 30 },
  });
});

test("旧位置的程序状态挪进 .pigeon/state/；worker 工作树经 git worktree move 挪位，git worktree list 指向新位置；旧学到的记忆挪进备份", () => {
  const root = repo();
  const homeDir = home();
  write(join(root, ".pigeon", "sessions", "enc", "s.jsonl"), "{}\n");
  write(join(root, ".pigeon", "learned", "MEMORY.md"), "- x\n");
  write(join(root, ".pigeon", "tui-history.json"), '{"version":1,"entries":[]}');
  const legacyTree = join(root, ".pigeon", "worktrees", "sess-w1");
  git(root, "worktree", "add", "-q", "-b", "pigeon/w1", legacyTree);
  migrate(root, homeDir);
  assert.ok(existsSync(join(sessionsDirOf(root), "enc", "s.jsonl")));
  // 旧学到的记忆不再挪进 state/：整个目录连同锁挪进用户级备份（决策 331、341）
  assert.ok(!existsSync(join(root, ".pigeon", "learned")), "旧 learned 目录已挪走");
  assert.equal(
    readFileSync(join(migrationBackupLocation(root, homeDir), "learned", "MEMORY.md"), "utf8"),
    "- x\n",
    "旧学到的记忆原文进备份"
  );
  assert.ok(existsSync(promptHistoryPathOf(root)));
  const moved = join(worktreesDirOf(root), "sess-w1");
  assert.ok(existsSync(join(moved, "a.txt")));
  assert.ok(!existsSync(join(root, ".pigeon", "worktrees")), "空的旧目录删掉");
  // git worktree list 输出的路径用正斜杠，Windows 下与 path.join 的反斜杠不一致，统一成正斜杠再比对
  const listed = git(root, "worktree", "list", "--porcelain").replaceAll("\\", "/");
  const movedSlash = moved.replaceAll("\\", "/");
  const legacySlash = legacyTree.replaceAll("\\", "/");
  assert.ok(listed.includes(`worktree ${movedSlash}`), listed);
  assert.ok(!listed.includes(`worktree ${legacySlash}`), listed);
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
  assert.throws(() => migrate(root), /锁正被占用/);
  assert.ok(existsSync(join(root, ".pigeon", "sessions")));
  rmSync(join(root, ".pigeon", "sessions"), { recursive: true });
  const legacyTree = join(root, ".pigeon", "worktrees", "sess-w2");
  git(root, "worktree", "add", "-q", "-b", "pigeon/w2", legacyTree);
  git(root, "worktree", "lock", legacyTree);
  assert.throws(() => migrate(root), /工作树被锁定/);
  assert.ok(existsSync(legacyTree));
});

test("迁移备份不在仓库里：git status 与快照提交里都没有备份文件与 key，备份目录里有原文；仍写 .pigeon/.gitignore", () => {
  const root = repo();
  const homeDir = home();
  const original = JSON.stringify({
    version: 1,
    search: { backend: "tavily", tavily: { apiKey: "tvly-secret" } },
  });
  write(join(root, ".pigeon", "web.json"), original);
  const result = migrate(root, homeDir);
  const backupDir = migrationBackupLocation(root, homeDir);
  assert.equal(readFileSync(join(backupDir, "web.json"), "utf8"), original);
  assert.ok(result.lines.join("\n").includes(`备份在 ${backupDir}`), "打印备份位置");
  assert.equal(
    readFileSync(join(root, ".pigeon", ".gitignore"), "utf8"),
    "state/\nsettings.local.json\n"
  );
  const status = git(root, "status", "--porcelain", "--untracked-files=all", "--ignored");
  assert.ok(!/backup|\.bak|web\.json/.test(status), status);
  assert.match(status, /\.pigeon\/settings\.json/);
  const snap = snapshotWorkdir({ repoRoot: root, ref: "refs/pigeon/worker-start/t" });
  const tree = git(root, "ls-tree", "-r", "--name-only", snap.commit);
  assert.ok(!/backup|\.bak|web\.json/.test(tree), tree);
  // git grep 找不到时退出码为 1
  assert.throws(() => git(root, "grep", "-I", "-l", "tvly-secret", snap.commit), "快照里没有 key");
  // 仓库里任何地方都没有原文
  assert.throws(() => execFileSync("grep", ["-rl", "tvly-secret", root]), "仓库目录里没有 key");
});

test("verify.json（决策 322）：不并入设置——挪进备份目录，打印改写为收尾（Stop）钩子的示例；旧布局检查列为已退役", () => {
  const root = repo();
  const homeDir = home();
  // 启动检查把 verify.json 列为已删除功能的遗留
  write(join(root, ".pigeon", "verify.json"), {
    version: 1,
    command: "npm test",
    timeoutMs: 300000,
  });
  const legacy = findLegacyLayout(root);
  assert.deepEqual(
    legacy.map((item) => [item.name, item.kind]),
    [["verify.json", "removed"]]
  );
  const result = migrate(root, homeDir);
  assert.equal(result.changed, true);
  assert.ok(!existsSync(join(root, ".pigeon", "verify.json")), "原文件已挪走");
  const backupDir = migrationBackupLocation(root, homeDir);
  assert.ok(existsSync(join(backupDir, "verify.json")), "原文进了备份目录");
  const text = result.lines.join("\n");
  assert.ok(text.includes('"Stop"'), "打印 Stop 钩子示例");
  assert.ok(text.includes('"command": "npm test"'), `示例用原命令填好：${text}`);
  // 不写入任何设置节
  assert.ok(!existsSync(projectSettingsPath(root)), "不生成 settings.json");
  // 重复执行无事可做
  assert.equal(migrate(root, homeDir).changed, false);
  assert.deepEqual(findLegacyLayout(root), []);
});

test("verify.json 分步配置：按各步命令以 && 连接，带执行目录的步包一层 cd", () => {
  const root = repo();
  const homeDir = home();
  write(join(root, ".pigeon", "verify.json"), {
    version: 1,
    steps: [
      { name: "类型", command: "tsc --noEmit" },
      { name: "测试", command: "pytest tests", cwd: "pkg" },
    ],
  });
  const result = migrate(root, homeDir);
  const text = result.lines.join("\n");
  assert.ok(
    text.includes('"command": "tsc --noEmit && ( cd pkg && pytest tests )"'),
    `分步按 && 连接：${text}`
  );
});

test("verify.json 既没有 command 也没有 steps：报错且不挪走", () => {
  const root = repo();
  write(join(root, ".pigeon", "verify.json"), { version: 1 });
  assert.throws(() => migrate(root), MigrationError);
  assert.ok(existsSync(join(root, ".pigeon", "verify.json")), "原文件保留");
});
test("已删除功能的遗留挪出仓库到用户级备份（决策 331、341）：旧学到的记忆两处与锁、补做复盘记录两处、复盘配置、旧人写说明；重复执行无事可做", () => {
  const root = repo();
  const homeDir = home();
  write(join(root, ".pigeon", "state", "learned", "MEMORY.md"), "- 旧的\n");
  write(join(root, ".pigeon", "state", "learned.lock"), "{}");
  write(join(root, ".pigeon", "learned.lock"), "{}");
  write(join(root, ".pigeon", "review-backfill", "r.json"), "{}");
  write(join(root, ".pigeon", "state", "review-backfill", "r2.json"), "{}");
  write(join(root, ".pigeon", "memory-review.json"), { version: 1 });
  write(join(root, ".pigeon", "memory", "notes.md"), "人写的旧说明\n");
  const result = migrate(root, homeDir);
  const backup = migrationBackupLocation(root, homeDir);
  assert.equal(result.changed, true);
  assert.match(result.lines.join("\n"), /把其中内容并入项目的 AGENTS\.md/);
  for (const rel of [
    join("state", "learned"),
    join("state", "learned.lock"),
    "learned.lock",
    "review-backfill",
    join("state", "review-backfill"),
    "memory-review.json",
    "memory",
  ]) {
    assert.ok(!existsSync(join(root, ".pigeon", rel)), `${rel} 已挪出仓库`);
  }
  for (const name of [
    join("state", "learned"),
    join("state", "learned.lock"),
    "learned.lock",
    "review-backfill",
    join("state", "review-backfill"),
    "memory-review.json",
    "memory",
  ]) {
    assert.ok(existsSync(join(backup, name)), `备份里有 ${name}`);
  }
  assert.equal(readFileSync(join(backup, "memory", "notes.md"), "utf8"), "人写的旧说明\n");
  assert.equal(readFileSync(join(backup, "state", "learned", "MEMORY.md"), "utf8"), "- 旧的\n");
  const again = migrate(root, homeDir);
  assert.equal(again.changed, false);
});

test("~/.pigeon/preferences.md 改名为 ~/.pigeon/AGENTS.md；目标已存在即拦阻、什么都不改", () => {
  const root = repo();
  const homeDir = home();
  write(join(homeDir, ".pigeon", "preferences.md"), "用户级旧说明\n");
  const result = migrate(root, homeDir);
  assert.ok(!existsSync(join(homeDir, ".pigeon", "preferences.md")));
  assert.equal(readFileSync(join(homeDir, ".pigeon", "AGENTS.md"), "utf8"), "用户级旧说明\n");
  assert.match(result.lines.join("\n"), /AGENTS\.md/);
  // 目标已存在：拦阻，一切原样
  const home2 = home();
  write(join(home2, ".pigeon", "preferences.md"), "旧\n");
  write(join(home2, ".pigeon", "AGENTS.md"), "已有\n");
  assert.throws(() => migrate(root, home2), /AGENTS\.md 已存在/);
  assert.equal(readFileSync(join(home2, ".pigeon", "preferences.md"), "utf8"), "旧\n");
  assert.equal(readFileSync(join(home2, ".pigeon", "AGENTS.md"), "utf8"), "已有\n");
});

test("迁移备份位置已被占用：拦阻、不覆盖，仓库里的旧文件原样", () => {
  const root = repo();
  const homeDir = home();
  write(join(root, ".pigeon", "memory-review.json"), { version: 1 });
  write(join(migrationBackupLocation(root, homeDir), "memory-review.json"), "已占用");
  assert.throws(() => migrate(root, homeDir), /已存在/);
  assert.ok(existsSync(join(root, ".pigeon", "memory-review.json")), "旧文件原样");
  assert.equal(
    readFileSync(join(migrationBackupLocation(root, homeDir), "memory-review.json"), "utf8"),
    "已占用",
    "已有备份不被覆盖"
  );
});
