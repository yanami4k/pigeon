import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import {
  dockerStreamShell,
  STREAM_COMMITTER,
  StreamWorkspace,
  shellQuote,
  timeoutWrapped,
} from "./stream-workspace.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 人的仓库：c1（带 .gitignore 与源代码）→ c2 → c3（未来），外加一个标签
function humanRepo(base: string): {
  dir: string;
  c1: string;
  c2: string;
  c3: string;
  bundle: Buffer;
} {
  const dir = join(base, "human");
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "human");
  git(dir, "config", "user.email", "human@example.invalid");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  const c1 = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "two\n");
  git(dir, "commit", "-q", "-am", "c2");
  const c2 = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "v-start");
  writeFileSync(join(dir, "future.txt"), "answer\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c3 future");
  const c3 = git(dir, "rev-parse", "HEAD");
  // 起点 bundle 只含起点可达的历史
  git(dir, "branch", "stream-start", c2);
  const bundlePath = join(base, "start.bundle");
  git(dir, "bundle", "create", bundlePath, "stream-start");
  return { dir, c1, c2, c3, bundle: readFileSync(bundlePath) };
}

function withTemp(fn: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), "pigeon-stream-ws-"));
    try {
      await fn(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
}

async function freshWorkspace(base: string, name = "ws") {
  const human = humanRepo(base);
  const root = join(base, name);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const ws = new StreamWorkspace(localStreamShell(root));
  await ws.initFromBundle(human.bundle, human.c2);
  return { human, root, ws };
}

// 每个用例各起一个临时仓库、互不相干，并发跑（历史清理里的 gc 在 Windows 上慢）
describe("流工作区（本机 sh 真跑同一批脚本）", { concurrency: true }, () => {
  test(
    "流起点：从 bundle 检出人的起点代码，历史清到只剩当前（无标签、未来对象不在），预装依赖目录保留",
    withTemp(async (base) => {
      const { human, root, ws } = await freshWorkspace(base);
      assert.equal(await ws.head(), human.c2);
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "two\n");
      assert.equal(git(root, "tag"), "");
      assert.equal(git(root, "rev-list", "--all", "--count"), "2");
      assert.throws(() => git(root, "cat-file", "-e", human.c3));
      assert.ok(!existsSync(join(root, "future.txt")));
      assert.ok(!existsSync(join(root, ".git", "pigeon-start.bundle")));
      assert.ok(existsSync(join(root, "node_modules", "dep", "index.js")));
      assert.ok(await ws.isClean());
    })
  );

  test(
    "流起点：bundle 里没有指定的起点提交时建立失败",
    withTemp(async (base) => {
      const human = humanRepo(base);
      const ws = new StreamWorkspace(localStreamShell(join(base, "ws")));
      mkdirSync(join(base, "ws"));
      await assert.rejects(ws.initFromBundle(human.bundle, human.c3), /建立流起点失败/);
    })
  );

  test(
    "人的文件：写入（含嵌套目录与二进制内容）与删除",
    withTemp(async (base) => {
      const { root, ws } = await freshWorkspace(base);
      const binary = Buffer.from([0, 1, 2, 255, 10, 13, 10]);
      const files: Record<string, Buffer> = {
        "src/deep/x.test.ts": Buffer.from("test('x', () => {});\n"),
        "fixtures/blob.bin": binary,
      };
      await ws.applyHumanFiles(
        [
          { path: "src/deep/x.test.ts", op: "write", kind: "test" },
          { path: "fixtures/blob.bin", op: "write", kind: "testaux" },
          { path: "a.txt", op: "delete", kind: "test" },
        ],
        (p) => files[p] ?? Buffer.alloc(0)
      );
      assert.equal(
        readFileSync(join(root, "src/deep/x.test.ts"), "utf8"),
        "test('x', () => {});\n"
      );
      assert.deepEqual(readFileSync(join(root, "fixtures/blob.bin")), binary);
      assert.ok(!existsSync(join(root, "a.txt")));
    })
  );

  test(
    "落地：以该步提交信息提交全部改动，提交者为程序身份；无改动也落一次",
    withTemp(async (base) => {
      const { human, root, ws } = await freshWorkspace(base);
      writeFileSync(join(root, "b.txt"), "agent\n");
      const message = "Add b\n\nBody line with 'quotes' and $dollar\n";
      const landed = await ws.land(message);
      assert.notEqual(landed, human.c2);
      assert.equal(git(root, "log", "-1", "--format=%B"), message.trimEnd());
      assert.equal(
        git(root, "log", "-1", "--format=%an <%ae>"),
        `${STREAM_COMMITTER.name} <${STREAM_COMMITTER.email}>`
      );
      assert.equal(git(root, "show", "--name-only", "--format=", "HEAD"), "b.txt");
      const again = await ws.land("Empty step\n");
      assert.equal(git(root, "rev-parse", "HEAD~1"), landed);
      assert.notEqual(again, landed);
    })
  );

  test(
    "回到本步起点：被跟踪文件复原、未忽略的未跟踪文件删除、被忽略的依赖目录不动",
    withTemp(async (base) => {
      const { root, ws } = await freshWorkspace(base);
      writeFileSync(join(root, "a.txt"), "broken\n");
      mkdirSync(join(root, "newdir"));
      writeFileSync(join(root, "newdir", "n.txt"), "untracked\n");
      writeFileSync(join(root, "node_modules", "dep", "cache.txt"), "ignored\n");
      assert.ok(!(await ws.isClean()));
      await ws.rollback();
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "two\n");
      assert.ok(!existsSync(join(root, "newdir")));
      assert.ok(existsSync(join(root, "node_modules", "dep", "cache.txt")));
      assert.ok(await ws.isClean());
    })
  );

  test(
    "续跑：导出的流历史在新目录恢复出同一 HEAD 与提交信息",
    withTemp(async (base) => {
      const { root, ws } = await freshWorkspace(base);
      writeFileSync(join(root, "b.txt"), "agent\n");
      const landed = await ws.land("Step one\n");
      const bundle = await ws.exportBundle();
      const again = join(base, "restored");
      mkdirSync(again);
      const restored = new StreamWorkspace(localStreamShell(again));
      await restored.restoreFromBundle(bundle, landed);
      assert.equal(await restored.head(), landed);
      assert.equal(readFileSync(join(again, "b.txt"), "utf8"), "agent\n");
      assert.equal(git(again, "log", "-1", "--format=%s"), "Step one");
      assert.equal(git(again, "remote"), "");
    })
  );

  test(
    "测量副本：从 HEAD 克隆、依赖目录接上，写入人的文件不影响工作区",
    withTemp(async (base) => {
      const { root, ws } = await freshWorkspace(base);
      writeFileSync(join(root, "uncommitted.txt"), "not in HEAD\n");
      const copy = join(base, "measure");
      await ws.prepareMeasureCopy(copy, ["node_modules", "no-such-dir"]);
      assert.equal(readFileSync(join(copy, "a.txt"), "utf8"), "two\n");
      assert.ok(!existsSync(join(copy, "uncommitted.txt")));
      assert.ok(existsSync(join(copy, "node_modules", "dep", "index.js")));
      assert.ok(!existsSync(join(copy, "no-such-dir")));
      await ws.applyHumanFilesAt(copy, [{ path: "t/h.test.ts", op: "write", kind: "test" }], () =>
        Buffer.from("human\n")
      );
      assert.equal(readFileSync(join(copy, "t/h.test.ts"), "utf8"), "human\n");
      assert.ok(!existsSync(join(root, "t")));
      // 重建副本会先清空旧副本（含以点开头的文件）；副本目录本身保留，非 root 用户不必能写它的上级目录
      writeFileSync(join(copy, ".stale"), "old\n");
      await ws.prepareMeasureCopy(copy, []);
      assert.ok(!existsSync(join(copy, "t")));
      assert.ok(!existsSync(join(copy, ".stale")));
      assert.equal(readFileSync(join(copy, "a.txt"), "utf8"), "two\n");
    })
  );

  test(
    "命令：带墙钟上限，超时由容器内 timeout 杀掉并如实报告",
    withTemp(async (base) => {
      const { ws } = await freshWorkspace(base);
      const ok = await ws.run(["sh", "-c", "echo hi; exit 3"], 10_000);
      assert.deepEqual([ok.exitCode, ok.timedOut, ok.output.trim()], [3, false, "hi"]);
      const slow = await ws.run(["sleep", "20"], 1_000);
      assert.equal(slow.timedOut, true);
    })
  );
});

