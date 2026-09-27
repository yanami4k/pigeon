// 快照挂到运行面（M7 S5，决策 078）：写档或命令档工具提议时记基线、落定后文件确实改变才生成快照，
// 在会话存储里写代码快照条目：条目紧跟在发起调用的助手消息之后、该调用的工具结果消息之前，以 toolCallId 对应，
// 快照与消息的对应关系因此可以只从会话文件查到。只读工具与没有改变文件的调用不打快照；非 git 工作区不打、不报错。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredEntry } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type CheckpointData, SessionEntryType } from "../state/session-entries.ts";
import { storeCheckpointBefore } from "../state/session-judge.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function isCheckpointEntry(entry: StoredEntry | undefined): boolean {
  return entry?.type === "custom" && entry.customType === SessionEntryType.Checkpoint;
}

// 条目里的消息（非消息条目返回 undefined）
function messageOf(
  entry: StoredEntry | undefined
): { role: string; content?: unknown; toolCallId?: string; toolName?: string } | undefined {
  return entry?.type === "message"
    ? (entry.message as { role: string; content?: unknown; toolCallId?: string })
    : undefined;
}

const SCRIPT = [
  { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
  {
    text: "改",
    toolCalls: [
      { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: "new\n" } },
    ],
  },
  { text: "改好了" },
];

test("写工具改变文件后生成快照，快照条目夹在发起调用的助手消息与其工具结果消息之间；只读工具不打快照", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-cp-runtime-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-cp-home-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "pigeon@example.invalid"]);
    git(root, ["config", "user.name", "pigeon-test"]);
    git(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, "a.txt"), "old\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies: SCRIPT }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      await opened.bundle.adapter.run("把 a.txt 改成 new");
      assert.deepEqual(opened.checkpoints?.errors(), [], "快照器没有内部故障");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const loaded = loadStoreSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.ok(loaded !== undefined);
    const entries = loaded.main;
    const indexes = entries.flatMap((entry, index) => (isCheckpointEntry(entry) ? [index] : []));
    assert.equal(indexes.length, 1, "只有改变文件的写工具打快照");
    const at = indexes[0] ?? -1;
    const checkpoint = entries[at]?.data as CheckpointData;
    // 前一条是发起 edit_file 调用的助手消息
    const assistant = messageOf(entries[at - 1]);
    assert.ok(assistant !== undefined && assistant.role === "assistant");
    const editCall = (
      assistant.content as Array<{ type: string; id?: string; name?: string }>
    ).filter((block) => block.type === "toolCall");
    assert.deepEqual(
      editCall.map((block) => [block.name, block.id]),
      [["edit_file", checkpoint.toolCallId]]
    );
    // 后一条是该调用的工具结果消息
    const toolResult = messageOf(entries[at + 1]);
    assert.equal(toolResult?.role, "toolResult");
    assert.equal(toolResult?.toolCallId, checkpoint.toolCallId, "快照与工具结果消息对得上");
    assert.equal(git(root, ["show", `${checkpoint.commit}:a.txt`]), "new\n");
    assert.equal(git(root, ["show", `${checkpoint.baseCommit}:a.txt`]), "old\n");
    // 视图里快照归到该工具结果消息（所属 Run 里的第几条消息），按分叉点取快照的口径取到它
    const run = loaded.view.runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.runId, checkpoint.runId);
    const resultSeq =
      run.messages.findIndex((ref) => ref.message.toolCallId === checkpoint.toolCallId) + 1;
    assert.ok(resultSeq > 0);
    assert.deepEqual(
      run.checkpoints.map((entry) => entry.afterRunSeq),
      [resultSeq]
    );
    assert.equal(
      storeCheckpointBefore(loaded.view, { runId: run.runId, runSeq: resultSeq })?.commit,
      checkpoint.commit
    );
    // 工具结果之前的分叉点取不到这个快照，只能取到改前基线
    assert.deepEqual(
      storeCheckpointBefore(loaded.view, { runId: run.runId, runSeq: resultSeq - 1 }),
      {
        commit: checkpoint.baseCommit,
      }
    );
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("非 git 工作区：不打快照，运行照常", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cp-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-cp-nogit-home-"));
  try {
    writeFileSync(join(root, "a.txt"), "old\n");
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies: SCRIPT }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      const run = await opened.bundle.adapter.run("把 a.txt 改成 new");
      assert.equal(run.status, "completed");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const loaded = loadStoreSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.ok(loaded !== undefined);
    assert.equal(loaded.view.runs.length, 1);
    assert.equal(loaded.main.filter((entry) => isCheckpointEntry(entry)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
