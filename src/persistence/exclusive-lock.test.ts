// 独占锁（M8 收口补遗）：同一份被保护的文件同一时刻只允许一个持有者（现为固化放权配置与会话树）。
// 与会话锁的区别是它不可重入——同一个进程里的两处可能同时改同一份文件，会话锁的同进程重入在这里正好是漏洞。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  acquireExclusiveLock,
  currentBootId,
  ExclusiveLockError,
  processStartTime,
} from "./exclusive-lock.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-exclusive-lock-"));
}

test("独占锁：同一把锁不可重入——同进程再取也拒绝", () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    const release = acquireExclusiveLock(path, "配置 a 正在写入");
    assert.throws(() => acquireExclusiveLock(path, "配置 a 正在写入"), ExclusiveLockError);
    release();
    assert.doesNotThrow(() => acquireExclusiveLock(path, "配置 a 正在写入")());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("独占锁：不同的锁互不影响", () => {
  const root = dir();
  try {
    const a = acquireExclusiveLock(join(root, "a.lock"), "a");
    const b = acquireExclusiveLock(join(root, "b.lock"), "b");
    a();
    b();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("独占锁：持有进程已死的残留锁可以接管；内容畸形同样接管", () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    // 一个几乎不可能存活的 pid
    writeFileSync(path, JSON.stringify({ pid: 0x7ffffffe, acquiredAt: 1 }), "utf8");
    const release = acquireExclusiveLock(path, "a");
    assert.match(readFileSync(path, "utf8"), new RegExp(`"pid":${process.pid}`));
    release();

    writeFileSync(path, "不是 JSON", "utf8");
    acquireExclusiveLock(path, "a")();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("独占锁：释放是幂等的，重复释放不删别人接管后的锁", () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    const release = acquireExclusiveLock(path, "a");
    release();
    const second = acquireExclusiveLock(path, "a");
    release();
    assert.throws(() => acquireExclusiveLock(path, "a"), ExclusiveLockError, "第二把锁仍然有效");
    second();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("独占锁：报错文案带上调用方给的说明与锁文件路径", () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    const release = acquireExclusiveLock(path, "配置 abc123 正在被另一次写入占用");
    assert.throws(
      () => acquireExclusiveLock(path, "配置 abc123 正在被另一次写入占用"),
      (error: unknown) =>
        /配置 abc123 正在被另一次写入占用/.test(String(error)) && String(error).includes(path)
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 另一个进程紧盯锁文件，数有多少次读到“存在但不是完整的持有者记录”。
// 停止信号用一个哨兵文件；另设兜底期限，父进程异常退出时子进程不会挂住
const POLLER = [
  'const fs = require("node:fs");',
  "const [lockPath, stopPath, outPath] = process.argv.slice(1);",
  "let torn = 0;",
  "let seen = 0;",
  "const deadline = Date.now() + 30000;",
  "while (!fs.existsSync(stopPath) && Date.now() < deadline) {",
  "  let raw;",
  '  try { raw = fs.readFileSync(lockPath, "utf8"); } catch { continue; }',
  "  seen += 1;",
  "  try {",
  "    const parsed = JSON.parse(raw);",
  '    if (typeof parsed.pid !== "number") { torn += 1; }',
  "  } catch { torn += 1; }",
  "}",
  'fs.writeFileSync(outPath, JSON.stringify({ torn, seen }), "utf8");',
].join("\n");

test("建锁原子性：锁文件一出现就是完整内容，另一个进程读不到半截锁", async () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    const stopPath = join(root, "stop");
    const outPath = join(root, "seen.json");
    const poller = spawn(process.execPath, ["-e", POLLER, path, stopPath, outPath], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => poller.on("exit", () => resolve()));
    // 反复取放同一把锁：建锁若分“先创建空文件、再写内容”两步，这中间的 0 字节窗口就会被读到，
    // 而读到的一方会把它判为损坏锁直接接管——于是两个进程同时认为自己持锁
    for (let i = 0; i < 400; i += 1) {
      acquireExclusiveLock(path, "夹具")();
    }
    writeFileSync(stopPath, "", "utf8");
    await exited;
    const observed = JSON.parse(readFileSync(outPath, "utf8")) as { torn: number; seen: number };
    assert.ok(observed.seen > 0, "子进程至少要读到过这把锁，否则这条用例什么都没测");
    assert.equal(observed.torn, 0, "锁文件不该有任何一刻是不完整的");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 开机编号与启动时刻只在 Linux 上取得到
const NO_PROC = currentBootId() === undefined ? "取不到开机编号（非 Linux）" : false;

test.skipIf(NO_PROC)(
  "独占锁：记下的开机编号或进程启动时刻与现在不符（整机重启、pid 被复用）即按残留接管；真在跑的持有者照常拒绝",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-lock-"));
    try {
      const path = join(dir, "run.lock");
      const alive = {
        pid: process.pid,
        acquiredAt: 1,
        bootId: currentBootId(),
        startTime: processStartTime(process.pid),
      };
      for (const [what, holder] of [
        ["开机编号不同", { ...alive, bootId: "00000000-0000-0000-0000-000000000000" }],
        ["同一 pid、启动时刻不同", { ...alive, startTime: "1" }],
      ] as const) {
        writeFileSync(path, `${JSON.stringify(holder)}\n`);
        const release = acquireExclusiveLock(path, "测试");
        assert.equal(JSON.parse(readFileSync(path, "utf8")).startTime, alive.startTime, what);
        release();
      }
      writeFileSync(path, `${JSON.stringify(alive)}\n`);
      assert.throws(() => acquireExclusiveLock(path, "测试"), ExclusiveLockError, "真在跑的持有者");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
