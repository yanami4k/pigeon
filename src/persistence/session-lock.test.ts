// 会话打开锁（M5.5 S1，决策 040 多窗口小修；决策 181 起按会话文件加锁）：另一个存活进程持有同一会话文件时拒绝打开；
// 持有进程崩溃留下的残留锁被接管；同进程多次取锁共存、最后一个释放才删锁；锁文件不进会话清单。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { newSessionId } from "../state/ids.ts";
import { acquireSessionFileLock, SessionLockedError, sessionFileLockPath } from "./session-lock.ts";
import { listSessionFiles, sessionDirectoryName, sessionFileName } from "./session-reader.ts";

// 会话根下按新存储布局放一个会话文件，返回它的路径
function sessionFile(root: string): { path: string; sessionId: string } {
  const sessionId = newSessionId();
  const dir = join(root, sessionDirectoryName("/work/ws"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionFileName(Date.now(), sessionId));
  writeFileSync(path, "");
  return { path, sessionId };
}

// 子进程对同一会话文件取锁并常驻，stdout 打出 ready 后返回
async function spawnHolder(path: string) {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "session-lock.ts")).href;
  const script =
    `const { acquireSessionFileLock } = await import(${JSON.stringify(moduleUrl)});` +
    `acquireSessionFileLock(${JSON.stringify(path)});` +
    `process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<void>();
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("ready")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("exit", (code) => ready.reject(new Error(`持有进程提前退出（${code}）：${stderr}`)));
  await ready.promise;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, exited };
}

test("会话打开锁：存活进程持有时拒绝打开并指明持有进程；进程崩溃后残留锁被接管", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const { path } = sessionFile(root);
  try {
    const { child, exited } = await spawnHolder(path);
    try {
      assert.throws(
        () => acquireSessionFileLock(path),
        (error: unknown) =>
          error instanceof SessionLockedError && error.message.includes(String(child.pid))
      );
    } finally {
      // 强杀 = 崩溃：持有进程来不及释放，锁文件留在磁盘
      child.kill();
      await exited;
    }
    assert.ok(existsSync(sessionFileLockPath(path)), "崩溃留下残留锁");

    const release = acquireSessionFileLock(path);
    const lock = JSON.parse(readFileSync(sessionFileLockPath(path), "utf8")) as { pid: number };
    assert.equal(lock.pid, process.pid, "残留锁被本进程接管");
    release();
    assert.equal(existsSync(sessionFileLockPath(path)), false, "释放即删锁");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话打开锁：同进程多次取锁可共存，最后一个释放才删锁", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const { path } = sessionFile(root);
  try {
    const first = acquireSessionFileLock(path);
    const second = acquireSessionFileLock(path);
    first();
    assert.ok(existsSync(sessionFileLockPath(path)), "仍有持有者，锁保留");
    second();
    // 重复释放幂等，不重复扣减
    second();
    assert.equal(existsSync(sessionFileLockPath(path)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话打开锁：锁文件不进会话清单", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const { path, sessionId } = sessionFile(root);
  try {
    const release = acquireSessionFileLock(path);
    assert.ok(existsSync(sessionFileLockPath(path)));
    assert.deepEqual(
      listSessionFiles(root).map((file) => file.sessionId),
      [sessionId]
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
