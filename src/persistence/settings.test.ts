// 三层设置的读取与快照（决策 325）：三个文件按层读取合并、出错指出文件与层、读出的快照是会话开始那一刻的样子
// （之后改文件不影响已读的快照）、项目根 .mcp.json 一并冻结；程序状态目录与 .pigeon/.gitignore 的建立；旧布局检查。
// 用户级一律指到临时目录，不碰真实的家目录。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  projectLocalSettingsPath,
  projectPigeonGitignorePath,
  projectSettingsPath,
  projectStateDir,
  userSettingsPath,
} from "../state/paths.ts";
import { commandsConfigOf, mcpConfigOf } from "../state/settings.ts";
import {
  assertNoLegacyLayout,
  findLegacyLayout,
  LegacyLayoutError,
  legacyLayoutMessage,
} from "./legacy-layout.ts";
import { ensureProjectStateDir, loadSettings, SettingsError } from "./settings.ts";

function dirs(): { root: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-settings-root-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-settings-home-"));
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("三层读取：缺失的层为空；有的层按优先级合并", () => {
  const { root, home, cleanup } = dirs();
  try {
    assert.deepEqual(commandsConfigOf(loadSettings(root, { homeDir: home })), {
      commands: {},
      roles: {},
    });
    write(userSettingsPath(home), { commands: { commands: { a: "echo user", b: "echo b" } } });
    write(projectSettingsPath(root), { commands: { commands: { a: "echo project" } } });
    write(projectLocalSettingsPath(root), { commands: { commands: { a: "echo local" } } });
    const snapshot = loadSettings(root, { homeDir: home });
    assert.deepEqual(commandsConfigOf(snapshot).commands, { a: "echo local", b: "echo b" });
    assert.deepEqual(
      snapshot.sources.map((source) => [source.layer, source.exists]),
      [
        ["user", true],
        ["project", true],
        ["local", true],
      ]
    );
  } finally {
    cleanup();
  }
});

test("出错响亮失败并指出文件与层：不是合法 JSON、未知键、合并后不成立", () => {
  const { root, home, cleanup } = dirs();
  try {
    write(projectSettingsPath(root), "{ nope");
    assert.throws(
      () => loadSettings(root, { homeDir: home }),
      (error: unknown) =>
        error instanceof SettingsError &&
        /\.pigeon\/settings\.json（项目共享）不是合法 JSON/.test(error.message)
    );
    write(projectSettingsPath(root), {});
    write(userSettingsPath(home), { grants: [] });
    assert.throws(
      () => loadSettings(root, { homeDir: home }),
      /~\/\.pigeon\/settings\.json（用户级）：未知键 grants/
    );
    write(userSettingsPath(home), {});
    write(projectLocalSettingsPath(root), { commands: { roles: { tester: ["nope"] } } });
    assert.throws(() => loadSettings(root, { homeDir: home }), /引用了未登记的短名：nope/);
  } finally {
    cleanup();
  }
});

test("快照冻结：读出之后改设置文件与 .mcp.json，已读的快照不变；下一次读取才看到新内容", () => {
  const { root, home, cleanup } = dirs();
  try {
    write(projectSettingsPath(root), { commands: { commands: { t: "npm test" } } });
    write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "node", args: ["a.js"] } } });
    const snapshot = loadSettings(root, { homeDir: home });
    write(projectSettingsPath(root), { commands: { commands: { t: "rm -rf /" } } });
    write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "evil" } } });
    assert.deepEqual(commandsConfigOf(snapshot).commands, { t: "npm test" });
    assert.deepEqual(
      mcpConfigOf(snapshot).servers.map((server) => server.launch),
      [{ command: "node", args: ["a.js"] }]
    );
    assert.deepEqual(commandsConfigOf(loadSettings(root, { homeDir: home })).commands, {
      t: "rm -rf /",
    });
  } finally {
    cleanup();
  }
});

test(".pigeon/.gitignore：第一次建状态目录时写入两行；已存在不改，缺行时提示一行", () => {
  const { root, home, cleanup } = dirs();
  try {
    void home;
    const notices: string[] = [];
    ensureProjectStateDir(root, (line) => notices.push(line));
    assert.equal(
      readFileSync(projectPigeonGitignorePath(root), "utf8"),
      "state/\nsettings.local.json\n"
    );
    assert.equal(notices.length, 0);
    // 已存在、缺一行：不改文件，提示一行
    rmSync(projectStateDir(root), { recursive: true });
    writeFileSync(projectPigeonGitignorePath(root), "state/\n");
    const later: string[] = [];
    ensureProjectStateDir(root, (line) => later.push(line));
    assert.equal(readFileSync(projectPigeonGitignorePath(root), "utf8"), "state/\n");
    assert.equal(later.length, 1);
    assert.match(later[0] ?? "", /缺 settings\.local\.json/);
  } finally {
    cleanup();
  }
});

test("旧布局：旧配置文件、旧位置的状态与已删除功能的遗留任一在场即报错并提示 pigeon migrate-config", () => {
  const { root, home, cleanup } = dirs();
  try {
    write(join(root, ".pigeon", "skills", "x", "SKILL.md"), "---\n");
    assert.deepEqual(findLegacyLayout(root, { homeDir: home }), []);
    assertNoLegacyLayout(root, { homeDir: home });
    write(join(root, ".pigeon", "grants.json"), {});
    mkdirSync(join(root, ".pigeon", "sessions"), { recursive: true });
    assert.deepEqual(
      findLegacyLayout(root, { homeDir: home }).map((item) => item.name),
      ["grants.json", "sessions"]
    );
    assert.throws(
      () => assertNoLegacyLayout(root, { homeDir: home }),
      (error: unknown) =>
        error instanceof LegacyLayoutError &&
        /\.pigeon\/grants\.json/.test(error.message) &&
        /\.pigeon\/sessions/.test(error.message) &&
        /pigeon migrate-config/.test(error.message)
    );
    // 已删除功能的遗留（决策 331、330）：复盘配置、补做复盘记录、旧学到的记忆（新旧两处）、旧人写说明、用户级偏好
    for (const rel of [
      "review-backfill",
      join("state", "review-backfill"),
      "learned",
      join("state", "learned"),
      "memory",
    ]) {
      mkdirSync(join(root, ".pigeon", rel), { recursive: true });
    }
    // 决策 322：verify.json 随验证门退役，算已删除功能的遗留
    for (const rel of [
      "verify.json",
      "memory-review.json",
      "learned.lock",
      join("state", "learned.lock"),
    ]) {
      write(join(root, ".pigeon", rel), "{}");
    }
    write(join(home, ".pigeon", "preferences.md"), "旧偏好\n");
    const names = findLegacyLayout(root, { homeDir: home }).map((item) => item.name);
    for (const name of [
      "verify.json",
      "memory-review.json",
      "review-backfill",
      join("state", "review-backfill"),
      "learned",
      "learned.lock",
      join("state", "learned"),
      join("state", "learned.lock"),
      "memory",
      "~/.pigeon/preferences.md",
    ]) {
      assert.ok(names.includes(name), `${name} 应列为旧文件，实际：${names.join("、")}`);
    }
    // 不传 homeDir 时不查用户级
    assert.ok(!findLegacyLayout(root).some((item) => item.name === "~/.pigeon/preferences.md"));
    const message = legacyLayoutMessage(findLegacyLayout(root, { homeDir: home }));
    assert.match(message, /memory-review\.json/);
    assert.match(message, /verify\.json/);
    assert.match(message, /preferences\.md/);
    assert.match(message, /pigeon migrate-config/);
  } finally {
    cleanup();
  }
});
