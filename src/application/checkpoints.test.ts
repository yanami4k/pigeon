// 快照挂到运行面（M7 S5，决策 078）：写档或命令档工具提议时记基线、落定后文件确实改变才生成快照，
// 落 workspace.checkpoint 观察记录；记录的条目号就是该工具结果消息的条目号（与内容文件里的工具调用号对得上），
// 快照与条目号的对应关系因此可以只从账本查到。只读工具与没有改变文件的调用不打快照；非 git 工作区不打、不报错。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession, readMessageContentFileDetailed } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { checkpointAtOrBefore } from "../state/materialize.ts";
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

test("写工具改变文件后生成快照，记录的条目号即工具结果消息的条目号；只读工具不打快照", async () => {
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
    const sessionsDir = join(root, ".pigeon", "sessions");
    const session = materializeSession(sessionsDir, sessionId);
    assert.equal(session.checkpoints.length, 1, "只有改变文件的写工具打快照");
    const checkpoint = session.checkpoints[0];
    assert.ok(checkpoint !== undefined);
    const editCall = session.runtimeEvents.find(
      (event) => event.kind === "tool.proposed" && event.payload.toolName === "edit_file"
    );
    assert.equal(
      checkpoint.payload.toolCallId,
      editCall?.kind === "tool.proposed" ? editCall.payload.toolCallId : ""
    );
    const toolResult = readMessageContentFileDetailed(
      join(sessionsDir, `${sessionId}.messages.jsonl`)
    ).records.find((record) => record.toolCallId === checkpoint.payload.toolCallId);
    assert.equal(checkpoint.payload.afterRunSeq, toolResult?.runSeq, "条目号对得上工具结果消息");
    assert.equal(git(root, ["show", `${checkpoint.payload.commit}:a.txt`]), "new\n");
    assert.equal(git(root, ["show", `${checkpoint.payload.baseCommit}:a.txt`]), "old\n");
    assert.equal(
      checkpointAtOrBefore(session, checkpoint.runId, checkpoint.payload.afterRunSeq)?.commit,
      checkpoint.payload.commit
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
    const session = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.equal(session.checkpoints.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
