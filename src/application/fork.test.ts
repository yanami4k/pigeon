// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078 / 079）：真实 git 仓库 + 真实装配根 + 假模型。
// - 分叉顺序：账本先记分叉记录 → 从账本与内容文件把历史导入 .pigeon/trees/ 的会话树 → 此后实时写穿；
// - 续跑：从分叉点之前最近的快照开独立工作树，以 buildSessionContext 还原的分支消息作为 Agent 初始状态，
//   新分支是新的 Pigeon 会话，会话头指向来源会话与分叉点；用户工作区不受影响；
// - 由账本重建树：删掉树文件后重建，各通道的路径与写穿结果一致；
// - 非 git 工作区发起分叉明确报错，不降级、不留分叉记录；写穿失败只告警、不进账本，不影响运行；
// - --retry-on-fail：尝试标为失败时从本次任务开始处分叉重试（不注入任何提示）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotGitWorkspaceError } from "../orchestration/checkpoint.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionTree, TREE_MAIN_LANE } from "../pi-runtime/session-tree.ts";
import { newSessionId } from "../state/ids.ts";
import { runForkBranch } from "./fork.ts";
import { runHeadless } from "./headless.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import {
  attachTreeWriteThrough,
  rebuildSessionTree,
  runTreeRebuildCommand,
} from "./session-tree.ts";

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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-fork-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-home-"));
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

function laneShape(
  entries: Awaited<ReturnType<Awaited<ReturnType<typeof openSessionTree>>["lanePath"]>>
) {
  return entries.map((entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    message: entry.message,
  }));
}

