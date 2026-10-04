// edit_file（replace 模式）的回执（决策 366）：写明这处改动在新文件里的行区间，附上下各两行带行号的内容；纯删除写明删去处。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReplaceEditTool } from "./replace-edit.ts";

function withFile(content: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-edit-receipt-"));
  writeFileSync(join(root, "a.txt"), content);
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");

const FILE = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");

test("回执给出改动在新文件里的行区间与上下各两行（带行号）", () =>
  withFile(`${FILE}\n`, async (root) => {
    const edit = createReplaceEditTool(root);
    const text = textOf(
      await edit.execute("e", { path: "a.txt", old_string: "l4", new_string: "X\nY" })
    );
    assert.match(text, /新文件第 4–5 行/);
    assert.ok(text.endsWith("2| l2\n3| l3\n4| X\n5| Y\n6| l5\n7| l6"), text);
  }));

test("纯删除写明删去处并给出前后两行；改在文件开头时上面没有行可给", () =>
  withFile(`${FILE}\n`, async (root) => {
    const edit = createReplaceEditTool(root);
    const removed = textOf(
      await edit.execute("e1", { path: "a.txt", old_string: "l4\n", new_string: "" })
    );
    assert.match(removed, /删去处在新文件第 4 行之前/);
    assert.ok(removed.endsWith("2| l2\n3| l3\n4| l5\n5| l6"), removed);
    const top = textOf(
      await edit.execute("e2", { path: "a.txt", old_string: "l1", new_string: "L1" })
    );
    assert.ok(top.endsWith("新文件第 1–1 行：\n1| L1\n2| l2\n3| l3"), top);
  }));
