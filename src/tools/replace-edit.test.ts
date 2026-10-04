// replace 式编辑工具（决策 061 S1）：参数 { path, old_string, new_string }，原文在文件里必须恰好出现一次，精确匹配、
// 不做空白宽松；匹配时按 LF 规整，写回保留 BOM、行尾风格与末尾换行；未找到、不唯一、新旧相同一律拒绝且文件不变；
// 审批预览 diff 与执行走同一段预检。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createReplaceEditTool } from "./replace-edit.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replace-edit-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("replace 编辑：原文唯一时替换并写回；回执以「已在 X 应用 1 处替换（+a −b 行）」开头，不回传 diff 或锚点", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\nbeta\ngamma\n" });
  try {
    const tool = createReplaceEditTool(root);
    const result = await tool.execute("tc-1", {
      path: "a.ts",
      old_string: "beta",
      new_string: "BETA",
    });
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.ok(textOf(result).startsWith("已在 a.ts 应用 1 处替换（+1 −1 行）"));

    const multi = await tool.execute("tc-2", {
      path: "a.ts",
      old_string: "BETA\ngamma",
      new_string: "delta",
    });
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\ndelta\n");
    assert.ok(textOf(multi).startsWith("已在 a.ts 应用 1 处替换（+1 −2 行）"));
  } finally {
    cleanup();
  }
});

test("replace 编辑：未找到、不唯一（出现次数与各处起始行号）、新旧相同一律拒绝，文件逐字节不变", async () => {
  const original = "x = 1\ny = 2\nx = 1\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const tool = createReplaceEditTool(root);
    await assert.rejects(
      () => tool.execute("tc-1", { path: "a.ts", old_string: "z = 3", new_string: "z = 4" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(
          "未找到 old_string：请重新 read_file 核对原文，含缩进与空白，不要带行号前缀"
        )
    );
    await assert.rejects(
      () => tool.execute("tc-2", { path: "a.ts", old_string: "x = 1", new_string: "x = 9" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith("old_string 不唯一") &&
        error.message.includes("出现 2 次") &&
        error.message.includes("起始行 1、3") &&
        error.message.includes("上下文")
    );
    await assert.rejects(
      () => tool.execute("tc-3", { path: "a.ts", old_string: "y = 2", new_string: "y = 2" }),
      (error: unknown) =>
        error instanceof Error && error.message.startsWith("编辑没有产生任何实际变化")
    );
    // 精确匹配、不做空白宽松：缩进不同即未找到
    await assert.rejects(
      () => tool.execute("tc-4", { path: "a.ts", old_string: "  y = 2", new_string: "y = 3" }),
      (error: unknown) => error instanceof Error && error.message.startsWith("未找到 old_string")
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
  } finally {
    cleanup();
  }
});

test("replace 编辑：CRLF 与 BOM 保留，old_string 用 LF 也能匹配 CRLF 文件；无末尾换行的文件保持无末尾换行", async () => {
  const { root, cleanup } = makeWorkspace({
    "crlf.txt": "﻿alpha\r\nbeta\r\ngamma\r\n",
    "tail.txt": "one\ntwo",
  });
  try {
    const tool = createReplaceEditTool(root);
    await tool.execute("tc-1", {
      path: "crlf.txt",
      old_string: "alpha\nbeta",
      new_string: "ALPHA\nBETA",
    });
    assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), "﻿ALPHA\r\nBETA\r\ngamma\r\n");
    await tool.execute("tc-2", { path: "tail.txt", old_string: "two", new_string: "TWO" });
    assert.equal(readFileSync(join(root, "tail.txt"), "utf8"), "one\nTWO");
  } finally {
    cleanup();
  }
});

test("replace 编辑：路径越出工作区、文件不存在、old_string 为空均拒绝", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\n" });
  try {
    const tool = createReplaceEditTool(root);
    await assert.rejects(() =>
      tool.execute("tc-1", { path: "../escape.ts", old_string: "alpha", new_string: "beta" })
    );
    await assert.rejects(() =>
      tool.execute("tc-2", { path: "missing.ts", old_string: "alpha", new_string: "beta" })
    );
    await assert.rejects(() =>
      tool.execute("tc-3", { path: "a.ts", old_string: "", new_string: "beta" })
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\n");
  } finally {
    cleanup();
  }
});

test("replace 编辑：审批预览 diff 与执行所得一致，预览零副作用", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const expected = "alpha\nBETA\ngamma\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const tool = createReplaceEditTool(root);
    const params = { path: "a.ts", old_string: "beta", new_string: "BETA" };
    const diff = await tool.preview(params);
    assert.match(diff, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n/);
    assert.ok(diff.includes("\n-beta\n+BETA\n"), diff);
    // 预览零副作用
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
    await tool.execute("tc-1", params);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), expected);
  } finally {
    cleanup();
  }
});
