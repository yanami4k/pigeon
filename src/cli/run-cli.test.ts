// pigeon run 子命令（M6.5 S1，决策 056）：headless API 的薄壳——真实子进程跑假 streamFn 模块，
// --json 退出时打印一行结构化结果，退出码按终态映射；任务描述可从 stdin 读。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";
import { HEADLESS_EXIT_CODES } from "../application/headless-core.ts";
import { isStatusText } from "../application/status-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const CLI_HOME = mkdtempSync(join(tmpdir(), "pigeon-cli-home-"));
afterAll(() => rmSync(CLI_HOME, { recursive: true, force: true }));
const FIXTURES = pathToFileURL(
  fileURLToPath(new URL("../pi-runtime/fixtures.ts", import.meta.url))
).href;
const ORIGINAL = "alpha\nbeta\ngamma\n";

function writeStreamFnModule(dir: string, behavior: unknown): string {
  const file = join(dir, "fake-stream-fn.mjs");
  writeFileSync(
    file,
    `import { createFakeStreamFn } from ${JSON.stringify(FIXTURES)};\n` +
      `export default createFakeStreamFn(${JSON.stringify(behavior)});\n`
  );
  return file;
}

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    timeout: 60_000,
    windowsHide: true,
    // 用户级目录指到临时目录（不读写真实的 ~/.pigeon）
    env: { ...process.env, HOME: CLI_HOME, USERPROFILE: CLI_HOME },
  });
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
}

const editReplies = {
  replies: [
    {
      text: "改",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "a.ts",
            snapshot: snapshotTag(ORIGINAL),
            edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
          },
        },
      ],
    },
    { text: "完成" },
  ],
};

