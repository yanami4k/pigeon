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
    assert.ok(textOf(result).startsWith("Applied 1 replacement in a.ts (+1 −1 lines)"));

    const multi = await tool.execute("tc-2", {
      path: "a.ts",
      old_string: "BETA\ngamma",
      new_string: "delta",
    });
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\ndelta\n");
    assert.ok(textOf(multi).startsWith("Applied 1 replacement in a.ts (+1 −2 lines)"));
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
          "old_string not found: read the file again with read_file and check the original text, " +
            "including indentation and whitespace, without the line-number prefix"
        )
    );
    await assert.rejects(
      () => tool.execute("tc-2", { path: "a.ts", old_string: "x = 1", new_string: "x = 9" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith("old_string is not unique") &&
        error.message.includes("appears 2 times") &&
        error.message.includes("starting at lines 1, 3") &&
        error.message.includes("surrounding context")
    );
    await assert.rejects(
      () => tool.execute("tc-3", { path: "a.ts", old_string: "y = 2", new_string: "y = 2" }),
      (error: unknown) =>
        error instanceof Error && error.message.startsWith("The edit makes no actual change")
    );
    // 精确匹配、不做空白宽松：缩进不同即未找到
    await assert.rejects(
      () => tool.execute("tc-4", { path: "a.ts", old_string: "  y = 2", new_string: "y = 3" }),
      (error: unknown) => error instanceof Error && error.message.startsWith("old_string not found")
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

// 决策 419：edits 一次多处，各处按改动前的原文定位，全部通过才一起写入
test("replace 编辑多处：顺序不限、逐段回执与审批 diff；同一行上的两处合成一段", async () => {
  const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"];
  const { root, cleanup } = makeWorkspace({
    "a.txt": `${lines.join("\n")}\n`,
    "b.ts": "foo(a, b)\n",
  });
  try {
    const tool = createReplaceEditTool(root);
    const result = await tool.execute("tc-1", {
      path: "a.txt",
      edits: [
        { old_string: "l8", new_string: "L8a\nL8b" },
        { old_string: "l2\n", new_string: "" },
      ],
    });
    assert.equal(
      readFileSync(join(root, "a.txt"), "utf8"),
      "l1\nl3\nl4\nl5\nl6\nl7\nL8a\nL8b\nl9\n"
    );
    const text = textOf(result);
    assert.ok(
      text.startsWith(
        "Applied 2 replacements in a.txt (+2 −2 lines); 2 changed regions\n" +
          "Region 1: deleted before line 2 of the new file"
      ),
      text
    );
    assert.ok(
      text.includes("Region 2: lines 7–8 of the new file:\n5| l6\n6| l7\n7| L8a\n8| L8b\n9| l9"),
      text
    );
    assert.equal((result.details.diff.match(/^@@ /gm) ?? []).length, 2);

    const same = await tool.execute("tc-2", {
      path: "b.ts",
      edits: [
        { old_string: " b)", new_string: " y)" },
        { old_string: "(a,", new_string: "(x," },
      ],
    });
    assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "foo(x, y)\n");
    assert.ok(
      textOf(same).startsWith(
        "Applied 2 replacements in b.ts (+1 −1 lines); lines 1–1 of the new file"
      )
    );
  } finally {
    cleanup();
  }
});

test("replace 编辑多处：任一处不通过、交叠或两种写法混用，整组不写并指明 edits 的第几项", async () => {
  const original = "x = 1\ny = 2\nz = 3\n";
  const { root, cleanup } = makeWorkspace({ "a.ts": original });
  try {
    const tool = createReplaceEditTool(root);
    const rejects = (edits: { old_string: string; new_string: string }[], pattern: RegExp) =>
      assert.rejects(() => tool.execute("tc", { path: "a.ts", edits }), pattern);
    // 第一处本身没问题、第二处不通过：整组不写
    await rejects(
      [
        { old_string: "x = 1", new_string: "q = 1" },
        { old_string: "q = 1", new_string: "r" },
      ],
      /: old_string not found in edits\[1\]: .*located in the original text before any change/
    );
    await rejects(
      [
        { old_string: "y = 2", new_string: "Y" },
        { old_string: " = ", new_string: "==" },
      ],
      /: old_string is not unique in edits\[1\]: it appears 3 times in a\.ts/
    );
    await rejects(
      [
        { old_string: "y = 2", new_string: "Y" },
        { old_string: "z = 3", new_string: "z = 3" },
      ],
      /: The edit makes no actual change in edits\[1\]/
    );
    await rejects(
      [
        { old_string: "y = 2", new_string: "b" },
        { old_string: "x = 1\ny", new_string: "a" },
      ],
      /The old_string of edits\[0\] and edits\[1\] overlap in the original text/
    );
    await rejects(
      [
        { old_string: "z = 3", new_string: "Z" },
        { old_string: "z = 3", new_string: "W" },
      ],
      /overlap/
    );
    await assert.rejects(
      () =>
        tool.execute("tc", {
          path: "a.ts",
          old_string: "x = 1",
          new_string: "X",
          edits: [{ old_string: "y = 2", new_string: "Y" }],
        }),
      /Use either edits or the top-level old_string and new_string, not both/
    );
    await assert.rejects(
      () => tool.execute("tc", { path: "a.ts" }),
      /Missing old_string or new_string/
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), original);
  } finally {
    cleanup();
  }
});
