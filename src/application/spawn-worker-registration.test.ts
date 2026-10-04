// 派 worker 的注册范围（决策 264–267）：会话运行面上终端界面给了工具槽才注册，命令行对话不给槽不注册。
// 装配根与 pigeon run 的注册范围见 orchestration-wiring.test.ts；派出立即返回与可并行见 spawn-worker-tool.test.ts。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { SPAWN_WORKER_TOOL, SpawnWorkerSlot } from "./spawn-worker-tool.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-reg-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

test("会话运行面：终端界面给槽即注册并交回槽；命令行对话不给槽不注册", async () => {
  const root = gitRoot();
  const flags = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const slot = new SpawnWorkerSlot();
  const tui = await openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn,
    flags,
    spawnWorker: slot,
    startMcp: () => noMcpSession(),
  });
  const line = await openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn,
    flags,
    startMcp: () => noMcpSession(),
  });
  try {
    assert.ok(tui.bundle.adapter.snapshot().tools.advertised.includes(SPAWN_WORKER_TOOL));
    assert.equal(tui.spawnWorker, slot);
    assert.ok(!line.bundle.adapter.snapshot().tools.advertised.includes(SPAWN_WORKER_TOOL));
    assert.equal(line.spawnWorker, undefined);
  } finally {
    await disposeRuntime(tui.bundle);
    await disposeRuntime(line.bundle);
  }
});
