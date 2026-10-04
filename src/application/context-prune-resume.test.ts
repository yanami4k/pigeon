// 上下文裁剪的续跑起点（决策 361）：续跑、分叉续跑、worker 续做各自从会话记录取回已有的裁剪，第一次请求里旧的工具结果
// 照记录换成同样的占位（续跑一侧关掉总开关或保护轮够大，不会新裁）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { ContextPruneSection } from "../state/prune-config.ts";
import { type PruneData, SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { runForkBranch } from "./fork.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const FLAGS = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };
// 读大文件、读小文件、收尾
const READS: FakeReply[] = [
  { text: "读大文件", toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] },
  { text: "读小文件", toolCalls: [{ name: "read_file", args: { path: "small.txt" } }] },
  { text: "完" },
];
// 不算价格、不设下限：保护轮之外的大读取一定裁
const PRUNE: ContextPruneSection = { protectTurns: 1, priceRatio: 1, minBatchTokens: 0 };

function workspace(git = false): { root: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-prune-resume-")));
  writeFileSync(join(root, "big.txt"), "大文件的一行内容。\n".repeat(600));
  writeFileSync(join(root, "small.txt"), "小\n");
  if (git) {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "pigeon@example.invalid"]);
    run(["config", "user.name", "pigeon-test"]);
    writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
    run(["add", "."]);
    run(["commit", "-q", "-m", "init"]);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function settingsOf(root: string, contextPrune: ContextPruneSection): SettingsSnapshot {
  const empty = emptySettingsSnapshot(root);
  return { ...empty, merged: { ...empty.merged, contextPrune } };
}

function prunes(root: string, sessionId: string): PruneData[] {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined);
  return (loaded.main as unknown as Array<{ customType?: string; data?: PruneData }>)
    .filter((entry) => entry.customType === SessionEntryType.Prune)
    .map((entry) => entry.data as PruneData);
}

// 第一次请求里这个工具结果的正文
function sentText(fake: FakeStreamFn, toolCallId: string | undefined): string | undefined {
  const message = fake.calls[0]?.context.messages.find(
    (entry) => entry.role === "toolResult" && entry.toolCallId === toolCallId
  );
  return message?.role === "toolResult"
    ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
    : undefined;
}

test("续跑：从会话记录取回已有的裁剪", async () => {
  const { root, cleanup } = workspace();
  const sessionId = newSessionId();
  const open = (streamFn: FakeStreamFn, contextPrune: ContextPruneSection, resume: boolean) =>
    openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn,
      flags: FLAGS,
      homeDir: root,
      startMcp: async () => noMcpSession(),
      settings: settingsOf(root, contextPrune),
      ...(resume ? { resume: true } : {}),
    });
  try {
    const first = await open(createFakeStreamFn({ replies: READS }), PRUNE, false);
    await first.bundle.adapter.run("读文件");
    await disposeRuntime(first.bundle);
    const [item] = prunes(root, sessionId)[0]?.items ?? [];
    const second = createFakeStreamFn({ replies: [{ text: "好" }] });
    const resumed = await open(second, { enabled: false }, true);
    await resumed.bundle.adapter.run("继续");
    await disposeRuntime(resumed.bundle);
    assert.equal(sentText(second, item?.toolCallId), item?.placeholder);
  } finally {
    cleanup();
  }
});

test("分叉续跑：分支会话记录里复制来的裁剪照样应用", async () => {
  const { root, cleanup } = workspace(true);
  const sourceId = newSessionId();
  try {
    // 保护 0 轮：第二次请求之前就裁掉大读取，裁剪记录落在分叉点（读小文件的结果）之前
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId: sourceId,
      streamFn: createFakeStreamFn({ replies: READS }),
      flags: FLAGS,
      homeDir: root,
      startMcp: async () => noMcpSession(),
      settings: settingsOf(root, { ...PRUNE, protectTurns: 0 }),
    });
    const branchModel = createFakeStreamFn({ replies: [{ text: "分支好了" }] });
    let item: PruneData["items"][number] | undefined;
    try {
      await opened.bundle.adapter.run("读文件");
      await opened.checkpoints?.settle();
      await opened.bundle.sessionStore.flush();
      item = prunes(root, sourceId)[0]?.items[0];
      const run = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sourceId)?.view
        .runs[0];
      const results = (run?.messages ?? []).flatMap((ref, index) =>
        ref.message.role === "toolResult" ? [index + 1] : []
      );
      assert.ok(run !== undefined && results.length === 2);
      await runForkBranch({
        governanceRoot: root,
        sourceSessionId: sourceId,
        sourceStore: opened.bundle.sessionStore,
        forkPoint: { runId: run.runId, runSeq: results[1] as number },
        trigger: "manual",
        run: {
          streamFn: branchModel,
          provider: "fake",
          modelId: "fake",
          yolo: true,
          homeDir: root,
          startMcp: async () => noMcpSession(),
        },
      });
    } finally {
      await disposeRuntime(opened.bundle);
    }
    assert.equal(sentText(branchModel, item?.toolCallId), item?.placeholder);
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {}
    cleanup();
  }
});

test("worker 续做：从 worker 会话记录取回已有的裁剪", async () => {
  const { root, cleanup } = workspace();
  const sessionId = newSessionId();
  const request = {
    sessionId,
    name: "w1",
    role: "implementer" as const,
    task: "读文件",
    policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" as const },
    governanceRoot: root,
    workspace: { kind: "git-worktree" as const, path: root, branch: "pigeon/w1" },
    lineage: { parentSessionId: newSessionId() },
    approvalHandler: async () => ({ approved: false }),
  };
  const factory = (streamFn: FakeStreamFn, contextPrune: ContextPruneSection) =>
    createWorkerRuntimeFactory({
      streamFnFor: () => streamFn,
      provider: "fake",
      modelId: "fake",
      homeDir: root,
      settingsSnapshot: settingsOf(root, contextPrune),
    });
  try {
    const first = factory(createFakeStreamFn({ replies: READS }), PRUNE)(request);
    await first.run("读文件");
    await first.dispose();
    const [item] = prunes(root, sessionId)[0]?.items ?? [];
    const second = createFakeStreamFn({ replies: [{ text: "好" }] });
    const resumed = factory(second, { enabled: false })({ ...request, resume: true });
    await resumed.run("继续");
    await resumed.dispose();
    assert.equal(sentText(second, item?.toolCallId), item?.placeholder);
  } finally {
    cleanup();
  }
});
