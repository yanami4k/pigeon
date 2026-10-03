// worker 工具作用范围的判定（决策 360）：路径按真实路径落在范围内（符号链接指出范围即越界、目标可以还不存在）；
// 命令前缀按词比对，只放行不经 shell 的单条命令——用 ; && | 换行、命令替换、重定向接在合规开头后面的一律越界。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRunCommandTool } from "./run-command.ts";
import { pathWithinScope, scopeViolation } from "./tool-scope.ts";

const root = mkdtempSync(join(tmpdir(), "pigeon-tool-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "a");
writeFileSync(join(root, "docs", "b.md"), "b");

test("路径范围：范围内（含还不存在的文件）放行；范围外、.. 绕出、同前缀的兄弟目录、符号链接指出范围都越界", (t) => {
  assert.equal(pathWithinScope(root, ["src"], "src/a.ts"), true);
  assert.equal(pathWithinScope(root, ["src"], "src/new/file.ts"), true);
  assert.equal(pathWithinScope(root, ["src", "docs"], "docs/b.md"), true);
  assert.equal(pathWithinScope(root, ["src"], "docs/b.md"), false);
  assert.equal(pathWithinScope(root, ["src"], "src/../docs/b.md"), false);
  assert.equal(pathWithinScope(root, ["src"], "srcx/a.ts"), false);
  try {
    symlinkSync(join(root, "docs"), join(root, "src", "link"), "dir");
  } catch {
    t.diagnostic("本机不能建符号链接，跳过符号链接一项");
    return;
  }
  assert.equal(pathWithinScope(root, ["src"], "src/link/b.md"), false);
});

test("路径范围的调用判定：缺 path 或越界给出拒绝理由，范围内不拦", () => {
  const scope = { tool: "read_file", paths: ["src"] };
  assert.equal(
    scopeViolation(scope, { workspaceRoot: root, args: { path: "src/a.ts" } }),
    undefined
  );
  assert.ok(scopeViolation(scope, { workspaceRoot: root, args: { path: "docs/b.md" } }));
  assert.ok(scopeViolation(scope, { workspaceRoot: root, args: {} }));
  assert.ok(scopeViolation(scope, { args: { path: "src/a.ts" } }));
});

test("命令前缀：按词比对，只放行不经 shell 的单条命令；拼接、换行、环境变量开头与半个词都越界", () => {
  const tool = createRunCommandTool({ workspaceRoot: root });
  const scope = { tool: "run_command", commandPrefixes: ["npm test", "git status"] };
  const judge = (command: string) =>
    scopeViolation(scope, { args: { command }, inspection: tool.inspectCommand({ command }) });
  for (const allowed of ["npm test", "npm test -- --grep x", "git status --short"]) {
    assert.equal(judge(allowed), undefined, allowed);
  }
  for (const refused of [
    "npm testing",
    "FOO=1 npm test",
    "npm",
    "git statusx",
    "npm test; rm -rf x",
    "npm test && rm x",
    "npm test || rm x",
    "npm test | tee x",
    "npm test > out.txt",
    "npm test\nrm x",
    "npm test\r\nrm x",
    "npm test $(rm x)",
    "npm test `rm x`",
  ]) {
    assert.ok(judge(refused), JSON.stringify(refused));
  }
  // Windows 的 .cmd 垫片带保守字符集外的参数时退到经 shell：即使参数数组以前缀开头也越界
  const shellFallback = {
    input: "npm test a&b",
    command: "npm test a&b",
    mode: "shell" as const,
    needsShell: true,
    argv: ["npm", "test", "a&b"],
  };
  assert.ok(scopeViolation(scope, { args: {}, inspection: shellFallback }));
  // 没有只读检查结果（不是命令工具）一律越界
  assert.ok(scopeViolation(scope, { args: { command: "npm test" } }));
});
