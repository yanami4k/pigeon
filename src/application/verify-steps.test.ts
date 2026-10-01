// 验证分步（决策 159）：项目验证配置支持命名分步，各步全跑、各出结论，整体为各步合取；验证记录加可选的各步结论字段
// （加法式）；回炉反馈写明哪几步失败并附各步输出末尾；单条命令的旧配置照常可用、视为只有一步。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { loadStoreSession } from "../persistence/session-view.ts";
import {
  loadVerifyConfig,
  VerifyConfigError,
  verifyConfigPath,
} from "../persistence/verify-config.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { VERIFY_CONFIG_VERSION, type VerifyConfig } from "../state/attempt-config.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import {
  type SessionCustomEntry,
  type SessionEntrySink,
  SessionEntryType,
  type VerificationData,
  VerificationDataSchema,
} from "../state/session-entries.ts";
import {
  combineStepVerdicts,
  LEGACY_VERIFY_STEP_NAME,
  recordStepsOf,
  verifyStepsOf,
} from "../state/verify-steps.ts";
import { verifyAttempt } from "./attempt-verify.ts";
import { runHeadless } from "./headless.ts";
import { buildRepairFeedback } from "./repair-loop.ts";

const NODE = `"${process.execPath}"`;

// 一个按参数退出的小脚本：exit <码> <输出>
const EXIT_SCRIPT = [
  "const [code, text] = process.argv.slice(2);",
  'process.stdout.write((text ?? "") + "\\n");',
  "process.exit(Number(code));",
].join("\n");

// 写一个临时工作区，放好 exit.mjs；返回根目录与清理
function workspace(): { root: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-verify-steps-")));
  writeFileSync(join(root, "exit.mjs"), EXIT_SCRIPT);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  };
}

const step = (name: string, code: number, text: string) => ({
  name,
  command: `${NODE} exit.mjs ${code} ${text}`,
});

function stepsConfig(steps: Array<{ name: string; command: string }>, timeoutMs = 30_000) {
  return {
    command: steps.map((entry) => `[${entry.name}] ${entry.command}`).join("；"),
    steps,
    timeoutMs,
  } satisfies VerifyConfig;
}

// 收集写入的会话条目（不落盘）
function memorySink(): SessionEntrySink & { entries: SessionCustomEntry[] } {
  const entries: SessionCustomEntry[] = [];
  return {
    entries,
    append(entry) {
      entries.push(entry);
    },
  };
}

// 写入面收到的唯一一条条目：必须是验证记录条目，且数据通过验证记录的 schema
function onlyVerification(sink: { entries: SessionCustomEntry[] }): VerificationData {
  assert.equal(sink.entries.length, 1, "只写一条验证记录条目");
  const entry = sink.entries[0];
  if (entry?.customType !== SessionEntryType.Verification) {
    assert.fail("应为验证记录条目");
  }
  assert.ok(Value.Check(VerificationDataSchema, entry.data), "验证记录条目通过 schema");
  return entry.data;
}

test("验证分步：四步全部执行、各出结论，前一步失败不跳过后续；整体为各步合取；记录带各步结论", async () => {
  const ws = workspace();
  try {
    const sink = memorySink();
    const target = { sessionId: newSessionId(), runId: newRunId() };
    const result = await verifyAttempt({
      config: stepsConfig([
        step("格式", 1, "fmt-bad"),
        step("类型", 0, "types-ok"),
        step("测试", 2, "tests-bad"),
        step("分层", 0, "layers-ok"),
      ]),
      workspace: ws.root,
      target,
      store: sink,
    });
    assert.equal(result.outcome.verdict, "fail");
    assert.deepEqual(
      result.steps?.map((entry) => [entry.name, entry.exitCode, entry.verdict]),
      [
        ["格式", 1, "fail"],
        ["类型", 0, "pass"],
        ["测试", 2, "fail"],
        ["分层", 0, "pass"],
      ]
    );
    const record = onlyVerification(sink);
    assert.deepEqual(record.target, target);
    assert.equal(record.verdict, "fail");
    assert.deepEqual(
      record.steps?.map((entry) => [entry.name, entry.exitCode, entry.verdict]),
      [
        ["格式", 1, "fail"],
        ["类型", 0, "pass"],
        ["测试", 2, "fail"],
        ["分层", 0, "pass"],
      ]
    );
    // 各步输出末尾各自留存；整体输出按步分段，后续步骤的输出也在
    assert.ok(record.steps?.[0]?.output.includes("fmt-bad"));
    assert.ok(record.steps?.[3]?.output.includes("layers-ok"));
    assert.ok(record.output.includes("tests-bad") && record.output.includes("layers-ok"));
    // 整体退出码取第一个失败步骤的退出码
    assert.equal(record.exitCode, 1);
  } finally {
    ws.cleanup();
  }
});

