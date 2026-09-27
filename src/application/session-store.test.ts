// 账本重构双写接线（决策 206）：在写旧账本的同一处同时写新会话存储。覆盖面：消息、Run 开始与收尾、验证记录、代码快照、
// worker 派出与收尾、分叉、授权建立与撤销；worker 与分支会话的来历写进文件头。新存储写失败只向标准错误输出去重告警，
// 不中断运行、不影响旧账本。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
  type SessionFileView,
  type StoredEntry,
  sessionDirectoryName,
} from "../persistence/session-reader.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { asRunId, newSessionId } from "../state/ids.ts";
import {
  type ForkData,
  type RunEndData,
  type SessionCustomEntry,
  SessionEntryType,
  type VerificationData,
  type WorkerData,
} from "../state/session-entries.ts";
import { runForkBranch } from "./fork.ts";
import { runHeadless } from "./headless.ts";
import type { McpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { teeChildFamilies, teeGrantEvents } from "./session-store.ts";

const NODE = `"${process.execPath}"`;
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

function repo(): { dir: string; home: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-dual-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-dual-home-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "old\n");
  writeFileSync(
    join(dir, "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return {
    dir,
    home,
    cleanup: () => {
      try {
        git(dir, ["worktree", "prune"]);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const edit = (content: string) => ({
  text: "改",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
  ],
});

const VERIFY = { command: `${NODE} check.mjs`, timeoutMs: 30_000 };

function viewOf(sessionsDir: string, sessionId: string): SessionFileView {
  const located = locateSessionFile(sessionsDir, sessionId);
  assert.ok(located !== undefined, `新存储里有 ${sessionId} 的会话文件`);
  const view = readSessionFile(located.path);
  assert.ok(view !== undefined);
  assert.deepEqual(view.warnings, []);
  return view;
}

function customs<T>(entries: readonly StoredEntry[], customType: string): T[] {
  return entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === customType ? [entry.data as T] : []
  );
}

function messages(entries: readonly StoredEntry[]): StoredEntry[] {
  return entries.filter((entry) => entry.type === "message");
}

test("双写端到端：失败自动分叉重试一次跑通，来源与分支两个新文件的消息、Run 起止、快照、验证、分叉都与旧账本对应", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({
        replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
      }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: VERIFY,
      retryOnFail: 1,
    });
    assert.equal(result.retries?.[0]?.label, "Passed");
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const old = materializeSession(sessionsDir, result.sessionId);
    const source = viewOf(sessionsDir, result.sessionId);
    assert.equal(source.header.cwd, dir);
    const runId = old.runStarteds[0]?.runId;
    assert.ok(runId !== undefined);

    // 消息：与旧账本同数同序同角色
    const sourceMessages = messages(source.entries);
    assert.deepEqual(
      sourceMessages.map((entry) => (entry.message as { role: string }).role),
      old.entries.map((entry) => entry.role)
    );
    // Run 起止：开始在前、收尾在后，收尾为正常完成
    const [start] = customs<{ runId: string }>(source.entries, SessionEntryType.RunStart);
    assert.equal(start?.runId, runId);
    assert.equal(source.entries[0]?.customType, SessionEntryType.RunStart);
    const [end] = customs<RunEndData>(source.entries, SessionEntryType.RunEnd);
    assert.equal(end?.ending, "completed");
    assert.equal(end?.messageCount, old.entries.length);
    // 代码快照：与旧记录同一次提交，位于发起调用的助手消息之后、工具结果之前
    const [checkpoint] = customs<{ commit: string; toolCallId: string }>(
      source.entries,
      SessionEntryType.Checkpoint
    );
    assert.equal(checkpoint?.commit, old.checkpoints[0]?.payload.commit);
    const checkpointAt = source.entries.findIndex(
      (entry) => entry.customType === SessionEntryType.Checkpoint
    );
    assert.equal(
      (source.entries[checkpointAt + 1]?.message as { toolCallId?: string } | undefined)
        ?.toolCallId,
      checkpoint?.toolCallId
    );
    // 收尾后补写的验证记录（运行面已释放，按会话号重新打开新文件）
    const [verification] = customs<VerificationData>(source.entries, SessionEntryType.Verification);
    assert.equal(verification?.verdict, "fail");
    assert.equal(verification?.outputHash, old.attemptVerifieds[0]?.outputHash);
    assert.deepEqual(verification?.target, { sessionId: result.sessionId, runId });
    // 分叉条目：分叉点对应本文件里该 Run 的第 1 条消息
    const [fork] = customs<ForkData>(source.entries, SessionEntryType.Fork);
    const branchId = result.retries?.[0]?.branchSessionId;
    assert.equal(fork?.branchSessionId, branchId);
    assert.equal(fork?.trigger, "retry-on-fail");
    assert.equal(fork?.forkEntryId, sourceMessages[0]?.id);

    // 分支会话：由 pi 的 fork 从来源复制分叉点（含）之前的历史，文件头记来源与来历，随后由分支运行面续写
    assert.ok(branchId !== undefined);
    const branch = viewOf(sessionsDir, branchId);
    assert.equal(branch.header.parentSessionId, result.sessionId);
    const lineage = (branch.header.metadata?.pigeon as { branch?: { trigger?: string } })?.branch;
    assert.equal(lineage?.trigger, "retry-on-fail");
    const branchPath = branchEntries(branch, branch.lanes.get("main") ?? null);
    assert.deepEqual(
      branchPath.slice(0, 2).map((entry) => entry.id),
      [source.entries[0]?.id, sourceMessages[0]?.id],
      "复制来源的 Run 开始与任务消息"
    );
    const branchOld = materializeSession(sessionsDir, branchId);
    assert.equal(messages(branchPath).length, 1 + branchOld.entries.length);
    assert.deepEqual(
      customs<RunEndData>(branchPath, SessionEntryType.RunEnd).map((data) => data.ending),
      ["completed"]
    );
    assert.equal(
      customs<VerificationData>(branchPath, SessionEntryType.Verification)[0]?.verdict,
      "pass"
    );
  } finally {
    cleanup();
  }
});

