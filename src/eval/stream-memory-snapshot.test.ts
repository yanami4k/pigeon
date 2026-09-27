import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  learnedDirOf,
  learnedSnapshotOf,
  snapshotOrRestoreLearned,
} from "./stream-memory-snapshot.ts";

function withJobDir(fn: (jobDir: string) => void): void {
  const jobDir = mkdtempSync(join(tmpdir(), "pigeon-learned-snapshot-"));
  try {
    fn(jobDir);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

test("记忆快照：每步开工前整体复制 .pigeon/learned/；同一步再开工（作废重做、续跑）即恢复成那份快照，不重取", () =>
  withJobDir((jobDir) => {
    const learned = learnedDirOf(jobDir);
    mkdirSync(join(learned, "sub"), { recursive: true });
    writeFileSync(join(learned, "MEMORY.md"), "第 1 步之前的记忆\n");
    writeFileSync(join(learned, "sub", "note.md"), "细节\n");
    assert.equal(snapshotOrRestoreLearned(jobDir, 1), "taken");
    assert.equal(
      readFileSync(join(learnedSnapshotOf(jobDir, 1), "learned", "MEMORY.md"), "utf8"),
      "第 1 步之前的记忆\n"
    );
    // 第 1 步的尝试改了记忆、加了文件，随后作废：重做前恢复成快照，多出的文件也不留
    writeFileSync(join(learned, "MEMORY.md"), "作废尝试写下的\n");
    writeFileSync(join(learned, "stray.md"), "x\n");
    assert.equal(snapshotOrRestoreLearned(jobDir, 1), "restored");
    assert.equal(readFileSync(join(learned, "MEMORY.md"), "utf8"), "第 1 步之前的记忆\n");
    assert.equal(readFileSync(join(learned, "sub", "note.md"), "utf8"), "细节\n");
    assert.equal(existsSync(join(learned, "stray.md")), false);
    // 第 1 步完成后的记忆成为第 2 步的快照
    writeFileSync(join(learned, "MEMORY.md"), "第 1 步完成后的记忆\n");
    assert.equal(snapshotOrRestoreLearned(jobDir, 2), "taken");
    assert.equal(
      readFileSync(join(learnedSnapshotOf(jobDir, 2), "learned", "MEMORY.md"), "utf8"),
      "第 1 步完成后的记忆\n"
    );
    assert.equal(
      readFileSync(join(learnedSnapshotOf(jobDir, 1), "learned", "MEMORY.md"), "utf8"),
      "第 1 步之前的记忆\n",
      "早先的快照不被改写"
    );
  }));

test("记忆快照：开工时还没有记忆目录也取一份（记下「没有」）；恢复时把作废尝试新建的记忆目录删掉", () =>
  withJobDir((jobDir) => {
    assert.equal(snapshotOrRestoreLearned(jobDir, 3), "taken");
    assert.equal(existsSync(join(learnedSnapshotOf(jobDir, 3), "learned")), false);
    mkdirSync(learnedDirOf(jobDir), { recursive: true });
    writeFileSync(join(learnedDirOf(jobDir), "MEMORY.md"), "作废尝试写下的\n");
    assert.equal(snapshotOrRestoreLearned(jobDir, 3), "restored");
    assert.equal(existsSync(learnedDirOf(jobDir)), false);
  }));

test("记忆快照：上次取到一半留下的临时目录不算快照，重取时先清掉", () =>
  withJobDir((jobDir) => {
    const tmp = `${learnedSnapshotOf(jobDir, 4)}.tmp`;
    mkdirSync(join(tmp, "learned"), { recursive: true });
    writeFileSync(join(tmp, "learned", "half.md"), "半份\n");
    mkdirSync(learnedDirOf(jobDir), { recursive: true });
    writeFileSync(join(learnedDirOf(jobDir), "MEMORY.md"), "完整的\n");
    assert.equal(snapshotOrRestoreLearned(jobDir, 4), "taken");
    assert.equal(existsSync(tmp), false);
    assert.equal(existsSync(join(learnedSnapshotOf(jobDir, 4), "learned", "half.md")), false);
    assert.equal(
      readFileSync(join(learnedSnapshotOf(jobDir, 4), "learned", "MEMORY.md"), "utf8"),
      "完整的\n"
    );
  }));
