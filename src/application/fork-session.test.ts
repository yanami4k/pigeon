// 主会话的分叉接线（M7 S6，决策 077 / 079）：
// - 分叉读写会话存储（账本重构 177 / 180）：来源会话文件记分叉条目，分支会话文件由 pi 的 fork 复制分叉点之前的历史，
//   分支运行面在它上面续写；来源会话此后的 Run 照常写进自己的文件（派生会话树的写穿随之去掉）；
// - 手动分叉命令 /fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]：缺省分叉点是最近一次 Run 的任务开始处。
// 失败自动分叉重试（--retry-on-fail）随决策 322 删除。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { parseForkCommand, resolveForkPoint, runForkCommand } from "./fork-command.ts";
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

function repo() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-fork-session-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-session-home-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "old\n");
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
      const loaded = loadStoreSession(join(dir, ".pigeon", "state", "sessions"), sessionId);
      assert.ok(loaded !== undefined);
      const session = loaded.view;
      const [first, second] = session.runs.map((run) => run.runId);
      assert.deepEqual(resolveForkPoint(session, {}), { runId: second, runSeq: 1 });
      assert.deepEqual(resolveForkPoint(session, { runSeq: 2 }), { runId: second, runSeq: 2 });
      // 两次 Run 号的最长公共前缀：同一毫秒开始的两次 Run 只差随机部分末位，前缀长短随时序而变，
      // 所以按公共前缀取——公共前缀本身两次都匹配、报不唯一，多取一位即只匹配第一次
      const a = first as string;
      const b = second as string;
      let common = 0;
      while (common < a.length && a[common] === b[common]) common += 1;
      assert.throws(
        () => resolveForkPoint(session, { runPrefix: a.slice(0, common), runSeq: 1 }),
        /不唯一（2 个）/
      );
      assert.deepEqual(
        resolveForkPoint(session, { runPrefix: a.slice(0, common + 1), runSeq: 1 }),
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
    const after = loadStoreSession(join(dir, ".pigeon", "state", "sessions"), sessionId);
    assert.ok(after !== undefined);
    assert.equal(after.view.forks.length, 1);
    assert.equal(after.view.forks[0]?.data.trigger, "manual");
    assert.deepEqual(after.view.forks[0]?.data.forkPoint, {
      runId: after.view.runs[1]?.runId,
      runSeq: 1,
    });
    // 分支会话文件已建，文件头指向来源会话
    const branch = loadStoreSession(
      join(dir, ".pigeon", "state", "sessions"),
      after.view.forks[0]?.data.branchSessionId ?? ""
    );
    assert.equal(branch?.file.header.parentSessionId, sessionId);
  } finally {
    cleanup();
  }
});
