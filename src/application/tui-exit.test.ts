// 终端界面退出（决策 283、331）：退出立即收尾、不调用模型；不再拍工作目录快照、不再写退出条目；沙箱会话交回并打出提示；
// 旧会话里已有的退出条目照常可读，会话照常可续。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { newSessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { closeTuiSession } from "./tui-exit.ts";
import {
  customOf,
  git,
  initRepo,
  mainEntries,
  openTuiSession,
  routedModel,
  tempRoot,
} from "./tui-session-fixtures.ts";
import { sessionsDirOf } from "./workspace.ts";

test("退出立即收尾：不调用模型，不新建任何会话，不写退出条目、不挂退出快照引用", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const { streamFn, calls } = routedModel({ main: [{ text: "好了" }] });
    const session = await openTuiSession({ root, streamFn, task: "看看 a.txt" });
    const before = calls.length;
    assert.ok(before > 0);
    await session.close();
    assert.equal(calls.length, before, "退出时不得再调用模型");
    assert.deepEqual(
      listSessionFiles(sessionsDirOf(root)).map((file) => file.sessionId),
      [session.sessionId]
    );
    assert.equal(customOf(mainEntries(root, session.sessionId), SessionEntryType.Exit).length, 0);
    assert.equal(git(root, ["for-each-ref", "refs/pigeon/exit"]), "");
  } finally {
    cleanup();
  }
});

test("沙箱会话：释放运行面后交回并打出提示", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-sandbox-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: routedModel({}).streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      homeDir: root,
      startMcp: noMcpSession,
    });
    await opened.bundle.adapter.run("在沙箱里干活");
    const logged: string[] = [];
    await closeTuiSession({
      governanceRoot: root,
      sessionId,
      bundle: opened.bundle,
      workerGraceMs: 0,
      closeSandbox: async () => ({ notice: "已交回" }),
      log: (line) => logged.push(line),
    });
    assert.deepEqual(logged, ["已交回"]);
    assert.equal(customOf(mainEntries(root, sessionId), SessionEntryType.Exit).length, 0);
  } finally {
    cleanup();
  }
});

test("旧会话里的退出条目照常可读：会话照常续开", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-legacy-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const old = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
    old.startRun({ task: "看" });
    old.assistant({ text: "好了" });
    old.endRun();
    old.append({
      customType: SessionEntryType.Exit,
      data: {
        version: SESSION_ENTRY_VERSION,
        exitedAt: Date.now(),
        workdir: { kind: "none", reason: "不是 git 工作区" },
      },
    });
    const { sessionId } = await old.close();
    const reopened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: routedModel({}).streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      homeDir: root,
      startMcp: noMcpSession,
      resume: true,
    });
    assert.equal(reopened.restored?.messages, 2);
    await disposeRuntime(reopened.bundle);
    assert.equal(customOf(mainEntries(root, sessionId), SessionEntryType.Exit).length, 1);
  } finally {
    cleanup();
  }
});
