// write_file（决策 358）：新建（含中间目录）；覆盖已存在的文件须本会话读过且读后未变，读过（含分段）或本工具写过即可；
// 目标是符号链接拒写，链接与它指向的文件都不变。受保护路径的拒写在 application/write-file-protected.test.ts。
// 另：run_command 的命令长度上限放宽到约 64KB，长命令照常执行。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceWriteRefusedError } from "./paths.ts";
import { createReadFileTool } from "./read-file.ts";
import { FileReadTracker } from "./read-tracker.ts";
import { createRunCommandTool } from "./run-command.ts";
import { createWriteFileTool, WriteFileError } from "./write-file.ts";

function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-write-file-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function tools(root: string) {
  const reads = new FileReadTracker();
  return {
    read: createReadFileTool(root, { editMode: "replace", reads }),
    write: createWriteFileTool(root, reads),
  };
}

test("新建文件（目录不存在会补建），之后本会话可直接再覆盖", () =>
  withRoot(async (root) => {
    const { write } = tools(root);
    await write.execute("w1", { path: "a/b/new.txt", content: "one\n" });
    assert.equal(readFileSync(join(root, "a", "b", "new.txt"), "utf8"), "one\n");
    await write.execute("w2", { path: "a/b/new.txt", content: "two\n" });
    assert.equal(readFileSync(join(root, "a", "b", "new.txt"), "utf8"), "two\n");
  }));

test("覆盖已存在的文件：没读过拒写；读过（分段读也算）即可；读后被别处改了拒写，重新读过即可", () =>
  withRoot(async (root) => {
    const file = join(root, "f.txt");
    writeFileSync(file, "1\n2\n3\n");
    const { read, write } = tools(root);
    await assert.rejects(
      () => write.execute("w1", { path: "f.txt", content: "x\n" }),
      (error: unknown) => error instanceof WriteFileError && /读过它/.test(error.message)
    );
    assert.equal(readFileSync(file, "utf8"), "1\n2\n3\n");
    await read.execute("r1", { path: "f.txt", offset: 2, limit: 1 });
    writeFileSync(file, "changed\n");
    await assert.rejects(
      () => write.execute("w2", { path: "f.txt", content: "x\n" }),
      /在你读过之后被改过/
    );
    assert.equal(readFileSync(file, "utf8"), "changed\n");
    await read.execute("r2", { path: "f.txt" });
    await write.execute("w3", { path: "f.txt", content: "x\n" });
    assert.equal(readFileSync(file, "utf8"), "x\n");
  }));

test("目标是符号链接即拒写，链接与它指向的文件都不变", { skip: process.platform === "win32" }, () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "real.txt"), "real\n");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const { read, write } = tools(root);
    await read.execute("r", { path: "real.txt" });
    await assert.rejects(
      () => write.execute("w", { path: "link.txt", content: "x\n" }),
      WorkspaceWriteRefusedError
    );
    assert.equal(readFileSync(join(root, "real.txt"), "utf8"), "real\n");
  })
);

test("长命令（4000 字符以上）照常执行", () =>
  withRoot(async (root) => {
    const payload = "z".repeat(20_000);
    const run = createRunCommandTool({ workspaceRoot: root });
    const result = await run.execute("c", {
      command: `node -e "console.log('${payload}'.length)"`,
    });
    const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
    assert.match(text, /退出码：0\n20000/);
  }));