test("验证分步：合取口径——任一步失败即失败；无失败但有步无法判定即无法判定；全过才通过", async () => {
  assert.equal(combineStepVerdicts(["pass", "pass"]), "pass");
  assert.equal(combineStepVerdicts(["pass", "undetermined", "fail"]), "fail");
  assert.equal(combineStepVerdicts(["pass", "undetermined"]), "undetermined");
  assert.equal(combineStepVerdicts([]), "undetermined");
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, "hang.mjs"), "setTimeout(() => {}, 60_000);\n");
    const sink = memorySink();
    const result = await verifyAttempt({
      config: stepsConfig(
        [step("甲", 0, "ok"), { name: "乙", command: `${NODE} hang.mjs` }, step("丙", 0, "ok")],
        10_000
      ),
      workspace: ws.root,
      target: { sessionId: newSessionId(), runId: newRunId() },
      store: sink,
    });
    assert.equal(result.outcome.verdict, "undetermined");
    assert.deepEqual(
      result.steps?.map((entry) => entry.verdict),
      ["pass", "undetermined", "pass"]
    );
    assert.equal(result.outcome.exitCode, null);
  } finally {
    ws.cleanup();
  }
});

test("验证分步：单条命令的旧配置照常可用——只跑一次、记录不带各步字段，读取时视为只有一步", async () => {
  const ws = workspace();
  try {
    const sink = memorySink();
    const legacy: VerifyConfig = { command: `${NODE} exit.mjs 3 legacy-out`, timeoutMs: 30_000 };
    assert.deepEqual(verifyStepsOf(legacy), [
      { name: LEGACY_VERIFY_STEP_NAME, command: legacy.command },
    ]);
    const result = await verifyAttempt({
      config: legacy,
      workspace: ws.root,
      target: { sessionId: newSessionId(), runId: newRunId() },
      store: sink,
    });
    assert.equal(result.outcome.verdict, "fail");
    const record = onlyVerification(sink);
    assert.equal(record.steps, undefined);
    assert.deepEqual(recordStepsOf(record), [
      {
        name: LEGACY_VERIFY_STEP_NAME,
        exitCode: 3,
        verdict: "fail",
        output: record.output,
        truncated: record.truncated,
      },
    ]);
  } finally {
    ws.cleanup();
  }
});

