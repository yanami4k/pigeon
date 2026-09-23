// 回炉（决策 142 / 143 / 147）：headless 路径上验证不过就在同一会话里接着修，到上限或预算耗尽仍失败即按快照撤回。
// 真实 git 仓库 + 真实装配根 + 可编排的假模型。验证命令是仓库里的 check.mjs：a.txt 内容为 fixed 时退出 0，否则退出 1。
// "逐字一致"的范围是快照覆盖的范围：受跟踪的文件，加上未跟踪且未被忽略的文件；被忽略的文件与治理目录不在范围内。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeProcess } from "../eval/process.ts";
import { createCheckpointer, restoreWorkspaceTo } from "../orchestration/checkpoint.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import { buildTaskAttempt } from "../state/episode.ts";
import { newSessionId } from "../state/ids.ts";
import { attemptOutcomeFacts, labelAttempt } from "../state/outcome-label.ts";
import { repairStepOutcome } from "../state/repair-step.ts";
import { runHeadless } from "./headless.ts";
import { parseLaunchFlags, resolveRepairRounds } from "./launch-flags.ts";
import { REPAIR_FEEDBACK_INSTRUCTION, restoreStepStart } from "./repair-loop.ts";

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

// 造一个未跟踪文件（在快照范围内）和一个被忽略的文件（不在范围内）
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

// 快照范围内的文件清单与内容（受跟踪 + 未跟踪且未被忽略；排除治理目录）
function scopeState(root: string): Record<string, string> {
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((name) => name !== "" && !name.startsWith(".pigeon/"))
    .sort();
  return Object.fromEntries(
    files.map((name) => [
      name,
      existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "<缺失>",
    ])
  );
}

