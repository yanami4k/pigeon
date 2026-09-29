// 终端界面退出（决策 283）：退出立即收尾、不复盘、不调用模型；给工作目录拍快照并把快照提交记进会话（退出条目）；
// 快照与退出那一刻的工作目录一致（受跟踪文件的当前内容加未被忽略的新文件），不动用户的工作目录、暂存区与 HEAD；
// 一次运行都没跑过的会话不记；非 git 工作区记无快照；沙箱会话不另拍，记交回的分支与提交。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { newSessionId } from "../state/ids.ts";
import { type ExitData, SessionEntryType } from "../state/session-entries.ts";
import { noMcpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { closeTuiSession, exitSnapshotRef } from "./tui-exit.ts";
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

function exitsOf(root: string, sessionId: string): ExitData[] {
  return customOf<ExitData>(mainEntries(root, sessionId), SessionEntryType.Exit);
}

test("退出立即收尾：不复盘、不调用模型，不新建任何会话", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const { streamFn, calls } = routedModel({ main: [{ text: "好了" }] });
    const session = await openTuiSession({ root, streamFn, task: "看看 a.txt" });
    const before = calls.length;
    assert.ok(before > 0);
    await session.close();
    assert.equal(calls.length, before, "退出时不得再调用模型");
    assert.equal(calls.filter((call) => call.kind === "review").length, 0);
    // 会话存储里只有这一个会话（没有复盘会话）
    assert.deepEqual(
      listSessionFiles(sessionsDirOf(root)).map((file) => file.sessionId),
      [session.sessionId]
    );
    assert.equal(exitsOf(root, session.sessionId).length, 1);
  } finally {
    cleanup();
  }
});

test("退出快照与退出那一刻的工作目录一致：含未提交改动与未被忽略的新文件；之后再改不影响；不动工作目录、暂存区与 HEAD", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-snap-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const head = git(root, ["rev-parse", "HEAD"]);
    const { streamFn } = routedModel({});
    const session = await openTuiSession({ root, streamFn, task: "改一下" });
    writeFileSync(join(root, "a.txt"), "退出时的内容\n");
    writeFileSync(join(root, "new.txt"), "新文件\n");
    const statusBefore = git(root, ["status", "--porcelain"]);
    await session.close();
    // 退出之后再改：快照不受影响
    writeFileSync(join(root, "a.txt"), "退出之后又改了\n");
    const [exit] = exitsOf(root, session.sessionId);
    assert.ok(exit !== undefined);
    assert.equal(exit.workdir.kind, "snapshot");
    assert.ok(exit.workdir.kind === "snapshot");
    assert.equal(exit.workdir.head, head);
    assert.notEqual(exit.workdir.commit, head);
    assert.equal(exit.workdir.ref, exitSnapshotRef(session.sessionId));
    assert.equal(git(root, ["rev-parse", exitSnapshotRef(session.sessionId)]), exit.workdir.commit);
    assert.equal(git(root, ["show", `${exit.workdir.commit}:a.txt`]), "退出时的内容");
    assert.equal(git(root, ["show", `${exit.workdir.commit}:new.txt`]), "新文件");
    // .pigeon（会话文件所在）不进快照
    const snapCommit = exit.workdir.commit;
    assert.throws(() => git(root, ["show", `${snapCommit}:.pigeon`]));
    // 用户的 HEAD、分支与暂存区不动
    assert.equal(git(root, ["rev-parse", "HEAD"]), head);
    assert.equal(git(root, ["diff", "--cached", "--name-only"]), "");
    writeFileSync(join(root, "a.txt"), "退出时的内容\n");
    assert.equal(git(root, ["status", "--porcelain"]), statusBefore);
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "新文件\n");
  } finally {
    cleanup();
  }
});

