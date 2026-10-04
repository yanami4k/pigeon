import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { lineTag, snapshotTag } from "./hashline.ts";
import { WorkspacePathError } from "./paths.ts";
import { createReadFileTool, type ReadFileDetails } from "./read-file.ts";
import type { PigeonToolResult } from "./wrap.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-read-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 工具结果首段文本（TextContent | ImageContent 联合类型需按 type 窄化）
function textOf(result: PigeonToolResult<ReadFileDetails>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("输出带锚点：头部 [PATH#TAG] 快照，每行 N#TAG 前缀，details 与文件内容一致", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "one\ntwo\nthree\n" });
  try {
    const tool = createReadFileTool(root);
    const result = await tool.execute("tc-1", { path: "a.ts" });
    const text = textOf(result);
    const snap = snapshotTag("one\ntwo\nthree\n");
    assert.ok(text.includes(`[a.ts#${snap}]`), text);
    assert.ok(text.includes(`1#${lineTag("one")}| one`), text);
    assert.ok(text.includes(`2#${lineTag("two")}| two`), text);
    assert.ok(text.includes(`3#${lineTag("three")}| three`), text);
    assert.ok(text.includes("共 3 行"), text);

    const details = result.details as ReadFileDetails;
    assert.equal(details.snapshot, snap);
    assert.equal(details.totalLines, 3);
    assert.equal(details.returnedLines, 3);
  } finally {
    cleanup();
  }
});

test("offset/limit 窗口：截取中间段，末尾给出下一窗口提示", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "l1\nl2\nl3\nl4\nl5\n" });
  try {
    const tool = createReadFileTool(root);
    const result = await tool.execute("tc-1", { path: "a.ts", offset: 2, limit: 2 });
    const text = textOf(result);
    assert.ok(text.includes("窗口 2-3"), text);
    assert.ok(text.includes(`2#${lineTag("l2")}| l2`), text);
    assert.ok(text.includes(`3#${lineTag("l3")}| l3`), text);
    assert.ok(!text.includes("| l1"), text);
    assert.ok(text.includes("还有 2 行未读"), text);
    assert.ok(text.includes("offset=4"), text);
  } finally {
    cleanup();
  }
});

test("offset 超界抛错（教练文案）", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "only\n" });
  try {
    const tool = createReadFileTool(root);
    await assert.rejects(() => tool.execute("tc-1", { path: "a.ts", offset: 9 }), /超出文件范围/);
  } finally {
    cleanup();
  }
});

test("空文件可读", async () => {
  const { root, cleanup } = makeWorkspace({ "empty.txt": "" });
  try {
    const tool = createReadFileTool(root);
    const result = await tool.execute("tc-1", { path: "empty.txt" });
    assert.ok(textOf(result).includes("空文件"));
  } finally {
    cleanup();
  }
});

test("CRLF 文件行内容不带 \\r", async () => {
  const { root, cleanup } = makeWorkspace({ "crlf.ts": "a\r\nb\r\n" });
  try {
    const tool = createReadFileTool(root);
    const result = await tool.execute("tc-1", { path: "crlf.ts" });
    const text = textOf(result);
    assert.ok(text.includes(`1#${lineTag("a")}| a`), text);
    assert.ok(!text.includes("\r"), text);
  } finally {
    cleanup();
  }
});

test("路径逃逸拒绝：../", async () => {
  const outside = join(tmpdir(), "pigeon-read-outside.txt");
  writeFileSync(outside, "secret");
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.execute("tc-1", { path: "../pigeon-read-outside.txt" }),
      WorkspacePathError
    );
  } finally {
    rmSync(outside, { force: true });
    cleanup();
  }
});

test("junction 解析后越界拒绝", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pigeon-read-ext-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    symlinkSync(outside, join(root, "link"), "junction");
    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.execute("tc-1", { path: "link/secret.txt" }),
      WorkspacePathError
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test("目录与非文件目标拒绝", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    mkdirSync(join(root, "dir"));
    const tool = createReadFileTool(root);
    await assert.rejects(() => tool.execute("tc-1", { path: "dir" }), /不是常规文件/);
  } finally {
    cleanup();
  }
});
