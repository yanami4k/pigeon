// 新会话存储的只读读取器（决策 181）：逐行解析文件头与各条变更、按 seq 重放出条目与通道；不完整的末行跳过、
// 不写文件；不认识的条目类型记告警并跳过这一条，整个文件照常可读。另覆盖按目录列会话文件、按会话号定位，
// 以及会话根下遗留的旧格式平铺文件不被列举。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  branchEntries,
  listSessionFiles,
  locateSessionFile,
  messageEntryAt,
  readSessionFile,
  sessionDirectoryName,
  sessionFileName,
} from "./session-reader.ts";

const HEADER = {
  kind: "header",
  version: 4,
  id: "sess_A",
  createdAt: 1_700_000_000_000,
  cwd: "/work",
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(seq: number, id: string, parentId: string | null, text: string) {
  return {
    kind: "entry",
    lane: "main",
    type: "message",
    id,
    parentId,
    seq,
    timestamp: 1_700_000_000_000 + seq,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  };
}

function withFile(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-reader-"));
  try {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("读取器：按 seq 重放出条目与通道，文件头与条目原样给出", () => {
  const content =
    line(HEADER) + line(message(1, "e1", null, "一")) + line(message(2, "e2", "e1", "二"));
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    assert.equal(view.header.id, "sess_A");
    assert.deepEqual(
      view.entries.map((entry) => [entry.id, entry.parentId, entry.seq]),
      [
        ["e1", null, 1],
        ["e2", "e1", 2],
      ]
    );
    assert.equal(view.lanes.get("main"), "e2");
    assert.deepEqual(view.warnings, []);
  });
});

test("读取器：不完整的末行跳过、不告警，文件一个字节都不改", () => {
  const whole = line(HEADER) + line(message(1, "e1", null, "一"));
  const content = `${whole}{"kind":"entry","lane":"main","type":"mess`;
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    assert.deepEqual(
      view.entries.map((entry) => entry.id),
      ["e1"]
    );
    assert.deepEqual(view.warnings, []);
    assert.equal(readFileSync(path, "utf8"), content, "只读：不修复、不改写");
  });
});

test("读取器：合法但缺换行的末行照常读入", () => {
  const content = line(HEADER) + JSON.stringify(message(1, "e1", null, "一"));
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.deepEqual(
      view?.entries.map((entry) => entry.id),
      ["e1"]
    );
    assert.equal(readFileSync(path, "utf8"), content);
  });
});

test("读取器：不认识的条目类型记告警并跳过，其子条目接到它的父条目上，通道指向随之回退", () => {
  const unknown = { ...message(2, "x", "e1", "?"), type: "pigeon_raw" };
  const content =
    line(HEADER) +
    line(message(1, "e1", null, "一")) +
    line(unknown) +
    line(message(3, "e3", "x", "三")) +
    line({ kind: "lane", seq: 4, lane: "side", leafId: "x" });
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    assert.deepEqual(
      view.entries.map((entry) => [entry.id, entry.parentId]),
      [
        ["e1", null],
        ["e3", "e1"],
      ]
    );
    assert.equal(view.lanes.get("main"), "e3");
    assert.equal(view.lanes.get("side"), "e1");
    assert.equal(view.warnings.length, 1);
    assert.match(view.warnings[0] ?? "", /第 3 行.*pigeon_raw/);
    assert.deepEqual(
      branchEntries(view, "e3").map((entry) => entry.id),
      ["e1", "e3"]
    );
  });
});

test("读取器：不认识的 record 类型与变更种类记告警并跳过，其余照读", () => {
  const content =
    line(HEADER) +
    line({ kind: "record", id: "r1", seq: 1, lane: "main", type: "pigeon_rec", timestamp: 1 }) +
    line({ kind: "mystery", seq: 2 }) +
    line(message(3, "e1", null, "一"));
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.deepEqual(
      view?.entries.map((entry) => entry.id),
      ["e1"]
    );
    assert.equal(view?.warnings.length, 2);
  });
});

test("读取器：中段坏行记告警并跳过，不让整个文件读失败", () => {
  const content =
    line(HEADER) +
    line(message(1, "e1", null, "一")) +
    "{坏\n" +
    line(message(3, "e3", "e1", "三"));
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.deepEqual(
      view?.entries.map((entry) => entry.id),
      ["e1", "e3"]
    );
    assert.equal(view?.warnings.length, 1);
    assert.match(view?.warnings[0] ?? "", /第 3 行/);
  });
});

