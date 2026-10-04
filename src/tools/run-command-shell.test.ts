// run_command 的 shell 修订（M5.5，048 修订）：Windows 下 .cmd / .bat 参数全在保守字符集内经 cmd.exe 启动器运行，
// 任一参数越界即判定需 shell——未经人确认拒绝并指出参数；shell 语法同样判定需 shell，确认后以 shell 运行；
// 成功结果的 details（执行证据）标明启动器与经 shell。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createRunCommandTool, RunCommandError } from "./run-command.ts";

const NODE = `"${process.execPath}"`;
const onWindows = process.platform === "win32";

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pigeon-run-command-shell-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

// 以 root 打头的 PATH（Windows 的 Path 键大小写不敏感，先去掉原键再设）
function envWithPath(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")
  );
  env.PATH = `${root}${path.delimiter}${process.env.PATH ?? ""}`;
  return env;
}

test.skipIf(!onWindows)(
  "Windows .cmd：参数全在保守字符集内经 cmd.exe 启动器运行（显式路径与 PATH 解析）",
  async () => {
    await withRoot(async (root) => {
      writeFileSync(path.join(root, "ok.cmd"), "@echo off\r\necho cmd-ok %*\r\n");
      const tool = createRunCommandTool({ workspaceRoot: root, env: envWithPath(root) });
      assert.equal(tool.inspectCommand({ command: "ok hello" }).mode, "launcher");

      const explicit = (await tool.execute("tc-1", { command: "ok.cmd hello-1 k=v a/b" })).details;
      assert.equal(explicit.launcher, true);
      assert.equal(explicit.shell, false);
      assert.equal(explicit.output.trim(), "cmd-ok hello-1 k=v a/b");

      const viaPath = (await tool.execute("tc-2", { command: "ok x@y:z_1.2" })).details;
      assert.equal(viaPath.launcher, true);
      assert.equal(viaPath.output.trim(), "cmd-ok x@y:z_1.2");
    });
  }
);

test.skipIf(!onWindows)(
  "Windows .cmd：白名单外参数未经 shell 确认即拒绝并指出参数，不启动进程",
  async () => {
    await withRoot(async (root) => {
      writeFileSync(path.join(root, "ok.cmd"), "@echo off\r\necho cmd-ok %*\r\n");
      const tool = createRunCommandTool({ workspaceRoot: root, env: envWithPath(root) });
      const command = 'ok.cmd "a b"';
      const inspection = tool.inspectCommand({ command });
      assert.equal(inspection.mode, "shell");
      assert.equal(inspection.needsShell, true);
      await assert.rejects(
        tool.execute("tc-3", { command }),
        (error: unknown) => error instanceof RunCommandError && error.message.includes("「a b」")
      );
    });
  }
);

test("shell 语法判定需 shell：未确认拒绝，确认后以 shell 运行，执行证据标明经 shell 且命令串原样", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root });
    const command = `${NODE} -e "process.stdout.write('x')" && ${NODE} -e "process.stdout.write('y')"`;
    const inspection = tool.inspectCommand({ command });
    assert.equal(inspection.mode, "shell");
    assert.equal(inspection.needsShell, true);
    assert.equal(inspection.command, command);

    await assert.rejects(
      tool.execute("tc-4", { command }),
      (error: unknown) => error instanceof RunCommandError && /需要经 shell/.test(error.message)
    );

    tool.authorizeShell("tc-5");
    const evidence = (await tool.execute("tc-5", { command })).details;
    assert.equal(evidence.shell, true);
    assert.equal(evidence.launcher, false);
    assert.equal(evidence.command, command);
    assert.equal(evidence.output, "xy");
    // 授权一次一用：同一 toolCallId 不能复用
    await assert.rejects(tool.execute("tc-5", { command }), RunCommandError);
  });
});

test("普通命令直接 spawn，不需 shell，执行证据两个标记都为否", async () => {
  await withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root });
    const command = `${NODE} -e "process.stdout.write('d')"`;
    assert.equal(tool.inspectCommand({ command }).mode, "direct");
    assert.equal(tool.inspectCommand({ command }).needsShell, false);
    const evidence = (await tool.execute("tc-6", { command })).details;
    assert.equal(evidence.shell, false);
    assert.equal(evidence.launcher, false);
    assert.equal(evidence.output, "d");
  });
});