test("工作目录没有未提交改动：快照即 HEAD，不另建提交、不挂引用", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-clean-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const head = git(root, ["rev-parse", "HEAD"]);
    const session = await openTuiSession({ root, streamFn: routedModel({}).streamFn, task: "看" });
    await session.close();
    const [exit] = exitsOf(root, session.sessionId);
    assert.deepEqual(exit?.workdir, { kind: "snapshot", commit: head, head });
  } finally {
    cleanup();
  }
});

test("一次运行都没跑过的会话：不记退出条目、不拍快照", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-idle-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    writeFileSync(join(root, "a.txt"), "改了没跑\n");
    const session = await openTuiSession({ root, streamFn: routedModel({}).streamFn });
    await session.close();
    const files = listSessionFiles(sessionsDirOf(root));
    if (files.length > 0) {
      assert.equal(exitsOf(root, session.sessionId).length, 0);
    }
    assert.throws(() => git(root, ["rev-parse", "--verify", exitSnapshotRef(session.sessionId)]));
  } finally {
    cleanup();
  }
});

test("非 git 工作区：记无快照与原因", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-nogit-");
  try {
    writeFileSync(join(root, "a.txt"), "一\n");
    const session = await openTuiSession({ root, streamFn: routedModel({}).streamFn, task: "看" });
    await session.close();
    const [exit] = exitsOf(root, session.sessionId);
    assert.equal(exit?.workdir.kind, "none");
    assert.ok(exit?.workdir.kind === "none" && exit.workdir.reason.includes("不是 git 工作区"));
  } finally {
    cleanup();
  }
});

test("沙箱会话：不另拍快照，记交回的分支与提交；交回失败记无快照与原因", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-sandbox-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    writeFileSync(join(root, "a.txt"), "宿主上没提交的改动\n");
    const head = git(root, ["rev-parse", "HEAD"]);
    for (const exported of [true, false]) {
      const sessionId = newSessionId();
      const { streamFn } = routedModel({});
      const opened = await openSessionRuntime({
        governanceRoot: root,
        sessionId,
        streamFn,
        flags: {
          yolo: true,
          provider: "custom",
          modelId: "custom",
          persistThinking: true,
          pushedMemory: true,
        },
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
        closeSandbox: async () =>
          exported
            ? {
                notice: "已交回",
                exported: {
                  branch: `pigeon/sandbox-${sessionId}`,
                  commit: head,
                  changed: true,
                  viewCommand: "git log",
                },
              }
            : { notice: "交回失败：容器已不在" },
        log: (line) => logged.push(line),
      });
      const [exit] = exitsOf(root, sessionId);
      if (exported) {
        assert.deepEqual(exit?.workdir, {
          kind: "sandbox",
          branch: `pigeon/sandbox-${sessionId}`,
          commit: head,
        });
        assert.deepEqual(logged, ["已交回"]);
      } else {
        assert.deepEqual(exit?.workdir, {
          kind: "none",
          reason: "沙箱交回失败：交回失败：容器已不在",
        });
      }
      assert.throws(() => git(root, ["rev-parse", "--verify", exitSnapshotRef(sessionId)]));
    }
  } finally {
    cleanup();
  }
});

// 与 disposeRuntime 的配对：closeTuiSession 释放运行面后会话写者已关，退出条目另开写者续写（同一把会话锁）
test("退出之后会话照常可续：退出条目不挡再次打开同一会话", async () => {
  const { root, cleanup } = tempRoot("pigeon-tui-exit-resume-");
  try {
    initRepo(root, { "a.txt": "一\n" });
    const { streamFn } = routedModel({});
    const session = await openTuiSession({ root, streamFn, task: "看" });
    await session.close();
    const reopened = await openSessionRuntime({
      governanceRoot: root,
      sessionId: session.sessionId,
      streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      homeDir: root,
      startMcp: noMcpSession,
      resume: true,
    });
    await disposeRuntime(reopened.bundle);
    assert.equal(exitsOf(root, session.sessionId).length, 1);
  } finally {
    cleanup();
  }
});