test("pigeon run：--yolo --json 跑通假 streamFn 任务，退出码 0，末行 JSON 带结构化结果", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-cli-"));
  try {
    writeFileSync(join(root, "a.ts"), ORIGINAL);
    const streamFn = writeStreamFnModule(root, editReplies);
    const child = runCli([
      "run",
      "把 beta 改成 BETA",
      "--root",
      root,
      "--stream-fn",
      streamFn,
      "--yolo",
      "--json",
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      "--edit-mode",
      "hashline",
    ]);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const result = lastJsonLine(child.stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.failure, null);
    assert.equal(result.turns, 2);
    assert.equal(result.approvalsNeeded, 1);
    assert.equal(typeof result.sessionId, "string");
    assert.equal(typeof result.runId, "string");
    assert.equal(typeof (result.usage as { totalTokens?: unknown }).totalTokens, "number");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pigeon run：任务描述从 stdin 读；不带 --yolo 时写调用 fail-closed，工具结果上标记策略拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-cli-"));
  try {
    writeFileSync(join(root, "a.ts"), ORIGINAL);
    const streamFn = writeStreamFnModule(root, editReplies);
    const child = runCli(
      ["run", "--root", root, "--stream-fn", streamFn, "--json", "--edit-mode", "hashline"],
      "改 beta\n"
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const result = lastJsonLine(child.stdout);
    // 因无审批通道而拒绝的写调用计入需审批次数（需要人来批的一次）
    assert.equal(result.approvalsNeeded, 1);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), ORIGINAL);
    const session = loadSessionView(
      join(root, ".pigeon", "state", "sessions"),
      String(result.sessionId)
    );
    assert.ok(session !== undefined);
    const calls = session.runs.flatMap((run) => run.toolCalls);
    assert.deepEqual(
      calls.map((call) => [call.toolName, call.result?.isError]),
      [["edit_file", true]]
    );
    const denied = calls[0]?.result;
    assert.ok(denied !== undefined);
    assert.deepEqual(toolResultMark(denied.raw as unknown as StoreMessage)?.gate, {
      outcome: "rejected",
      approvedBy: "policy:deny",
    });
    // stdin 读到的任务进了 user 消息（决策 363：开工状态块另算）
    const users = session.messages.filter(
      (message) =>
        message.role === "user" &&
        !message.blocks.some((block) => block.type === "text" && isStatusText(block.text))
    );
    assert.equal(users.length, 1);
    assert.ok(JSON.stringify(users[0]?.blocks).includes("改 beta"), JSON.stringify(users[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pigeon run：模型请求失败时终态 failed，退出码按映射表", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-cli-"));
  try {
    const streamFn = writeStreamFnModule(root, {
      replies: [{ text: "不会到这" }],
      failOnCall: 1,
      failureMessage: "模拟 provider 故障",
    });
    const child = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    const result = lastJsonLine(child.stdout);
    assert.equal(result.status, "failed", child.stdout);
    assert.equal(child.status, HEADLESS_EXIT_CODES.failed);
    assert.notEqual(HEADLESS_EXIT_CODES.failed, 0);
    // 映射表各终态互不相同，completed 为 0
    assert.equal(HEADLESS_EXIT_CODES.completed, 0);
    const codes = Object.values(HEADLESS_EXIT_CODES);
    assert.equal(new Set(codes).size, codes.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("决策 326 ③：项目里有未确认的会执行命令的配置——pigeon run 开跑前退出、退出码非 0、逐条列出；加 --trust-config 只对本次放行", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-trust-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      JSON.stringify({ commands: { commands: { test: "npm test" } } })
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { fx: { command: "node", args: ["fx.js"] } } })
    );
    const streamFn = writeStreamFnModule(root, { replies: [{ text: "完成" }] });
    const refused = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /命令短名 test：npm test/);
    assert.match(refused.stderr, /MCP 服务 fx：node fx\.js/);
    assert.match(refused.stderr, /--trust-config/);
    assert.equal(existsSync(join(root, ".pigeon", "state", "sessions")), false, "没有开跑");
    // 放行只对本次：MCP 服务按配置启动（这里的 fx.js 不存在，启动失败只提示、不挡运行）
    const allowed = runCli([
      "run",
      "随便",
      "--root",
      root,
      "--stream-fn",
      streamFn,
      "--json",
      "--trust-config",
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    const again = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    assert.notEqual(again.status, 0, "放行不记指纹，下次仍要确认");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("决策 324：--no-hooks 只对本次运行停用全部钩子——Stop 钩子脚本不被执行", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-nohooks-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    // 钩子脚本：被跑起来就在项目根落一个标记文件（cwd 是工作区根，PIGEON_PROJECT_DIR 是治理根）
    writeFileSync(
      join(root, "hook.mjs"),
      'import { writeFileSync } from "node:fs";\n' +
        'import { join } from "node:path";\n' +
        'writeFileSync(join(process.env.PIGEON_PROJECT_DIR, "hook-ran.marker"), "stop\\n");\n'
    );
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }] },
      })
    );
    const streamFn = writeStreamFnModule(root, { replies: [{ text: "完成" }] });
    const marker = join(root, "hook-ran.marker");
    // 正控：不带 --no-hooks 时 Stop 钩子在收尾跑，标记文件落盘（证明钩子链路确实在跑，下面的断言才有意义）
    const ran = runCli([
      "run",
      "随便",
      "--root",
      root,
      "--stream-fn",
      streamFn,
      "--json",
      "--trust-config",
    ]);
    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.ok(existsSync(marker), "不带 --no-hooks 时 Stop 钩子应执行");
    rmSync(marker);
    // 带 --no-hooks：本次运行不接钩子，脚本一次都不跑
    const skipped = runCli([
      "run",
      "随便",
      "--root",
      root,
      "--stream-fn",
      streamFn,
      "--json",
      "--trust-config",
      "--no-hooks",
    ]);
    assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
    assert.equal(existsSync(marker), false, "--no-hooks 时钩子脚本不得执行");
    assert.equal(lastJsonLine(skipped.stdout).status, "completed", "停用钩子不影响正常跑完");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--governance-root：设置与程序状态锚到治理根——工作区自带的 .pigeon/ 设置与 .mcp.json 不生效，会话落在治理根、工作区没有 .pigeon/state；与 --sandbox 同用报错", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-gov-ws-"));
  const gov = mkdtempSync(join(tmpdir(), "pigeon-run-gov-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    // 工作区自带须确认的配置：治理根分开时不读它（读了就会开跑前退出，见决策 326 ③的用例）
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      JSON.stringify({ commands: { commands: { test: "npm test" } } })
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { fx: { command: "node", args: ["fx.js"] } } })
    );
    const streamFn = writeStreamFnModule(root, { replies: [{ text: "完成" }] });
    const child = runCli([
      "run",
      "随便",
      "--root",
      root,
      "--governance-root",
      gov,
      "--stream-fn",
      streamFn,
      "--json",
    ]);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const result = lastJsonLine(child.stdout);
    assert.equal(result.status, "completed");
    // 会话落在治理根；工作区里没有程序状态目录
    const session = loadSessionView(
      join(gov, ".pigeon", "state", "sessions"),
      String(result.sessionId)
    );
    assert.ok(session !== undefined, "会话文件在治理根下");
    assert.equal(existsSync(join(root, ".pigeon", "state")), false, "工作区没有 .pigeon/state");
    // 缺省不变：不给 --governance-root 时仍须确认工作区自带配置
    const refused = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    assert.notEqual(refused.status, 0, "不给 --governance-root 时工作区设置照常生效");
    // 与 --sandbox 同用报错
    const sandboxed = runCli([
      "run",
      "随便",
      "--root",
      root,
      "--governance-root",
      gov,
      "--stream-fn",
      streamFn,
      "--json",
      "--sandbox",
    ]);
    assert.notEqual(sandboxed.status, 0);
    assert.match(sandboxed.stderr, /--governance-root 不与 --sandbox 同用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gov, { recursive: true, force: true });
  }
});

test("决策 325：启动遇旧配置文件即报错并提示 pigeon migrate-config（不自动迁移）；迁移后照常开跑", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-legacy-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "orchestration.json"),
      JSON.stringify({ version: 1, maxConcurrent: 2 })
    );
    const streamFn = writeStreamFnModule(root, { replies: [{ text: "完成" }] });
    const refused = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /\.pigeon\/orchestration\.json/);
    assert.match(refused.stderr, /pigeon migrate-config/);
    assert.ok(existsSync(join(root, ".pigeon", "orchestration.json")), "不自动迁移");
    const migrated = runCli(["migrate-config", "--root", root]);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, /已迁移 \.pigeon\/orchestration\.json/);
    const ran = runCli(["run", "随便", "--root", root, "--stream-fn", streamFn, "--json"]);
    assert.equal(ran.status, 0, ran.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