test("双写：手动分叉时来源写者在本进程，先落盘再分叉；分叉条目与分支文件照写", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const sourceId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId: sourceId,
      streamFn: createFakeStreamFn({ replies: [edit("wrong\n"), { text: "改好了" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      verify: VERIFY,
    });
    let branchId: string;
    try {
      const run = await opened.bundle.adapter.run("把 a.txt 改成 new");
      await opened.verification?.idle();
      const branch = await runForkBranch({
        governanceRoot: dir,
        sourceSessionId: sourceId,
        sourceLog: opened.bundle.eventLog,
        sourceStore: opened.bundle.sessionStore,
        forkPoint: { runId: run.runId, runSeq: 3 },
        trigger: "manual",
        run: {
          input: "继续",
          streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
          provider: "custom",
          modelId: "custom",
          yolo: true,
          homeDir: home,
          startMcp: noMcp,
        },
      });
      branchId = branch.branchSessionId;
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const source = viewOf(sessionsDir, sourceId);
    const [fork] = customs<ForkData>(source.entries, SessionEntryType.Fork);
    const third = messages(source.entries)[2];
    assert.equal(fork?.forkEntryId, third?.id);
    assert.equal(
      customs<VerificationData>(source.entries, SessionEntryType.Verification).length,
      1,
      "运行面挂的验证同时写进新存储"
    );
    const branch = viewOf(sessionsDir, branchId);
    const path = branchEntries(branch, branch.lanes.get("main") ?? null);
    const at = source.entries.findIndex((entry) => entry.id === third?.id);
    assert.deepEqual(
      path.slice(0, at + 1).map((entry) => entry.id),
      source.entries.slice(0, at + 1).map((entry) => entry.id),
      "分叉点（含）之前的历史原样复制"
    );
    assert.equal(branch.header.parentSessionId, sourceId);
  } finally {
    cleanup();
  }
});

test("双写：撞轮数上限的 Run 收尾条目记轮数上限（原因随中止请求交给运行面）", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "改",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("wrong\n"), { text: "还没完" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      maxTurns: 1,
    });
    assert.equal(result.status, "turn-limit");
    const view = viewOf(join(dir, ".pigeon", "sessions"), result.sessionId);
    assert.deepEqual(
      customs<RunEndData>(view.entries, SessionEntryType.RunEnd).map((data) => data.ending),
      ["turn-limit"]
    );
  } finally {
    cleanup();
  }
});