function sessionOf(root: string, sessionId: string) {
  return materializeSession(join(root, ".pigeon", "sessions"), sessionId as never, {
    content: false,
  });
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
      reverted: false,
      budgetExhausted: false,
      restored: false,
    });
    assert.equal(result.verification?.verdict, "pass");
    assert.equal(result.label, "Passed");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "fixed\n");
    // 同一会话：两次 Run、两条验证记录，run.started 里冻结了回炉设定
    const session = sessionOf(repo.root, result.sessionId);
    assert.equal(session.runStarteds.length, 2);
    assert.deepEqual(
      session.runStarteds.map((record) => record.payload.repairRounds),
      [3, 3]
    );
    assert.deepEqual(
      session.attemptVerifieds.map((record) => record.verdict),
      ["fail", "pass"]
    );
    assert.equal(result.runId, session.runStarteds[0]?.runId, "一步的身份是首个 Run");
    // 整步标签：中间轮的失败不决定这一步的成败——从首个 Run 取值同样是整步结论
    const firstRun = session.runStarteds[0]?.runId;
    assert.ok(firstRun !== undefined);
    assert.equal(labelAttempt(attemptOutcomeFacts(session, firstRun)), "Passed");
    assert.equal(
      buildTaskAttempt({ governanceRoot: repo.root, session, runId: firstRun }).label,
      "Passed"
    );
    assert.equal(buildTaskAttempt({ governanceRoot: repo.root, session }).label, "Passed");
    assert.equal(result.turns, 4, "指标按整步汇总：两次 Run 共 4 轮");
    // 对比尝试的轮次与过程指标同样按整步：两次 Run 各一次 edit_file
    assert.equal(buildTaskAttempt({ governanceRoot: repo.root, session }).turns, 4);
    assert.equal(
      summarizeProcess({
        sessionsDir: join(repo.root, ".pigeon", "sessions"),
        sessionId: result.sessionId,
        editMode: "replace",
      }).tools.edit_file?.calls,
      2
    );
    assert.deepEqual(repairStepOutcome(session), {
      rounds: 1,
      verdict: "pass",
      reverted: false,
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
    const session = sessionOf(repo.root, result.sessionId);
    assert.deepEqual(
      session.classification.runs.map((entry) => entry.failure),
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

test("回炉反馈：带验证命令、退出码、输出末尾与修正要求；附加内容注入点默认为空，给了就附在末尾", async () => {
  for (const appendix of [undefined, "相关记忆：a.txt 上次也是这样修的"]) {
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
        ...(appendix !== undefined ? { repairAppendix: () => appendix } : {}),
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
      if (appendix === undefined) {
        assert.ok(feedback.trimEnd().endsWith(REPAIR_FEEDBACK_INSTRUCTION), feedback);
      } else {
        assert.ok(feedback.trimEnd().endsWith(appendix), feedback);
      }
    } finally {
      repo.cleanup();
    }
  }
});

test("回炉三轮都失败：按快照撤回，快照范围内与第一个 Run 之前逐字一致；账本推出已撤回；恢复可重复执行", async () => {
  const repo = makeRepo();
  try {
    const before = scopeState(repo.root);
    const head = git(repo.root, ["rev-parse", "HEAD"]).trim();
    // 治理目录里一个未被忽略、目标树里没有的文件：恢复若不过滤治理目录就会把它当作多余文件删掉
    mkdirSync(join(repo.root, ".pigeon"), { recursive: true });
    writeFileSync(join(repo.root, ".pigeon", "probe.txt"), "治理目录探针\n");
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
    assert.deepEqual(result.repair, {
      rounds: 3,
      verdict: "fail",
      closed: true,
      reverted: true,
      budgetExhausted: false,
      restored: true,
    });
    // 治理目录不在恢复范围内：探针文件（未被忽略、目标树里没有）原样还在
    assert.equal(readFileSync(join(repo.root, ".pigeon", "probe.txt"), "utf8"), "治理目录探针\n");
    assert.equal(result.label, "Failed");
    assert.equal(streamFn.calls.length, 9, "首次 3 次调用加三轮各 2 次，不开第四轮");
    // 快照范围内逐字一致：改过的受跟踪文件还原、新建的未跟踪文件删掉
    assert.deepEqual(scopeState(repo.root), before);
    assert.equal(existsSync(join(repo.root, "extra.txt")), false);
    // 范围外：被忽略的文件不动；用户的 HEAD 不动
    assert.equal(readFileSync(join(repo.root, "build", "out.txt"), "utf8"), "构建产物\n");
    assert.equal(git(repo.root, ["rev-parse", "HEAD"]).trim(), head);
    // 账本不新增记录：回炉开启且最后一次验证为失败即推出已撤回
    const session = sessionOf(repo.root, result.sessionId);
    assert.equal(session.runStarteds.length, 4);
    assert.deepEqual(repairStepOutcome(session), { rounds: 3, verdict: "fail", reverted: true });
    // 恢复可重复执行：崩溃在最后一次验证之后、恢复之前时，续跑再执行一次即可
    const again = restoreStepStart({
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      sessionId: result.sessionId,
    });
    assert.equal(again.restored, true);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

// 把会话文件截到最后一条验证记录之前：即进程崩溃在"最后一个回炉 Run 结束之后、它的验证落盘之前"留下的账本
function truncateBeforeLastVerification(root: string, sessionId: string): void {
  const file = JsonlEventLog.filePathFor(join(root, ".pigeon", "sessions"), sessionId as never);
  const lines = readFileSync(file, "utf8").split("\n");
  const cut = lines.findLastIndex(
    (line) =>
      line.trim() !== "" && (JSON.parse(line) as { kind?: string }).kind === "attempt.verified"
  );
  assert.ok(cut > 0, "会话文件里应有验证记录");
  writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
}

test("崩溃窗口：某轮回炉 Run 结束后、其验证落盘前中断——推为未撤回、这一步未收尾，标签为未知而不是失败", async () => {
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
    assert.equal(result.repair?.reverted, true, "正常收尾时撤回");
    truncateBeforeLastVerification(repo.root, result.sessionId);
    const session = sessionOf(repo.root, result.sessionId);
    // 两个 Run 都有运行结束记录，只有首个 Run 有验证记录（失败）
    assert.equal(session.runStarteds.length, 2);
    const [firstRun, lastRun] = session.runStarteds.map((record) => record.runId);
    assert.ok(firstRun !== undefined && lastRun !== undefined);
    assert.equal(
      session.runtimeEvents.filter((event) => event.kind === "run.ended").length,
      2,
      "最后一个 Run 已结束"
    );
    assert.deepEqual(
      session.attemptVerifieds.map((record) => [record.target.runId, record.verdict]),
      [[firstRun, "fail"]]
    );
    // 收紧后的规则：最后一个 Run 没有验证记录即未收尾、推为未撤回；上一轮的失败验证不作数
    assert.deepEqual(repairStepOutcome(session), { rounds: 1, reverted: false });
    // 成败标签：中间轮的失败不决定整步，这一步现算为未知
    assert.equal(labelAttempt(attemptOutcomeFacts(session, firstRun)), "Unknown");
    assert.equal(buildTaskAttempt({ governanceRoot: repo.root, session }).label, "Unknown");
  } finally {
    repo.cleanup();
  }
});

test("崩溃窗口：最后一次验证失败后、恢复前中断——推为已撤回，续跑从账本找到起点重新恢复，结果相同", async () => {
  const repo = makeRepo();
  try {
    const before = scopeState(repo.root);
    // 只给 1 轮且两次验证都失败，这一步照常撤回；再把工作区弄脏，模拟崩溃在恢复之前留下的现场
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
    assert.equal(result.repair?.reverted, true);
    writeFileSync(join(repo.root, "a.txt"), "w2\n");
    writeFileSync(join(repo.root, "stray.txt"), "残留\n");
    // 恢复不写账本：崩溃在恢复之前的账本与正常收尾的相同，推出已撤回，续跑据此重新恢复
    const session = sessionOf(repo.root, result.sessionId);
    assert.deepEqual(repairStepOutcome(session), { rounds: 1, verdict: "fail", reverted: true });
    assert.equal(buildTaskAttempt({ governanceRoot: repo.root, session }).label, "Failed");
    const first = restoreStepStart({
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      sessionId: result.sessionId,
    });
    const second = restoreStepStart({
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      sessionId: result.sessionId,
    });
    assert.equal(first.restored, true);
    assert.equal(second.restored, true);
    assert.deepEqual(scopeState(repo.root), before);
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
      reverted: false,
      budgetExhausted: false,
      restored: false,
    });
    assert.equal(result.label, "Unknown");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "half\n", "无法判定不撤回");
    assert.deepEqual(repairStepOutcome(sessionOf(repo.root, result.sessionId)), {
      rounds: 0,
      verdict: "undetermined",
      reverted: false,
    });
  } finally {
    repo.cleanup();
  }
});

test("预算耗尽：回炉各轮与首次共用同一个总预算，耗尽即不再回炉、提前撤回", async () => {
  const repo = makeRepo();
  try {
    const before = scopeState(repo.root);
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
    assert.equal(result.repair?.budgetExhausted, true);
    assert.equal(result.repair?.reverted, true);
    assert.equal(result.repair?.restored, true);
    assert.equal(result.repair?.rounds, 1, "预算耗尽在第 1 轮回炉，不再开第 2 轮");
    assert.equal(result.repair?.verdict, "fail");
    assert.equal(result.label, "Failed");
    assert.ok(streamFn.calls.length <= 4, String(streamFn.calls.length));
    assert.deepEqual(scopeState(repo.root), before);
    assert.equal(repairStepOutcome(sessionOf(repo.root, result.sessionId))?.reverted, true);
  } finally {
    repo.cleanup();
  }
});

test("缺省关闭：行为与现状一致——验证失败不回炉、不撤回、不打快照，run.started 不带回炉设定", async () => {
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
    const session = sessionOf(repo.root, result.sessionId);
    assert.equal(session.runStarteds.length, 1);
    assert.equal(session.runStarteds[0]?.payload.repairRounds, undefined);
    assert.equal(session.checkpoints.length, 0);
    assert.equal(repairStepOutcome(session), undefined);
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

test("启动即报错：开启回炉却没有可用快照（非 git 工作区）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-repair-nogit-"));
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    const streamFn = createFakeStreamFn({ replies: [done()] });
    await assert.rejects(
      runHeadless({
        task: "t",
        governanceRoot: root,
        workspaceRoot: join(root, "sub"),
        streamFn,
        yolo: true,
        homeDir: root,
        verify: VERIFY,
        repairRounds: 3,
      }),
      /回炉.*快照/
    );
    assert.equal(streamFn.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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

// 截获标准错误（去重告警走这里）
async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), lines };
  } finally {
    process.stderr.write = original;
  }
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

