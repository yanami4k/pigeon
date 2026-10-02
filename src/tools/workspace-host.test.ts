// 执行端接口（决策 098）：三个工作区工具只调接口、不判断自己在哪——给一个纯内存的执行端，工具照常读、改、执行，
// 且不触碰宿主文件系统（工作区根是一个不存在的路径）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditFileTool } from "./edit-file.ts";
import { lineTag, snapshotTag } from "./hashline.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { WorkspacePathError, WorkspacePathNotFoundError } from "./paths.ts";
import { createReadFileTool } from "./read-file.ts";
import { createReplaceEditTool } from "./replace-edit.ts";
import { createRunCommandTool } from "./run-command.ts";
import type { HostExecPlan, WorkspaceHost } from "./workspace-host.ts";

const FAKE_ROOT = "/nowhere/on/this/machine";

function memoryHost(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const plans: HostExecPlan[] = [];
  const host: WorkspaceHost = {
    platform: "linux",
    root: FAKE_ROOT,
    async resolveExisting(inputPath) {
      calls.push(`resolve:${inputPath}`);
      const target = inputPath.startsWith("/") ? inputPath : `${FAKE_ROOT}/${inputPath}`;
      if (!target.startsWith(`${FAKE_ROOT}/`) || target.includes("..")) {
        throw new WorkspacePathError(`路径越出工作区根：${inputPath}`);
      }
      if (!files.has(target)) {
        throw new WorkspacePathError(`路径不存在或不可读：${inputPath}`);
      }
      return target;
    },
    async resolveForWrite(inputPath) {
      return host.resolveExisting(inputPath);
    },
    async isFile(resolvedPath) {
      return files.has(resolvedPath);
    },
    async readText(resolvedPath) {
      calls.push(`read:${resolvedPath}`);
      return files.get(resolvedPath) ?? "";
    },
    async writeText(resolvedPath, content) {
      calls.push(`write:${resolvedPath}`);
      files.set(resolvedPath, content);
    },
    async exec(plan) {
      plans.push(plan);
      files.set(`${FAKE_ROOT}/made-by-command.txt`, "x");
      return {
        spawned: true,
        exitCode: 7,
        timedOut: false,
        outputBytes: 5,
        outputHash: "0".repeat(64),
        output: "hello",
        stdout: "hello",
        stderr: "",
      };
    },
    async listFiles() {
      return {
        files: new Map([...files.keys()].map((key) => [key.slice(FAKE_ROOT.length + 1), "sig"])),
        truncated: false,
      };
    },
    findLauncherScript: () => undefined,
  };
  return { host, files, calls, plans };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

test("工具只调执行端接口：read_file / edit_file（两种模式）经内存执行端读写，不碰宿主文件系统", async () => {
  const { host, files, calls } = memoryHost({ [`${FAKE_ROOT}/src/a.txt`]: "one\ntwo\n" });
  const read = await createReadFileTool(host).execute("c1", { path: "src/a.txt" });
  assert.match(textOf(read), /共 2 行/);
  assert.equal(read.details.resolvedPath, `${FAKE_ROOT}/src/a.txt`);

  const hashline = createEditFileTool(host);
  await hashline.execute("c2", {
    path: "src/a.txt",
    snapshot: snapshotTag("one\ntwo\n"),
    edits: [{ op: "replace", anchor: `1#${lineTag("one")}`, lines: ["ONE"] }],
  });
  assert.equal(files.get(`${FAKE_ROOT}/src/a.txt`), "ONE\ntwo\n");

  const replace = createReplaceEditTool(host);
  await replace.execute("c3", { path: "src/a.txt", old_string: "two", new_string: "TWO" });
  assert.equal(files.get(`${FAKE_ROOT}/src/a.txt`), "ONE\nTWO\n");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("write:")),
    [`write:${FAKE_ROOT}/src/a.txt`, `write:${FAKE_ROOT}/src/a.txt`]
  );
  // 越界由执行端的围栏拒绝，工具原样上抛
  await assert.rejects(
    createReadFileTool(host).execute("c4", { path: "../etc/passwd" }),
    WorkspacePathError
  );
});

test("工具只调执行端接口：run_command 的平台、执行、文件变化都取自执行端", async () => {
  const { host, plans } = memoryHost({ [`${FAKE_ROOT}/a.txt`]: "x" });
  // workspaceRoot 给一个不相干的值：注入执行端后以执行端为准
  const tool = createRunCommandTool({ workspaceRoot: "Z:\\unused", host });
  const direct = await tool.execute("c1", { command: "python -m pytest tests/x.py" }, undefined);
  assert.deepEqual(plans[0], {
    program: "python",
    args: ["-m", "pytest", "tests/x.py"],
    verbatim: false,
  });
  assert.equal(direct.details.exitCode, 7);
  assert.equal(direct.details.output, "hello");
  assert.deepEqual(direct.details.fileChanges.added, ["made-by-command.txt"]);
  // 需要 shell 的命令：执行端平台是 linux，经 /bin/sh -c（不因宿主是 Windows 而走 cmd.exe）
  tool.authorizeShell("c2");
  await tool.execute("c2", { command: "git diff | head -5" }, undefined);
  assert.deepEqual(plans[1], {
    program: "/bin/sh",
    args: ["-c", "git diff | head -5"],
    verbatim: false,
  });
  assert.match(await tool.preview({ command: "ls" }), new RegExp(`工作目录：${FAKE_ROOT}`));
});

test("本地执行端的路径解析：不存在抛「不存在」子类，越界抛普通围栏错误（二者可区分）", async () => {
  // 越界目标必须真实存在（realpath 解析失败会先判"不存在"）：在独立临时目录里建出工作区与其同级的 outside.txt，
  // 不依赖系统临时目录里的残留文件
  const base = mkdtempSync(join(tmpdir(), "pigeon-host-notfound-"));
  const root = join(base, "ws");
  mkdirSync(root);
  writeFileSync(join(base, "outside.txt"), "o");
  try {
    const host = createLocalWorkspaceHost(root);
    await assert.rejects(host.resolveExisting("nope.txt"), WorkspacePathNotFoundError);
    await assert.rejects(
      host.resolveExisting("../outside.txt"),
      (error: unknown) =>
        error instanceof WorkspacePathError && !(error instanceof WorkspacePathNotFoundError)
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
