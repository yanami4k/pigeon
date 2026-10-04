// 设置快照（决策 325）：会话开始时读一次，本会话内各处都从快照取——会话中途改设置文件不影响本会话；worker 用派出它的
// 会话的快照（这里是命令短名：快照之后把短名改成别的命令，worker 照旧按快照里的命令跑）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { createSessionWorkers } from "./workers.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeSettings(repo: string, tag: string): void {
  writeFileSync(
    join(repo, ".pigeon", "settings.json"),
    JSON.stringify({
      commands: { commands: { mark: `git tag ${tag}` }, roles: { tester: ["mark"] } },
    })
  );
}

test("会话中途改设置文件不影响本会话：worker 按派出它的会话的快照展开命令短名", async () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-worker-settings-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-worker-settings-home-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "pigeon@example.invalid"]);
    git(repo, ["config", "user.name", "pigeon-test"]);
    writeFileSync(join(repo, "a.ts"), "alpha\n");
    git(repo, ["add", "a.ts"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    mkdirSync(join(repo, ".pigeon"), { recursive: true });
    writeSettings(repo, "from-snapshot");
    const settings = loadSettings(repo, { homeDir: home });
    // 会话开始之后才改的设置
    writeSettings(repo, "from-edited-file");
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "跑", toolCalls: [{ name: "run_command", args: { command: "mark" } }] },
        { text: "好了" },
      ],
    });
    const parent = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: repo,
      settings,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: home,
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
      const workerId = orchestrator.spawn({ role: "tester", task: "打标记", name: "mark" });
      const outcome = await orchestrator.awaitResult(workerId);
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      assert.deepEqual(git(repo, ["tag", "-l"]).trim().split("\n"), ["from-snapshot"]);
    } finally {
      await disposeRuntime(parent);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
