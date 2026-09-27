// pigeon run 子命令（M6.5 S1，决策 056）：headless API 的薄壳——真实子进程跑假 streamFn 模块，
// --json 退出时打印一行结构化结果，退出码按终态映射；任务描述可从 stdin 读。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HEADLESS_EXIT_CODES } from "../application/headless.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
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
    const session = loadSessionView(join(root, ".pigeon", "sessions"), String(result.sessionId));
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
    // stdin 读到的任务进了 user 消息
    const users = session.messages.filter((message) => message.role === "user");
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
