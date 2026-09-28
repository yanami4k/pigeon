// 验证命令执行核心（M7 S3，决策 071；从 M6.5 Eval 验证器下沉）：独立子进程、带超时、输出只留尾部并记字节数与哈希，
// 退出码三值判决（0 通过、非 0 失败、超时或拉不起来为未判定）。会话级验证命令是人配置的一行命令，经系统 shell 执行，
// 实际交给子进程的参数数组原样记录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeVerdict, runCheckCommand, shellCommand } from "./check-command.ts";

// 进程是否还在：Windows 用 tasklist 查 PID，其余用 kill(pid,0)（EPERM 视为仍在）
function isAlive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
      return out.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isAlive(pid);
}

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-check-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  };
}

const NODE = `"${process.execPath}"`;

test("三值判决：退出码 0 通过、非 0 失败；超时、拉不起来、无退出码为未判定", () => {
  assert.equal(judgeVerdict({ exitCode: 0, timedOut: false }), "pass");
  assert.equal(judgeVerdict({ exitCode: 2, timedOut: false }), "fail");
  assert.equal(judgeVerdict({ exitCode: 0, timedOut: true }), "undetermined");
  assert.equal(judgeVerdict({ exitCode: null, timedOut: false }), "undetermined");
  assert.equal(judgeVerdict({ exitCode: 0, timedOut: false, error: "拉不起来" }), "undetermined");
});

test("一行命令经系统 shell 执行：在给定工作区里跑，输出进哈希与尾部，参数数组原样记录", async () => {
  const { dir, cleanup } = workspace();
  try {
    writeFileSync(join(dir, "v.mjs"), 'console.log("checked"); process.exit(3);\n');
    const line = `${NODE} v.mjs`;
    const outcome = await runCheckCommand({ ...shellCommand(line), cwd: dir, timeoutMs: 30_000 });
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.verdict, "fail");
    assert.ok(outcome.output.includes("checked"), outcome.output);
    assert.equal(outcome.outputHash.length, 64);
    assert.ok(outcome.outputBytes > 0);
    assert.equal(outcome.command.at(-1), line, "记录的参数数组以原始命令行结尾");
    writeFileSync(join(dir, "v.mjs"), "process.exit(0);\n");
    const passed = await runCheckCommand({ ...shellCommand(line), cwd: dir, timeoutMs: 30_000 });
    assert.equal(passed.verdict, "pass");
  } finally {
    cleanup();
  }
});

test("超时终止并判未判定；工作区不存在时拉不起来也判未判定", async () => {
  const { dir, cleanup } = workspace();
  try {
    writeFileSync(join(dir, "hang.mjs"), "setInterval(() => {}, 1000);\n");
    const hung = await runCheckCommand({
      ...shellCommand(`${NODE} hang.mjs`),
      cwd: dir,
      timeoutMs: 300,
    });
    assert.equal(hung.timedOut, true);
    assert.equal(hung.verdict, "undetermined");
    const missing = await runCheckCommand({
      ...shellCommand(`${NODE} -e 0`),
      cwd: join(dir, "不存在"),
      timeoutMs: 5_000,
    });
    assert.equal(missing.verdict, "undetermined");
    assert.ok(missing.error !== undefined);
  } finally {
    cleanup();
  }
});

test("超时终止整棵进程树：shell 里再起的 node 孙进程在宽限内消失，不留孤儿", async () => {
  const { dir, cleanup } = workspace();
  let grandchildPid = 0;
  try {
    const pidFile = join(dir, "gc.pid");
    // 经系统 shell 起 node hang.mjs：shell 是直接子进程，node 是孙进程，它把自己的 pid 写进文件
    writeFileSync(
      join(dir, "hang.mjs"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`
    );
    const hung = await runCheckCommand({
      ...shellCommand(`${NODE} hang.mjs`),
      cwd: dir,
      timeoutMs: 800,
    });
    assert.equal(hung.timedOut, true);
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(grandchildPid > 0, "孙进程应已写出 pid");
    assert.equal(await waitGone(grandchildPid, 6000), true, "超时后孙进程应在宽限内消失");
  } finally {
    if (grandchildPid > 0 && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
    cleanup();
  }
});
