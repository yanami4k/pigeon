// 打转检测在 pigeon run 上（决策 305–308）：真实装配根 + 重复同一轮的假模型。
// 新状态 looping 与退出码、提醒进下一轮并留在会话记录、第 20 轮叫停且之后不再发模型请求、Run 收尾记结束方式为打转、
// 叫停后照常结束（验证与回炉已随决策 322 删除）、标签算失败、关掉即不管；真实形状（每轮两条相同的 run_command）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import {
  DEFAULT_LOOP_GUARD_SETTINGS,
  DISABLED_LOOP_GUARD_SETTINGS,
} from "../state/loop-guard-config.ts";
import type { StoreSessionView } from "../state/session-judge.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "./headless-core.ts";
import { loadSessionHistory } from "./history.ts";
import { LOOP_REMINDER_PREFIX } from "./loop-guard.ts";

const NODE = `"${process.execPath}"`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): { root: string; home: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-loop-run-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-loop-run-home-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "pigeon@example.invalid"]);
  git(root, ["config", "user.name", "pigeon-test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

const READ_AGAIN: FakeReply = {
  text: "再看一眼",
  toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
};

// 每轮同一条读文件：回复用完即重复最后一条
function looping(): FakeStreamFn {
  return createFakeStreamFn({ replies: [READ_AGAIN] });
}

function sessionOf(root: string, sessionId: string): StoreSessionView {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined);
  return loaded.view;
}

function userTexts(call: { context: { messages: unknown[] } } | undefined): string[] {
  const messages = (call?.context.messages ?? []) as Array<{ role: string; content: unknown }>;
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ type: string; text?: string }>)
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .join("")
    );
}

const reminders = (texts: readonly string[]) =>
  texts.filter((text) => text.startsWith(LOOP_REMINDER_PREFIX));

test("pigeon run：第 5 轮提醒、第 10 轮再提醒、第 20 轮叫停；新状态 looping 与退出码 9，收尾记结束方式为打转，标签失败", async () => {
  const repo = makeRepo();
  try {
    const streamFn = looping();
    const result = await runHeadless({
      task: "看看 a.ts",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      maxTurns: 200,
      loopGuard: DEFAULT_LOOP_GUARD_SETTINGS,
    });
    assert.equal(result.status, "looping");
    assert.equal(HEADLESS_EXIT_CODES[result.status], 9);
    // 退出码接在现有的之后、各不相同
    assert.equal(
      new Set(Object.values(HEADLESS_EXIT_CODES)).size,
      Object.keys(HEADLESS_EXIT_CODES).length
    );
    assert.equal(result.label, "Failed");
    assert.equal(result.looping?.count, 20);
    assert.equal(result.looping?.pattern[0]?.calls[0]?.toolName, "read_file");
    // 第 1 轮原样、其后 20 轮重复：叫停后不再有带内容的模型请求（中止中的请求至多一条且不产出）
    assert.ok(result.turns <= 22, `turns=${result.turns}`);
    assert.ok(streamFn.calls.length <= 22, `calls=${streamFn.calls.length}`);
    // 提醒进下一轮：第 6 轮结束（计数 5）后的请求里有第一次提醒，第 11 轮结束后的请求里有第二次提醒
    assert.deepEqual(reminders(userTexts(streamFn.calls[5])), []);
    const first = reminders(userTexts(streamFn.calls[6]));
    assert.equal(first.length, 1);
    assert.match(
      first[0] ?? "",
      /^\[打转提醒\] [^\n]*5 轮[^\n]*\n- read_file \{"path":"a\.ts"\}\n {4}结果：/
    );
    assert.match(first[0] ?? "", /重复同样的调用不会带来新信息。请换一个思路/);
    const second = reminders(userTexts(streamFn.calls[11]));
    assert.equal(second.length, 2);
    assert.match(second[1] ?? "", /^\[打转提醒\] 这是第二次提醒。最近连续 10 轮/);
    assert.match(second[1] ?? "", /如果再重复 10 轮，本次运行将被叫停。/);
    // 会话记录里留作用户消息；Run 收尾的结束方式为打转
    const view = sessionOf(repo.root, result.sessionId);
    const stored = view.runs.flatMap((run) =>
      run.messages
        .filter((ref) => ref.message.role === "user")
        .map((ref) => JSON.stringify(ref.message.content))
    );
    assert.equal(stored.filter((text) => text.includes("[打转提醒]")).length, 2);
    assert.equal(view.runs.at(-1)?.end?.ending, "looping");
    assert.equal(view.runs.length, 1, "照常结束，不多开 Run");
    // /resume 回看历史：两次提醒都是系统行，不显示成人输入的话
    const history = loadSessionHistory(repo.root, result.sessionId);
    const shown = history.filter((line) => line.text.includes("[打转提醒]"));
    assert.equal(shown.length, 2);
    assert.ok(shown.every((line) => line.kind === "notice" && line.text.startsWith("[打转提醒]")));
    assert.ok(history.some((line) => line.kind === "user" && line.text === "> 看看 a.ts"));
  } finally {
    repo.cleanup();
  }
});

