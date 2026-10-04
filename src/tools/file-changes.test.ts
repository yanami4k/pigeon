// run_command 的文件变化（决策 348）：git 工作区按命令前后两次 git status 找候选——新增、删除、修改、命令前已改又被改、
// 改回原样都识别，被 .gitignore 忽略的与工作区根下 .pigeon 不报；非 git 工作区全量扫描，跳过常见的虚拟环境与构建目录
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createRunCommandTool } from "./run-command.ts";

function seed(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

// 在工作区根执行的 node 脚本：脚本放在工作区外，自身不算文件变化
function withScript(body: string, run: (command: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-file-changes-script-"));
  const script = join(dir, "change.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";\nconst touchLater = (file) => { const t = new Date(Date.now() + 60_000); utimesSync(file, t, t); };\n${body}`
  );
  return run(`"${process.execPath}" "${script}"`).finally(() =>
    rmSync(dir, { recursive: true, force: true })
  );
}

async function changesOf(root: string, command: string) {
  const tool = createRunCommandTool({ workspaceRoot: root, host: createLocalWorkspaceHost(root) });
  const result = await tool.execute("c1", { command }, undefined);
  assert.equal(result.details.exitCode, 0, result.details.output);
  return result.details.fileChanges;
}

test("git 工作区：新增、删除、修改、命令前已改又被改、改回原样都报出；被忽略的与根下 .pigeon 不报", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-file-changes-git-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: root,
      });
    git("init", "-q");
    seed(root, {
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c\n",
      "r.txt": "r\n",
      "s.txt": "s1\n",
      ".gitignore": "ignored/\n*.log\n",
    });
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    // 命令前已有改动：c.txt、r.txt 改过，u.txt 未跟踪
    seed(root, {
      "c.txt": "c changed\n",
      "r.txt": "r changed\n",
      "s.txt": "s2\n",
      "u.txt": "u\n",
    });
    await withScript(
      [
        'writeFileSync("new.txt", "new\\n");',
        'rmSync("b.txt");',
        'appendFileSync("a.txt", "more\\n");',
        'appendFileSync("c.txt", "again\\n");',
        'writeFileSync("r.txt", "r\\n");',
        // 命令前已改、命令又改成同样大小：只有内容与修改时间变了
        'writeFileSync("s.txt", "s3\\n"); touchLater("s.txt");',
        'mkdirSync("ignored", { recursive: true });',
        'writeFileSync("ignored/x.txt", "x\\n");',
        'writeFileSync("app.log", "log\\n");',
        'mkdirSync(".pigeon/state", { recursive: true });',
        'writeFileSync(".pigeon/state/s.jsonl", "{}\\n");',
      ].join("\n"),
      async (command) => {
        assert.deepEqual(await changesOf(root, command), {
          added: ["new.txt"],
          removed: ["b.txt"],
          modified: ["a.txt", "c.txt", "r.txt", "s.txt"],
          truncated: false,
        });
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非 git 工作区：全量扫描，虚拟环境、构建产物与缓存目录里的改动不报", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-file-changes-scan-"));
  try {
    seed(root, {
      "src/z.ts": "z\n",
      "src/same.ts": "aaaa\n",
      "dist/x.js": "x\n",
      ".venv/lib/y.py": "y\n",
      "__pycache__/m.pyc": "m\n",
    });
    await withScript(
      [
        'appendFileSync("src/z.ts", "more\\n");',
        'writeFileSync("src/new.ts", "new\\n");',
        'writeFileSync("src/same.ts", "bbbb\\n"); touchLater("src/same.ts");',
        'appendFileSync("dist/x.js", "more\\n");',
        'appendFileSync(".venv/lib/y.py", "more\\n");',
        'mkdirSync("build", { recursive: true });',
        'writeFileSync("build/out.o", "o\\n");',
      ].join("\n"),
      async (command) => {
        assert.deepEqual(await changesOf(root, command), {
          added: ["src/new.ts"],
          removed: [],
          modified: ["src/same.ts", "src/z.ts"],
          truncated: false,
        });
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
