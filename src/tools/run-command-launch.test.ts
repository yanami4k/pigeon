// MCP server 启动计划（M5.7 S2，复用 048）：启动命令来自人写的配置（参数已是数组，不经切分）。
// 非 Windows 或解析到可执行文件 = 直接 spawn；Windows 上解析到 .cmd / .bat 且参数全在保守字符集内 =
// cmd.exe 启动器；否则以 shell 运行（配置由人写，即人确认），带引号也无法安全表达的参数拒绝。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planMcpLaunch, RunCommandError } from "./run-command.ts";

function withScriptDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-mcp-launch-"));
  try {
    writeFileSync(join(dir, "npx.cmd"), "@echo off\r\n");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("MCP 启动计划：非 Windows 直接 spawn，参数原样", () => {
  const plan = planMcpLaunch({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything", "a b"],
    cwd: "/repo",
    env: { PATH: "/usr/bin" },
    platform: "linux",
  });
  assert.deepEqual(plan, {
    mode: "direct",
    program: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything", "a b"],
    verbatim: false,
  });
});

test("MCP 启动计划：Windows 上 .cmd 且参数在保守字符集内走 cmd.exe 启动器", () => {
  withScriptDir((dir) => {
    const plan = planMcpLaunch({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "D:/work/tree"],
      cwd: dir,
      env: { PATH: dir, COMSPEC: "C:\\Windows\\system32\\cmd.exe" },
      platform: "win32",
    });
    assert.deepEqual(plan, {
      mode: "launcher",
      program: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""${join(dir, "npx.cmd")}" -y @modelcontextprotocol/server-filesystem D:/work/tree"`,
      ],
      verbatim: true,
    });
  });
});

test("MCP 启动计划：Windows 上 .cmd 带字符集外参数时以 shell 运行并给参数加引号；引号与百分号无法安全表达即拒绝", () => {
  withScriptDir((dir) => {
    const plan = planMcpLaunch({
      command: "npx",
      args: ["-y", "server", "C:\\My Projects\\tree"],
      cwd: dir,
      env: { PATH: dir },
      platform: "win32",
    });
    assert.equal(plan.mode, "shell");
    assert.equal(plan.program, "cmd.exe");
    assert.deepEqual(plan.args, [
      "/d",
      "/s",
      "/c",
      `""${join(dir, "npx.cmd")}" -y server "C:\\My Projects\\tree""`,
    ]);
    assert.equal(plan.verbatim, true);
    for (const bad of ['say "hi"', "%PATH%", "line\nbreak"]) {
      assert.throws(
        () =>
          planMcpLaunch({
            command: "npx",
            args: [bad],
            cwd: dir,
            env: { PATH: dir },
            platform: "win32",
          }),
        RunCommandError,
        bad
      );
    }
  });
});

test("MCP 启动计划：Windows 上解析不到 .cmd / .bat（可执行文件或绝对路径程序）直接 spawn", () => {
  withScriptDir((dir) => {
    writeFileSync(join(dir, "node.exe"), "");
    assert.deepEqual(
      planMcpLaunch({
        command: "node",
        args: ["server.js", "a b"],
        cwd: dir,
        env: { PATH: dir },
        platform: "win32",
      }),
      { mode: "direct", program: "node", args: ["server.js", "a b"], verbatim: false }
    );
  });
});
