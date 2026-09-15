// Eval 验证器（M6.5 S3，决策 058 含修订）：runner 收工后先把验证资产从任务目录覆盖写回工作区，再作为独立子进程
// 在工作区执行验证器——退出码三值判决（0 通过、非 0 失败、超时或拉不起来为未判定），stdout 尾行 JSON 可选收入；
// 误报第一层 = agent 自报完成（末轮正常 stop、无未闭合的工具调用、末个工具结果不是错误）但验证失败；
// 判决记观察族 eval.verified 落该次运行的会话文件，trace 的 Run 头显示。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHeadless } from "../application/headless.ts";
import { runTraceCommand } from "../cli/trace.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { LoadedEvalTask } from "./task.ts";
import { runVerifier, verifyTaskRun } from "./verify.ts";

const VERIFY_SCRIPT = [
  'import { existsSync, readFileSync } from "node:fs";',
  // 模拟"测试文件被删就没有测试可跑、照样退出 0"——正是回填要防的骗过方式
  'if (!existsSync("checks/expected.txt")) { console.log("no checks"); process.exit(0); }',
  'const ok = readFileSync("checks/expected.txt", "utf8").trim() === readFileSync("answer.txt", "utf8").trim();',
  "console.log(JSON.stringify({ ok }));",
  "process.exit(ok ? 0 : 1);",
].join("\n");

function makeTask(
  root: string,
  verifier: { command: string[]; timeoutMs: number } = {
    command: ["node", "{TASK_DIR}/verify.mjs"],
    timeoutMs: 30_000,
  }
): LoadedEvalTask {
  const dir = join(root, "task");
  mkdirSync(join(dir, "assets", "checks"), { recursive: true });
  writeFileSync(join(dir, "verify.mjs"), VERIFY_SCRIPT);
  writeFileSync(join(dir, "assets", "checks", "expected.txt"), "42\n");
  writeFileSync(join(dir, "task.md"), "把 answer.txt 改成 42\n");
  return {
    dir,
    instructions: "把 answer.txt 改成 42\n",
    repoRoot: root,
    spec: {
      version: 1,
      id: "answer",
      instructions: "task.md",
      repo: { path: ".", ref: "HEAD" },
      budget: { maxTurns: 5, wallClockMs: 60_000 },
      verifier,
      assets: ["checks/expected.txt"],
      tags: [],
      holdout: false,
    },
  };
}

function makeWorkspace(root: string, answer: string): string {
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "answer.txt"), answer);
  return workspace;
}

