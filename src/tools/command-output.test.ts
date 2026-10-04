// 命令输出的头尾保留与全文落盘（决策 356）：超长时结果留开头与末尾、注明省略的行数；完整输出存进会话落盘目录，
// read_file 按虚拟路径 pigeon://outputs/<编号> 直接读（本机与容器执行端各验一次）；虚拟路径不能越出落盘目录；
// 落盘总量满了删最旧的。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { CommandOutputStore, OutputPathError } from "./command-output.ts";
import { createReadFileTool } from "./read-file.ts";
import { createRunCommandTool } from "./run-command.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

const LINES = 3000;
// 打印 line 1 … line N
const printLines = (n: number) => `node -e "for(let i=1;i<=${n};i++)console.log('line '+i)"`;

function workspace(): { root: string; store: CommandOutputStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-outputs-"));
  return {
    root,
    store: new CommandOutputStore(join(root, ".pigeon", "state", "outputs", "s1"), 10_000_000),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");

async function runAndReadBack(root: string, store: CommandOutputStore, host?: WorkspaceHost) {
  const run = createRunCommandTool({
    workspaceRoot: root,
    ...(host !== undefined ? { host } : {}),
    output: { headBytes: 200, tailBytes: 400, store },
  });
  const text = textOf(await run.execute("c1", { command: printLines(LINES) }));
  const read = createReadFileTool(root, { editMode: "replace", outputs: store });
  const middle = textOf(
    await read.execute("r1", { path: "pigeon://outputs/1", offset: 1500, limit: 1 })
  );
  return { text, middle };
}

test("超长输出：留开头与末尾、注明省略的行数与全文路径；全文落盘，read_file 按虚拟路径读到中间那段", async () => {
  const { root, store, cleanup } = workspace();
  try {
    const { text, middle } = await runAndReadBack(root, store);
    assert.match(text, /\nline 1\n/);
    assert.match(text, /line 3000\n/);
    assert.doesNotMatch(text, /line 1500\n/);
    const omitted = Number(/中间省略 (\d+) 行/.exec(text)?.[1]);
    const shown = (text.match(/^line \d+$/gm) ?? []).length;
    assert.equal(omitted + shown, LINES);
    assert.match(text, new RegExp(`全文共 ${LINES} 行，已存为 pigeon://outputs/1`));
    assert.match(middle, /^1500\| line 1500$/m);
    // 没超过的输出原样给出，不落盘、不给路径
    const run = createRunCommandTool({ workspaceRoot: root, output: { store } });
    const short = textOf(await run.execute("c2", { command: printLines(3) }));
    assert.match(short, /line 1\nline 2\nline 3/);
    assert.doesNotMatch(short, /pigeon:\/\//);
  } finally {
    cleanup();
  }
});

test("容器执行端：完整输出同样落在宿主的会话落盘目录，read_file 不经执行端读回", async () => {
  const { root, store, cleanup } = workspace();
  const docker = localDockerHost(root);
  try {
    const { text, middle } = await runAndReadBack(root, store, docker.host);
    assert.match(text, /pigeon:\/\/outputs\/1/);
    assert.match(middle, /^1500\| line 1500$/m);
  } finally {
    docker.cleanup();
    cleanup();
  }
});

test("虚拟路径只能指向本会话落盘目录里的编号：..、绝对路径、子路径、别的前缀一律拒绝", async () => {
  const { root, store, cleanup } = workspace();
  try {
    // 落盘文件按 <编号>.log 取：越界的写法若没被拦下，就会读到工作区根的 secret.log
    writeFileSync(join(root, "secret.log"), "secret\n");
    const read = createReadFileTool(root, { outputs: store });
    for (const path of [
      "pigeon://outputs/../../../../secret",
      "pigeon://outputs/1/../../../../../secret",
      `pigeon://outputs/${join(root, "secret")}`,
      "pigeon://outputs/0",
      "pigeon://outputs/1.log",
      "pigeon://other/1",
    ]) {
      await assert.rejects(() => read.execute("r", { path }), OutputPathError, path);
    }
  } finally {
    cleanup();
  }
});

test("落盘总量满了从最旧的删起，刚写的那份保留", async () => {
  const { root, cleanup } = workspace();
  try {
    const store = new CommandOutputStore(join(root, "outputs"), 40_000);
    const run = createRunCommandTool({
      workspaceRoot: root,
      output: { headBytes: 100, tailBytes: 100, store },
    });
    for (const id of ["a", "b", "c"]) {
      await run.execute(id, { command: printLines(LINES) });
    }
    assert.throws(() => store.resolve("pigeon://outputs/1"), /已因落盘总量上限被清理/);
    assert.ok(store.resolve("pigeon://outputs/3").endsWith("3.log"));
  } finally {
    cleanup();
  }
});
