// 命令输出的头尾保留与全文落盘（决策 356）：超长时结果留开头与末尾、注明省略的行数；完整输出存进会话落盘目录，
// read_file 按虚拟路径 pigeon://outputs/<会话号>/<编号> 直接读（本机与容器执行端各验一次）；虚拟路径不能越出落盘目录，
// 别的会话的编号明确报错、分叉来源的可读；读取只认 Pigeon 写下的那份（换成符号链接、硬链接、同内容的别的文件或原地改了
// 内容都拒绝）；分行只按 \n，与总行数同一口径；落盘目录被换成链接即拒绝读写；写到一半出错照常给出头尾并注明，不留临时
// 文件、编号照常前进；落盘总量满了删最旧的，只删身份与记录一致的。另有收集器单测：首次超限时补写此前的开头与末尾余量、
// 超过写入上限只写前面部分、头尾对齐 UTF-8、落盘文件独占新建且不跟随链接。
import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { CommandOutputStore, OutputPathError } from "./command-output.ts";
import { createHeadCollector } from "./local-host.ts";
import { createReadFileTool } from "./read-file.ts";
import { createRunCommandTool } from "./run-command.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

const LINES = 3000;
// 打印 line 1 … line N
const printLines = (n: number) => `node -e "for(let i=1;i<=${n};i++)console.log('line '+i)"`;
// CommonJS 形式的 fs：可替换其中的函数（模拟写入出错），再同步到 ESM 的具名导出
const fs: typeof import("node:fs") = createRequire(import.meta.url)("node:fs");
const NO_SYMLINKS = process.platform === "win32" ? "Windows 上建不了原生符号链接" : false;

function storeFor(
  root: string,
  sessionId: string,
  maxBytes = 10_000_000,
  ancestors?: () => string[]
) {
  return new CommandOutputStore({
    base: root,
    outputsRoot: join(root, ".pigeon", "state", "outputs"),
    sessionId,
    maxBytes,
    ...(ancestors !== undefined ? { ancestors } : {}),
  });
}

