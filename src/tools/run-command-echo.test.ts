// 命令结果不整段回显命令（决策 421）：结果首行只回显命令开头（首行、至多 200 字），省略了的注明共几行或共几字；短命令照旧；
// 用了短名照旧给出展开后的完整命令；审批预览与执行证据（会话记录里工具结果的 details）里的命令不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { COMMAND_ECHO_CHARS, commandEcho, commandLabel } from "./command-echo.ts";
import { createRunCommandTool, type ExecEvidence } from "./run-command.ts";
import type { PigeonToolResult } from "./wrap.ts";

const NODE = `"${process.execPath}"`;
// 引号里的换行属于参数：不经 shell 直接执行，各平台都能跑
const LINES = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`);
const MULTI = `${NODE} -e "${LINES.join("\n")}\nprocess.stdout.write('ok')"`;
const LONG = `${NODE} -e "process.stdout.write('ok')" ${"x".repeat(300)}`;

const textOf = (result: PigeonToolResult<ExecEvidence>) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-command-echo-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("长命令只回显开头并注明共几行或共几字；短命令照旧；预览与执行证据里仍是完整命令", () =>
  withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root });
    const multi = await tool.execute("c1", { command: MULTI });
    const firstLine = textOf(multi).split("\n")[0];
    assert.equal(
      firstLine,
      `$ ${MULTI.split("\n")[0]} (31 lines; the rest is omitted, the full command is in this call's arguments)`
    );
    assert.ok(!textOf(multi).includes(LINES[29] as string), textOf(multi));
    assert.equal(multi.details.command, MULTI);
    assert.ok((await tool.preview({ command: MULTI })).includes(MULTI));

    const long = await tool.execute("c2", { command: LONG });
    assert.equal(
      textOf(long).split("\n")[0],
      `$ ${LONG.slice(0, COMMAND_ECHO_CHARS)}… (${LONG.length} characters; the rest is omitted, the full command is in this call's arguments)`
    );

    const short = `${NODE} -e "process.stdout.write('ok')"`;
    assert.equal(textOf(await tool.execute("c3", { command: short })).split("\n")[0], `$ ${short}`);
  }));

test("用了短名时照旧给出展开后的完整命令", () =>
  withRoot(async (root) => {
    const tool = createRunCommandTool({ workspaceRoot: root, commands: { gen: MULTI } });
    const text = textOf(await tool.execute("c1", { command: "gen" }));
    assert.ok(text.startsWith(`$ ${MULTI} (short name gen)`), text);
  }));

test("作业列表等处的简短标识：首行至多 80 字，多行注明共几行", () => {
  assert.equal(commandLabel("npm test"), "npm test");
  assert.equal(commandLabel(`cat > a.py <<'EOF'\nprint(1)\nEOF`), "cat > a.py <<'EOF'… (3 lines)");
  assert.equal(commandLabel("y".repeat(100)), `${"y".repeat(80)}…`);
  // 末尾的换行不算一行，短命令原样
  assert.equal(commandEcho("ls\n"), "ls\n");
});