test("恢复：agent 删掉忽略规则后，原本被忽略的依赖目录不被当作多余文件删掉", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo.root, ".gitignore"), "build/\nnode_modules/\n");
    const start = commitAll(repo.root, "忽略依赖目录");
    mkdirSync(join(repo.root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo.root, "node_modules", "dep", "index.js"), "依赖\n");
    // 依赖目录自带的 .gitignore：在被忽略的目录里，不算 agent 新建的忽略文件
    writeFileSync(join(repo.root, "node_modules", "dep", ".gitignore"), "*.log\n");
    const before = scopeState(repo.root);
    // agent 删掉了 node_modules/ 这条忽略规则
    writeFileSync(join(repo.root, ".gitignore"), "build/\n");
    restoreWorkspaceTo(repo.root, start);
    assert.equal(
      readFileSync(join(repo.root, "node_modules", "dep", "index.js"), "utf8"),
      "依赖\n"
    );
    assert.equal(
      readFileSync(join(repo.root, "node_modules", "dep", ".gitignore"), "utf8"),
      "*.log\n"
    );
    assert.equal(readFileSync(join(repo.root, ".gitignore"), "utf8"), "build/\nnode_modules/\n");
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("恢复：agent 新增忽略规则后，被它隐藏的新文件一次恢复即被删掉", () => {
  const repo = makeRepo();
  try {
    const start = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const before = scopeState(repo.root);
    // agent 新建 secret.txt，又加了一条规则把它藏起来
    writeFileSync(join(repo.root, "secret.txt"), "agent 新建\n");
    writeFileSync(join(repo.root, ".gitignore"), "build/\nsecret.txt\n");
    restoreWorkspaceTo(repo.root, start);
    assert.equal(existsSync(join(repo.root, "secret.txt")), false);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("恢复：agent 新建的未跟踪目录（含嵌套仓库）被整个删掉", () => {
  const repo = makeRepo();
  try {
    const start = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const before = scopeState(repo.root);
    mkdirSync(join(repo.root, "nested"), { recursive: true });
    git(join(repo.root, "nested"), ["init", "-q"]);
    writeFileSync(join(repo.root, "nested", "f.txt"), "嵌套仓库里的文件\n");
    mkdirSync(join(repo.root, "newdir", "deep"), { recursive: true });
    writeFileSync(join(repo.root, "newdir", "deep", "g.txt"), "新目录里的文件\n");
    restoreWorkspaceTo(repo.root, start);
    assert.equal(existsSync(join(repo.root, "nested")), false);
    assert.equal(existsSync(join(repo.root, "newdir", "deep", "g.txt")), false);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("恢复：agent 删掉的受跟踪文件被写回", () => {
  const repo = makeRepo();
  try {
    const start = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const before = scopeState(repo.root);
    rmSync(join(repo.root, "a.txt"));
    rmSync(join(repo.root, "make-extra.mjs"));
    restoreWorkspaceTo(repo.root, start);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "bug\n");
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("回炉反馈的附加内容注入点每轮都抛错：只告警一次、以空附加照常回炉，这一步按最后一次验证收尾", async () => {
  const repo = makeRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [
        edit("bug", "w1"),
        done(),
        edit("w1", "half"),
        done(),
        edit("half", "fixed"),
        done("修好了"),
      ],
    });
    let appendixCalls = 0;
    const { result, lines } = await captureStderr(() =>
      runHeadless({
        task: "把 a.txt 修好",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn,
        yolo: true,
        homeDir: repo.home,
        verify: VERIFY,
        repairRounds: 3,
        repairAppendix: () => {
          appendixCalls += 1;
          throw new Error("记忆索引读不出：坏文件");
        },
      })
    );
    assert.deepEqual(result.repair, {
      rounds: 2,
      verdict: "pass",
      closed: true,
      reverted: false,
      budgetExhausted: false,
      restored: false,
    });
    assert.equal(result.label, "Passed");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "fixed\n");
    assert.equal(appendixCalls, 2, "两轮回炉各调用一次注入点");
    const warnings = lines.filter((line) => line.startsWith("回炉反馈附加内容告警："));
    assert.equal(warnings.length, 1, `同一类故障只告警一次：${lines.join("")}`);
    assert.match(warnings[0] ?? "", /出错的轮次反馈不带附加内容，回炉照常进行/);
    for (const call of [streamFn.calls[2], streamFn.calls[4]]) {
      const feedback = lastUserText(call);
      assert.ok(feedback.trimEnd().endsWith(REPAIR_FEEDBACK_INSTRUCTION), feedback);
    }
  } finally {
    repo.cleanup();
  }
});

test("撤回而这一步一次文件都没改过：记为已撤回，restored 为 false、不带原因，也不告警", async () => {
  const repo = makeRepo();
  try {
    const { result, lines } = await captureStderr(() =>
      runHeadless({
        task: "把 a.txt 修好",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn: createFakeStreamFn({ replies: [done("没改"), done("还是没改")] }),
        yolo: true,
        homeDir: repo.home,
        verify: VERIFY,
        repairRounds: 1,
      })
    );
    assert.deepEqual(result.repair, {
      rounds: 1,
      verdict: "fail",
      closed: true,
      reverted: true,
      budgetExhausted: false,
      restored: false,
    });
    assert.equal(result.errorMessage, undefined);
    assert.equal(
      lines.some((line) => line.startsWith("回炉告警：")),
      false
    );
  } finally {
    repo.cleanup();
  }
});

test("撤回而快照出过故障、没有起点：明确报出 restoreError 并告警，不静默记为撤回", async () => {
  const repo = makeRepo();
  const gitDir = join(repo.root, ".git");
  const parked = join(repo.root, ".git-parked");
  try {
    const { result, lines } = await captureStderr(() =>
      runHeadless({
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
        // 快照挂上之后工作区不再是 git 工作区：快照生成必定失败（真实故障，不是桩）
        onBundle: () => renameSync(gitDir, parked),
      })
    );
    assert.equal(result.repair?.reverted, true);
    assert.equal(result.repair?.restored, false);
    assert.match(result.repair?.restoreError ?? "", /快照出过故障，没有撤回起点/);
    assert.equal(result.errorMessage, result.repair?.restoreError);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w2\n", "工作区未恢复");
    const warnings = lines.filter((line) => line.startsWith("回炉告警："));
    assert.equal(warnings.length, 1, lines.join(""));
    assert.match(warnings[0] ?? "", /工作区仍是最后一轮修改后的样子/);
  } finally {
    if (existsSync(parked)) {
      renameSync(parked, gitDir);
    }
    repo.cleanup();
  }
});

test("回炉途中出现异常：结果仍带回炉字段并标明这一步未收尾，不撤回", async () => {
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
    // 回炉那一轮没开起来：轮数按账本的推法（Run 数减 1）为 0
    assert.equal(sessionOf(repo.root, result.sessionId).runStarteds.length, 1);
    assert.deepEqual(result.repair, {
      rounds: 0,
      verdict: "fail",
      closed: false,
      reverted: false,
      budgetExhausted: false,
      restored: false,
    });
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "half\n", "未收尾不撤回");
  } finally {
    repo.cleanup();
  }
});

test("轮数与预算同时用满：记为轮数用满，不算预算耗尽提前撤回", async () => {
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
      // 首次 2 轮加回炉一轮 2 轮，恰好用满总轮次
      maxTurns: 4,
    });
    assert.equal(result.turns, 4);
    assert.equal(result.repair?.rounds, 1);
    assert.equal(result.repair?.reverted, true);
    assert.equal(result.repair?.budgetExhausted, false);
  } finally {
    repo.cleanup();
  }
});

