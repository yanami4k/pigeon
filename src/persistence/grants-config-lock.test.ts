// 放权配置写入的互斥（并发缺口修复）：追加与移除都是"读出整份、改数组、原子写回"。
// 原子写只保证文件不撕裂，不保证不丢更新——两个窗口同时固化放权时，后写的那份是基于旧内容算出来的，
// 会把先写的那条整份覆盖掉。改为写前按配置文件取一把跨进程锁，撞上即明确拒绝（与会话锁同口径）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConfigGrantRule } from "../state/grants.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "./exclusive-lock.ts";
import {
  appendGrantConfigRule,
  grantsConfigLockPath,
  grantsConfigPath,
  loadGrantConfig,
  removeGrantConfigRule,
} from "./grants-config.ts";

const SESSION = newSessionId();
const ids = new Map<string, string>();

// 每个标签一个稳定的 grantId：同一标签再取到同一个，用来试重复升格
function rule(label: string): ConfigGrantRule {
  let grantId = ids.get(label);
  if (grantId === undefined) {
    grantId = newGrantId();
    ids.set(label, grantId);
  }
  return {
    tool: "read_file",
    pathPrefix: `src/${label}/`,
    promotedFrom: {
      grantId,
      sessionId: SESSION,
      firstCall: { toolCallId: `toolu_${label}`, args: { path: `src/${label}/a.ts` } },
      promotedAt: 1_757_000_000_000,
    },
  } as ConfigGrantRule;
}

const labelOf = (item: ConfigGrantRule): string =>
  [...ids.entries()].find(([, id]) => id === item.promotedFrom.grantId)?.[0] ?? "?";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-grants-lock-"));
}

test("放权配置：写入锁被占着时，追加与移除都被明确拒绝，文件一个字节都不动", () => {
  const dir = root();
  try {
    appendGrantConfigRule(dir, rule("g1"));
    const before = readFileSync(grantsConfigPath(dir), "utf8");
    const release = acquireExclusiveLock(grantsConfigLockPath(dir), "夹具占位：另一个窗口在写");
    try {
      assert.throws(() => appendGrantConfigRule(dir, rule("g2")), ExclusiveLockError);
      assert.throws(() => removeGrantConfigRule(dir, 0), ExclusiveLockError);
      assert.equal(readFileSync(grantsConfigPath(dir), "utf8"), before, "被拒时配置文件不变");
    } finally {
      release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("放权配置：依次写入互不覆盖，并且每次用完都放锁", () => {
  const dir = root();
  try {
    appendGrantConfigRule(dir, rule("g1"));
    appendGrantConfigRule(dir, rule("g2"));
    assert.deepEqual(loadGrantConfig(dir).map(labelOf), ["g1", "g2"], "先写的那条不被后写的覆盖");
    removeGrantConfigRule(dir, 0);
    assert.deepEqual(loadGrantConfig(dir).map(labelOf), ["g2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("放权配置：异常路径同样放锁——重复升格被拒之后锁不留在原地", () => {
  const dir = root();
  try {
    appendGrantConfigRule(dir, rule("g1"));
    assert.throws(() => appendGrantConfigRule(dir, rule("g1")), /已升格/);
    assert.doesNotThrow(() => appendGrantConfigRule(dir, rule("g2")), "上一次的锁要已经放掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