test("分叉续跑：先记分叉记录再建树再写穿；从分叉点前最近的快照开独立工作树，分支消息只到分叉点；删树后由账本重建一致", async () => {
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
    let branch: Awaited<ReturnType<typeof runForkBranch>>;
    const branchModel = createFakeStreamFn({ replies: [edit("new\n"), { text: "这次对了" }] });
    try {
      await opened.bundle.adapter.run("把 a.txt 改成 new");
      await opened.verification?.idle();
      const source = materializeSession(join(dir, ".pigeon", "sessions"), sourceId);
      const runId = source.runStarteds[0]?.runId;
      assert.ok(runId !== undefined);
      assert.equal(source.checkpoints.length, 1);
      branch = await runForkBranch({
        governanceRoot: dir,
        sourceSessionId: sourceId,
        sourceLog: opened.bundle.eventLog,
        forkPoint: { runId, runSeq: 1 },
        trigger: "manual",
        run: {
          streamFn: branchModel,
          provider: "custom",
          modelId: "custom",
          yolo: true,
          homeDir: home,
          startMcp: noMcp,
          verify: VERIFY,
        },
      });
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const source = materializeSession(sessionsDir, sourceId);
    const forked = source.sessionForkeds[0];
    assert.ok(forked !== undefined, "来源会话先记分叉记录");
    assert.equal(forked.branchSessionId, branch.branchSessionId);
    assert.equal(forked.trigger, "manual");
    assert.equal(
      forked.checkpoint.commit,
      source.checkpoints[0]?.payload.baseCommit,
      "分叉点早于首次改动：取改前基线"
    );
    assert.equal(git(dir, ["rev-parse", forked.checkpoint.ref]).trim(), forked.checkpoint.commit);

    const branchSession = materializeSession(sessionsDir, branch.branchSessionId);
    const header = branchSession.branchHeader;
    assert.ok(header !== undefined);
    assert.equal(header.sourceSessionId, sourceId);
    assert.deepEqual(header.forkPoint, forked.forkPoint);
    assert.ok(header.timestamp >= forked.timestamp, "分支会话头晚于分叉记录");
    assert.ok(existsSync(header.workspace.path));
    assert.equal(readFileSync(join(header.workspace.path, "a.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "wrong\n", "用户工作区不受分支影响");
    assert.equal(branch.label, "Passed");
    assert.equal(branchSession.attemptVerifieds[0]?.workspace, header.workspace.path);

    const firstCall = branchModel.calls[0]?.context.messages ?? [];
    assert.equal(firstCall.length, 1, "分支初始消息只到分叉点（任务消息）");
    assert.equal(firstCall[0]?.role, "user");

    const tree = await openSessionTree({ governanceRoot: dir, rootSessionId: sourceId });
    const mainBefore = laneShape(await tree.lanePath(TREE_MAIN_LANE));
    const branchBefore = laneShape(await tree.lanePath(branch.branchSessionId));
    assert.deepEqual(
      mainBefore.map((entry) => entry.id),
      source.entries.map((entry) => entry.id)
    );
    assert.equal(branchBefore[0]?.id, source.entries[0]?.id, "分支通道从分叉条目长出");
    assert.deepEqual(
      branchBefore.slice(1).map((entry) => entry.id),
      branchSession.entries.map((entry) => entry.id),
      "分支消息实时写穿"
    );
    await tree.remove();
    const rebuilt = await rebuildSessionTree({ governanceRoot: dir, rootSessionId: sourceId });
    assert.deepEqual(laneShape(await rebuilt.lanePath(TREE_MAIN_LANE)), mainBefore);
    assert.deepEqual(laneShape(await rebuilt.lanePath(branch.branchSessionId)), branchBefore);
    // 由账本重建的命令入口：给分支会话号也按根会话整棵重建
    const report = await runTreeRebuildCommand({
      governanceRoot: dir,
      sessionId: branch.branchSessionId,
    });
    assert.ok(report.includes(`根会话 ${sourceId}`), report);
    assert.ok(report.includes(`通道 ${branch.branchSessionId}：${branchBefore.length} 条`), report);
  } finally {
    cleanup();
  }
});

test("非 git 工作区发起分叉：明确报错，不降级、不留分叉记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fork-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-nogit-home-"));
  try {
    const result = await runHeadless({
      task: "做点事",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
    });
    const session = materializeSession(join(dir, ".pigeon", "sessions"), result.sessionId);
    const runId = session.runStarteds[0]?.runId;
    assert.ok(runId !== undefined);
    await assert.rejects(
      () =>
        runForkBranch({
          governanceRoot: dir,
          sourceSessionId: result.sessionId,
          forkPoint: { runId, runSeq: 1 },
          trigger: "manual",
          run: {
            streamFn: createFakeStreamFn({ replies: [{ text: "x" }] }),
            yolo: true,
            homeDir: home,
            startMcp: noMcp,
          },
        }),
      NotGitWorkspaceError
    );
    const after = materializeSession(join(dir, ".pigeon", "sessions"), result.sessionId);
    assert.equal(after.sessionForkeds.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("写穿失败：向标准错误告警一次（说明可重建补齐），不进账本，运行照常完成", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }, { text: "再好" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    try {
      const failing = {
        rootSessionId: sessionId,
        append: async () => {
          throw new Error("磁盘写满");
        },
      };
      const writer = attachTreeWriteThrough({
        bundle: opened.bundle,
        tree: failing as never,
        lane: TREE_MAIN_LANE,
      });
      process.stderr.write = ((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      // 两个 Run：同一类故障复发，告警仍只说一次
      const run = await opened.bundle.adapter.run("修一下");
      const again = await opened.bundle.adapter.run("再修一下");
      await writer.idle();
      writer.stop();
      process.stderr.write = originalWrite;
      assert.equal(run.status, "completed");
      assert.equal(again.status, "completed");
    } finally {
      process.stderr.write = originalWrite;
      await disposeRuntime(opened.bundle);
    }
    const warnings = captured.filter((line) => line.startsWith("会话树写穿告警："));
    assert.equal(warnings.length, 1, `同一类故障只告警一次：${warnings.join(" | ")}`);
    assert.match(warnings[0] ?? "", /磁盘写满/);
    assert.match(warnings[0] ?? "", /会话树落后于账本，可用 pigeon tree rebuild/);
    const session = materializeSession(join(dir, ".pigeon", "sessions"), sessionId);
    assert.ok(
      session.records.every((record) => (record.kind as string) !== "tree.write-failed"),
      "写穿失败不进账本"
    );
  } finally {
    cleanup();
  }
});

test("--retry-on-fail 1：首次失败后从任务开始处分叉重试（不注入提示）", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const model = createFakeStreamFn({
      replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
    });
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: model,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: VERIFY,
      retryOnFail: 1,
    });
    assert.equal(result.label, "Failed");
    assert.equal(result.retries?.length, 1);
    assert.equal(result.retries?.[0]?.label, "Passed");
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const source = materializeSession(sessionsDir, result.sessionId);
    assert.equal(source.runStarteds[0]?.payload.retryOnFail, 1);
    const forked = source.sessionForkeds[0];
    assert.equal(forked?.trigger, "retry-on-fail");
    assert.equal(forked?.forkPoint.runSeq, 1, "从本次任务开始处分叉");
    const retryCall = model.calls[2]?.context.messages ?? [];
    assert.equal(retryCall.length, 1, "重试不注入任何提示");
    assert.equal(result.retries?.[0]?.branchSessionId, forked?.branchSessionId);
    assert.deepEqual(source.unfinishedRuns, []);
  } finally {
    cleanup();
  }
});
