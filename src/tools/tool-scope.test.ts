// worker 工具作用范围的判定（决策 360）：调用目标的真实路径须落在范围路径的字面位置之内——符号链接指出范围、范围路径本身经过
// 符号链接、路径上有悬空链接都越界，目标可以还不存在；派出时查出范围路径经过的符号链接。命令前缀按词比对，只放行不经 shell 的
// 单条命令；Windows 上带范围时程序只按 PATH 解析，工作树里的同名程序顶替不了。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { createRunCommandTool } from "./run-command.ts";
import { pathWithinScope, scopePathLinkProblem, scopeViolation } from "./tool-scope.ts";

const root = mkdtempSync(join(tmpdir(), "pigeon-tool-scope-"));
const outside = mkdtempSync(join(tmpdir(), "pigeon-tool-scope-outside-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "docs", "sub"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "a");
writeFileSync(join(root, "docs", "b.md"), "b");

// 建符号链接（目录）；本机建不了即返回原因
function links(): string | undefined {
  try {
    symlinkSync(join(root, "docs"), join(root, "src", "link"), "dir");
    symlinkSync(join(root, "missing"), join(root, "src", "dangling"), "dir");
    symlinkSync(outside, join(root, "src", "out"), "dir");
    return undefined;
  } catch (error) {
    return `本机不能建符号链接（${(error as NodeJS.ErrnoException).code}）`;
  }
}
const linkProblem = links();

test("路径范围：范围内（含还不存在的文件）放行；范围外、.. 绕出、同前缀的兄弟目录都越界", () => {
  assert.equal(pathWithinScope(root, ["src"], "src/a.ts"), true);
  assert.equal(pathWithinScope(root, ["src"], "src/new/file.ts"), true);
  assert.equal(pathWithinScope(root, ["src", "docs"], "docs/b.md"), true);
  assert.equal(pathWithinScope(root, ["src"], "docs/b.md"), false);
  assert.equal(pathWithinScope(root, ["src"], "src/../docs/b.md"), false);
  assert.equal(pathWithinScope(root, ["src"], "srcx/a.ts"), false);
});

test("路径范围与符号链接：指出范围、范围路径本身经过链接（嵌套派出借链接放宽）、悬空链接都越界", (t) => {
  if (linkProblem !== undefined) {
    t.skip(linkProblem);
    return;
  }
  assert.equal(pathWithinScope(root, ["src"], "src/link/b.md"), false);
  // 子范围 src/link 字面上在 src 之内，经链接指向 docs：docs 下的文件一律越界
  assert.equal(pathWithinScope(root, ["src/link"], "src/link/b.md"), false);
  assert.equal(pathWithinScope(root, ["src/link"], "docs/b.md"), false);
  assert.equal(pathWithinScope(root, ["src"], "src/dangling/new.ts"), false);
  assert.equal(pathWithinScope(root, ["src"], "src/dangling"), false);
});

test("派出时查范围路径：自身或上级经过符号链接即给出理由（指向工作树内的带上真实路径），真实路径与还不存在的路径不拦", (t) => {
  if (linkProblem !== undefined) {
    t.skip(linkProblem);
    return;
  }
  assert.equal(scopePathLinkProblem(root, "src"), undefined);
  assert.equal(scopePathLinkProblem(root, "src/new/dir"), undefined);
  assert.equal(scopePathLinkProblem(root, "."), undefined);
  assert.ok(scopePathLinkProblem(root, "src/link")?.includes("docs"));
  assert.ok(scopePathLinkProblem(root, "src/link/sub")?.includes("docs/sub"));
  for (const linked of ["src/dangling", "src/out"]) {
    const reason = scopePathLinkProblem(root, linked);
    assert.ok(reason !== undefined, linked);
    assert.ok(!reason.includes(outside), reason);
  }
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

test("Windows 上带命令前缀范围：程序只按 PATH 解析，工作树里的同名程序顶替不了；显式写出路径的照旧", () => {
  const bin = mkdtempSync(join(tmpdir(), "pigeon-tool-scope-bin-"));
  try {
    for (const name of ["git.cmd", "tool.cmd"]) {
      writeFileSync(join(root, name), "@echo off");
    }
    writeFileSync(join(bin, "git.cmd"), "@echo off");
    writeFileSync(join(bin, "node.exe"), "");
    const options = { workspaceRoot: root, platform: "win32" as const, env: { PATH: bin } };
    const scoped = createRunCommandTool({ ...options, pathOnly: true });
    assert.equal(scoped.inspectCommand({ command: "git status" }).scriptPath, join(bin, "git.cmd"));
    assert.equal(scoped.inspectCommand({ command: "node -v" }).program, join(bin, "node.exe"));
    const missing = scoped.inspectCommand({ command: "tool run" });
    assert.equal(missing.mode, "invalid");
    // 本就执行不了的交回只读检查给的原因
    assert.equal(
      scopeViolation(
        { tool: "run_command", commandPrefixes: ["tool"] },
        { args: {}, inspection: missing }
      ),
      missing.error
    );
    assert.equal(
      scoped.inspectCommand({ command: "./git.cmd status" }).scriptPath,
      join(root, "git.cmd")
    );
    // 不带范围的照旧先查工作树根
    const plain = createRunCommandTool(options);
    assert.equal(plain.inspectCommand({ command: "git status" }).scriptPath, join(root, "git.cmd"));
  } finally {
    rmSync(bin, { recursive: true, force: true });
    for (const name of ["git.cmd", "tool.cmd"]) {
      rmSync(join(root, name), { force: true });
    }
  }
});
