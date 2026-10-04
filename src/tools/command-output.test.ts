// 命令输出的头尾保留与全文落盘（决策 356）：超长时结果留开头与末尾、注明省略的行数；完整输出存进会话落盘目录，
// read_file 按虚拟路径 pigeon://outputs/<会话号>/<编号> 直接读（本机与容器执行端各验一次）；虚拟路径不能越出落盘目录，
// 别的会话的编号明确报错、分叉来源的可读；落盘目录或文件被换成链接即拒绝读写；落盘出错时照常给出头尾并注明；
// 落盘总量满了删最旧的。另有收集器单测：首次超限时补写此前的开头与末尾余量、超过写入上限只写前面部分、头尾对齐 UTF-8。
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { CommandOutputStore, OutputPathError } from "./command-output.ts";
import { createHeadCollector } from "./local-host.ts";
import { createReadFileTool } from "./read-file.ts";
import { createRunCommandTool } from "./run-command.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

const LINES = 3000;
// 打印 line 1 … line N
const printLines = (n: number) => `node -e "for(let i=1;i<=${n};i++)console.log('line '+i)"`;

function workspace(maxBytes = 10_000_000, ancestors?: () => string[]) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-outputs-"));
  const outputsRoot = join(root, ".pigeon", "state", "outputs");
  const store = new CommandOutputStore({
    base: root,
    outputsRoot,
    sessionId: "s1",
    maxBytes,
    ...(ancestors !== undefined ? { ancestors } : {}),
  });
  return {
    root,
    outputsRoot,
    store,
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
    await read.execute("r1", { path: "pigeon://outputs/s1/1", offset: 1500, limit: 1 })
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
    assert.match(text, new RegExp(`全文共 ${LINES} 行，已存为 pigeon://outputs/s1/1`));
    assert.match(middle, /^1500\| line 1500$/m);
    assert.match(middle, /共 3000 行/);
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
    assert.match(text, /pigeon:\/\/outputs\/s1\/1/);
    assert.match(middle, /^1500\| line 1500$/m);
  } finally {
    docker.cleanup();
    cleanup();
  }
});

test("虚拟路径只认 pigeon://outputs/<会话号>/<编号>：越界写法一律拒绝；别的会话报错，分叉来源可读", async () => {
  const { root, outputsRoot, store, cleanup } = workspace(10_000_000, () => ["parent"]);
  try {
    // 落盘文件按 <编号>.log 取：越界的写法若没被拦下，就会读到工作区根的 secret.log
    writeFileSync(join(root, "secret.log"), "secret\n");
    mkdirSync(join(outputsRoot, "parent"), { recursive: true });
    writeFileSync(join(outputsRoot, "parent", "1.log"), "from parent\n");
    mkdirSync(join(outputsRoot, "worker"), { recursive: true });
    writeFileSync(join(outputsRoot, "worker", "1.log"), "from worker\n");
    const read = createReadFileTool(root, { editMode: "replace", outputs: store });
    for (const path of [
      "pigeon://outputs/s1/../../../../../secret",
      "pigeon://outputs/../../../../secret",
      `pigeon://outputs/s1/${join(root, "secret")}`,
      "pigeon://outputs/s1/0",
      "pigeon://outputs/s1/1.log",
      "pigeon://outputs/1",
      "pigeon://other/s1/1",
    ]) {
      await assert.rejects(() => read.execute("r", { path }), OutputPathError, path);
    }
    await assert.rejects(
      () => read.execute("r", { path: "pigeon://outputs/worker/1" }),
      /别的会话/
    );
    const parent = textOf(await read.execute("r", { path: "pigeon://outputs/parent/1" }));
    assert.match(parent, /^1\| from parent$/m);
  } finally {
    cleanup();
  }
});

