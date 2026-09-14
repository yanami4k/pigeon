// TUI 审批块的 exec 命令行（048 修订）：原样显示将执行的命令串；需 shell 时文案含"经 shell"，[a] 为经 shell 的精确命令放权。
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalBlockText } from "./approval.ts";

const COMMAND = `node -e "console.log('a')" && echo done`;

test("审批块：exec 调用原样显示命令串；需 shell 时标明经 shell", () => {
  const shellBlock = approvalBlockText({
    toolName: "run_command",
    toolCallId: "tc-1",
    args: { command: COMMAND },
    tier: "exec",
    command: COMMAND,
    needsShell: true,
  });
  assert.ok(shellBlock.includes(`命令（经 shell）：${COMMAND}`), shellBlock);
  assert.ok(shellBlock.includes("[a] 本会话允许这条命令（精确匹配，经 shell）"), shellBlock);

  const directBlock = approvalBlockText({
    toolName: "run_command",
    toolCallId: "tc-2",
    args: { command: "node --test" },
    tier: "exec",
    command: "node --test",
    needsShell: false,
  });
  assert.ok(directBlock.includes("命令：node --test"), directBlock);
  assert.equal(directBlock.includes("经 shell"), false, directBlock);
});
