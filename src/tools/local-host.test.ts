// 本地执行端 run_command 的整树终止（决策 098：超时或中止后该命令起的进程不残留）：
// 子进程再起孙进程并让孙进程占着输出管道，验证超时与中止都终止整组、且工具调用在超时加宽限内返回。
// 另验文件清单跳过工作区根下的治理目录 .pigeon（与容器执行端同一口径）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHURN_FILE_CHANGES,
  CHURN_LISTED_BEFORE,
  seedGovernanceChurn,
} from "./listing-fixtures.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createRunCommandTool } from "./run-command.ts";
import type { HostExecOptions } from "./workspace-host.ts";

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

// 在工作区里写好 parent.mjs 与 gc.mjs：parent 再起 gc（孙进程），gc 继承父的 stdout 占着输出管道并写出自己的 pid
function writeTreeFixture(dir: string): { pidFile: string; parentScript: string } {
  const pidFile = join(dir, "gc.pid");
  const gcScript = join(dir, "gc.mjs");
  const parentScript = join(dir, "parent.mjs");
  writeFileSync(
    gcScript,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `setInterval(() => {}, 1000);\n`
  );
  writeFileSync(
    parentScript,
    `import { spawn } from "node:child_process";\n` +
      `spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: ["ignore", "inherit", "inherit"] });\n` +
      `setInterval(() => {}, 1000);\n`
  );
  return { pidFile, parentScript };
}

function execOptions(over: Partial<HostExecOptions>): HostExecOptions {
  return {
    env: process.env,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
    signal: undefined,
    ...over,
  };
}

async function readGrandchildPid(pidFile: string, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0) {
        return pid;
      }
    } catch {
      // 还没写出
    }
    await sleep(50);
  }
  return 0;
}

test("run_command 超时：孙进程占着管道时，整组被终止且调用在超时加宽限内返回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-localhost-"));
  let grandchildPid = 0;
  try {
    const { pidFile, parentScript } = writeTreeFixture(dir);
    const host = createLocalWorkspaceHost(dir);
    const started = Date.now();
    const result = await host.exec(
      { program: process.execPath, args: [parentScript], verbatim: false },
      execOptions({ timeoutMs: 1000 })
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true, "应判超时");
    // 宽限 5000ms：孙进程占着管道时 close 不来，也要在超时加宽限内返回（给 3000ms 余量覆盖机器抖动）
    assert.ok(elapsed < 1000 + 5000 + 3000, `调用应在超时加宽限内返回，实际 ${elapsed}ms`);
    grandchildPid = await readGrandchildPid(pidFile, 2000);
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("run_command 中止：abort 信号终止整组，孙进程在宽限内消失且调用及时返回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-localhost-abort-"));
  let grandchildPid = 0;
  try {
    const { pidFile, parentScript } = writeTreeFixture(dir);
    const host = createLocalWorkspaceHost(dir);
    const controller = new AbortController();
    // 大超时，用中止而非超时收尾：等孙进程起来后 abort
    const call = host.exec(
      { program: process.execPath, args: [parentScript], verbatim: false },
      execOptions({ timeoutMs: 30_000, signal: controller.signal })
    );
    grandchildPid = await readGrandchildPid(pidFile, 5000);
    assert.ok(grandchildPid > 0, "孙进程应已写出 pid");
    const started = Date.now();
    controller.abort();
    const result = await call;
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, false, "中止不是超时");
    assert.ok(elapsed < 5000 + 3000, `中止后应在宽限内返回，实际 ${elapsed}ms`);
    assert.equal(await waitGone(grandchildPid, 6000), true, "中止后孙进程应在宽限内消失");
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

test("文件清单跳过工作区根下的 .pigeon：执行期间治理目录里的新增与修改不进文件变化，别处与子目录里同名的普通文件夹照常报出", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-localhost-listing-"));
  const churn = seedGovernanceChurn(root);
  try {
    const host = createLocalWorkspaceHost(root);
    assert.deepEqual([...(await host.listFiles(100)).files.keys()].sort(), CHURN_LISTED_BEFORE);
    const tool = createRunCommandTool({ workspaceRoot: root, host });
    const result = await tool.execute("c1", { command: churn.command }, undefined);
    assert.equal(result.details.exitCode, 0, result.details.output);
    assert.deepEqual(result.details.fileChanges, CHURN_FILE_CHANGES);
  } finally {
    churn.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
