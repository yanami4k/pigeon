// M5 S3（决策 042）：常驻 Memory 两层读取与字符预算——偏好永不截断且排最前；项目 Memory 按
// 配置顺序装到预算满，边界文件部分装入标 truncated，其余只列文件名；每文件 sha256 与字节数。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MEMORY_BUDGET_CHARS, loadResidentMemory } from "./resident.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

function makeDirs(): { root: string; home: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "pigeon-resident-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeMemory(root: string, name: string, content: string): void {
  writeFileSync(join(root, ".pigeon", "memory", name), content);
}

function writePreferences(home: string, content: string): void {
  mkdirSync(join(home, ".pigeon"), { recursive: true });
  writeFileSync(join(home, ".pigeon", "preferences.md"), content);
}

test("偏好永不截断且排最前；Memory 按序装到预算满，边界文件部分装入，其余只列文件名（去预算判断变红）", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    writePreferences(home, "偏好：回答用中文");
    writeMemory(root, "a.md", "A".repeat(30));
    writeMemory(root, "b.md", "B".repeat(30));
    writeMemory(root, "c.md", "C".repeat(30));
    const memory = loadResidentMemory({ workspaceRoot: root, homeDir: home, budgetChars: 60 });

    assert.deepEqual(
      memory.manifest.map((entry) => [entry.path, entry.included, entry.truncated]),
      [
        ["~/.pigeon/preferences.md", true, false],
        [".pigeon/memory/a.md", true, false],
        [".pigeon/memory/b.md", true, true],
        [".pigeon/memory/c.md", false, false],
      ]
    );
    assert.equal(memory.usedChars, 60);
    assert.ok(memory.section.includes("偏好：回答用中文"));
    assert.ok(memory.section.includes("A".repeat(30)));
    assert.ok(memory.section.includes("B".repeat(22)));
    assert.ok(!memory.section.includes("B".repeat(23)));
    assert.ok(!memory.section.includes("CCC"));
    assert.match(memory.section, /未注入（超出预算.*\.pigeon\/memory\/c\.md/);
    assert.ok(memory.section.indexOf("偏好：回答用中文") < memory.section.indexOf("AAA"));
  } finally {
    cleanup();
  }
});

test("偏好超出预算照样全文注入；此时 Memory 全部只列文件名", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    writePreferences(home, "P".repeat(100));
    writeMemory(root, "a.md", "项目约定");
    const memory = loadResidentMemory({ workspaceRoot: root, homeDir: home, budgetChars: 50 });
    assert.ok(memory.section.includes("P".repeat(100)));
    assert.deepEqual(
      memory.manifest.map((entry) => [entry.path, entry.included]),
      [
        ["~/.pigeon/preferences.md", true],
        [".pigeon/memory/a.md", false],
      ]
    );
    assert.ok(!memory.section.includes("项目约定"));
  } finally {
    cleanup();
  }
});

test("配置顺序优先，未列出的按文件名字典序排在其后；非 .md 文件与子目录不进 Memory", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    writeMemory(root, "a.md", "甲");
    writeMemory(root, "b.md", "乙");
    writeMemory(root, "c.md", "丙");
    writeMemory(root, "notes.txt", "不算");
    mkdirSync(join(root, ".pigeon", "memory", "sub.md"));
    const memory = loadResidentMemory({
      workspaceRoot: root,
      homeDir: home,
      order: ["c.md", "a.md"],
    });
    assert.deepEqual(
      memory.manifest.map((entry) => entry.path),
      [".pigeon/memory/c.md", ".pigeon/memory/a.md", ".pigeon/memory/b.md"]
    );
    assert.equal(DEFAULT_MEMORY_BUDGET_CHARS, 8000);
  } finally {
    cleanup();
  }
});

test("冻结身份：每文件按原始字节算 sha256 与字节数；无任何文件时段落与清单为空", () => {
  const { root, home, cleanup } = makeDirs();
  try {
    const empty = loadResidentMemory({ workspaceRoot: root, homeDir: home });
    assert.equal(empty.section, "");
    assert.deepEqual(empty.manifest, []);

    writeMemory(root, "a.md", "中文");
    const memory = loadResidentMemory({ workspaceRoot: root, homeDir: home });
    assert.deepEqual(memory.manifest, [
      {
        path: ".pigeon/memory/a.md",
        hash: sha256("中文"),
        bytes: 6,
        truncated: false,
        included: true,
      },
    ]);
  } finally {
    cleanup();
  }
});
