// 会话级验证命令（M7 S3，决策 071）：--verify-command / --verify-timeout 按会话冻结，写进注入快照与 Run 开始条目；
// 尝试收尾后由程序作为独立子进程在该尝试的工作区执行，模型看不到，结果落通用验证记录；未配置时不跑、标签为未知。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreSessionView, storeAttemptLabel } from "../state/session-judge.ts";
import { runHeadless } from "./headless.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, parseLaunchFlags, verifyConfigOf } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const NODE = `"${process.execPath}"`;

// 读新会话存储里的会话视图（会话必须存在）
function storeView(root: string, sessionId: string): StoreSessionView {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, `会话存储里应有会话 ${sessionId}`);
  return loaded.view;
}

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

test("启动参数：--verify-command 与 --verify-timeout 解析；缺省超时为常量；未允许的入口按未知参数处理", () => {
  const flags = parseLaunchFlags(["--verify-command", "npm test", "--verify-timeout", "5000"], {
    usage: "u",
    verify: true,
  });
  assert.deepEqual(verifyConfigOf(flags), {
    command: "npm test",
    timeoutMs: 5000,
    source: "flag",
  });
  const defaults = parseLaunchFlags(["--verify-command", "npm test"], { usage: "u", verify: true });
  assert.deepEqual(verifyConfigOf(defaults), {
    command: "npm test",
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    source: "flag",
  });
  assert.equal(verifyConfigOf(parseLaunchFlags([], { usage: "u", verify: true })), undefined);
  assert.throws(() => parseLaunchFlags(["--verify-timeout", "0"], { usage: "u", verify: true }));
  assert.throws(() => parseLaunchFlags(["--verify-command"], { usage: "u", verify: true }));
  assert.throws(() => parseLaunchFlags(["--verify-command", "x"], { usage: "u" }), /未知参数/);
});

test("主会话：配置冻结进注入快照与 Run 开始条目；Run 结束后在工作区独立执行，结果落通用验证记录，标签由此现算", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-attempt-verify-"));
  try {
    writeFileSync(join(root, "v.mjs"), "process.exit(1);\n");
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies: [{ text: "改好了" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      verify: { command: `${NODE} v.mjs`, timeoutMs: 30_000 },
    });
    try {
      assert.deepEqual(opened.bundle.adapter.snapshot().verify, {
        command: `${NODE} v.mjs`,
        timeoutMs: 30_000,
      });
      const run = await opened.bundle.adapter.run("修一下");
      assert.equal(run.status, "completed");
      await opened.verification?.idle();
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const view = storeView(root, sessionId);
    assert.deepEqual(view.runs[0]?.start.verify, {
      command: `${NODE} v.mjs`,
      timeoutMs: 30_000,
    });
    assert.equal(view.verifications.length, 1, "Run 结束后落一条通用验证记录");
    const verified = view.verifications[0]?.data;
    assert.ok(verified !== undefined);
    assert.equal(verified.verdict, "fail");
    assert.equal(verified.exitCode, 1);
    assert.equal(verified.workspace, root);
    assert.equal(verified.target.sessionId, sessionId);
    const runId = view.runs[0]?.runId;
    assert.ok(runId !== undefined);
    assert.equal(verified.target.runId, runId);
    assert.equal(storeAttemptLabel(view, runId), "Failed");
    assert.equal(view.runs.length, 1);
    assert.equal(view.runs[0]?.messages.length, 2, "验证结果不进模型可见的消息");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("主会话：未配置验证命令时不跑、不落记录，正常完成的尝试标签为未知", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-attempt-noverify-"));
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
    });
    try {
      await opened.bundle.adapter.run("修一下");
      assert.equal(opened.verification, undefined);
      assert.equal(opened.bundle.adapter.snapshot().verify, undefined);
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const view = storeView(root, sessionId);
    assert.equal(view.verifications.length, 0);
    const runId = view.runs[0]?.runId;
    assert.ok(runId !== undefined);
    assert.equal(storeAttemptLabel(view, runId), "Unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless：配置验证命令时收尾后在工作区独立执行并落本会话，结果带验证结论与标签", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-headless-verify-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-headless-verify-home-"));
  try {
    writeFileSync(join(root, "v.mjs"), "process.exit(0);\n");
    const result = await runHeadless({
      task: "做点事",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "做完了" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: { command: `${NODE} v.mjs`, timeoutMs: 30_000 },
    });
    assert.equal(result.verification?.verdict, "pass");
    assert.equal(result.label, "Passed");
    const view = storeView(root, result.sessionId);
    assert.equal(view.verifications.length, 1);
    assert.equal(view.verifications[0]?.data.verdict, "pass");
    assert.equal(view.runs[0]?.start.verify?.timeoutMs, 30_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
