// 整树终止的共用做法（决策 098）：以独立进程组拉起，终止时对整组发信号，覆盖子进程再起的孙进程；
// 进程退出兜底把仍在跑的子进程组一并终止。用真的父—孙进程验证孙进程在宽限内消失。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  killProcessTree,
  killTrackedChildren,
  processGroupSpawnOptions,
  trackChild,
  untrackChild,
} from "./process-tree.ts";

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

// 父进程再起一个孙进程（孙进程把自己的 pid 写进文件、继承父的 stdout 并常驻），返回子进程与孙进程 pid
async function spawnGrandchild(dir: string): Promise<{
  child: ReturnType<typeof spawn>;
  grandchildPid: number;
}> {
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
  const child = spawn(process.execPath, [parentScript], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...processGroupSpawnOptions(),
  });
  // 等孙进程把 pid 写出来
  const deadline = Date.now() + 5000;
  let grandchildPid = 0;
  while (Date.now() < deadline && grandchildPid === 0) {
    await sleep(50);
    try {
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
    } catch {
      // 还没写出
    }
  }
  assert.ok(grandchildPid > 0, "孙进程应已写出 pid");
  return { child, grandchildPid };
}

test("killProcessTree：终止整组，子进程再起的孙进程在宽限内消失", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ptree-"));
  let grandchildPid = 0;
  try {
    const spawned = await spawnGrandchild(dir);
    grandchildPid = spawned.grandchildPid;
    assert.equal(isAlive(grandchildPid), true, "终止前孙进程在跑");
    killProcessTree(spawned.child, "SIGKILL");
    assert.equal(await waitGone(grandchildPid, 5000), true, "终止后孙进程应在宽限内消失");
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

test("killTrackedChildren：进程退出兜底把仍在跑的子进程组一并终止", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ptree-exit-"));
  let grandchildPid = 0;
  try {
    const spawned = await spawnGrandchild(dir);
    grandchildPid = spawned.grandchildPid;
    trackChild(spawned.child);
    assert.equal(isAlive(grandchildPid), true);
    // 直接触发退出兜底（真的让进程退出无法在测试里断言）
    killTrackedChildren();
    assert.equal(await waitGone(grandchildPid, 5000), true, "兜底应终止整组，孙进程消失");
  } finally {
    if (grandchildPid > 0 && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
    // untrack 以免影响其他用例
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("untrackChild：解除跟踪后兜底不再终止它", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ptree-untrack-"));
  let grandchildPid = 0;
  try {
    const spawned = await spawnGrandchild(dir);
    grandchildPid = spawned.grandchildPid;
    trackChild(spawned.child);
    untrackChild(spawned.child);
    killTrackedChildren();
    // 未被兜底终止：仍在跑（给一点时间确认没被误杀）
    await sleep(200);
    assert.equal(isAlive(grandchildPid), true, "已解除跟踪，不应被兜底终止");
    // 自己收尾整组
    killProcessTree(spawned.child, "SIGKILL");
    assert.equal(await waitGone(grandchildPid, 5000), true);
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
