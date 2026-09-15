// read_file 的 replace 模式输出（决策 061 S1）：头部 [路径] 共 N 行（窗口 a-b），每行 `行号| 内容`，
// 不带行标签与快照标签；工具描述写明编辑时不要带行号前缀。缺省（hashline）输出不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lineTag, snapshotTag } from "./hashline.ts";
import { createReadFileTool } from "./read-file.ts";

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("read_file replace 模式：每行 `行号| 内容`、头部只有路径与行数窗口，不带行标签与快照标签；截断提示照旧", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-read-replace-"));
  try {
    const content = "alpha\nbeta\ngamma\n";
    writeFileSync(join(root, "a.ts"), content);
    writeFileSync(join(root, "empty.ts"), "");
    const tool = createReadFileTool(root, { editMode: "replace" });
    assert.match(tool.description, /不要带行号前缀/);
    assert.equal(
      textOf(await tool.execute("tc-1", { path: "a.ts" })),
      "[a.ts] 共 3 行（窗口 1-3）\n1| alpha\n2| beta\n3| gamma"
    );
    assert.equal(
      textOf(await tool.execute("tc-2", { path: "a.ts", offset: 2, limit: 1 })),
      "[a.ts] 共 3 行（窗口 2-2）\n2| beta\n还有 1 行未读，下一窗口参数 offset=3"
    );
    assert.equal(textOf(await tool.execute("tc-3", { path: "empty.ts" })), "[empty.ts] 空文件");

    const hashline = createReadFileTool(root);
    assert.equal(
      textOf(await hashline.execute("tc-4", { path: "a.ts" })),
      `[a.ts#${snapshotTag(content)}] 共 3 行（窗口 1-3）\n1#${lineTag("alpha")}| alpha\n2#${lineTag("beta")}| beta\n3#${lineTag("gamma")}| gamma`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
