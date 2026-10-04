// git 工作区的取证与安全（决策 348、352）：写工具不写版本库元数据；Pigeon 起的 git 不执行仓库配置里的过滤与 fsmonitor；
// git status 失败时改用全量扫描并注明；工作区是外层仓库里被忽略的子目录时按非 git 工作区扫描；嵌套仓库里的改动逐个取证
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createCheckpointer } from "../orchestration/checkpoint.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createReplaceEditTool } from "./replace-edit.ts";
import { createRunCommandTool } from "./run-command.ts";

const POSIX = process.platform !== "win32";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function seedRepo(root: string, files: Record<string, string>, init: string[] = []): void {
  git(root, "init", "-q", ...init);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
}

// 在工作区根执行的 node 脚本（脚本放在工作区外）
async function changesAfter(root: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-git-workspace-script-"));
  try {
    const script = join(dir, "change.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, rmSync, writeFileSync } from "node:fs";\n${body}`
    );
    const tool = createRunCommandTool({
      workspaceRoot: root,
      host: createLocalWorkspaceHost(root),
    });
    const result = await tool.execute(
      "c",
      { command: `"${process.execPath}" "${script}"` },
      undefined
    );
    assert.equal(result.details.exitCode, 0, result.details.output);
    return result.details.fileChanges;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withDirs(count: number, run: (...dirs: string[]) => Promise<void>): Promise<void> {
  const dirs = Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), "pigeon-git-ws-")));
  return run(...dirs).finally(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

test("写工具不写版本库元数据：.git 下的文件一律拒写", () =>
  withDirs(1, async (root) => {
    seedRepo(root, { "a.txt": "a\n" });
    await assert.rejects(
      createReplaceEditTool(root).execute("e", {
        path: ".git/config",
        old_string: "[core]",
        new_string: "[core]\n\tfsmonitor = x",
      }),
      /版本库元数据/
    );
  }));

test(
  "Pigeon 起的 git 不执行 .git/config 里配的过滤与 fsmonitor（重算哈希时也不执行）",
  { skip: POSIX ? false : "用 sh 写的过滤命令" },
  () =>
    withDirs(2, async (root, out) => {
      seedRepo(root, { "a.txt": "aaaa\n", ".gitattributes": "* filter=evil\n" });
      const filtered = join(out, "filtered");
      const monitored = join(out, "monitored");
      const monitor = join(out, "monitor.sh");
      writeFileSync(monitor, `#!/bin/sh\ntouch '${monitored}'\n`);
      chmodSync(monitor, 0o755);
      git(root, "config", "filter.evil.clean", `sh -c "touch '${filtered}'; cat"`);
      git(root, "config", "core.fsmonitor", monitor);
      // 内容不变、修改时间变了：git 要重算内容哈希才知道没改
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(root, "a.txt"), later, later);
      await changesAfter(root, 'appendFileSync("a.txt", "more\\n");');
      assert.equal(existsSync(filtered), false, "过滤命令被执行了");
      assert.equal(existsSync(monitored), false, "fsmonitor 被执行了");
    })
);

test("git status 失败（命令删了 .git）：改用全量扫描并注明，报告标为不完整", () =>
  withDirs(1, async (root) => {
    seedRepo(root, { "a.txt": "a\n" });
    const changes = await changesAfter(
      root,
      'rmSync(".git", { recursive: true, force: true }); writeFileSync("b.txt", "b\\n");'
    );
    assert.equal(changes.truncated, true);
    assert.match(changes.note ?? "", /改用全量扫描/);
  }));

test("工作区是外层仓库里被忽略的子目录：按非 git 工作区扫描，改动照常报出", () =>
  withDirs(1, async (outer) => {
    seedRepo(outer, { ".gitignore": "ws/\n", "top.txt": "t\n" });
    const root = join(outer, "ws");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "a\n");
    assert.deepEqual(
      await changesAfter(
        root,
        'appendFileSync("a.txt", "more\\n"); writeFileSync("b.txt", "b\\n");'
      ),
      { added: ["b.txt"], removed: [], modified: ["a.txt"], truncated: false }
    );
  }));

test("嵌套仓库：status 报出的目录里有 .git 的，取它自己的 status，里面的新增与修改照常报出", () =>
  withDirs(1, async (root) => {
    seedRepo(root, { "a.txt": "a\n" });
    const inner = join(root, "inner");
    mkdirSync(inner);
    seedRepo(inner, { "x.txt": "x\n" });
    writeFileSync(join(inner, "x.txt"), "x changed\n");
    assert.deepEqual(
      await changesAfter(
        root,
        'appendFileSync("inner/x.txt", "again\\n"); writeFileSync("inner/new.txt", "n\\n");'
      ),
      { added: ["inner/new.txt"], removed: [], modified: ["inner/x.txt"], truncated: false }
    );
  }));

test("SHA-256 仓库：空树按仓库的对象格式算出，取证与代码快照都照常", () =>
  withDirs(1, async (root) => {
    seedRepo(root, { "a.txt": "a\n", "c.txt": "c\n" }, ["--object-format=sha256"]);
    // 修改时间往后挪：status 要重算内容哈希，此时才读属性来源，空树编号不对会报错
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "c.txt"), later, later);
    assert.deepEqual(
      await changesAfter(
        root,
        'appendFileSync("a.txt", "more\\n"); writeFileSync("b.txt", "b\\n");'
      ),
      { added: ["b.txt"], removed: [], modified: ["a.txt"], truncated: false }
    );
    const checkpointer = createCheckpointer({ workspaceRoot: root, sessionId: newSessionId() });
    checkpointer.beforeChange();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const snapshot = checkpointer.afterChange();
    assert.match(snapshot?.commit ?? "", /^[0-9a-f]{64}$/);
  }));