function workspace(maxBytes = 10_000_000, ancestors?: () => string[]) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-outputs-"));
  const outputsRoot = join(root, ".pigeon", "state", "outputs");
  const store = storeFor(root, "s1", maxBytes, ancestors);
  return {
    root,
    outputsRoot,
    store,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");

// 跑一条超长输出的命令（开头 100、末尾 100 字节），返回结果文本
async function runLong(
  root: string,
  store: CommandOutputStore,
  command = printLines(LINES)
): Promise<string> {
  const run = createRunCommandTool({
    workspaceRoot: root,
    output: { headBytes: 100, tailBytes: 100, store },
  });
  return textOf(await run.execute("c", { command }));
}

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

test("分行只按 \\n：单独的 \\r 不算断行，总行数与 run_command 给出的一致，按 offset 读到对应的那行", async () => {
  const { root, store, cleanup } = workspace();
  try {
    // 每行前面先打一段以 \r 结尾的进度
    const text = await runLong(
      root,
      store,
      `node -e "for(let i=1;i<=${LINES};i++){process.stdout.write('p'+i+'\\r');console.log('line '+i)}"`
    );
    assert.match(text, new RegExp(`全文共 ${LINES} 行`));
    const read = createReadFileTool(root, { editMode: "replace", outputs: store });
    const middle = textOf(
      await read.execute("r", { path: "pigeon://outputs/s1/1", offset: 1500, limit: 1 })
    );
    assert.match(middle, /^1500\| p1500\rline 1500$/m);
    assert.match(middle, new RegExp(`共 ${LINES} 行`));
  } finally {
    cleanup();
  }
});

test("虚拟路径只认 pigeon://outputs/<会话号>/<编号>：越界写法一律拒绝；别的会话报错，分叉来源可读", async () => {
  const { root, store, cleanup } = workspace(10_000_000, () => ["parent"]);
  try {
    // 落盘文件按 <编号>.log 取：越界的写法若没被拦下，就会读到工作区根的 secret.log
    writeFileSync(join(root, "secret.log"), "secret\n");
    await runLong(root, storeFor(root, "parent"));
    await runLong(root, storeFor(root, "worker"));
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
    const parent = textOf(
      await read.execute("r", { path: "pigeon://outputs/parent/1", offset: 7, limit: 1 })
    );
    assert.match(parent, /^7\| line 7$/m);
  } finally {
    cleanup();
  }
});

test("读取只认 Pigeon 写下的那份：原地改了内容、换成同内容的别的文件或硬链接都拒绝，改回原样可读", async () => {
  const { root, store, cleanup } = workspace();
  try {
    await runLong(root, store);
    const file = join(store.dir, "1.log");
    const original = readFileSync(file);
    const read = createReadFileTool(root, { editMode: "replace", outputs: store });
    const readBack = () => read.execute("r", { path: "pigeon://outputs/s1/1", limit: 1 });
    // 同一个文件、大小不变，只改一个字节
    const tampered = Buffer.from(original);
    tampered[0] = 0x4c;
    writeFileSync(file, tampered);
    await assert.rejects(readBack, /已被改动/);
    writeFileSync(file, original);
    assert.match(textOf(await readBack()), /^1\| line 1$/m);
    // 内容逐字节相同的另一个文件（先建好再换上，免得删掉原文件后 inode 被立即复用）
    writeFileSync(join(root, "copy.log"), original);
    renameSync(join(root, "copy.log"), file);
    await assert.rejects(readBack, /已被改动/);
    // 硬链接到工作区里的别的文件
    writeFileSync(join(root, "secret.txt"), "secret\n");
    unlinkSync(file);
    linkSync(join(root, "secret.txt"), file);
    await assert.rejects(readBack, /已被改动/);
  } finally {
    cleanup();
  }
});

test("读取只认 Pigeon 写下的那份：换成符号链接拒绝", { skip: NO_SYMLINKS }, async () => {
  const { root, store, cleanup } = workspace();
  try {
    await runLong(root, store);
    const file = join(store.dir, "1.log");
    // 链接指向内容逐字节相同的副本
    writeFileSync(join(root, "copy.log"), readFileSync(file));
    unlinkSync(file);
    symlinkSync(join(root, "copy.log"), file);
    const read = createReadFileTool(root, { editMode: "replace", outputs: store });
    await assert.rejects(
      () => read.execute("r", { path: "pigeon://outputs/s1/1" }),
      /链接|已被改动/
    );
  } finally {
    cleanup();
  }
});

test("落盘目录被换成链接：读取拒绝，下一次长输出不落盘并注明原因，链接目标不被写", {
  skip: NO_SYMLINKS,
}, async () => {
  const { root, outputsRoot, store, cleanup } = workspace();
  try {
    const outside = mkdtempSync(join(tmpdir(), "pigeon-outputs-outside-"));
    writeFileSync(join(outside, "1.log"), "host secret\n");
    mkdirSync(outputsRoot, { recursive: true });
    symlinkSync(outside, join(outputsRoot, "s1"));
    const read = createReadFileTool(root, { outputs: store });
    await assert.rejects(() => read.execute("r", { path: "pigeon://outputs/s1/1" }), /链接/);
    const text = await runLong(root, store);
    assert.match(text, /全文未能保存（[^）]*链接/);
    assert.deepEqual(readdirSync(outside), ["1.log"]);
    assert.equal(readFileSync(join(outside, "1.log"), "utf8"), "host secret\n");
    unlinkSync(join(outputsRoot, "s1"));
    rmSync(outside, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test("写到一半出错：照常给出头尾并注明原因，不留半截文件，编号照常前进，下一次照常落盘", async () => {
  const { root, store, cleanup } = workspace();
  const original = fs.writeSync;
  let calls = 0;
  // 落盘的第二次写入起报磁盘满（标准输出、标准错误照常）
  const failing = mock.method(fs, "writeSync", ((fd: number, ...rest: unknown[]) => {
    if (fd > 2 && ++calls > 1) {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return (original as (...args: unknown[]) => number)(fd, ...rest);
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  try {
    const failed = await runLong(root, store);
    failing.mock.restore();
    syncBuiltinESMExports();
    assert.match(failed, /全文未能保存（[^）]*ENOSPC/);
    assert.match(failed, /line 3000\n/);
    assert.deepEqual(
      readdirSync(store.dir).filter((name) => name !== "index.json"),
      []
    );
    const text = await runLong(root, store);
    assert.match(text, /已存为 pigeon:\/\/outputs\/s1\/2/);
    const read = createReadFileTool(root, { editMode: "replace", outputs: store });
    const back = textOf(
      await read.execute("r", { path: "pigeon://outputs/s1/2", offset: LINES, limit: 1 })
    );
    assert.match(back, new RegExp(`^${LINES}\\| line ${LINES}$`, "m"));
  } finally {
    failing.mock.restore();
    syncBuiltinESMExports();
    cleanup();
  }
});

test("落盘总量满了从最旧的删起，刚写的那份保留，剩下的总量不超过上限", async () => {
  const { root, store, cleanup } = workspace(40_000);
  try {
    for (let run = 0; run < 3; run += 1) await runLong(root, store);
    assert.throws(() => store.resolve("pigeon://outputs/s1/1"), /已因落盘总量上限被清理/);
    assert.ok(store.resolve("pigeon://outputs/s1/3").file.endsWith("3.log"));
    assert.ok(store.totalBytes() <= 40_000, String(store.totalBytes()));
  } finally {
    cleanup();
  }
});

test("按配额删旧文件只删身份与记录一致的：被换成别的文件的不删，只从索引里去掉", async () => {
  const { root, store, cleanup } = workspace(40_000);
  try {
    await runLong(root, store);
    const first = join(store.dir, "1.log");
    unlinkSync(first);
    writeFileSync(first, "precious\n");
    await runLong(root, store);
    assert.equal(readFileSync(first, "utf8"), "precious\n");
    assert.throws(() => store.resolve("pigeon://outputs/s1/1"), /已因落盘总量上限被清理/);
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

// 喂一段超过开头加末尾的输出，落盘到 path
function spillTo(path: string) {
  const collector = createHeadCollector(10, {
    tailBytes: 10,
    fullOutput: { path, maxBytes: 1000 },
  });
  collector.push(Buffer.from("x".repeat(100)));
  return collector.finish();
}

test("收集器：落盘文件独占新建，已在的文件不覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-collector-"));
  try {
    writeFileSync(join(dir, "taken.log"), "theirs\n");
    const result = spillTo(join(dir, "taken.log"));
    assert.equal(result.fullOutputSaved, undefined);
    assert.match(result.fullOutputError ?? "", /EEXIST/);
    assert.equal(readFileSync(join(dir, "taken.log"), "utf8"), "theirs\n");
    // 写成的那份带上身份：写入字节的 sha256
    const saved = spillTo(join(dir, "mine.log"));
    assert.ok(saved.fullOutputFile !== undefined);
    assert.equal(saved.fullOutputFile.sha256.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("收集器：落盘路径是符号链接时不跟随，链接指向的文件不变", { skip: NO_SYMLINKS }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-collector-"));
  try {
    writeFileSync(join(dir, "target.txt"), "keep\n");
    symlinkSync(join(dir, "target.txt"), join(dir, "link.log"));
    symlinkSync(join(dir, "missing.txt"), join(dir, "dangling.log"));
    for (const name of ["link.log", "dangling.log"]) {
      const result = spillTo(join(dir, name));
      assert.equal(result.fullOutputSaved, undefined, name);
      assert.ok(result.fullOutputError !== undefined, name);
    }
    assert.equal(readFileSync(join(dir, "target.txt"), "utf8"), "keep\n");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.log", "link.log", "target.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
