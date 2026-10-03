// grants.json 原子替换（M5.5 S1，决策 040 多窗口小修）：写到一半崩溃不留半截文件——
// 临时文件写满并 fsync 后改名替换，中断时原文件逐字节不变、仍可载入。
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ConfigGrantRule } from "../state/grants.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import {
  appendGrantConfigRule,
  grantsConfigPath,
  loadGrantConfig,
  removeGrantConfigRule,
} from "./grants-config.ts";

function makeRule(tool: string): ConfigGrantRule {
  return {
    tool,
    promotedFrom: {
      grantId: newGrantId(),
      sessionId: newSessionId(),
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
      promotedAt: 1_757_000_000_000,
    },
  };
}

// 写一半即抛：模拟进程在写盘中途死亡
const crashHalfway = {
  write(fd: number, data: string) {
    writeSync(fd, data.slice(0, Math.floor(data.length / 2)));
    throw new Error("模拟写到一半崩溃");
  },
};

test("放权配置原子替换：升格写到一半崩溃，原文件逐字节不变且可载入", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-atomic-"));
  try {
    const first = makeRule("edit_file");
    appendGrantConfigRule(root, first);
    const before = readFileSync(grantsConfigPath(root), "utf8");

    assert.throws(
      () => appendGrantConfigRule(root, makeRule("read_file"), { io: crashHalfway }),
      /模拟写到一半崩溃/
    );
    assert.equal(readFileSync(grantsConfigPath(root), "utf8"), before);
    assert.deepEqual(loadGrantConfig(root), [first]);
    // 失败路径清掉自己的临时文件
    assert.deepEqual(
      readdirSync(dirname(grantsConfigPath(root))).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("放权配置原子替换：移除规则写到一半崩溃，原文件不变", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-atomic-"));
  try {
    const first = makeRule("edit_file");
    const second = makeRule("read_file");
    appendGrantConfigRule(root, first);
    appendGrantConfigRule(root, second);
    const before = readFileSync(grantsConfigPath(root), "utf8");

    assert.throws(() => removeGrantConfigRule(root, 0, { io: crashHalfway }), /模拟写到一半崩溃/);
    assert.equal(readFileSync(grantsConfigPath(root), "utf8"), before);
    assert.deepEqual(loadGrantConfig(root), [first, second]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("放权配置原子替换：真实崩溃残留的临时文件不影响载入与后续写入", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-atomic-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(`${grantsConfigPath(root)}.4242.deadbeef.tmp`, '{"permissions":{"gra');
    assert.deepEqual(loadGrantConfig(root), []);
    const rule = makeRule("edit_file");
    appendGrantConfigRule(root, rule);
    assert.deepEqual(loadGrantConfig(root), [rule]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
