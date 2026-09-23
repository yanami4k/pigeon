// 主会话的分叉接线（M7 S6，决策 077 / 079）：
// - --retry-on-fail 解析、按会话冻结；主会话一次尝试验证为失败后在后台从任务开始处分叉重试；
// - 分叉后来源会话此后的 Run 实时写穿进会话树，与由账本重建的结果一致；恢复一个已在树里的会话同样接上写穿；
// - 手动分叉命令 /fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]：缺省分叉点是最近一次 Run 的任务开始处。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionTree, TREE_MAIN_LANE } from "../pi-runtime/session-tree.ts";
import { newSessionId } from "../state/ids.ts";
import { parseForkCommand, resolveForkPoint, runForkCommand } from "./fork-command.ts";
import { parseLaunchFlags } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { rebuildSessionTree } from "./session-tree.ts";

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

function repo() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-fork-session-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-session-home-"));
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

type Lane = Awaited<ReturnType<Awaited<ReturnType<typeof openSessionTree>>["lanePath"]>>;
const shape = (lane: Lane) =>
  lane.map((entry) => ({ id: entry.id, parentId: entry.parentId, message: entry.message }));

test("启动参数：--retry-on-fail 取非负整数，缺省 0；未允许的入口按未知参数处理", () => {
  assert.equal(parseLaunchFlags([], { usage: "u", retry: true }).retryOnFail, undefined);
  assert.equal(
    parseLaunchFlags(["--retry-on-fail", "2"], { usage: "u", retry: true }).retryOnFail,
    2
  );
  assert.throws(() => parseLaunchFlags(["--retry-on-fail", "-1"], { usage: "u", retry: true }));
  assert.throws(() => parseLaunchFlags(["--retry-on-fail", "1"], { usage: "u" }), /未知参数/);
});

test("主会话 --retry-on-fail 1：失败后后台分叉重试；分叉后来源会话的新 Run 实时写穿，与重建一致", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const sessionId = newSessionId();
    const model = createFakeStreamFn({
      replies: [
        edit("wrong\n"),
        { text: "改好了" },
        edit("new\n"),
        { text: "对了" },
        { text: "第二个问题的回答" },
      ],
    });
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: model,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
      retryOnFail: 1,
    });
    let branchId: string | undefined;
    try {
      assert.equal(opened.bundle.adapter.snapshot().retryOnFail, 1);
      await opened.bundle.adapter.run("把 a.txt 改成 new");
      await opened.verification?.idle();
      await opened.retry?.idle();
      const afterRetry = materializeSession(join(dir, ".pigeon", "sessions"), sessionId);
      branchId = afterRetry.sessionForkeds[0]?.branchSessionId;
      assert.ok(branchId !== undefined, "失败后分叉重试");
      assert.equal(afterRetry.sessionForkeds[0]?.trigger, "retry-on-fail");
      // 分叉后来源会话继续：新 Run 实时写穿进 main 通道
      await opened.bundle.adapter.run("再问一个问题");
      await opened.tree?.idle();
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const source = materializeSession(join(dir, ".pigeon", "sessions"), sessionId);
    const tree = await openSessionTree({ governanceRoot: dir, rootSessionId: sessionId });
    const main = shape(await tree.lanePath(TREE_MAIN_LANE));
    assert.deepEqual(
      main.map((entry) => entry.id),
      source.entries.map((entry) => entry.id),
      "来源会话分叉后的消息也写穿"
    );
    const branch = shape(await tree.lanePath(branchId as string));
    await tree.remove();
    const rebuilt = await rebuildSessionTree({ governanceRoot: dir, rootSessionId: sessionId });
    assert.deepEqual(shape(await rebuilt.lanePath(TREE_MAIN_LANE)), main);
    assert.deepEqual(shape(await rebuilt.lanePath(branchId as string)), branch);
  } finally {
    cleanup();
  }
});

test("/fork 命令：解析 --at 与新输入；缺省分叉点是最近一次 Run 的任务开始处；Run 号可用前缀", async () => {
  assert.deepEqual(parseForkCommand(""), {});
  assert.deepEqual(parseForkCommand('--at 3 "换个思路"'), { at: { runSeq: 3 }, input: "换个思路" });
  assert.deepEqual(parseForkCommand("--at run_01AB:2"), {
    at: { runPrefix: "run_01AB", runSeq: 2 },
  });
  assert.throws(() => parseForkCommand("--at 0"), /--at/);
  const { dir, home, cleanup } = repo();
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: createFakeStreamFn({
        replies: [{ text: "第一次" }, { text: "第二次" }, edit("new\n"), { text: "分支完成" }],
      }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      await opened.bundle.adapter.run("第一个任务");
      await opened.bundle.adapter.run("第二个任务");
      const session = materializeSession(join(dir, ".pigeon", "sessions"), sessionId);
      const [first, second] = session.runStarteds.map((record) => record.runId);
      assert.deepEqual(resolveForkPoint(session, {}), { runId: second, runSeq: 1 });
      assert.deepEqual(resolveForkPoint(session, { runSeq: 2 }), { runId: second, runSeq: 2 });
      assert.deepEqual(
        resolveForkPoint(session, { runPrefix: (first as string).slice(0, -2), runSeq: 1 }),
        { runId: first, runSeq: 1 }
      );
      assert.throws(() => resolveForkPoint(session, { runSeq: 99 }), /没有/);
      const text = await runForkCommand({
        governanceRoot: dir,
        opened,
        args: "",
        run: {
          streamFn: createFakeStreamFn({ replies: [edit("new\n"), { text: "分支完成" }] }),
          yolo: true,
          homeDir: home,
          startMcp: noMcp,
        },
      });
      assert.ok(text.includes("分支会话"), text);
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const session = materializeSession(join(dir, ".pigeon", "sessions"), sessionId);
    assert.equal(session.sessionForkeds[0]?.trigger, "manual");
    assert.equal(session.sessionForkeds[0]?.forkPoint.runId, session.runStarteds[1]?.runId);
  } finally {
    cleanup();
  }
});
