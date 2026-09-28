// MCP stdio 传输关闭时的整树终止（决策 041 / 055；098 口径）：经启动器再起的孙进程（如 npx 之下的 node server）
// 在关闭时随整组一并终止，不残留。用真的父—孙进程验证 close 后孙进程消失。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PigeonStdioTransport } from "./transport.ts";

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

test("MCP stdio 传输：关闭时启动器再起的 node 孙进程随整组终止，不残留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-mcp-transport-"));
  let grandchildPid = 0;
  try {
    const pidFile = join(dir, "gc.pid");
    const gcScript = join(dir, "gc.mjs");
    const serverScript = join(dir, "server.mjs");
    writeFileSync(
      gcScript,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`
    );
    // 模拟经启动器起的 MCP server：再起 gc（孙进程）继承 stdout 占着管道，自身忽略 stdin 关闭、常驻不退
    writeFileSync(
      serverScript,
      `import { spawn } from "node:child_process";\n` +
        `spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: ["ignore", "inherit", "inherit"] });\n` +
        `process.stdin.resume();\n` +
        `setInterval(() => {}, 1000);\n`
    );
    const transport = new PigeonStdioTransport(
      { mode: "direct", program: process.execPath, args: [serverScript], verbatim: false },
      { cwd: dir, env: process.env, platform: process.platform }
    );
    await transport.start();
    // 等孙进程写出 pid
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && grandchildPid === 0) {
      await sleep(50);
      try {
        grandchildPid = Number(readFileSync(pidFile, "utf8"));
      } catch {
        // 还没写出
      }
    }
    assert.ok(grandchildPid > 0, "孙进程应已写出 pid");
    assert.equal(isAlive(grandchildPid), true, "关闭前孙进程在跑");
    await transport.close();
    assert.equal(await waitGone(grandchildPid, 6000), true, "关闭后孙进程应在宽限内消失");
  } finally {
    if (grandchildPid > 0 && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