test("pigeon run：关掉即不提醒、不叫停，照旧撞轮数上限", async () => {
  const repo = makeRepo();
  try {
    const streamFn = looping();
    const result = await runHeadless({
      task: "看看 a.ts",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      maxTurns: 25,
      loopGuard: DISABLED_LOOP_GUARD_SETTINGS,
    });
    assert.equal(result.status, "turn-limit");
    assert.equal(result.looping, undefined);
    assert.deepEqual(reminders(streamFn.calls.flatMap((call) => userTexts(call))), []);
  } finally {
    repo.cleanup();
  }
});

test("pigeon run：改过的轮数照配置叫停", async () => {
  const repo = makeRepo();
  try {
    const result = await runHeadless({
      task: "看看 a.ts",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: looping(),
      yolo: true,
      homeDir: repo.home,
      maxTurns: 200,
      loopGuard: { ...DEFAULT_LOOP_GUARD_SETTINGS, remindAt: 2, warnAt: 3, stopAt: 4 },
    });
    assert.equal(result.status, "looping");
    assert.equal(result.looping?.count, 4);
    assert.ok(result.turns <= 6, `turns=${result.turns}`);
  } finally {
    repo.cleanup();
  }
});

test("真实形状：每轮两条相同的 run_command、结果相同——第 20 轮叫停，花费止于此", async () => {
  const repo = makeRepo();
  try {
    const round: FakeReply = {
      text: "再跑一次",
      toolCalls: [
        {
          name: "run_command",
          args: { command: `${NODE} -e "console.log('FAIL src/a.test.ts')"` },
        },
        {
          name: "run_command",
          args: { command: `${NODE} -e "console.log('export const a = 1;')"` },
        },
      ],
    };
    const streamFn = createFakeStreamFn({ replies: [round] });
    const result = await runHeadless({
      task: "修好测试",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      // 正式跑里打转连续数百轮才撞上限
      maxTurns: 600,
      loopGuard: DEFAULT_LOOP_GUARD_SETTINGS,
    });
    assert.equal(result.status, "looping");
    assert.equal(result.looping?.count, 20);
    assert.equal(result.looping?.pattern[0]?.calls.length, 2);
    // run_command 的文件变化不含治理目录（会话文件的新建与修改不进结果）：第 1 轮起各轮相同，计到 20 在第 21 轮；
    // 叫停后至多一条被中止的请求，不再有工具调用
    assert.ok(streamFn.calls.length <= 22, `calls=${streamFn.calls.length}`);
    assert.ok(result.toolCalls <= 42, `toolCalls=${result.toolCalls}`);
  } finally {
    repo.cleanup();
  }
});

test("run_command 的文件变化不含治理目录：同一条命令连续两轮、期间只有会话文件在变，两轮结果逐字相同，打转从第 2 轮起计数", async () => {
  const repo = makeRepo();
  try {
    const round: FakeReply = {
      text: "再跑一次",
      toolCalls: [{ name: "run_command", args: { command: `${NODE} -e "console.log('same')"` } }],
    };
    const streamFn = createFakeStreamFn({ replies: [round] });
    const result = await runHeadless({
      task: "跑一下",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      maxTurns: 50,
      loopGuard: { ...DEFAULT_LOOP_GUARD_SETTINGS, remindAt: 1, warnAt: 2, stopAt: 3 },
    });
    assert.equal(result.status, "looping");
    const texts = sessionOf(repo.root, result.sessionId)
      .runs.flatMap((run) => run.messages.map((ref) => ref.message))
      .filter((message) => message.role === "toolResult")
      .map((message) =>
        (message.content as Array<{ type: string; text?: string }>)
          .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
          .join("")
      );
    assert.ok(texts.length >= 2, `toolResults=${texts.length}`);
    assert.equal(texts[1], texts[0]);
    assert.doesNotMatch(texts[0] ?? "", /\.pigeon/);
    // 第 2 轮与第 1 轮相同即计 1：第 2 轮结束后的请求（第 3 次）里已有第一次提醒
    assert.deepEqual(reminders(userTexts(streamFn.calls[1])), []);
    assert.equal(reminders(userTexts(streamFn.calls[2])).length, 1);
  } finally {
    repo.cleanup();
  }
});