test("读取器：空文件与文件头不完整的文件不是会话（返回 undefined），只有文件头的是空会话", () => {
  withFile("", (path) => assert.equal(readSessionFile(path), undefined));
  withFile('{"kind":"header","vers', (path) => assert.equal(readSessionFile(path), undefined));
  withFile(line({ ...HEADER, version: 3 }), (path) =>
    assert.equal(readSessionFile(path), undefined)
  );
  withFile(line(HEADER), (path) => {
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    assert.deepEqual(view.entries, []);
    assert.equal(view.lanes.get("main"), null);
    assert.deepEqual(view.warnings, []);
  });
});

test("读取器：会话名与条目标签按最新值还原", () => {
  const content =
    line(HEADER) +
    line(message(1, "e1", null, "一")) +
    line({ kind: "fact", seq: 2, fact: "name", name: "甲" }) +
    line({ kind: "fact", seq: 3, fact: "label", targetId: "e1", label: "起点" }) +
    line({ kind: "fact", seq: 4, fact: "name", name: "乙" });
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.equal(view?.name, "乙");
    assert.equal(view?.labels.get("e1"), "起点");
  });
});

test("按会话号定位分叉点：Run 开始条目之后按条数数到第 runSeq 条消息", () => {
  const runStart = (seq: number, id: string, parentId: string | null, runId: string) => ({
    kind: "entry",
    lane: "main",
    type: "custom",
    customType: "pigeon.run-start",
    data: { version: 1, runId },
    id,
    parentId,
    seq,
    timestamp: seq,
  });
  const content =
    line(HEADER) +
    line(runStart(1, "s1", null, "run_1")) +
    line(message(2, "m1", "s1", "一")) +
    line(message(3, "m2", "m1", "二")) +
    line(runStart(4, "s2", "m2", "run_2")) +
    line(message(5, "m3", "s2", "三"));
  withFile(content, (path) => {
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    const main = branchEntries(view, view.lanes.get("main") ?? null);
    assert.equal(messageEntryAt(main, "run_1", 2), "m2");
    assert.equal(messageEntryAt(main, "run_2", 1), "m3");
    assert.equal(messageEntryAt(main, "run_2", 2), undefined);
    assert.equal(messageEntryAt(main, "run_9", 1), undefined);
  });
});

test("列会话文件：只认会话根下各工作目录子目录里的 <时间>_<会话号>.jsonl，不读文件内容", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-list-"));
  try {
    const dir = join(root, sessionDirectoryName("D:\\work\\repo"));
    assert.equal(sessionDirectoryName("D:\\work\\repo"), "--D--work-repo--");
    assert.equal(sessionDirectoryName("/home/u/repo"), "--home-u-repo--");
    mkdirSync(dir, { recursive: true });
    const name = sessionFileName(Date.UTC(2026, 8, 27, 1, 2, 3, 456), "sess_01ABC");
    assert.equal(name, "2026-09-27T01-02-03-456Z_sess_01ABC.jsonl");
    // 内容不是合法会话也照列：列举只看文件名
    writeFileSync(join(dir, name), "garbage");
    // 分叉时的临时文件、锁文件与无关文件不进清单
    writeFileSync(join(dir, `${name}.tmp`), "");
    writeFileSync(join(dir, `${name}.lock`), "");
    writeFileSync(join(dir, "notes.jsonl"), "");
    // 遗留的旧格式平铺文件（账本、旁置正文、锁）在会话根下，不在任何子目录里
    writeFileSync(join(root, "sess_01ABC.jsonl"), line({ version: 17, kind: "entry" }));
    writeFileSync(join(root, "sess_01ABC.messages.jsonl"), "");
    writeFileSync(join(root, "sess_01ABC.lock"), "");
    const files = listSessionFiles(root);
    assert.deepEqual(
      files.map((file) => [file.sessionId, file.path]),
      [["sess_01ABC", join(dir, name)]]
    );
    assert.equal(files[0]?.createdAt, Date.UTC(2026, 8, 27, 1, 2, 3, 456));
    assert.equal(locateSessionFile(root, "sess_01ABC")?.path, join(dir, name));
    assert.equal(locateSessionFile(root, "sess_01AB"), undefined, "会话号精确匹配，不按后缀");
    assert.equal(locateSessionFile(join(root, "missing"), "sess_01ABC"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
