// 检查工具自身崩溃（决策 170 ③）：分步验证配置里以 tool 声明这一步用的检查工具，按该工具公开的非正常退出码识别崩溃
// （pytest 3、4，mypy 2，ruff 2；表里没有的工具不识别）。命中即重跑该步一次；仍崩溃即这一步在验证记录里标工具故障，
// 整体结论只看其余步，不因它判失败、也不据此回炉。回炉反馈把工具故障单列，headless 的回炉结果带这一步的工具故障次数。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadVerifyConfig,
  VerifyConfigError,
  verifyConfigPath,
} from "../persistence/verify-config.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { VERIFY_CONFIG_VERSION, type VerifyConfig } from "../state/attempt-config.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import type { SessionCustomEntry, VerificationData } from "../state/session-entries.ts";
import { isToolCrash, TOOL_CRASH_EXIT_CODES, verdictOfSteps } from "../state/verify-steps.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { runHeadless } from "./headless.ts";
import { buildRepairFeedback } from "./repair-loop.ts";

const NODE = `"${process.execPath}"`;

// 按执行次数退出的小脚本：crash.mjs <计数文件> <第一次的退出码> <之后的退出码>；每次执行把计数加一
const CRASH_SCRIPT = [
  'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
  "const [counter, first, after] = process.argv.slice(2);",
  'const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
  "writeFileSync(counter, String(n + 1));",
  'process.stdout.write(n === 0 ? "第一次\\n" : "please use --show-traceback\\n");',
  "process.exit(Number(n === 0 ? first : after));",
].join("\n");

