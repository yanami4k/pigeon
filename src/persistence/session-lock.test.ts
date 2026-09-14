// 会话打开锁（M5.5 S1，决策 040 多窗口小修）：另一个存活进程持有同一会话时拒绝打开；
// 持有进程崩溃留下的残留锁被接管；同进程多个写入实例共存、最后一个关闭才释放。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { newSessionId } from "../state/ids.ts";
import { EventLogLockedError, JsonlEventLog } from "./event-log.ts";
import { sessionLockPath } from "./session-lock.ts";

// 子进程打开同一会话并常驻，stdout 打出 ready 后返回
async function spawnHolder(dir: string, sessionId: string) {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "event-log.ts")).href;
  const script =
    `const { JsonlEventLog } = await import(${JSON.stringify(moduleUrl)});` +
    `new JsonlEventLog(${JSON.stringify(dir)}, ${JSON.stringify(sessionId)});` +
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
  const dir = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const sessionId = newSessionId();
  try {
    const { child, exited } = await spawnHolder(dir, sessionId);
    try {
      assert.throws(
        () => new JsonlEventLog(dir, sessionId),
        (error: unknown) =>
          error instanceof EventLogLockedError && error.message.includes(String(child.pid))
      );
    } finally {
      // 强杀 = 崩溃：持有进程来不及释放，锁文件留在磁盘
      child.kill();
      await exited;
    }
    assert.ok(existsSync(sessionLockPath(dir, sessionId)), "崩溃留下残留锁");

    const log = new JsonlEventLog(dir, sessionId);
    const lock = JSON.parse(readFileSync(sessionLockPath(dir, sessionId), "utf8")) as {
      pid: number;
    };
    assert.equal(lock.pid, process.pid, "残留锁被本进程接管");
    log.close();
    assert.equal(existsSync(sessionLockPath(dir, sessionId)), false, "关闭即释放");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("会话打开锁：同进程多个写入实例可共存，最后一个关闭才释放锁", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const sessionId = newSessionId();
  try {
    const first = new JsonlEventLog(dir, sessionId);
    const second = new JsonlEventLog(dir, sessionId);
    first.close();
    assert.ok(existsSync(sessionLockPath(dir, sessionId)), "仍有实例打开，锁保留");
    second.close();
    // 重复关闭幂等，不重复扣减
    second.close();
    assert.equal(existsSync(sessionLockPath(dir, sessionId)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("会话打开锁：锁文件不进会话清单", async () => {
  const { listSessionIds } = await import("./event-log.ts");
  const dir = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
  const sessionId = newSessionId();
  try {
    const log = new JsonlEventLog(dir, sessionId);
    log.appendBreaker({
      toolName: "edit_file",
      toolCallId: "toolu_1",
      scope: "tool",
      count: 3,
      threshold: 3,
      at: 1,
      runId: "run_01J5Z7K8W9ABCDEFGHJKMNPQRS" as never,
    });
    assert.deepEqual(listSessionIds(dir), [sessionId]);
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
