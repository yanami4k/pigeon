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
import { assertNoLegacyLayout, findLegacyLayout, LegacyLayoutError } from "./legacy-layout.ts";
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

test("旧布局：7 个旧配置文件与旧位置的状态任一在场即报错并提示 pigeon migrate-config；memory-review.json 不算，verify.json 按已退役列入", () => {
  const { root, cleanup } = dirs();
  try {
    write(join(root, ".pigeon", "memory-review.json"), {});
    write(join(root, ".pigeon", "skills", "x", "SKILL.md"), "---\n");
    assert.deepEqual(findLegacyLayout(root), []);
    assertNoLegacyLayout(root);
    write(join(root, ".pigeon", "verify.json"), {});
    assert.deepEqual(
      findLegacyLayout(root).map((item) => [item.name, item.retired === true]),
      [["verify.json", true]]
    );
    assert.throws(() => assertNoLegacyLayout(root), /verify\.json/);
    rmSync(join(root, ".pigeon", "verify.json"));
    write(join(root, ".pigeon", "grants.json"), {});
    mkdirSync(join(root, ".pigeon", "sessions"), { recursive: true });
    assert.deepEqual(
      findLegacyLayout(root).map((item) => item.name),
      ["grants.json", "sessions"]
    );
    assert.throws(
      () => assertNoLegacyLayout(root),
      (error: unknown) =>
        error instanceof LegacyLayoutError &&
        /\.pigeon\/grants\.json/.test(error.message) &&
        /\.pigeon\/sessions/.test(error.message) &&
        /pigeon migrate-config/.test(error.message)
    );
  } finally {
    cleanup();
  }
});