function workspace(): { root: string; runs: (counter: string) => number; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-tool-fault-")));
  writeFileSync(join(root, "crash.mjs"), CRASH_SCRIPT);
  return {
    root,
    runs: (counter) => Number(readFileSync(join(root, counter), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  };
}

interface StepSpec {
  name: string;
  tool?: string;
  first: number;
  after?: number;
}

function config(steps: readonly StepSpec[]): VerifyConfig {
  const built = steps.map((spec) => ({
    name: spec.name,
    command: `${NODE} crash.mjs ${spec.name}.count ${spec.first} ${spec.after ?? spec.first}`,
    ...(spec.tool !== undefined ? { tool: spec.tool } : {}),
  }));
  return {
    command: built.map((entry) => `[${entry.name}] ${entry.command}`).join("；"),
    steps: built,
    timeoutMs: 30_000,
  };
}

function storeSink(): { entries: SessionCustomEntry[]; append: (e: SessionCustomEntry) => void } {
  const entries: SessionCustomEntry[] = [];
  return { entries, append: (entry) => entries.push(entry) };
}

async function verify(root: string, steps: readonly StepSpec[]) {
  const store = storeSink();
  const result = await verifyAttempt({
    config: config(steps),
    workspace: root,
    target: { sessionId: newSessionId(), runId: newRunId() },
    store,
  });
  return { result, recorded: store.entries[0]?.data as VerificationData | undefined };
}

test("崩溃退出码表：pytest 3、4，mypy 2，ruff 2；只认配置里声明了工具、且工具在表里的步", () => {
  assert.deepEqual(TOOL_CRASH_EXIT_CODES, { pytest: [3, 4], mypy: [2], ruff: [2] });
  assert.equal(isToolCrash("pytest", 3), true);
  assert.equal(isToolCrash("pytest", 4), true);
  assert.equal(isToolCrash("mypy", 2), true);
  assert.equal(isToolCrash("ruff", 2), true);
  // 工具的"检查出问题"不是崩溃
  assert.equal(isToolCrash("pytest", 1), false);
  assert.equal(isToolCrash("pytest", 2), false);
  assert.equal(isToolCrash("pytest", 5), false);
  assert.equal(isToolCrash("mypy", 1), false);
  assert.equal(isToolCrash("ruff", 1), false);
  // 没声明工具、表里没有的工具、拉不起来或超时（没有退出码）一律不认
  assert.equal(isToolCrash(undefined, 2), false);
  assert.equal(isToolCrash("tsc", 2), false);
  assert.equal(isToolCrash("mypy", null), false);
});

test("整体结论只看不是工具故障的步：工具故障的步不判失败；全是工具故障即无法判定", () => {
  const fault = { verdict: "fail" as const, toolFault: true as const };
  assert.equal(verdictOfSteps([{ verdict: "pass" }, fault]), "pass");
  assert.equal(verdictOfSteps([{ verdict: "fail" }, fault]), "fail");
  assert.equal(verdictOfSteps([{ verdict: "undetermined" }, fault]), "undetermined");
  assert.equal(verdictOfSteps([fault, fault]), "undetermined");
  assert.equal(verdictOfSteps([{ verdict: "pass" }, { verdict: "fail" }]), "fail");
});

test("崩溃一次、重跑正常：该步按重跑的结论，不标工具故障", async () => {
  const ws = workspace();
  try {
    const { result, recorded } = await verify(ws.root, [
      { name: "mypy", tool: "mypy", first: 2, after: 0 },
      { name: "测试", first: 0 },
    ]);
    assert.equal(ws.runs("mypy.count"), 2, "崩溃即重跑一次");
    assert.equal(ws.runs("测试.count"), 1);
    assert.equal(result.outcome.verdict, "pass");
    assert.deepEqual(
      recorded?.steps?.map((s) => [s.name, s.exitCode, s.verdict, s.toolFault]),
      [
        ["mypy", 0, "pass", undefined],
        ["测试", 0, "pass", undefined],
      ]
    );
  } finally {
    ws.cleanup();
  }
});

test("重跑一次仍崩溃：该步在验证记录里标工具故障，整体结论只看其余步——其余通过即通过，退出码为 0", async () => {
  const ws = workspace();
  try {
    const { result, recorded } = await verify(ws.root, [
      { name: "ruff", tool: "ruff", first: 0 },
      { name: "mypy", tool: "mypy", first: 2 },
      { name: "pytest", tool: "pytest", first: 0 },
    ]);
    assert.equal(ws.runs("mypy.count"), 2, "只重跑一次");
    assert.equal(result.outcome.verdict, "pass");
    assert.equal(result.outcome.exitCode, 0);
    assert.deepEqual(
      result.steps?.map((s) => [s.name, s.exitCode, s.verdict, s.toolFault]),
      [
        ["ruff", 0, "pass", undefined],
        ["mypy", 2, "fail", true],
        ["pytest", 0, "pass", undefined],
      ]
    );
    assert.equal(recorded?.verdict, "pass");
    assert.equal(recorded?.steps?.[1]?.toolFault, true);
    // 整体输出里这一步单列为工具故障
    assert.match(result.outcome.output, /\[mypy\].*工具故障/);
  } finally {
    ws.cleanup();
  }
});

test("工具故障不掩盖其余步的失败：整体失败，退出码取第一个真正失败的步", async () => {
  const ws = workspace();
  try {
    const { result } = await verify(ws.root, [
      { name: "mypy", tool: "mypy", first: 2 },
      { name: "pytest", tool: "pytest", first: 1 },
    ]);
    assert.equal(result.outcome.verdict, "fail");
    assert.equal(result.outcome.exitCode, 1);
    assert.equal(ws.runs("pytest.count"), 1, "检查出问题不是崩溃，不重跑");
  } finally {
    ws.cleanup();
  }
});

test("全部步都是工具故障：整体无法判定", async () => {
  const ws = workspace();
  try {
    const { result } = await verify(ws.root, [
      { name: "pytest", tool: "pytest", first: 3, after: 4 },
    ]);
    assert.equal(ws.runs("pytest.count"), 2);
    assert.equal(result.outcome.verdict, "undetermined");
    assert.equal(result.outcome.exitCode, null);
    assert.equal(result.steps?.[0]?.toolFault, true);
  } finally {
    ws.cleanup();
  }
});

test("不猜：没声明工具、表里没有的工具、或退出码不在该工具的崩溃码里，都不重跑、照常判失败", async () => {
  const ws = workspace();
  try {
    const { result } = await verify(ws.root, [
      { name: "无工具", first: 2 },
      { name: "tsc", tool: "tsc", first: 2 },
      { name: "pytest", tool: "pytest", first: 2 },
      { name: "ruff", tool: "ruff", first: 1 },
    ]);
    for (const name of ["无工具", "tsc", "pytest", "ruff"]) {
      assert.equal(ws.runs(`${name}.count`), 1, name);
    }
    assert.equal(result.outcome.verdict, "fail");
    assert.ok(result.steps?.every((s) => s.toolFault === undefined));
  } finally {
    ws.cleanup();
  }
});

test("项目验证配置：分步可声明 tool，原样读出；声明了表里没有的工具即响亮失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-tool-fault-config-"));
  try {
    mkdirSync(join(dir, ".pigeon"), { recursive: true });
    const write = (steps: unknown) =>
      writeFileSync(
        verifyConfigPath(dir),
        JSON.stringify({ version: VERIFY_CONFIG_VERSION, steps, timeoutMs: 1000 })
      );
    write([
      { name: "类型", command: "mypy src", tool: "mypy" },
      { name: "测试", command: "npm test" },
    ]);
    assert.deepEqual(loadVerifyConfig(dir)?.steps, [
      { name: "类型", command: "mypy src", tool: "mypy" },
      { name: "测试", command: "npm test" },
    ]);
    write([{ name: "类型", command: "tsc", tool: "tsc" }]);
    assert.throws(() => loadVerifyConfig(dir), VerifyConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回炉反馈：工具故障的步单列，不算进失败的步骤、不附输出", () => {
  const feedback = buildRepairFeedback({
    command: "[mypy] m；[pytest] p",
    outcome: { exitCode: 1, output: "整体", truncated: false },
    steps: [
      {
        name: "mypy",
        exitCode: 2,
        verdict: "fail",
        output: "please use --show-traceback",
        truncated: false,
        toolFault: true,
      },
      { name: "pytest", exitCode: 1, verdict: "fail", output: "FAILED t", truncated: false },
    ],
    round: 1,
    maxRounds: 3,
  });
  assert.ok(feedback.includes("失败的步骤：pytest\n"), feedback);
  assert.match(feedback, /工具故障的步骤.*：mypy/);
  assert.ok(!feedback.includes("please use --show-traceback"), feedback);
  assert.ok(!feedback.includes("【mypy】"), feedback);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repairRepo(): { root: string; home: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-tool-fault-repair-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-tool-fault-home-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "pigeon@example.invalid"]);
  git(root, ["config", "user.name", "pigeon-test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "a.txt"), "bug\n");
  writeFileSync(
    join(root, "check-a.mjs"),
    'import { readFileSync } from "node:fs";\nconst c = readFileSync("a.txt", "utf8");\n' +
      'process.stdout.write("a.txt=" + c.trim() + "\\n");\nprocess.exit(c === "fixed\\n" ? 0 : 1);\n'
  );
  writeFileSync(
    join(root, "crash.mjs"),
    'process.stdout.write("INTERNAL ERROR\\n");\nprocess.exit(2);\n'
  );
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
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

const edit = (from: string, to: string): FakeReply => ({
  text: "改",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` } },
  ],
});

const REPAIR_VERIFY: VerifyConfig = {
  command: "[内容] …；[mypy] …",
  steps: [
    { name: "内容", command: `${NODE} check-a.mjs` },
    { name: "mypy", command: `${NODE} crash.mjs`, tool: "mypy" },
  ],
  timeoutMs: 30_000,
};

test("headless：工具故障不据此回炉——其余步通过即这一步通过；回炉结果带这一步的工具故障次数", async () => {
  const repo = repairRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [edit("bug", "fixed"), { text: "好了" }] });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: REPAIR_VERIFY,
      repairRounds: 2,
    });
    assert.equal(streamFn.calls.length, 2, "不开回炉轮");
    assert.deepEqual(result.repair, { rounds: 0, verdict: "pass", closed: true, toolFaults: 1 });
    assert.equal(result.label, "Passed");
  } finally {
    repo.cleanup();
  }
});

test("headless：其余步失败照常回炉，反馈单列工具故障；工具故障次数按这一步的各次验证累计", async () => {
  const repo = repairRepo();
  try {
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), { text: "好了" }, edit("half", "fixed"), { text: "修好了" }],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: REPAIR_VERIFY,
      repairRounds: 2,
    });
    assert.deepEqual(result.repair, { rounds: 1, verdict: "pass", closed: true, toolFaults: 2 });
    const messages = (streamFn.calls[2]?.context.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;
    const feedback = JSON.stringify(messages.findLast((message) => message.role === "user"));
    assert.ok(feedback.includes("失败的步骤：内容"), feedback);
    assert.match(feedback, /工具故障的步骤.*：mypy/);
  } finally {
    repo.cleanup();
  }
});

test("headless：没有工具故障时回炉结果不带工具故障次数（与既有结果形状一致）", async () => {
  const repo = repairRepo();
  try {
    const streamFn = createFakeStreamFn({ replies: [edit("bug", "fixed"), { text: "好了" }] });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn,
      yolo: true,
      homeDir: repo.home,
      verify: {
        command: "[内容] …",
        steps: [{ name: "内容", command: `${NODE} check-a.mjs` }],
        timeoutMs: 30_000,
      },
      repairRounds: 2,
    });
    assert.deepEqual(result.repair, { rounds: 0, verdict: "pass", closed: true });
  } finally {
    repo.cleanup();
  }
});