test("双写：授权建立与撤销先写旧账本再写新存储；worker 会话的来历写进新文件头", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-dual-grant-"));
  try {
    const sessionId = newSessionId();
    const parentRunId = asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS");
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: root,
      sessionId,
      yolo: true,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      storeLineage: {
        worker: {
          parentSessionId: newSessionId(),
          parentRunId,
          worker: { name: "implementer-1", role: "implementer" },
          workspace: { kind: "none" },
          startedAt: 7,
        },
      },
    });
    const grant = bundle.grantStore.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "tc-1", args: { path: "src/a.ts", note: undefined } },
    });
    bundle.grantStore.revoke(grant.grantId);
    await disposeRuntime(bundle);
    const view = viewOf(join(root, ".pigeon", "sessions"), sessionId);
    assert.deepEqual(
      customs<{ event: string; grantId: string }>(view.entries, SessionEntryType.Grant).map(
        (data) => [data.event, data.grantId]
      ),
      [
        ["created", grant.grantId],
        ["revoked", grant.grantId],
      ]
    );
    const header = view.header.metadata?.pigeon as {
      worker?: { name: string; parentRunId?: string };
    };
    assert.equal(header.worker?.name, "implementer-1");
    assert.equal(header.worker?.parentRunId, parentRunId);
    assert.ok(typeof view.header.parentSessionId === "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("转接：旧账本写不进时抛出且新存储不写（授权不生效、worker 不派）；写进之后新存储照写", () => {
  const written: SessionCustomEntry[] = [];
  const store = { append: (entry: SessionCustomEntry) => written.push(entry) };
  const failing = {
    appendGrantCreated: () => {
      throw new Error("盘满");
    },
    appendGrantRevoked: () => {
      throw new Error("盘满");
    },
    appendChildSpawned: () => {
      throw new Error("盘满");
    },
    appendChildSettled: () => {
      throw new Error("盘满");
    },
  };
  const grantInput = {
    grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS" as never,
    tool: "edit_file",
    createdAt: 1,
    firstCall: { toolCallId: "tc", args: {} },
  };
  assert.throws(() => teeGrantEvents(failing, store).appendGrantCreated(grantInput), /盘满/);
  const spawned = {
    childSessionId: newSessionId(),
    name: "tester-1",
    role: "tester" as const,
    task: "测",
    taskKey: "k",
    policy: { allow: [], deny: [], approvalMode: "yolo" as const },
    limits: { maxTurns: 1, wallClockMs: 1 },
    workspace: { kind: "none" as const },
    spawnedAt: 1,
  };
  assert.throws(() => teeChildFamilies(failing, store).appendChildSpawned(spawned), /盘满/);
  assert.equal(written.length, 0);
  const ok = {
    appendGrantCreated: () => "g",
    appendGrantRevoked: () => "r",
    appendChildSpawned: () => "s",
    appendChildSettled: () => "t",
  };
  assert.equal(teeGrantEvents(ok, store).appendGrantCreated(grantInput), "g");
  assert.equal(teeChildFamilies(ok, store).appendChildSpawned(spawned), "s");
  teeChildFamilies(ok, store).appendChildSettled({
    childSessionId: spawned.childSessionId,
    name: "tester-1",
    status: "completed",
    result: {
      branch: "b",
      changedFiles: ["a"],
      receiptIds: [],
      summary: "好",
      summaryTruncated: false,
      structured: { x: 1 },
    },
    turns: 2,
    settledAt: 3,
  });
  const worker = written.filter((entry) => entry.customType === SessionEntryType.Worker);
  assert.deepEqual(
    worker.map((entry) => (entry.data as WorkerData).event),
    ["spawned", "settled"]
  );
  assert.equal("taskKey" in (worker[0]?.data ?? {}), false, "无读者的 taskKey 不写");
  assert.deepEqual(
    (worker[1]?.data as Extract<WorkerData, { event: "settled" }> | undefined)?.result,
    {
      branch: "b",
      changedFiles: ["a"],
      summary: "好",
      summaryTruncated: false,
    }
  );
});

test("双写：新存储建不起文件时向标准错误输出告警一次，运行照常完成，旧账本照写", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-dual-fault-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // 新存储要建的子目录位置被一个普通文件占着
    writeFileSync(join(sessionsDir, sessionDirectoryName(root)), "占位");
    const warnings: string[] = [];
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: root,
      sessionId,
      yolo: true,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      storeWarn: (line) => warnings.push(line),
    });
    const first = await bundle.adapter.run("一");
    const second = await bundle.adapter.run("二");
    await disposeRuntime(bundle);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(
      warnings[0] ?? "",
      /新会话存储告警：新会话存储打开失败.*旧账本照常写入，运行不受影响/
    );
    const old = materializeSession(sessionsDir, sessionId);
    assert.equal(old.entries.length, 4);
    assert.equal(old.unfinishedRuns.length, 0);
    assert.equal(locateSessionFile(sessionsDir, sessionId), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("双写：双写之前就存在的旧会话（旧账本已有记录、新存储没有文件）续跑时不在新存储里建文件，只写旧账本、不告警", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-dual-legacy-"));
  try {
    const sessionsDir = join(root, ".pigeon", "sessions");
    const sessionId = newSessionId();
    // 双写之前的会话：只有旧账本
    const legacy = new JsonlEventLog(sessionsDir, sessionId);
    legacy.appendBreaker({
      toolName: "edit_file",
      toolCallId: "tc-old",
      scope: "tool",
      count: 3,
      threshold: 3,
      at: 1,
      runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
    });
    legacy.close();
    const warnings: string[] = [];
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "接着干" }] }),
      workspaceRoot: root,
      sessionId,
      yolo: true,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      storeWarn: (line) => warnings.push(line),
    });
    const run = await bundle.adapter.run("续跑");
    bundle.grantStore.create({ tool: "edit_file", firstCall: { toolCallId: "tc", args: {} } });
    await disposeRuntime(bundle);
    assert.equal(run.status, "completed");
    assert.equal(locateSessionFile(sessionsDir, sessionId), undefined, "新存储里没有这个会话");
    assert.deepEqual(warnings, []);
    const old = materializeSession(sessionsDir, sessionId);
    assert.equal(old.entries.length, 2, "旧账本照写");
    assert.equal(old.grantCreateds.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
