// run_command（M5.5 S5，决策 048）：命令串切分与 shell 语法拒绝；参数数组直接 spawn，执行证据（退出码、输出哈希、
// 文件变化）作为成功结果的 details 返回；超时终止；输出按字节截断；环境变量白名单；短名展开与角色允许清单；
// 命令不存在为域错误。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  createRunCommandTool,
  parseCommandLine,
  RunCommandError,
  RunCommandTimeoutError,
} from "./run-command.ts";

const NODE = `"${process.execPath}"`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-command-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("命令串切分：空白分隔、单双引号、双引号内转义、Windows 路径；shell 语法与未闭合引号拒绝", () => {
  assert.deepEqual(parseCommandLine('git commit -m "修复 a|b"'), [
    "git",
    "commit",
    "-m",
    "修复 a|b",
  ]);
  assert.deepEqual(parseCommandLine("node -e 'console.log(1)'"), ["node", "-e", "console.log(1)"]);
  assert.deepEqual(parseCommandLine('echo "a\\"b"'), ["echo", 'a"b']);
  assert.deepEqual(parseCommandLine("C:\\tools\\x.exe --flag"), ["C:\\tools\\x.exe", "--flag"]);
  assert.deepEqual(parseCommandLine('  x  ""  '), ["x", ""]);
  for (const bad of [
    "npm test && rm -rf x",
    "ls | grep a",
    "echo a > b",
    "a; b",
    "echo `id`",
    "echo $(id)",
    'echo "unterminated',
    "   ",
  ]) {
    assert.throws(() => parseCommandLine(bad), RunCommandError, bad);
  }
});

test("执行：参数数组直接 spawn，结果 details 记退出码、输出与哈希、文件增删改", async () => {
  await withRoot(async (root) => {
    writeFileSync(join(root, "keep.txt"), "x");
    writeFileSync(join(root, "gone.txt"), "y");
    const tool = createRunCommandTool({ workspaceRoot: root });
    const script =
      "const fs=require('fs');fs.writeFileSync('new.txt','n');fs.unlinkSync('gone.txt');" +
      "fs.appendFileSync('keep.txt','more');process.stdout.write('你好');process.exit(3)";
    const result = await tool.execute("tc-1", { command: `${NODE} -e "${script}"` });
    const text = result.content[0];
    assert.ok(
      text?.type === "text" && text.text.includes("退出码：3") && text.text.includes("你好")
    );

    const evidence = result.details;
    assert.equal(evidence.spawned, true);
    assert.equal(evidence.exitCode, 3);
    assert.equal(evidence.argv[0], process.execPath);
    assert.equal(evidence.output, "你好");
    assert.equal(evidence.outputHash, sha256("你好"));
    assert.equal(evidence.truncated, false);
    assert.deepEqual(evidence.fileChanges, {
      added: ["new.txt"],
      removed: ["gone.txt"],
      modified: ["keep.txt"],
      truncated: false,
    });
  });
});

test("超时：终止进程并抛环境类错误", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root, timeoutMs: 300 });
    await assert.rejects(
      tool.execute("tc-2", { command: `${NODE} -e "setTimeout(() => {}, 20000)"` }),
      (error: unknown) =>
        error instanceof RunCommandTimeoutError && /命令超时（300 毫秒）已终止/.test(error.message)
    );
  });
});

test("决策 411：timeout_seconds 超过上限按上限执行，结果里注明夹取", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root, maxTimeoutMs: 1000 });
    const quick = await tool.execute("tc-c1", { command: `${NODE} -e "1"`, timeout_seconds: 30 });
    assert.deepEqual(quick.details.timeoutClamped, { requestedSeconds: 30, appliedSeconds: 1 });
    const text = quick.content[0];
    assert.ok(text?.type === "text" && text.text.includes("夹到上限 1 秒"), JSON.stringify(text));
    // 按上限（1 秒）到时终止，而不是等到给的 30 秒
    await assert.rejects(
      tool.execute("tc-c2", {
        command: `${NODE} -e "setTimeout(() => {}, 20000)"`,
        timeout_seconds: 30,
      }),
      (error: unknown) =>
        error instanceof RunCommandTimeoutError &&
        error.message.includes("命令超时（1 秒）") &&
        error.message.includes("夹到上限")
    );
  });
});

test("输出按字节截断并标记，哈希按全量输出", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root, maxOutputBytes: 10 });
    const result = await tool.execute("tc-3", {
      command: `${NODE} -e "process.stdout.write('x'.repeat(100))"`,
    });
    const evidence = result.details;
    assert.equal(evidence.output, "x".repeat(10));
    assert.equal(evidence.outputBytes, 100);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.outputHash, sha256("x".repeat(100)));
    const text = result.content[0];
    assert.ok(text?.type === "text" && text.text.includes("输出已截断：共 100 字节"));
  });
});

test("环境变量只透传白名单：密钥类变量不进子进程，PATH 照常", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({
      workspaceRoot: root,
      env: { ...process.env, PIGEON_TEST_SECRET: "s3cr3t" },
    });
    const result = await tool.execute("tc-4", {
      command: `${NODE} -e "process.stdout.write((process.env.PIGEON_TEST_SECRET ?? 'none') + ':' + typeof process.env.PATH)"`,
    });
    assert.equal(result.details.output, "none:string");
  });
});

test("短名与角色允许清单：清单内短名与其展开命令放行，清单外拒绝且不启动进程；预览显示完整命令", async () => {
  await withRoot(async (root) => {
    const hello = `${NODE} -e "process.stdout.write('hi')"`;
    const tool = createRunCommandTool({
      workspaceRoot: root,
      commands: { hello },
      allowlist: ["hello"],
    });
    const aliased = (await tool.execute("tc-a", { command: "hello" })).details;
    assert.equal(aliased.alias, "hello");
    assert.equal(aliased.command, hello);
    assert.equal(aliased.output, "hi");

    const expanded = (await tool.execute("tc-b", { command: hello })).details;
    assert.equal(expanded.output, "hi");

    await assert.rejects(
      tool.execute("tc-c", { command: `${NODE} -e "1"` }),
      (error: unknown) =>
        error instanceof RunCommandError && /不在本角色允许清单内/.test(error.message)
    );

    const preview = await tool.preview({ command: "hello" });
    assert.ok(preview.includes(`命令：${hello}（短名 hello）`), preview);
    const refused = await tool.preview({ command: "other" });
    assert.ok(refused.includes("不在本角色允许清单内"), refused);
  });
});

test("命令不存在：域错误", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root });
    await assert.rejects(
      tool.execute("tc-5", { command: "pigeon-no-such-command-xyz --flag" }),
      (error: unknown) => error instanceof RunCommandError && /命令不存在/.test(error.message)
    );
  });
});
