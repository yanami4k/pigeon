// write_file（决策 358）：新建（含中间目录）；覆盖已存在的文件须本会话读过且读后未变，读过（含分段）或本工具写过即可；
// 目标是符号链接拒写，链接与它指向的文件都不变。受保护路径的拒写在 application/write-file-protected.test.ts。
// 另：路径含控制字符拒写（write_file 与 edit_file 两种模式）；新建越出工作区根、检查后被别人建了、检查后路径上的目录被
// 换成链接都拒写；失败的读取不算读过；读取记录按文件字节判断；审批预览逐行分段；run_command 长命令照常执行，超出执行端
// 能执行的长度直接给出明确错误。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditFileTool } from "./edit-file.ts";
import {
  createWorkspaceFile,
  resolveWorkspaceCreatePath,
  WorkspacePathError,
  WorkspaceWriteRefusedError,
} from "./paths.ts";
import { createReadFileTool } from "./read-file.ts";
import { FileReadTracker } from "./read-tracker.ts";
import { createReplaceEditTool } from "./replace-edit.ts";
import { commandTooLong, createRunCommandTool, RunCommandError } from "./run-command.ts";
import { createWriteFileTool, lineDiff, WriteFileError } from "./write-file.ts";

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

test("路径含换行或其他控制字符一律拒写，什么也不建", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, ".pigeon"));
    const { write } = tools(root);
    for (const path of [".pigeon\n/x", "a\tb.txt", "c\u0000.txt"]) {
      await assert.rejects(
        () => write.execute("w", { path, content: "x" }),
        WorkspaceWriteRefusedError
      );
    }
    assert.equal(existsSync(join(root, ".pigeon\n")), false);
  }));

test("edit_file 两种模式：路径含控制字符一律拒写，同名文件确实存在时也不改", () =>
  withRoot(async (root) => {
    // Windows 的文件名不能含控制字符：那里只验拒写本身
    const named = process.platform !== "win32";
    if (named) writeFileSync(join(root, "a\tb.txt"), "old\n");
    const replace = createReplaceEditTool(root);
    const hashline = createEditFileTool(root);
    for (const path of ["a\tb.txt", "a\nb.txt", "a\u0000b.txt"]) {
      await assert.rejects(
        () => replace.execute("e", { path, old_string: "old", new_string: "new" }),
        WorkspaceWriteRefusedError,
        JSON.stringify(path)
      );
      await assert.rejects(
        () =>
          hashline.execute("e", {
            path,
            snapshot: "0".repeat(16),
            edits: [{ op: "replace", anchor: "1#0000", lines: ["new"] }],
          }),
        WorkspaceWriteRefusedError,
        JSON.stringify(path)
      );
    }
    if (named) assert.equal(readFileSync(join(root, "a\tb.txt"), "utf8"), "old\n");
  }));

test(
  "新建：越出工作区根拒写；检查之后被别人建了不覆盖；检查之后路径上的目录被换成链接拒写",
  { skip: process.platform === "win32" },
  () =>
    withRoot(async (root) => {
      assert.throws(() => resolveWorkspaceCreatePath(root, "../outside.txt"), WorkspacePathError);
      const raced = resolveWorkspaceCreatePath(root, "raced.txt");
      assert.equal(raced.exists, false);
      writeFileSync(join(root, "raced.txt"), "theirs\n");
      assert.throws(() => createWorkspaceFile(raced.path, "mine\n"), WorkspaceWriteRefusedError);
      assert.equal(readFileSync(join(root, "raced.txt"), "utf8"), "theirs\n");
      mkdirSync(join(root, "d"));
      const nested = resolveWorkspaceCreatePath(root, "d/new.txt");
      const away = mkdtempSync(join(tmpdir(), "pigeon-write-away-"));
      renameSync(join(root, "d"), join(root, "d-old"));
      symlinkSync(away, join(root, "d"));
      assert.throws(() => createWorkspaceFile(nested.path, "x"), WorkspaceWriteRefusedError);
      assert.equal(existsSync(join(away, "new.txt")), false);
      rmSync(away, { recursive: true, force: true });
    })
);

test("失败的读取不算读过；读后未变按文件字节判断（不同的非法字节也看得出）", () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "f.txt"), "1\n");
    const { read, write } = tools(root);
    await assert.rejects(() => read.execute("r", { path: "f.txt", offset: 9 }));
    await assert.rejects(() => write.execute("w", { path: "f.txt", content: "x" }), /读过它/);
    writeFileSync(join(root, "bin.txt"), Buffer.from([0x61, 0xff, 0x0a]));
    await read.execute("r2", { path: "bin.txt" });
    writeFileSync(join(root, "bin.txt"), Buffer.from([0x61, 0xfe, 0x0a]));
    await assert.rejects(() => write.execute("w2", { path: "bin.txt", content: "x" }), /被改过/);
  }));

test("审批预览按行比对：分散的两处改动各成一段", () => {
  const old = ["a", "b", "c", "d", "e", "f", "g"];
  const hunks = lineDiff(old, ["a", "B", "c", "d", "e", "F", "g"]);
  assert.deepEqual(
    hunks.map((hunk) => [hunk.startLine, hunk.removed, hunk.added]),
    [
      [2, ["b"], ["B"]],
      [6, ["f"], ["F"]],
    ]
  );
  assert.deepEqual(lineDiff(old, old), []);
});

test("命令超出执行端能执行的长度：直接给出明确错误（建议先写成脚本），不拉进程", () =>
  withRoot(async (root) => {
    const run = createRunCommandTool({ workspaceRoot: root, platform: "linux" });
    const huge = `node -e "require('fs').writeFileSync('ran','${"汉".repeat(50_000)}')"`;
    await assert.rejects(
      () => run.execute("c", { command: huge }),
      (error: unknown) => error instanceof RunCommandError && /write_file/.test(error.message)
    );
    assert.equal(existsSync(join(root, "ran")), false);
    assert.match(commandTooLong("x".repeat(9000), "win32", "shell", "win32") ?? "", /cmd\.exe/);
    assert.equal(commandTooLong("x".repeat(9000), "win32", "direct", "win32"), undefined);
    assert.equal(commandTooLong("x".repeat(40_000), "linux", "direct", "linux"), undefined);
    assert.match(commandTooLong("x".repeat(40_000), "linux", "direct", "win32") ?? "", /Windows/);
  }));
