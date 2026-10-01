// worker 继承父运行面的上下文压缩配置（决策 188、218）：压缩对所有 Run 生效，worker 按主会话同一配置跑，
// worker 会话的 Run 开始条目记下同一份；主会话没给配置时即产品缺省。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { createSessionWorkers } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function workerCompaction(parentConfig: CompactionConfigInput | undefined) {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-worker-compaction-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-worker-compaction-home-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.ts"), "alpha\n");
    git(repo, ["add", "a.ts"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const streamFn = createFakeStreamFn({ replies: [{ text: "看过了" }] });
    const parent = buildRuntime({
      streamFn,
      workspaceRoot: repo,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: home,
      ...(parentConfig !== undefined ? { compaction: parentConfig } : {}),
    });
    try {
      const orchestrator = createSessionWorkers({
        governanceRoot: repo,
        bundle: parent,
        approvals: async () => ({ approved: true }),
        streamFn,
        provider: "fake-provider",
        modelId: "fake-model-1",
        homeDir: home,
      });
      const workerId = orchestrator.spawn({ role: "explorer", task: "看一眼 a.ts", name: "look" });
      const outcome = await orchestrator.awaitResult(workerId);
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      const located = locateSessionFile(join(repo, ".pigeon", "state", "sessions"), workerId);
      assert.ok(located !== undefined);
      const loaded = loadStoreSessionFile(located.path);
      assert.ok(loaded !== undefined);
      const start = (
        loaded.main as unknown as Array<{ type: string; customType?: string; data?: unknown }>
      ).find((entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart);
      return (start?.data as RunStartData | undefined)?.compaction;
    } finally {
      await disposeRuntime(parent);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("worker 继承父运行面的压缩配置：worker 会话的 Run 开始条目记下与主会话同一份配置", async () => {
  assert.deepEqual(await workerCompaction({ thresholdTokens: 30_000, keepRecentTokens: 4000 }), {
    contextWindow: 1_000_000,
    reserveTokens: 16_384,
    keepRecentTokens: 4000,
    thresholdTokens: 30_000,
  });
});

test("主会话没给压缩配置：worker 即产品缺省", async () => {
  assert.deepEqual(await workerCompaction(undefined), {
    contextWindow: 1_000_000,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    thresholdTokens: 983_616,
  });
});
