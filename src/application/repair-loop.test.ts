// 回炉（决策 142 / 143 / 147）：headless 路径上验证不过就在同一会话里接着修，到上限或预算耗尽仍失败即以失败收尾，
// 工作区保留 agent 的改动（决策 172 / 173：不做回退）。
// 真实 git 仓库 + 真实装配根 + 可编排的假模型。验证命令是仓库里的 check.mjs：a.txt 内容为 fixed 时退出 0，否则退出 1。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { RunId } from "../state/ids.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import {
  type StoreSessionView,
  storeAttemptLabel,
  storeRepairStepOutcome,
  storeRunFailure,
  storeTaskAttempt,
  storeToolOutcomes,
} from "../state/session-judge.ts";
import { prepareFork } from "./fork.ts";
import { runHeadless } from "./headless.ts";
import { parseLaunchFlags, resolveRepairRounds } from "./launch-flags.ts";
import { REPAIR_FEEDBACK_INSTRUCTION } from "./repair-loop.ts";

const NODE = `"${process.execPath}"`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const CHECK_SCRIPT = [
  'import { readFileSync } from "node:fs";',
  'const content = readFileSync("a.txt", "utf8");',
  'process.stdout.write("a.txt=" + content.trim() + "\\n");',
  'if (content !== "fixed\\n") {',
  '  process.stdout.write("期望 fixed\\n");',
  "  process.exit(1);",
  "}",
].join("\n");

// 造一个未跟踪文件和一个被忽略的文件（agent 在这一步里新造的，修满仍失败后照样留在工作区）
const MAKE_EXTRA_SCRIPT = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'writeFileSync("extra.txt", "agent 新建\\n");',
  'mkdirSync("build", { recursive: true });',
  'writeFileSync("build/out.txt", "构建产物\\n");',
].join("\n");

interface Repo {
  root: string;
  home: string;
  cleanup: () => void;
}