test("命令拼接：单引号转义、安全字符原样、超时换算为整秒", () => {
  assert.equal(shellQuote("npm"), "npm");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(timeoutWrapped(["npm", "run", "verify"], 1500), "timeout -s KILL 2 npm run verify");
});

test("清理测量与判题的产物：测量副本目录清空（目录本身保留），判题报告与维护步验证门的报告（/tmp/pigeon-gate-junit.xml）都删掉", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-artifacts-"));
  try {
    const root = join(base, "ws");
    mkdirSync(join(root, ".git"), { recursive: true });
    const measure = join(base, "measure");
    mkdirSync(join(measure, "copy"), { recursive: true });
    writeFileSync(join(measure, "copy", "report.xml"), "x");
    writeFileSync(join(root, ".git", "pigeon-cases-junit.xml"), "x");
    const ws = new StreamWorkspace(localStreamShell(root));
    const gate = "/tmp/pigeon-gate-junit.xml";
    await ws.run(["sh", "-c", `echo x > ${gate}`], 10_000);
    await ws.clearArtifacts(measure);
    const left = await ws.run(["sh", "-c", `test -e ${gate}`], 10_000);
    assert.notEqual(left.exitCode, 0, "验证门的报告已删");
    assert.equal(existsSync(join(root, ".git", "pigeon-cases-junit.xml")), false);
    assert.deepEqual(readdirSync(measure), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("容器里的 root 操作：跑批器写 agent 不可写的位置时以 docker exec -u 0 执行，平常的命令不带", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-root-"));
  try {
    const log = join(base, "docker.log");
    const fake = join(base, "docker.mjs");
    writeFileSync(
      fake,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      ].join("\n")
    );
    const ws = new StreamWorkspace(
      dockerStreamShell({ container: "box", root: "/testbed", docker: [process.execPath, fake] })
    );
    await ws.asRoot("true", "root 操作");
    await ws.head().catch(() => undefined);
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(calls[0]?.slice(0, 4), ["exec", "-u", "0", "-w"]);
    assert.ok(
      calls.slice(1).every((c) => !c.includes("-u")),
      JSON.stringify(calls)
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
