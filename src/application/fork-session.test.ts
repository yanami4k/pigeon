// 主会话的分叉接线（M7 S6，决策 077 / 079）：
// - --retry-on-fail 解析、按会话冻结；主会话一次尝试验证为失败后在后台从任务开始处分叉重试；
// - 分叉读写会话存储（账本重构 177 / 180）：来源会话文件记分叉条目，分支会话文件由 pi 的 fork 复制分叉点之前的历史，
//   分支运行面在它上面续写；来源会话此后的 Run 照常写进自己的文件（派生会话树的写穿随之去掉）；
// - 手动分叉命令 /fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]：缺省分叉点是最近一次 Run 的任务开始处。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { parseForkCommand, resolveForkPoint, runForkCommand } from "./fork-command.ts";
import { parseLaunchFlags } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

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

test("启动参数：--retry-on-fail 取非负整数，缺省 0；未允许的入口按未知参数处理", () => {
  assert.equal(parseLaunchFlags([], { usage: "u", retry: true }).retryOnFail, undefined);
  assert.equal(
    parseLaunchFlags(["--retry-on-fail", "2"], { usage: "u", retry: true }).retryOnFail,
    2
  );
  assert.throws(() => parseLaunchFlags(["--retry-on-fail", "-1"], { usage: "u", retry: true }));
  assert.throws(() => parseLaunchFlags(["--retry-on-fail", "1"], { usage: "u" }), /未知参数/);
});

test("主会话 --retry-on-fail 1：失败后后台分叉重试；分支文件从来源复制分叉点之前的历史，来源会话此后的 Run 照常写进自己的文件", async () => {
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
      await opened.bundle.sessionStore.flush();
      const afterRetry = loadStoreSession(join(dir, ".pigeon", "sessions"), sessionId);
      assert.ok(afterRetry !== undefined);
      assert.equal(afterRetry.view.forks.length, 1, "失败后分叉重试一次");
      branchId = afterRetry.view.forks[0]?.data.branchSessionId;
      assert.ok(branchId !== undefined, "失败后分叉重试");
      assert.equal(afterRetry.view.forks[0]?.data.trigger, "retry-on-fail");
      // 分叉后来源会话继续：新 Run 照常写进来源会话自己的文件
      await opened.bundle.adapter.run("再问一个问题");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const source = loadStoreSession(sessionsDir, sessionId);
    assert.ok(source !== undefined);
    assert.equal(source.view.runs.length, 2);
    assert.equal(source.view.forks[0]?.data.branchSessionId, branchId);
    assert.equal(source.view.forks[0]?.data.trigger, "retry-on-fail");
    const branch = loadStoreSession(sessionsDir, branchId as string);
    assert.ok(branch !== undefined);
    // 分支文件开头是来源会话首个 Run 的开始条目与任务消息（复制段），之后是分支自己的 Run
    assert.equal(branch.file.header.parentSessionId, sessionId);
    const copiedStart = branch.main[0];
    assert.equal(copiedStart?.type, "custom");
    assert.equal(
      (copiedStart?.data as { runId?: string } | undefined)?.runId,
      source.view.runs[0]?.runId
    );
    assert.equal(branch.view.runs.length, 1);
    assert.notEqual(branch.view.runs[0]?.runId, source.view.runs[0]?.runId);
    assert.equal(branch.view.runs[0]?.end?.ending, "completed");
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
      await opened.bundle.sessionStore.flush();
      const loaded = loadStoreSession(join(dir, ".pigeon", "sessions"), sessionId);
      assert.ok(loaded !== undefined);
      const session = loaded.view;
      const [first, second] = session.runs.map((run) => run.runId);
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
    const after = loadStoreSession(join(dir, ".pigeon", "sessions"), sessionId);
    assert.ok(after !== undefined);
    assert.equal(after.view.forks.length, 1);
    assert.equal(after.view.forks[0]?.data.trigger, "manual");
    assert.deepEqual(after.view.forks[0]?.data.forkPoint, {
      runId: after.view.runs[1]?.runId,
      runSeq: 1,
    });
    // 分支会话文件已建，文件头指向来源会话
    const branch = loadStoreSession(
      join(dir, ".pigeon", "sessions"),
      after.view.forks[0]?.data.branchSessionId ?? ""
    );
    assert.equal(branch?.file.header.parentSessionId, sessionId);
  } finally {
    cleanup();
  }
});

test("主会话 --retry-on-fail 1、不配验证命令：Run 收尾后按新存储现算的标签判失败（输出截断即业务失败）并分叉重试", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: createFakeStreamFn({
        replies: [{ text: "说到一半", stopReason: "length" }, { text: "这次说完了" }],
      }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      retryOnFail: 1,
    });
    try {
      await opened.bundle.adapter.run("讲个完整的故事");
      await opened.retry?.idle();
      assert.deepEqual(opened.retry?.errors(), []);
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const source = loadStoreSession(join(dir, ".pigeon", "sessions"), sessionId);
    assert.ok(source !== undefined);
    assert.equal(source.view.runs[0]?.end?.stopReason, "length");
    assert.deepEqual(
      source.view.forks.map((fork) => fork.data.trigger),
      ["retry-on-fail"],
      "标签判为失败才分叉重试"
    );
  } finally {
    cleanup();
  }
});