test("验证器三值判决：退出码 0 通过、非 0 失败、超时与拉不起来为未判定；stdout 尾行 JSON 收入 details", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-verify-"));
  try {
    const task = makeTask(root);
    const pass = await runVerifier(task, makeWorkspace(join(root, "p"), "42\n"), {
      restoreFirst: true,
    });
    assert.equal(pass.verdict, "pass");
    assert.equal(pass.exitCode, 0);
    assert.deepEqual(pass.details, { ok: true });
    assert.match(pass.outputHash, /^[0-9a-f]{64}$/);

    const fail = await runVerifier(task, makeWorkspace(join(root, "f"), "41\n"), {
      restoreFirst: true,
    });
    assert.equal(fail.verdict, "fail");
    assert.equal(fail.exitCode, 1);

    const slow = makeTask(join(root, "s"), {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 300,
    });
    const timedOut = await runVerifier(slow, makeWorkspace(join(root, "s"), "42\n"));
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.verdict, "undetermined");

    const missing = makeTask(join(root, "m"), {
      command: ["pigeon-no-such-verifier-command"],
      timeoutMs: 5_000,
    });
    const crashed = await runVerifier(missing, makeWorkspace(join(root, "m"), "42\n"));
    assert.equal(crashed.verdict, "undetermined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("验证资产回填：agent 删掉或改掉测试文件后，验证器仍按任务目录里的版本判定", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-verify-"));
  try {
    const task = makeTask(root);
    // agent 答错并删掉了验证资产：不回填时脚本"没有测试"照样退出 0
    const deleted = makeWorkspace(join(root, "d"), "41\n");
    const deletedResult = await runVerifier(task, deleted, { restoreFirst: true });
    assert.equal(deletedResult.verdict, "fail");
    assert.equal(readFileSync(join(deleted, "checks", "expected.txt"), "utf8"), "42\n");

    // agent 把测试期望改成与错误答案一致
    const tampered = makeWorkspace(join(root, "t"), "41\n");
    mkdirSync(join(tampered, "checks"), { recursive: true });
    writeFileSync(join(tampered, "checks", "expected.txt"), "41\n");
    const tamperedResult = await runVerifier(task, tampered, { restoreFirst: true });
    assert.equal(tamperedResult.verdict, "fail");
    assert.deepEqual(tamperedResult.assets, ["checks/expected.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("误报第一层与 eval.verified：自报完成但验证失败记误报，判决落该次运行的会话文件，trace Run 头可见；未自报完成不算误报", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-verify-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-verify-home-"));
  try {
    const task = makeTask(root);
    const workspace = makeWorkspace(root, "41\n");
    const governanceRoot = join(root, "out");
    mkdirSync(governanceRoot, { recursive: true });
    const run = await runHeadless({
      task: task.instructions,
      governanceRoot,
      workspaceRoot: workspace,
      streamFn: createFakeStreamFn({ replies: [{ text: "已改好" }] }),
      yolo: true,
      homeDir: home,
      skillRoots: [],
      memoryRoots: [],
    });
    const verified = await verifyTaskRun({
      task,
      workspaceRoot: workspace,
      governanceRoot,
      sessionId: run.sessionId,
      ...(run.runId !== undefined ? { runId: run.runId } : {}),
    });
    assert.equal(verified.verdict, "fail");
    assert.equal(verified.selfReportedDone, true);
    assert.equal(verified.falsePositive, true);
    assert.equal(verified.recorded, true);

    const session = materializeSession(join(governanceRoot, ".pigeon", "sessions"), run.sessionId);
    assert.equal(session.evalVerifieds.length, 1);
    const payload = session.evalVerifieds[0]?.payload;
    assert.equal(payload?.taskId, "answer");
    assert.equal(payload?.verdict, "fail");
    assert.equal(payload?.exitCode, 1);
    assert.equal(payload?.falsePositive, true);
    assert.equal(session.evalVerifieds[0]?.runId, run.runId);

    const trace = runTraceCommand({
      root: governanceRoot,
      sessionId: run.sessionId,
      withContent: false,
    });
    assert.match(trace, /验证判决：任务 answer ｜ 失败 ｜ 退出码 1/);
    assert.match(trace, /自报完成但验证失败（误报）/);

    // 轮次上限中止：没有自报完成，验证失败也不算误报
    const limited = await runHeadless({
      task: task.instructions,
      governanceRoot,
      workspaceRoot: workspace,
      streamFn: createFakeStreamFn({
        replies: [{ text: "读", toolCalls: [{ name: "read_file", args: { path: "answer.txt" } }] }],
      }),
      yolo: true,
      maxTurns: 1,
      homeDir: home,
      skillRoots: [],
      memoryRoots: [],
    });
    assert.equal(limited.status, "turn-limit");
    const limitedVerified = await verifyTaskRun({
      task,
      workspaceRoot: workspace,
      governanceRoot,
      sessionId: limited.sessionId,
      ...(limited.runId !== undefined ? { runId: limited.runId } : {}),
    });
    assert.equal(limitedVerified.verdict, "fail");
    assert.equal(limitedVerified.selfReportedDone, false);
    assert.equal(limitedVerified.falsePositive, false);
    assert.ok(existsSync(join(workspace, "checks", "expected.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