test("token 预算整步共用：首次与回炉一轮各自都没到上限，合起来到了即不再回炉、提前撤回", async () => {
  const repo = makeRepo();
  try {
    const before = scopeState(repo.root);
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
    const session = sessionOf(repo.root, result.sessionId);
    const [firstRun, secondRun] = session.runStarteds.map((record) => record.runId);
    const tokensOf = (runId: unknown) =>
      session.runtimeEvents
        .filter((event) => event.kind === "turn.completed" && event.runId === runId)
        .reduce(
          (sum, event) =>
            sum + ((event.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0),
          0
        );
    assert.ok(tokensOf(firstRun) < 1200, String(tokensOf(firstRun)));
    assert.ok(tokensOf(secondRun) < 1200, String(tokensOf(secondRun)));
    assert.equal(session.runStarteds.length, 2, "不开第 2 轮回炉");
    assert.equal(result.repair?.rounds, 1);
    assert.equal(result.repair?.budgetExhausted, true);
    assert.equal(result.repair?.reverted, true);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("墙钟预算计入验证耗时：Run 内没到点、验证期间到点，即不再回炉、提前撤回", async () => {
  const repo = makeRepo();
  try {
    const before = scopeState(repo.root);
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
    const session = sessionOf(repo.root, result.sessionId);
    // 会话确实读到了（否则下面"没有撞上限记录"恒真）：一个 Run、一条失败的验证记录
    assert.equal(session.runStarteds.length, 1);
    assert.deepEqual(
      session.attemptVerifieds.map((record) => record.verdict),
      ["fail"]
    );
    assert.equal(result.status, "completed", "首个 Run 以完成收尾，不是被墙钟中止");
    assert.equal(session.limitHits.length, 0, "首个 Run 在墙钟到点之前正常收尾");
    assert.equal(streamFn.calls.length, 2, "不开回炉轮");
    assert.equal(result.repair?.rounds, 0);
    assert.equal(result.repair?.budgetExhausted, true);
    assert.equal(result.repair?.reverted, true);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("恢复：起点前就有的未跟踪嵌套仓库原样保留，其 .git、提交与未提交的改动完好", () => {
  const repo = makeRepo();
  try {
    const sub = join(repo.root, "sub");
    mkdirSync(sub);
    git(sub, ["init", "-q", "-b", "main"]);
    git(sub, ["config", "user.email", "pigeon@example.invalid"]);
    git(sub, ["config", "user.name", "pigeon-test"]);
    writeFileSync(join(sub, "x.txt"), "嵌套仓库里提交过的\n");
    git(sub, ["add", "."]);
    git(sub, ["commit", "-q", "-m", "嵌套仓库的提交"]);
    const subHead = git(sub, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(sub, "wip.txt"), "嵌套仓库里未提交的\n");
    // 起点：真实快照器在首次改动前记下的基线（嵌套仓库以 gitlink 收进，名字不带斜杠）
    const checkpointer = createCheckpointer({
      workspaceRoot: repo.root,
      sessionId: newSessionId(),
    });
    checkpointer.beforeChange();
    writeFileSync(join(repo.root, "a.txt"), "w1\n");
    const snapshot = checkpointer.afterChange();
    const base = snapshot?.baseCommit;
    assert.ok(base !== undefined);
    assert.ok(git(repo.root, ["ls-tree", "-r", "--name-only", base]).split("\n").includes("sub"));
    restoreWorkspaceTo(repo.root, base);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "bug\n");
    assert.ok(existsSync(join(sub, ".git")), "嵌套仓库的 .git 还在");
    assert.equal(git(sub, ["rev-parse", "HEAD"]).trim(), subHead, "嵌套仓库的提交完好");
    assert.equal(readFileSync(join(sub, "wip.txt"), "utf8"), "嵌套仓库里未提交的\n");
  } finally {
    repo.cleanup();
  }
});

test("恢复：agent 新建的自忽略目录（目录内 .gitignore 为 *）一次恢复即被删掉", () => {
  const repo = makeRepo();
  try {
    const start = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const before = scopeState(repo.root);
    mkdirSync(join(repo.root, ".pytest_cache", "v", "cache"), { recursive: true });
    writeFileSync(join(repo.root, ".pytest_cache", ".gitignore"), "*\n");
    writeFileSync(join(repo.root, ".pytest_cache", "v", "cache", "lastfailed"), "{}\n");
    restoreWorkspaceTo(repo.root, start);
    assert.equal(existsSync(join(repo.root, ".pytest_cache", ".gitignore")), false);
    assert.equal(existsSync(join(repo.root, ".pytest_cache", "v", "cache", "lastfailed")), false);
    assert.deepEqual(scopeState(repo.root), before);
  } finally {
    repo.cleanup();
  }
});

test("恢复：内容没变的文件不重写，修改时间不变", () => {
  const repo = makeRepo();
  try {
    const start = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const old = new Date("2020-01-01T00:00:00Z");
    // 修改时间与索引里记的不同、内容相同：只有刷新过文件状态，写回才会跳过它
    utimesSync(join(repo.root, "make-extra.mjs"), old, old);
    writeFileSync(join(repo.root, "a.txt"), "w1\n");
    restoreWorkspaceTo(repo.root, start);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "bug\n");
    assert.equal(statSync(join(repo.root, "make-extra.mjs")).mtimeMs, old.getTime());
  } finally {
    repo.cleanup();
  }
});

test("首次记基线失败后撤回：不恢复到改到一半的状态，报起点丢失；续跑时从账本同样认得出", async () => {
  const repo = makeRepo();
  const gitDir = join(repo.root, ".git");
  const parked = join(repo.root, ".git-parked");
  // agent 的第一条命令：把 .git 挪回来并改文件——提议时（记基线）工作区不是 git 工作区，落定时（打快照）又是了
  writeFileSync(
    join(repo.root, "unpark.mjs"),
    [
      'import { renameSync, writeFileSync } from "node:fs";',
      'renameSync(".git-parked", ".git");',
      'writeFileSync("a.txt", "w1\\n");',
    ].join("\n")
  );
  commitAll(repo.root, "加 unpark.mjs");
  try {
    const { result, lines } = await captureStderr(() =>
      runHeadless({
        task: "把 a.txt 修好",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn: createFakeStreamFn({
          replies: [
            {
              text: "先跑个命令",
              toolCalls: [{ name: "run_command", args: { command: `${NODE} unpark.mjs` } }],
            },
            done(),
            edit("w1", "w2"),
            done(),
          ],
        }),
        yolo: true,
        homeDir: repo.home,
        verify: VERIFY,
        repairRounds: 1,
        onBundle: () => renameSync(gitDir, parked),
      })
    );
    assert.equal(existsSync(gitDir), true, "命令已把 .git 挪回");
    assert.equal(result.repair?.reverted, true);
    assert.equal(result.repair?.restored, false);
    assert.match(result.repair?.restoreError ?? "", /起点丢失|没有撤回起点/);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w2\n", "不恢复到改到一半的状态");
    assert.ok(
      lines.some((line) => line.startsWith("回炉告警：")),
      lines.join("")
    );
    // 账本里有快照记录，但没有改前基线
    const session = sessionOf(repo.root, result.sessionId);
    assert.ok(session.checkpoints.length > 0);
    assert.equal(
      session.checkpoints.some((record) => record.payload.baseCommit !== undefined),
      false
    );
    // 续跑：新进程里没有前一进程的快照故障清单，仍从账本认出起点丢失，不动工作区
    assert.deepEqual(
      restoreStepStart({
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        sessionId: result.sessionId,
      }),
      { restored: false, startLost: true }
    );
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "w2\n");
  } finally {
    if (existsSync(parked)) {
      renameSync(parked, gitDir);
    }
    repo.cleanup();
  }
});

test("撤回时恢复抛错：报 restored 为 false 并带原因，告警写明工作区可能只恢复了一部分", async () => {
  const repo = makeRepo();
  const gitDir = join(repo.root, ".git");
  const parked = join(repo.root, ".git-parked");
  // 验证门：最后一次验证时把 .git 挪走，接下来的恢复必定抛错（真实故障）
  writeFileSync(
    join(repo.root, "gate-park.mjs"),
    [
      'import { readFileSync, renameSync } from "node:fs";',
      'if (readFileSync("a.txt", "utf8") === "w2\\n") renameSync(".git", ".git-parked");',
      "process.exit(1);",
    ].join("\n")
  );
  commitAll(repo.root, "加 gate-park.mjs");
  try {
    const { result, lines } = await captureStderr(() =>
      runHeadless({
        task: "把 a.txt 修好",
        governanceRoot: repo.root,
        workspaceRoot: repo.root,
        streamFn: createFakeStreamFn({
          replies: [edit("bug", "w1"), done(), edit("w1", "w2"), done()],
        }),
        yolo: true,
        homeDir: repo.home,
        verify: { command: `${NODE} gate-park.mjs`, timeoutMs: 30_000 },
        repairRounds: 1,
      })
    );
    assert.equal(result.repair?.reverted, true);
    assert.equal(result.repair?.restored, false);
    assert.match(result.repair?.restoreError ?? "", /撤回时恢复工作区失败/);
    assert.equal(result.errorMessage, result.repair?.restoreError);
    const warnings = lines.filter((line) => line.startsWith("回炉告警："));
    assert.equal(warnings.length, 1, lines.join(""));
    assert.match(warnings[0] ?? "", /工作区可能只恢复了一部分/);
  } finally {
    if (existsSync(parked)) {
      renameSync(parked, gitDir);
    }
    repo.cleanup();
  }
});