test("落盘目录或落盘文件被换成链接：读取拒绝，下一次长输出不落盘并注明原因，链接目标不被写", async () => {
  const { root, outputsRoot, store, cleanup } = workspace();
  try {
    const outside = mkdtempSync(join(tmpdir(), "pigeon-outputs-outside-"));
    writeFileSync(join(outside, "1.log"), "host secret\n");
    mkdirSync(outputsRoot, { recursive: true });
    symlinkSync(outside, join(outputsRoot, "s1"));
    const read = createReadFileTool(root, { outputs: store });
    await assert.rejects(() => read.execute("r", { path: "pigeon://outputs/s1/1" }), /链接/);
    const run = createRunCommandTool({
      workspaceRoot: root,
      output: { headBytes: 100, tailBytes: 100, store },
    });
    const text = textOf(await run.execute("c", { command: printLines(LINES) }));
    assert.match(text, /全文未能保存（[^）]*链接/);
    assert.equal(readFileSync(join(outside, "1.log"), "utf8"), "host secret\n");
    // 目录正常、文件本身是链接
    unlinkSync(join(outputsRoot, "s1"));
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(join(outputsRoot, "s1"));
    const target = join(root, "elsewhere.txt");
    writeFileSync(target, "elsewhere\n");
    symlinkSync(target, join(outputsRoot, "s1", "7.log"));
    await assert.rejects(() => read.execute("r", { path: "pigeon://outputs/s1/7" }), /链接|不存在/);
  } finally {
    cleanup();
  }
});

test("落盘总量满了从最旧的删起，刚写的那份保留，剩下的总量不超过上限", async () => {
  const { root, store, cleanup } = workspace(40_000);
  try {
    const run = createRunCommandTool({
      workspaceRoot: root,
      output: { headBytes: 100, tailBytes: 100, store },
    });
    for (const id of ["a", "b", "c"]) {
      await run.execute(id, { command: printLines(LINES) });
    }
    assert.throws(() => store.resolve("pigeon://outputs/s1/1"), /已因落盘总量上限被清理/);
    assert.ok(store.resolve("pigeon://outputs/s1/3").endsWith("3.log"));
    assert.ok(store.totalBytes() <= 40_000, String(store.totalBytes()));
  } finally {
    cleanup();
  }
});

test("收集器：分块到达时首次超限即补写此前的开头与末尾余量，落盘内容与输出逐字节一致；超过写入上限只写前面部分", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-collector-"));
  try {
    const all = Buffer.from(Array.from({ length: 400 }, (_, i) => `row ${i}\n`).join(""));
    const feed = (path: string, maxBytes: number) => {
      const collector = createHeadCollector(50, { tailBytes: 80, fullOutput: { path, maxBytes } });
      // 30 字节一块：开头在第二块中途填满，第 5 块才首次超过开头加末尾
      for (let offset = 0; offset < all.length; offset += 30) {
        collector.push(all.subarray(offset, offset + 30));
      }
      return collector.finish();
    };
    const whole = feed(join(dir, "whole.log"), 1_000_000);
    assert.deepEqual(readFileSync(join(dir, "whole.log")), all);
    assert.deepEqual(whole.fullOutputSaved, { bytes: all.length, partial: false });
    assert.equal(whole.outputLines, 400);
    const cut = feed(join(dir, "cut.log"), 1000);
    assert.deepEqual(readFileSync(join(dir, "cut.log")), all.subarray(0, 1000));
    assert.deepEqual(cut.fullOutputSaved, { bytes: 1000, partial: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("收集器：落盘打不开时照常给出头尾并给出原因；头尾按字节截取后对齐 UTF-8 字符边界", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-collector-"));
  try {
    writeFileSync(join(dir, "file"), "x");
    const collector = createHeadCollector(10, {
      tailBytes: 10,
      fullOutput: { path: join(dir, "file", "1.log"), maxBytes: 1_000_000 },
    });
    collector.push(Buffer.from("汉字".repeat(50)));
    const result = collector.finish();
    assert.equal(result.fullOutputSaved, undefined);
    assert.ok(result.fullOutputError !== undefined);
    assert.ok(!`${result.output}${result.tail}`.includes("�"), `${result.output}|${result.tail}`);
    assert.ok(result.output.length > 0 && (result.tail ?? "").length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