function makeRepo(): Repo {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-repair-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-repair-home-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "pigeon@example.invalid"]);
  git(root, ["config", "user.name", "pigeon-test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "a.txt"), "bug\n");
  writeFileSync(join(root, "check.mjs"), CHECK_SCRIPT);
  writeFileSync(join(root, "make-extra.mjs"), MAKE_EXTRA_SCRIPT);
  // 治理目录 .pigeon/ 不设成忽略：恢复与快照对治理目录的过滤因此真正被测到
  writeFileSync(join(root, ".gitignore"), "build/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return {
    root,
    home,
    cleanup: () => {
      // 超时被杀的验证子进程在 Windows 上可能还占着目录片刻：清理带重试
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

const VERIFY: VerifyConfig = { command: `${NODE} check.mjs`, timeoutMs: 30_000, source: "flag" };

function edit(from: string, to: string): FakeReply {
  return {
    text: `把 ${from} 改成 ${to}`,
    toolCalls: [
      {
        name: "edit_file",
        args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` },
      },
    ],
  };
}

const done = (text = "改好了"): FakeReply => ({ text });

// 读新会话存储里的会话视图（会话必须存在）
function sessionOf(root: string, sessionId: string): StoreSessionView {
  const loaded = loadStoreSession(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(loaded !== undefined, `会话存储里应有会话 ${sessionId}`);
  return loaded.view;
}

// 某次模型调用收到的最后一条用户消息正文
function lastUserText(call: { context: { messages: unknown[] } } | undefined): string {
  const messages = (call?.context.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = messages.findLast((message) => message.role === "user");
  if (last === undefined) {
    return "";
  }
  return typeof last.content === "string"
    ? last.content
    : (last.content as Array<{ type: string; text?: string }>)
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("");
}

test("回炉一轮修好：第一次验证失败、反馈发回同一会话，第二次通过；整步标签为通过", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), done(), edit("half", "fixed"), done("修好了")],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.deepEqual(result.repair, {
      rounds: 1,
      verdict: "pass",
      closed: true,
    });
    assert.equal(result.verification?.verdict, "pass");
    assert.equal(result.label, "Passed");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "fixed\n");
    // 同一会话：两次 Run、两条验证记录，Run 开始条目里冻结了回炉设定
    const view = sessionOf(repo.root, result.sessionId);
    assert.equal(view.runs.length, 2);
    assert.deepEqual(
      view.runs.map((run) => run.start.repairRounds),
      [3, 3]
    );
    assert.deepEqual(
      view.verifications.map((record) => record.data.verdict),
      ["fail", "pass"]
    );
    assert.equal(result.runId, view.runs[0]?.runId, "一步的身份是首个 Run");
    // 整步标签：中间轮的失败不决定这一步的成败——从首个 Run 取值同样是整步结论
    const firstRun = view.runs[0]?.runId;
    assert.ok(firstRun !== undefined);
    assert.equal(storeAttemptLabel(view, firstRun), "Passed");
    assert.equal(
      storeTaskAttempt({ governanceRoot: repo.root, view, runId: firstRun }).label,
      "Passed"
    );
    assert.equal(storeTaskAttempt({ governanceRoot: repo.root, view }).label, "Passed");
    assert.equal(result.turns, 4, "指标按整步汇总：两次 Run 共 4 轮");
    // 对比尝试的轮次与会话里的工具调用同样按整步：两次 Run 各一次成功的 edit_file
    assert.equal(storeTaskAttempt({ governanceRoot: repo.root, view }).turns, 4);
    const edits = storeToolOutcomes(view).filter((outcome) => outcome.toolName === "edit_file");
    assert.deepEqual(
      edits.map((outcome) => [outcome.runId, outcome.failure]),
      view.runs.map((run) => [run.runId, null])
    );
    assert.deepEqual(storeRepairStepOutcome(view), {
      rounds: 1,
      verdict: "pass",
    });
  } finally {
    repo.cleanup();
  }
});

test("回炉整步的失败分类取最后一个 Run：首个 Run 撞输出上限（业务失败），回炉一轮修好后分类为正常收尾", async () => {
  const repo = makeRepo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({
        replies: [
          edit("bug", "half"),
          { text: "写到一半", stopReason: "length" },
          edit("half", "fixed"),
          done("修好了"),
        ],
      }),
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    const view = sessionOf(repo.root, result.sessionId);
    assert.deepEqual(
      view.runs.map((run) => storeRunFailure(run)),
      [{ category: "business" }, null],
      "首个 Run 业务失败、回炉那一轮正常收尾"
    );
    assert.equal(result.repair?.verdict, "pass");
    assert.equal(result.failure, null);
    assert.equal(result.label, "Passed");
  } finally {
    repo.cleanup();
  }
});

test("回炉反馈：带验证命令、退出码、输出末尾与修正要求，以修正要求收尾、不附别的内容（回炉不另推记忆）", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), done(), edit("half", "fixed"), done("修好了")],
    });
    await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    // 第 3 次模型调用是回炉第一轮的开头，收到的最后一条用户消息即反馈
    const feedback = lastUserText(streamFn.calls[2]);
    assert.ok(feedback.includes(VERIFY.command), feedback);
    assert.ok(feedback.includes("退出码：1"), feedback);
    assert.ok(feedback.includes("a.txt=half"), feedback);
    assert.ok(feedback.includes("期望 fixed"), feedback);
    assert.ok(feedback.includes(REPAIR_FEEDBACK_INSTRUCTION), feedback);
    assert.ok(REPAIR_FEEDBACK_INSTRUCTION.includes("修正代码直到验证通过，不要修改测试文件"));
    assert.ok(feedback.includes("第 1/3 轮"), feedback);
    assert.ok(feedback.trimEnd().endsWith(REPAIR_FEEDBACK_INSTRUCTION), feedback);
  } finally {
    repo.cleanup();
  }
});

test("回炉三轮都失败：这一步以失败收尾，工作区保留 agent 的改动，不做任何回退", async () => {
  const repo = makeRepo();
  try {
    const head = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const streamFn = createFakeStreamFn({
      replies: [
        {
          text: "先造点文件",
          toolCalls: [{ name: "run_command", args: { command: `${NODE} make-extra.mjs` } }],
        },
        edit("bug", "w1"),
        done(),
        edit("w1", "w2"),
        done(),
        edit("w2", "w3"),
        done(),
        edit("w3", "w4"),
        done(),
      ],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.deepEqual(result.repair, { rounds: 3, verdict: "fail", closed: true });
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.label, "Failed");
    assert.equal(streamFn.calls.length, 9, "首次 3 次调用加三轮各 2 次，不开第四轮");
    // 工作区是最后一轮修改后的样子：受跟踪文件的改动、新建的未跟踪文件与被忽略的产物都在
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w4\n");
    assert.equal(readFileSync(join(repo.root, "extra.txt"), "utf8"), "agent 新建\n");
    assert.equal(readFileSync(join(repo.root, "build", "out.txt"), "utf8"), "构建产物\n");
    assert.equal(git(repo.root, ["rev-parse", "HEAD"]).trim(), head);
    // 开工忽略清单只为撤回而记，已停写
    assert.equal(git(repo.root, ["for-each-ref", "refs/pigeon/start-ignored/"]).trim(), "");
    // 失败由验证记录体现：这一步的结论取最后一次验证
    const view = sessionOf(repo.root, result.sessionId);
    assert.equal(view.runs.length, 4);
    assert.deepEqual(
      view.verifications.map((record) => record.data.verdict),
      ["fail", "fail", "fail", "fail"]
    );
    assert.deepEqual(storeRepairStepOutcome(view), { rounds: 3, verdict: "fail" });
  } finally {
    repo.cleanup();
  }
});

// 把会话文件截到最后一条验证记录条目之前：即进程崩溃在"最后一个回炉 Run 结束之后、它的验证落盘之前"留下的会话文件
function truncateBeforeLastVerification(root: string, sessionId: string): void {
  const located = locateSessionFile(join(root, ".pigeon", "sessions"), sessionId);
  assert.ok(located !== undefined, "会话存储里应有会话文件");
  const file = located.path;
  const lines = readFileSync(file, "utf8").split("\n");
  const cut = lines.findLastIndex((line) => {
    if (line.trim() === "") {
      return false;
    }
    const entry = JSON.parse(line) as { type?: string; customType?: string };
    return entry.type === "custom" && entry.customType === SessionEntryType.Verification;
  });
  assert.ok(cut > 0, "会话文件里应有验证记录");
  writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
}

test("崩溃窗口：某轮回炉 Run 结束后、其验证落盘前中断——这一步未收尾，标签为未知而不是失败", async () => {
  const repo = makeRepo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({
        replies: [edit("bug", "w1"), done(), edit("w1", "w2"), done()],
      }),
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 1,
    });
    assert.deepEqual(result.repair, { rounds: 1, verdict: "fail", closed: true }, "正常收尾为失败");
    truncateBeforeLastVerification(repo.root, result.sessionId);
    const view = sessionOf(repo.root, result.sessionId);
    // 两个 Run 都有收尾条目，只有首个 Run 有验证记录（失败）
    assert.equal(view.runs.length, 2);
    const [firstRun, lastRun] = view.runs.map((run) => run.runId);
    assert.ok(firstRun !== undefined && lastRun !== undefined);
    assert.equal(view.runs.filter((run) => run.end !== undefined).length, 2, "最后一个 Run 已结束");
    assert.deepEqual(
      view.verifications.map((record) => [record.data.target.runId, record.data.verdict]),
      [[firstRun, "fail"]]
    );
    // 最后一个 Run 没有验证记录即未收尾、没有结论；上一轮的失败验证不作数
    assert.deepEqual(storeRepairStepOutcome(view), { rounds: 1 });
    // 成败标签：中间轮的失败不决定整步，这一步现算为未知
    assert.equal(storeAttemptLabel(view, firstRun), "Unknown");
    assert.equal(storeTaskAttempt({ governanceRoot: repo.root, view }).label, "Unknown");
  } finally {
    repo.cleanup();
  }
});

test("验证无法判定（超时）：不进入回炉，按现有口径记为未知，这一步结束", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [edit("bug", "half"), done()] });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: { command: `${NODE} -e "setTimeout(() => {}, 3000)"`, timeoutMs: 300 },
      repairRounds: 3,
    });
    assert.equal(streamFn.calls.length, 2, "没有开回炉轮");
    assert.deepEqual(result.repair, {
      rounds: 0,
      verdict: "undetermined",
      closed: true,
    });
    assert.equal(result.label, "Unknown");
    assert.equal(
      readFileSync(join(repo.root, "a.txt"), "utf8"),
      "half\n",
      "无法判定时工作区照样保留"
    );
    assert.deepEqual(storeRepairStepOutcome(sessionOf(repo.root, result.sessionId)), {
      rounds: 0,
      verdict: "undetermined",
    });
  } finally {
    repo.cleanup();
  }
});

test("预算耗尽：回炉各轮与首次共用同一个总预算，耗尽即不再回炉、以失败收尾，工作区保留 agent 的改动", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "w1"), done(), edit("w1", "w2"), done(), edit("w2", "fixed"), done()],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
      // 首次用掉 2 轮，回炉第一轮的第 1 轮即用满总预算
      maxTurns: 3,
    });
    assert.equal(result.repair?.rounds, 1, "预算耗尽在第 1 轮回炉，不再开第 2 轮");
    assert.equal(result.repair?.verdict, "fail");
    assert.equal(result.label, "Failed");
    assert.ok(streamFn.calls.length <= 4, String(streamFn.calls.length));
    // 第 3 轮用满即中止，这一轮提议的改动没有执行：工作区保留首次 Run 改到的样子，不回到起点
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w1\n");
    assert.deepEqual(storeRepairStepOutcome(sessionOf(repo.root, result.sessionId)), {
      rounds: 1,
      verdict: "fail",
    });
  } finally {
    repo.cleanup();
  }
});

test("缺省关闭：行为与现状一致——验证失败不回炉、不打快照，Run 开始条目不带回炉设定", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [edit("bug", "half"), done()] });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
    });
    assert.equal(streamFn.calls.length, 2);
    assert.equal(result.repair, undefined);
    assert.equal(result.verification?.verdict, "fail");
    assert.equal(result.label, "Failed");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "half\n");
    const view = sessionOf(repo.root, result.sessionId);
    assert.equal(view.runs.length, 1);
    assert.equal(view.runs[0]?.start.repairRounds, undefined);
    assert.equal(view.runs[0]?.checkpoints.length, 0);
    assert.equal(storeRepairStepOutcome(view), undefined);
  } finally {
    repo.cleanup();
  }
});

test("启动即报错：设了回炉轮数却没有验证命令", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [done()] });
    await assert.rejects(
      runHeadless({
        task: "t",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn,
        yolo: true,
        homeDir: repo.home,
        repairRounds: 3,
      }),
      /回炉.*验证命令/
    );
    assert.equal(streamFn.calls.length, 0, "装配之前就拒绝");
    assert.equal(existsSync(join(repo.root, ".pigeon", "sessions")), false);
  } finally {
    repo.cleanup();
  }
});

test("启动即报错：给了受保护文件，执行端却不能按这一步起点还原（本地工作区）", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [done()] });
    await assert.rejects(
      runHeadless({
        task: "t",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn,
        yolo: true,
        homeDir: repo.home,
        verify: VERIFY,
        repairRounds: 3,
        protectedFiles: () => true,
      }),
      /受保护文件.*无法在验证前还原/
    );
    assert.equal(streamFn.calls.length, 0);
  } finally {
    repo.cleanup();
  }
});

test("启动即报错：回炉与失败自动分叉重试同时开启", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [done()] });
    await assert.rejects(
      runHeadless({
        task: "t",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn,
        yolo: true,
        homeDir: repo.home,
        verify: VERIFY,
        repairRounds: 3,
        retryOnFail: 1,
      }),
      /回炉.*失败自动分叉重试.*不能同时/
    );
    assert.equal(streamFn.calls.length, 0);
  } finally {
    repo.cleanup();
  }
});

test("非 git 工作区开启回炉（决策 281）：不报错、照常跑完回炉循环，只是不打快照", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-repair-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-repair-nogit-home-"));
  try {
    assert.equal(isGitWorkspace(root), false, "前提：临时目录不在任何 git 工作区里");
    writeFileSync(join(root, "a.txt"), "bug\n");
    writeFileSync(join(root, "check.mjs"), CHECK_SCRIPT);
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), done(), edit("half", "fixed"), done("修好了")],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      verify: VERIFY,
      repairRounds: 3,
    });
    // 回炉循环与 git 工作区里一样：首次验证失败、反馈发回同一会话、第二次通过
    assert.equal(streamFn.calls.length, 4);
    assert.deepEqual(result.repair, { rounds: 1, verdict: "pass", closed: true });
    assert.equal(result.verification?.verdict, "pass");
    assert.equal(result.label, "Passed");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "fixed\n");
    const view = sessionOf(root, result.sessionId);
    assert.equal(view.runs.length, 2);
    assert.deepEqual(
      view.runs.map((run) => run.start.repairRounds),
      [3, 3]
    );
    assert.deepEqual(
      view.verifications.map((record) => record.data.verdict),
      ["fail", "pass"]
    );
    assert.deepEqual(storeRepairStepOutcome(view), { rounds: 1, verdict: "pass" });
    // 非 git 工作区不打快照：两个 Run 都没有快照条目
    assert.deepEqual(
      view.runs.map((run) => run.checkpoints.length),
      [0, 0]
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("git 工作区开启回炉：照旧在开工时打快照；/fork 回到回炉中间某一轮取到的是那一轮开工前的工作区", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), done(), edit("half", "fixed"), done("修好了")],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.deepEqual(result.repair, { rounds: 1, verdict: "pass", closed: true });
    const view = sessionOf(repo.root, result.sessionId);
    const [first, second] = view.runs;
    assert.ok(first !== undefined && second !== undefined, "首轮与回炉一轮各一个 Run");
    // 每个 Run 里各一次改动、各一个快照；会话首个快照带改前基线，即这一步开工时的工作区
    const firstCheckpoint = first.checkpoints[0]?.data;
    const secondCheckpoint = second.checkpoints[0]?.data;
    assert.equal(first.checkpoints.length, 1);
    assert.equal(second.checkpoints.length, 1);
    assert.ok(firstCheckpoint !== undefined && secondCheckpoint !== undefined);
    assert.ok(firstCheckpoint.baseCommit !== undefined, "首个快照带改前基线");
    const fileAt = (commit: string): string => git(repo.root, ["show", `${commit}:a.txt`]);
    assert.equal(fileAt(firstCheckpoint.baseCommit), "bug\n", "改前基线是这一步开工时的工作区");
    assert.equal(fileAt(firstCheckpoint.commit), "half\n", "首轮改完的快照");
    assert.equal(fileAt(secondCheckpoint.commit), "fixed\n", "回炉一轮改完的快照");
    assert.equal(secondCheckpoint.baseCommit, undefined, "改前基线只在会话首个快照上");
    // /fork 回到回炉这一轮的开始处（第二个 Run 第 1 条，即回炉反馈）：取到的是首轮改完、这一轮开工前的工作区
    const atRepairRound = await prepareFork({
      governanceRoot: repo.root,
      sourceSessionId: result.sessionId,
      forkPoint: { runId: second.runId, runSeq: 1 },
      trigger: "manual",
    });
    assert.equal(atRepairRound.checkpoint.commit, firstCheckpoint.commit);
    assert.equal(atRepairRound.continueFromHistory, true, "分叉点是回炉反馈（用户消息），直接续跑");
    assert.equal(readFileSync(join(atRepairRound.workspace.path, "a.txt"), "utf8"), "half\n");
    // /fork 回到这一步的任务开始处（首个 Run 第 1 条）：取到的是改前基线
    const atStepStart = await prepareFork({
      governanceRoot: repo.root,
      sourceSessionId: result.sessionId,
      forkPoint: { runId: first.runId, runSeq: 1 },
      trigger: "manual",
    });
    assert.equal(atStepStart.checkpoint.commit, firstCheckpoint.baseCommit);
    assert.equal(readFileSync(join(atStepStart.workspace.path, "a.txt"), "utf8"), "bug\n");
    assert.equal(
      readFileSync(join(repo.root, "a.txt"), "utf8"),
      "fixed\n",
      "用户工作区不受分叉影响"
    );
  } finally {
    try {
      git(repo.root, ["worktree", "prune"]);
    } catch {}
    repo.cleanup();
  }
});

test("回炉轮数的来源：启动参数优先于项目验证配置，缺省为 0", () => {
  const repo = makeRepo();
  try {
    const usage = "用法";
    const none = parseLaunchFlags([], { usage, cwd: repo.root, verify: true, repair: true });
    assert.equal(resolveRepairRounds(none, repo.root), 0);
    mkdirSync(join(repo.root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(repo.root, ".pigeon", "verify.json"),
      JSON.stringify({ version: 1, command: "node check.mjs", repairRounds: 2 })
    );
    assert.equal(resolveRepairRounds(none, repo.root), 2);
    const flagged = parseLaunchFlags(["--repair-rounds", "3"], {
      usage,
      cwd: repo.root,
      verify: true,
      repair: true,
    });
    assert.equal(flagged.repairRounds, 3);
    assert.equal(resolveRepairRounds(flagged, repo.root), 3);
    const off = parseLaunchFlags(["--repair-rounds", "0"], {
      usage,
      cwd: repo.root,
      verify: true,
      repair: true,
    });
    assert.equal(resolveRepairRounds(off, repo.root), 0, "参数给 0 即关闭，压过项目配置");
    assert.throws(
      () => parseLaunchFlags(["--repair-rounds", "-1"], { usage, verify: true, repair: true }),
      /--repair-rounds/
    );
    // 只有 pigeon run 接受（REPL / TUI 与 worker 路径不动）
    assert.throws(
      () => parseLaunchFlags(["--repair-rounds", "3"], { usage, verify: true }),
      /--repair-rounds|未知/
    );
  } finally {
    repo.cleanup();
  }
});

test("回炉途中出现异常：结果仍带回炉字段并标明这一步未收尾", async () => {
  const repo = makeRepo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({ replies: [edit("bug", "half"), done()] }),
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
      // 回炉第一轮开跑时运行面抛错
      onBundle: (bundle) => {
        const run = bundle.adapter.run.bind(bundle.adapter);
        let calls = 0;
        bundle.adapter.run = (async (task: string) => {
          calls += 1;
          if (calls === 2) {
            throw new Error("运行面故障");
          }
          return run(task);
        }) as typeof bundle.adapter.run;
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /运行面故障/);
    // 回炉那一轮没开起来：轮数按会话记录的推法（Run 数减 1）为 0
    assert.equal(sessionOf(repo.root, result.sessionId).runs.length, 1);
    assert.deepEqual(result.repair, {
      rounds: 0,
      verdict: "fail",
      closed: false,
    });
    assert.equal(
      readFileSync(join(repo.root, "a.txt"), "utf8"),
      "half\n",
      "未收尾时工作区照样保留"
    );
  } finally {
    repo.cleanup();
  }
});

test("token 预算整步共用：首次与回炉一轮各自都没到上限，合起来到了即不再回炉、以失败收尾", async () => {
  const repo = makeRepo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({
        replies: [
          edit("bug", "w1"),
          done(),
          { text: "想".repeat(1100) },
          edit("w1", "fixed"),
          done(),
        ],
      }),
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
      maxTokens: 1200,
    });
    const view = sessionOf(repo.root, result.sessionId);
    const [firstRun, secondRun] = view.runs.map((run) => run.runId);
    // 一个 Run 各轮助手消息的 token 用量之和
    const tokensOf = (runId: RunId | undefined) =>
      (view.runs.find((run) => run.runId === runId)?.messages ?? [])
        .filter((ref) => ref.message.role === "assistant")
        .reduce((sum, ref) => sum + (ref.message.usage?.totalTokens ?? 0), 0);
    assert.ok(tokensOf(firstRun) > 0 && tokensOf(firstRun) < 1200, String(tokensOf(firstRun)));
    assert.ok(tokensOf(secondRun) > 0 && tokensOf(secondRun) < 1200, String(tokensOf(secondRun)));
    assert.equal(view.runs.length, 2, "不开第 2 轮回炉");
    assert.equal(result.repair?.rounds, 1);
    assert.equal(result.repair?.verdict, "fail");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w1\n");
  } finally {
    repo.cleanup();
  }
});

test("墙钟预算计入验证耗时：Run 内没到点、验证期间到点，即不再回炉、以失败收尾", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "w1"), done(), edit("w1", "fixed"), done()],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      // 验证命令本身就比墙钟预算长
      verify: {
        command: `${NODE} -e "setTimeout(() => process.exit(1), 9000)"`,
        timeoutMs: 30_000,
      },
      repairRounds: 3,
      wallClockMs: 5000,
    });
    const view = sessionOf(repo.root, result.sessionId);
    // 一个 Run、一条失败的验证记录
    assert.equal(view.runs.length, 1);
    assert.deepEqual(
      view.verifications.map((record) => record.data.verdict),
      ["fail"]
    );
    assert.equal(result.status, "completed", "首个 Run 以完成收尾，不是被墙钟中止");
    assert.deepEqual(
      view.runs.map((run) => run.end?.ending),
      ["completed"],
      "首个 Run 在墙钟到点之前正常收尾"
    );
    assert.equal(streamFn.calls.length, 2, "不开回炉轮");
    assert.equal(result.repair?.rounds, 0);
    assert.equal(result.repair?.verdict, "fail");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w1\n");
  } finally {
    repo.cleanup();
  }
});

test("空回复异常结束（决策 170 ②）：重试一次仍空，照常验证一次后不再回炉；终态 empty-reply，重试那一轮计入整步轮数", async () => {
  const repo = makeRepo();
  try {
    // 第 2 次调用空回复，第 3 次（重试）仍空；此后若再回炉会拿到 edit，不该发生
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), { text: "" }, { text: "" }, edit("half", "fixed"), done()],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.equal(streamFn.calls.length, 3, "空回复只重试一次，之后不开回炉轮");
    assert.equal(result.status, "empty-reply");
    assert.match(result.errorMessage ?? "", /空回复/);
    assert.deepEqual(result.failure, { category: "business" });
    assert.deepEqual(result.repair, { rounds: 0, verdict: "fail", closed: true });
    assert.equal(result.turns, 3, "重试那一轮计入轮数");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "half\n");
    const session = sessionOf(repo.root, result.sessionId);
    assert.equal(session.runs.length, 1);
    assert.deepEqual(storeRepairStepOutcome(session), { rounds: 0, verdict: "fail" });
  } finally {
    repo.cleanup();
  }
});

test("空回复重试一次即有内容：同一个 Run 里接着做完，回炉照常", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [{ text: "" }, edit("bug", "fixed"), done()],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: VERIFY,
      repairRounds: 3,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.repair, { rounds: 0, verdict: "pass", closed: true });
    assert.equal(result.turns, 3);
    assert.equal(sessionOf(repo.root, result.sessionId).runs.length, 1);
  } finally {
    repo.cleanup();
  }
});
