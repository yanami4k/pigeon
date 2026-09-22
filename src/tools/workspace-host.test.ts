// 执行端接口（决策 098）：三个工作区工具只调接口、不判断自己在哪——给一个纯内存的执行端，工具照常读、改、执行，
// 且不触碰宿主文件系统（工作区根是一个不存在的路径）；写保护包装在工具边界上挡住受保护路径的写入。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditFileTool } from "./edit-file.ts";
import { classifyToolError } from "./error-kind.ts";
import { lineTag, snapshotTag } from "./hashline.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { WorkspacePathError, WorkspacePathNotFoundError } from "./paths.ts";
import { createReadFileTool } from "./read-file.ts";
import { createReplaceEditTool } from "./replace-edit.ts";
import { createRunCommandTool } from "./run-command.ts";
import {
  type HostExecPlan,
  type WorkspaceHost,
  WorkspaceReadonlyError,
  withReadonlyPaths,
} from "./workspace-host.ts";

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
    readTextSync(inputPath) {
      return files.get(`${FAKE_ROOT}/${inputPath}`) ?? "";
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
  // 回执落盘时的同步实测也走执行端
  assert.equal(
    hashline.hashContentTarget({
      path: "src/a.txt",
      snapshot: "0".repeat(16),
      edits: [{ op: "delete", anchor: "1#0000" }],
    }),
    snapshotTag("ONE\ntwo\n")
  );

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

test("写保护包装：受保护路径经 edit_file 写入被拒（域错误，文件不变），其余路径照常；同一文件换个写法的路径也拦得住", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-readonly-"));
  try {
    mkdirSync(join(root, "tests"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "tests", "test_a.py"), "assert True\n");
    writeFileSync(join(root, "src", "a.py"), "x = 1\n");
    const host = withReadonlyPaths(
      createLocalWorkspaceHost(root),
      ["tests/test_a.py", "tests/not_yet_there.py"],
      "判分时会先复位测试文件"
    );
    const edit = createReplaceEditTool(host);
    for (const spelled of ["tests/test_a.py", "./src/../tests/test_a.py"]) {
      await assert.rejects(
        edit.execute("c1", { path: spelled, old_string: "True", new_string: "False" }),
        (error: unknown) => {
          assert.ok(error instanceof WorkspaceReadonlyError);
          assert.match(error.message, /tests\/test_a\.py 不可修改：判分时会先复位测试文件/);
          assert.equal(classifyToolError(error), "domain");
          return true;
        }
      );
    }
    assert.equal(readFileSync(join(root, "tests", "test_a.py"), "utf8"), "assert True\n");
    // 读不受影响；未受保护的文件照常可写
    assert.match(
      textOf(await createReadFileTool(host).execute("c2", { path: "tests/test_a.py" })),
      /assert True/
    );
    await edit.execute("c3", { path: "src/a.py", old_string: "x = 1", new_string: "x = 2" });
    assert.equal(readFileSync(join(root, "src", "a.py"), "utf8"), "x = 2\n");
    // 受保护清单为空时不包装
    const bare = createLocalWorkspaceHost(root);
    assert.equal(withReadonlyPaths(bare, [], "无"), bare);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写保护包装：受保护路径解析失败而原因不是「不存在」（执行端不可用、越界）时拒绝写入，不当作不受保护放行；「不存在」照常放行别的写入", async () => {
  const failures: Record<string, Error> = {
    "tests/down.py": new Error("容器不可用：Cannot connect to the Docker daemon"),
    "tests/escaping.py": new WorkspacePathError("路径越出工作区根：tests/escaping.py"),
    "tests/missing.py": new WorkspacePathNotFoundError("路径不存在或不可读：tests/missing.py"),
  };
  for (const [guarded, failure] of Object.entries(failures)) {
    const { host, calls, files } = memoryHost({ [`${FAKE_ROOT}/src/a.py`]: "x = 1\n" });
    const flaky: WorkspaceHost = {
      ...host,
      async resolveExisting(inputPath) {
        if (inputPath === guarded) {
          throw failure;
        }
        return host.resolveExisting(inputPath);
      },
    };
    const wrapped = withReadonlyPaths(flaky, [guarded], "判分时会先复位测试文件");
    const target = `${FAKE_ROOT}/src/a.py`;
    if (failure instanceof WorkspacePathNotFoundError) {
      await wrapped.writeText(target, "x = 2\n");
      assert.equal(files.get(target), "x = 2\n", guarded);
    } else {
      await assert.rejects(wrapped.writeText(target, "x = 2\n"), (error: Error) => {
        assert.match(
          error.message,
          new RegExp(`无法确认受保护路径 ${guarded.replace(".", "\\.")}`)
        );
        assert.match(error.message, new RegExp(failure.message.slice(0, 8)));
        return true;
      });
      assert.equal(files.get(target), "x = 1\n", guarded);
      assert.equal(calls.includes(`write:${target}`), false, guarded);
    }
  }
});

test("本地执行端的路径解析：不存在抛「不存在」子类，越界抛普通围栏错误（二者可区分）", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-host-notfound-"));
  try {
    const host = createLocalWorkspaceHost(root);
    assert.throws(() => host.readTextSync("nope.txt"), WorkspacePathNotFoundError);
    assert.throws(
      () => host.readTextSync("../outside.txt"),
      (error: unknown) =>
        error instanceof WorkspacePathError && !(error instanceof WorkspacePathNotFoundError)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
