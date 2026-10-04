import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import {
  memoryFactsOf,
  memoryFileOf,
  memorySnapshotOf,
  snapshotOrRestoreMemory,
} from "./stream-memory-snapshot.ts";

function withJobDir(fn: (jobDir: string) => void): void {
  const jobDir = mkdtempSync(join(tmpdir(), "pigeon-memory-snapshot-"));
  try {
    fn(jobDir);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

function remember(jobDir: string, text: string): void {
  mkdirSync(dirname(memoryFileOf(jobDir)), { recursive: true });
  writeFileSync(memoryFileOf(jobDir), text);
}

test("记忆快照：每步开工前复制项目级记忆 .pigeon/state/memory.md；同一步再开工（作废重做、续跑）即恢复成那份快照，不重取", () =>
  withJobDir((jobDir) => {
    assert.equal(memoryFileOf(jobDir), join(jobDir, ".pigeon", "state", "memory.md"));
    remember(jobDir, "第 1 步之前的记忆\n");
    assert.equal(snapshotOrRestoreMemory(jobDir, 1), "taken");
    assert.equal(
      readFileSync(join(memorySnapshotOf(jobDir, 1), "memory.md"), "utf8"),
      "第 1 步之前的记忆\n"
    );
    // 第 1 步的尝试改了记忆，随后作废：重做前恢复成快照
    remember(jobDir, "作废尝试写下的\n");
    assert.equal(snapshotOrRestoreMemory(jobDir, 1), "restored");
    assert.equal(readFileSync(memoryFileOf(jobDir), "utf8"), "第 1 步之前的记忆\n");
    // 第 1 步完成后的记忆成为第 2 步的快照
    remember(jobDir, "第 1 步完成后的记忆\n");
    assert.equal(snapshotOrRestoreMemory(jobDir, 2), "taken");
    assert.equal(
      readFileSync(join(memorySnapshotOf(jobDir, 2), "memory.md"), "utf8"),
      "第 1 步完成后的记忆\n"
    );
    assert.equal(
      readFileSync(join(memorySnapshotOf(jobDir, 1), "memory.md"), "utf8"),
      "第 1 步之前的记忆\n",
      "早先的快照不被改写"
    );
  }));

test("记忆快照：开工时还没有记忆文件也取一份（记下「没有」）；恢复时把作废尝试新建的记忆文件删掉", () =>
  withJobDir((jobDir) => {
    assert.equal(snapshotOrRestoreMemory(jobDir, 3), "taken");
    assert.equal(existsSync(join(memorySnapshotOf(jobDir, 3), "memory.md")), false);
    remember(jobDir, "作废尝试写下的\n");
    assert.equal(snapshotOrRestoreMemory(jobDir, 3), "restored");
    assert.equal(existsSync(memoryFileOf(jobDir)), false);
  }));

test("记忆快照：上次取到一半留下的临时目录不算快照，重取时先清掉", () =>
  withJobDir((jobDir) => {
    const tmp = `${memorySnapshotOf(jobDir, 4)}.tmp`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "half.md"), "半份\n");
    remember(jobDir, "完整的\n");
    assert.equal(snapshotOrRestoreMemory(jobDir, 4), "taken");
    assert.equal(existsSync(tmp), false);
    assert.equal(existsSync(join(memorySnapshotOf(jobDir, 4), "half.md")), false);
    assert.equal(readFileSync(join(memorySnapshotOf(jobDir, 4), "memory.md"), "utf8"), "完整的\n");
  }));

test("开工时的记忆大小：文件不在记 0；条目数按「- [P编号]」开头的行数，条目字符数从第一条起按码点计（文件头不计）", () =>
  withJobDir((jobDir) => {
    assert.deepEqual(memoryFactsOf(jobDir), { bytes: 0, entries: 0, entryChars: 0 });
    const header = "# 学到的记忆（本项目）\n<!-- 说明 -->\n\n";
    const entries = "- [P1] 甲 〔2026-10-01 · 终端界面 · 会话 sess_1〕\n- [P3] 丙\n";
    remember(jobDir, header + entries);
    assert.deepEqual(memoryFactsOf(jobDir), {
      bytes: Buffer.byteLength(header + entries),
      entries: 2,
      entryChars: [...entries].length,
    });
    remember(jobDir, header);
    assert.deepEqual(memoryFactsOf(jobDir), {
      bytes: Buffer.byteLength(header),
      entries: 0,
      entryChars: 0,
    });
  }));
