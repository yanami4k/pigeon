// 独占锁（M8 收口补遗，决策 086）：同一条候选同一时刻只允许一次验证在跑。
// 与会话锁的区别是它不可重入——人工触发与无人值守自动验证可能在同一个进程里同时跑同一条候选，
// 会话锁的同进程重入在这里正好是漏洞。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireExclusiveLock, ExclusiveLockError } from "./exclusive-lock.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-exclusive-lock-"));
}

test("独占锁：同一把锁不可重入——同进程再取也拒绝", () => {
  const root = dir();
  try {
    const path = join(root, "a.lock");
    const release = acquireExclusiveLock(path, "候选 a 正在验证");
    assert.throws(() => acquireExclusiveLock(path, "候选 a 正在验证"), ExclusiveLockError);
    release();
    assert.doesNotThrow(() => acquireExclusiveLock(path, "候选 a 正在验证")());
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
    const release = acquireExclusiveLock(path, "候选 abc123 正在被另一次验证占用");
    assert.throws(
      () => acquireExclusiveLock(path, "候选 abc123 正在被另一次验证占用"),
      (error: unknown) =>
        /候选 abc123 正在被另一次验证占用/.test(String(error)) && String(error).includes(path)
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
