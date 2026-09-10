import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditFileTool, type EditFileDetails, EditFileError } from "./edit-file.ts";
import { lineTag, snapshotTag } from "./hashline.ts";
import { WorkspacePathError } from "./paths.ts";
import { createReadFileTool } from "./read-file.ts";
import type { PigeonToolResult } from "./wrap.ts";

function makeWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-edit-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function textOf(result: PigeonToolResult<EditFileDetails>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

test("锚点命中编辑：read 给锚点与快照，edit 消费同一套标签完成替换", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "alpha\nbeta\ngamma\n" });
  try {
    const reader = createReadFileTool(root);
    const readResult = await reader.execute("tc-1", { path: "a.ts" });
    const snapshot = readResult.details.snapshot;

    const editor = createEditFileTool(root);
    const result = await editor.execute("tc-2", {
      path: "a.ts",
      snapshot,
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    });
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    // 返回新快照供链式编辑；diff 含 +/- 行
    const after = snapshotTag("alpha\nBETA\ngamma\n");
    assert.equal(result.details.afterSnapshot, after);
    assert.ok(result.details.diff.includes("-beta"), result.details.diff);
    assert.ok(result.details.diff.includes("+BETA"), result.details.diff);
    assert.ok(textOf(result).includes(after), textOf(result));
  } finally {
    cleanup();
  }
});

test("过期快照拒绝：读取后文件被外部改动，edit 拒绝且不覆盖外部改动", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "v1\n" });
  try {
    const editor = createEditFileTool(root);
    const stale = snapshotTag("v1\n");
    writeFileSync(join(root, "a.ts"), "v2\n");
    await assert.rejects(
      () =>
        editor.execute("tc-1", {
          path: "a.ts",
          snapshot: stale,
          edits: [{ op: "replace", anchor: `1#${lineTag("v1")}`, lines: ["v3"] }],
        }),
      EditFileError
    );
    // 文件保持外部改动后的内容，未被编辑覆盖
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "v2\n");
  } finally {
    cleanup();
  }
});

test("锚点漂移拒绝：行内容已变导致 tag 不匹配", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "new\ncontent\n" });
  try {
    const editor = createEditFileTool(root);
    await assert.rejects(
      () =>
        editor.execute("tc-1", {
          path: "a.ts",
          snapshot: snapshotTag("new\ncontent\n"),
          edits: [{ op: "replace", anchor: `1#${lineTag("old")}`, lines: ["x"] }],
        }),
      /未命中/
    );
  } finally {
    cleanup();
  }
});

test("多段预检原子性：第二处锚点坏 → 整单拒绝，文件逐字节不变", async () => {
  const original = "a\nb\nc\nd\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const editor = createEditFileTool(root);
    await assert.rejects(
      () =>
        editor.execute("tc-1", {
          path: "a.ts",
          snapshot: snapshotTag(original),
          edits: [
            { op: "replace", anchor: `1#${lineTag("a")}`, lines: ["A"] },
            { op: "replace", anchor: `3#${lineTag("已不存在的行")}`, lines: ["X"] },
          ],
        }),
      /未命中/
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
  } finally {
    cleanup();
  }
});

test("无实际变化的编辑拒绝", async () => {
  const original = "same\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const editor = createEditFileTool(root);
    await assert.rejects(
      () =>
        editor.execute("tc-1", {
          path: "a.ts",
          snapshot: snapshotTag(original),
          edits: [{ op: "replace", anchor: `1#${lineTag("same")}`, lines: ["same"] }],
        }),
      /没有产生任何实际变化/
    );
  } finally {
    cleanup();
  }
});

test("CRLF 与 BOM 忠实保留", async () => {
  const original = "\uFEFFfirst\r\nsecond\r\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const editor = createEditFileTool(root);
    await editor.execute("tc-1", {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("second")}`, lines: ["SECOND"] }],
    });
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "\uFEFFfirst\r\nSECOND\r\n");
  } finally {
    cleanup();
  }
});

test("路径逃逸拒绝（edit 侧）", async () => {
  const outside = join(tmpdir(), "pigeon-edit-outside.txt");
  writeFileSync(outside, "secret\n");
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    const editor = createEditFileTool(root);
    await assert.rejects(
      () =>
        editor.execute("tc-1", {
          path: "../pigeon-edit-outside.txt",
          snapshot: snapshotTag("secret\n"),
          edits: [{ op: "replace", anchor: `1#${lineTag("secret")}`, lines: ["pwned"] }],
        }),
      WorkspacePathError
    );
    assert.equal(readFileSync(outside, "utf8"), "secret\n");
  } finally {
    rmSync(outside, { force: true });
    cleanup();
  }
});

test("畸形参数在 execute 入口被拒绝（schema 校验）", async () => {
  const { root, cleanup } = makeWorkspace({ "a.ts": "x\n" });
  try {
    const editor = createEditFileTool(root);
    await assert.rejects(() =>
      editor.execute("tc-1", {
        path: "a.ts",
        snapshot: "not-a-snapshot",
        edits: [],
      })
    );
  } finally {
    cleanup();
  }
});