test("回炉反馈：分步配置下写明哪几步失败并附各失败步的输出末尾，通过的步骤不附输出", () => {
  const feedback = buildRepairFeedback({
    command: "[格式] a；[类型] b；[测试] c",
    outcome: { exitCode: 1, output: "整体输出", truncated: false },
    steps: [
      { name: "格式", exitCode: 0, verdict: "pass", output: "fmt 通过的输出", truncated: false },
      { name: "类型", exitCode: 2, verdict: "fail", output: "TS2322 在 a.ts", truncated: false },
      { name: "测试", exitCode: 1, verdict: "fail", output: "✖ adds numbers", truncated: true },
      {
        name: "子测试",
        exitCode: 1,
        verdict: "fail",
        output: "FAILED tests/test_x.py::t",
        truncated: false,
        cwd: "strands-py",
      },
    ],
    round: 1,
    maxRounds: 3,
  });
  assert.ok(feedback.includes("失败的步骤：类型、测试、子测试"), feedback);
  // 设了执行目录的步写明目录，报错路径相对它
  assert.ok(feedback.includes("【子测试 @ strands-py】"), feedback);
  assert.ok(feedback.includes("【类型】"), feedback);
  assert.ok(feedback.includes("TS2322 在 a.ts"), feedback);
  assert.ok(feedback.includes("✖ adds numbers"), feedback);
  assert.ok(!feedback.includes("fmt 通过的输出"), feedback);
  assert.ok(feedback.includes("第 1/3 轮"), feedback);
  // 旧单条配置：不带各步结论时格式与此前一致（验证命令、退出码、输出末尾）
  const legacy = buildRepairFeedback({
    command: "npm test",
    outcome: { exitCode: 1, output: "整体输出", truncated: false },
    round: 1,
    maxRounds: 3,
  });
  assert.ok(legacy.includes("验证命令：npm test") && legacy.includes("退出码：1"), legacy);
  assert.ok(legacy.includes("整体输出"), legacy);
  assert.ok(!legacy.includes("失败的步骤"), legacy);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("回炉路径：分步配置下各步全跑，回炉反馈发回的是失败步骤；修好后整步通过", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-verify-steps-repair-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-verify-steps-home-"));
  try {
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
    writeFileSync(join(root, "ok.mjs"), 'process.stdout.write("一切正常\\n");\n');
    writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    const edit = (from: string, to: string): FakeReply => ({
      text: "改",
      toolCalls: [
        {
          name: "edit_file",
          args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` },
        },
      ],
    });
    const streamFn = createFakeStreamFn({
      replies: [edit("bug", "half"), { text: "好了" }, edit("half", "fixed"), { text: "修好了" }],
    });
    const result = await runHeadless({
      task: "把 a.txt 修好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      verify: stepsConfig([
        { name: "内容", command: `${NODE} check-a.mjs` },
        { name: "其他", command: `${NODE} ok.mjs` },
      ]),
      repairRounds: 2,
    });
    assert.equal(result.repair?.verdict, "pass");
    const messages = (streamFn.calls[2]?.context.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;
    const feedback = JSON.stringify(messages.findLast((message) => message.role === "user"));
    assert.ok(feedback.includes("失败的步骤：内容"), feedback);
    assert.ok(feedback.includes("a.txt=half"), feedback);
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.ok(loaded !== undefined);
    assert.deepEqual(
      loaded.view.verifications.map((record) => record.data.steps?.map((entry) => entry.verdict)),
      [
        ["fail", "pass"],
        ["pass", "pass"],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

function configRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-verify-steps-config-"));
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  return dir;
}

test("项目验证配置：命名分步读出步名与命令；单条命令照旧；两者都给、都不给、步名为空或重复都响亮失败", () => {
  const dir = configRoot();
  const write = (body: unknown) => writeFileSync(verifyConfigPath(dir), JSON.stringify(body));
  write({
    version: VERIFY_CONFIG_VERSION,
    steps: [
      { name: "格式", command: "npm run lint" },
      { name: "类型", command: "npm run check" },
    ],
    timeoutMs: 1000,
  });
  const loaded = loadVerifyConfig(dir);
  assert.deepEqual(loaded?.steps, [
    { name: "格式", command: "npm run lint" },
    { name: "类型", command: "npm run check" },
  ]);
  assert.equal(loaded?.timeoutMs, 1000);
  assert.equal(loaded?.command, "[格式] npm run lint；[类型] npm run check");
  write({ version: VERIFY_CONFIG_VERSION, command: "npm test" });
  assert.equal(loadVerifyConfig(dir)?.steps, undefined);
  for (const bad of [
    { version: VERIFY_CONFIG_VERSION, command: "npm test", steps: [{ name: "a", command: "x" }] },
    { version: VERIFY_CONFIG_VERSION },
    { version: VERIFY_CONFIG_VERSION, steps: [] },
    { version: VERIFY_CONFIG_VERSION, steps: [{ name: " ", command: "x" }] },
    { version: VERIFY_CONFIG_VERSION, steps: [{ name: "a", command: "  " }] },
    {
      version: VERIFY_CONFIG_VERSION,
      steps: [
        { name: "a", command: "x" },
        { name: "a", command: "y" },
      ],
    },
  ]) {
    write(bad);
    assert.throws(() => loadVerifyConfig(dir), VerifyConfigError, JSON.stringify(bad));
  }
});

test("本仓库的验证配置样例：四步（格式、类型、测试、分层），经项目配置读取口径读出，与 npm run verify 等价", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  // 样例入库、.pigeon/ 不入库：本机使用时由人复制到 .pigeon/verify.json，这里按同样方式放进临时治理根再读
  const dir = configRoot();
  writeFileSync(
    verifyConfigPath(dir),
    readFileSync(join(repoRoot, "docs", "samples", "verify.json"), "utf8")
  );
  const config = loadVerifyConfig(dir);
  assert.deepEqual(
    config?.steps?.map((entry) => entry.name),
    ["格式", "类型", "测试", "分层"]
  );
  // npm run verify 是四个脚本用 && 串起来；分步配置逐一对应同样四个脚本、同样顺序
  const scripts = (
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const chained = (scripts.verify ?? "").split("&&").map((part) => part.trim());
  assert.deepEqual(
    config?.steps?.map((entry) => entry.command),
    chained
  );
  assert.deepEqual(chained, ["npm run lint", "npm run check", "npm run test", "npm run deps"]);
});
