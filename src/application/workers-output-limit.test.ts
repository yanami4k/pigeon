// worker 继承父运行面的单轮输出上限（决策 063 第 1 件）：按会话装配的编排器从父运行面的冻结快照取上限，
// worker 的模型调用收到同一 maxTokens，worker 会话的 run.started 记下同一值。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { createSessionWorkers } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("worker 继承父运行面的输出上限：worker 的模型调用收到父值，worker 会话 run.started 记下同一值", async () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-worker-limit-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-worker-limit-home-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.ts"), "alpha\n");
    git(repo, ["add", "a.ts"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const seen: unknown[] = [];
    const fake = createFakeStreamFn({ replies: [{ text: "看过了" }] });
    const streamFn: StreamFn = (model, context, options) => {
      seen.push(options?.maxTokens);
      return fake(model, context, options);
    };
    const parent = buildRuntime({
      streamFn,
      workspaceRoot: repo,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: home,
      maxOutputTokens: 2048,
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
      assert.deepEqual(seen, [2048]);
      const worker = materializeSession(join(repo, ".pigeon", "sessions"), workerId);
      assert.equal(worker.runStarteds[0]?.payload.model.maxOutputTokens, 2048);
    } finally {
      await disposeRuntime(parent);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
