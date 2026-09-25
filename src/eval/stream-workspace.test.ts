import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
  removeCoveringHelpers,
  STREAM_COMMITTER,
  StreamWorkspace,
  StreamWorkspaceAccessError,
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
    // 本用例自己的报告路径：不碰各用例共用的 /tmp/pigeon-gate-junit.xml
    const gate = `${root.replace(/\\/g, "/")}/gate-junit.xml`;
    const ws = new StreamWorkspace(localStreamShell(root), { gateReport: gate });
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

test("删覆盖人写测试的自动加载辅助文件：按文件系统列（嵌套的 git 仓库里的也删），名叫 conftest 的目录整个删；agent 自己目录的与人的保留", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-helpers-"));
  try {
    const root = join(base, "ws");
    const put = (p: string, content = "x\n") => {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), content);
    };
    git(base, "init", "-q", "ws");
    put("tests/unit/test_a.sh");
    put("tests/conftest.sh", "human\n");
    put("tests/unit/conftest.sh", "agent\n");
    // 嵌套的 git 仓库（外层 git 看不到里面的文件）
    git(root, "init", "-q", "tests/deep");
    put("tests/deep/test_b.sh");
    put("tests/deep/conftest.sh", "agent\n");
    // 名叫 conftest.sh 的目录
    mkdirSync(join(root, "tests", "unit", "more", "conftest.sh"), { recursive: true });
    put("tests/unit/more/test_c.sh");
    put("tests/unit/more/conftest.sh/inner", "x\n");
    // agent 自己的测试目录
    put("own/conftest.sh", "agent\n");
    put("own/test_own.sh");
    const ws = new StreamWorkspace(localStreamShell(root));
    const human = ["tests/unit/test_a.sh", "tests/deep/test_b.sh", "tests/unit/more/test_c.sh"];
    const removed = await removeCoveringHelpers(
      ws,
      "conftest.sh",
      (p) => p === "tests/conftest.sh" || human.includes(p),
      human
    );
    assert.deepEqual(removed.sort(), [
      "tests/deep/conftest.sh",
      "tests/unit/conftest.sh",
      "tests/unit/more/conftest.sh",
    ]);
    assert.equal(existsSync(join(root, "tests", "conftest.sh")), true, "人的保留");
    assert.equal(existsSync(join(root, "own", "conftest.sh")), true, "agent 自己目录的保留");
    assert.equal(existsSync(join(root, "tests", "unit", "more", "conftest.sh")), false);
    // 空格、非 ASCII 与根目录下的路径
    put("有 空格/test_d.sh");
    put("有 空格/conftest.sh", "agent\n");
    put("conftest.sh", "agent at root\n");
    const again = await removeCoveringHelpers(ws, "conftest.sh", (p) => p === "tests/conftest.sh", [
      "有 空格/test_d.sh",
    ]);
    assert.deepEqual(again.sort(), ["conftest.sh", "有 空格/conftest.sh"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 本机（Windows）建不了原生符号链接：符号链接的用例只在 Linux 上跑
const NO_SYMLINKS = process.platform === "win32" ? "本机建不了原生符号链接" : false;

test("删覆盖人写测试的 conftest 时不跟随符号链接：名为 conftest 的链接只删链接；人写测试的上级目录被换成链接的删掉链接本身，链接那边的目录与其中的 conftest 不动；agent 自己目录的链接保留", {
  skip: NO_SYMLINKS,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-helpers-link-"));
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    mkdirSync(join(root, "tests", "unit"), { recursive: true });
    writeFileSync(join(root, "tests", "unit", "test_a.sh"), "x\n");
    // 链接那边：一个会让用例恒过的 conftest，和一份人写测试的副本
    const outside = join(base, "np");
    mkdirSync(outside);
    writeFileSync(join(outside, "conftest.sh"), "sh() { return 0; }\n");
    writeFileSync(join(outside, "test_b.sh"), "x\n");
    const outsideFile = join(base, "outside.sh");
    writeFileSync(outsideFile, "outside\n");
    // 人写测试的上级目录被换成指向别处的链接
    execFileSync("ln", ["-s", outside, join(root, "tests", "x")]);
    // 名为 conftest 的链接（指向一个文件）
    execFileSync("ln", ["-s", outsideFile, join(root, "tests", "unit", "conftest.sh")]);
    // agent 自己目录里的链接：不在人写测试的路径上
    mkdirSync(join(root, "own"));
    execFileSync("ln", ["-s", outside, join(root, "own", "linked")]);
    const ws = new StreamWorkspace(localStreamShell(root));
    const human = ["tests/unit/test_a.sh", "tests/x/test_b.sh"];
    const removed = await removeCoveringHelpers(ws, "conftest.sh", (p) => human.includes(p), human);
    assert.deepEqual(removed.sort(), ["tests/unit/conftest.sh", "tests/x"]);
    assert.equal(existsSync(join(root, "tests", "x")), false, "链接本身删掉");
    assert.equal(existsSync(join(root, "tests", "unit", "conftest.sh")), false);
    assert.equal(
      readFileSync(join(outside, "conftest.sh"), "utf8"),
      "sh() { return 0; }\n",
      "链接那边不动"
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "outside\n", "链接指向的文件不动");
    assert.equal(
      lstatSync(join(root, "own", "linked")).isSymbolicLink(),
      true,
      "agent 自己目录的链接保留"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("写入人写测试之前，路径上被换成符号链接的目录与文件换成真的：不顺着链接写到工作区之外，按判题的方式加载 conftest 加载不到，错的实现照样失败；测量副本同样", {
  skip: NO_SYMLINKS,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-human-link-"));
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "wrong\n");
    // agent 把这一步新增的人写测试目录换成链接，那边放一个让用例恒过的 conftest；另把一个人写测试文件换成链接
    const outside = join(base, "np");
    mkdirSync(outside);
    writeFileSync(join(outside, "conftest.sh"), "sh() { return 0; }\n");
    writeFileSync(join(base, "evil.sh"), "true\n");
    mkdirSync(join(root, "tests"));
    execFileSync("ln", ["-s", outside, join(root, "tests", "x")]);
    execFileSync("ln", ["-s", join(base, "evil.sh"), join(root, "tests", "y.test.sh")]);
    const ws = new StreamWorkspace(localStreamShell(root));
    const content = Buffer.from("grep -q alpha src/a.txt\n");
    const ops = [
      { path: "tests/x/a.test.sh", op: "write" as const, kind: "test" as const },
      { path: "tests/y.test.sh", op: "write" as const, kind: "test" as const },
    ];
    await ws.applyHumanFiles(ops, () => content);
    assert.equal(lstatSync(join(root, "tests", "x")).isSymbolicLink(), false, "换成真目录");
    assert.equal(lstatSync(join(root, "tests", "y.test.sh")).isSymbolicLink(), false, "换成真文件");
    assert.equal(readFileSync(join(root, "tests", "x", "a.test.sh"), "utf8"), content.toString());
    assert.deepEqual(readdirSync(outside), ["conftest.sh"], "没有写到链接那边");
    assert.equal(readFileSync(join(base, "evil.sh"), "utf8"), "true\n", "链接指向的文件没被改写");
    // 判题：先加载覆盖这些测试的 conftest，再跑用例
    const judge = () =>
      execFileSync(
        "sh",
        [
          "-c",
          'for c in tests/x/conftest.sh; do [ -f "$c" ] && . "./$c"; done; sh tests/x/a.test.sh && sh tests/y.test.sh',
        ],
        { cwd: root, stdio: "ignore" }
      );
    assert.throws(judge, "错的实现照样失败");
    // 测量副本：同样不顺着链接写
    const copy = join(base, "copy");
    mkdirSync(join(copy, "tests"), { recursive: true });
    execFileSync("ln", ["-s", outside, join(copy, "tests", "x")]);
    await ws.applyHumanFilesAt(copy, ops.slice(0, 1), () => content);
    assert.equal(lstatSync(join(copy, "tests", "x")).isSymbolicLink(), false);
    assert.deepEqual(readdirSync(outside), ["conftest.sh"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("删 conftest 之前先放回属主权限：agent 把目录设成能进不能列（0311），里面可读的子目录放一个覆盖人写测试的 conftest，照样找到并删掉", {
  skip: NO_SYMLINKS,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-helpers-perm-"));
  const hidden = join(base, "ws", "tests", "x");
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    mkdirSync(join(hidden, "y"), { recursive: true });
    writeFileSync(join(hidden, "y", "test_a.sh"), "x\n");
    writeFileSync(join(hidden, "y", "conftest.sh"), "sh() { return 0; }\n");
    execFileSync("chmod", ["0311", hidden]);
    // 先确认目录确实列不出来（root 下 chmod 不生效，用例会空转）
    let listable = true;
    try {
      readdirSync(hidden);
    } catch {
      listable = false;
    }
    if (listable) return;
    const ws = new StreamWorkspace(localStreamShell(root));
    const removed = await removeCoveringHelpers(ws, "conftest.sh", () => false, [
      "tests/x/y/test_a.sh",
    ]);
    assert.deepEqual(removed, ["tests/x/y/conftest.sh"]);
  } finally {
    execFileSync("chmod", ["-R", "u+rwX", join(base, "ws")]);
    rmSync(base, { recursive: true, force: true });
  }
});

test("写人的文件时路径上的链接删不掉：报访问错误（调用方把这一步作废），不顺着链接写到工作区之外", {
  skip: NO_SYMLINKS,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-unlink-"));
  const tests = join(base, "ws", "tests");
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    mkdirSync(tests);
    const outside = join(base, "np");
    mkdirSync(outside);
    execFileSync("ln", ["-s", outside, join(tests, "x")]);
    // 上级目录不可写：链接删不掉
    execFileSync("chmod", ["0555", tests]);
    const ws = new StreamWorkspace(localStreamShell(root));
    await assert.rejects(
      ws.applyHumanFiles([{ path: "tests/x/a.test.sh", op: "write", kind: "test" }], () =>
        Buffer.from("x\n")
      ),
      StreamWorkspaceAccessError
    );
    assert.deepEqual(readdirSync(outside), [], "没有写到链接那边");
  } finally {
    execFileSync("chmod", ["-R", "u+rwX", join(base, "ws")]);
    rmSync(base, { recursive: true, force: true });
  }
});

test("写人的文件时路径上某一级是普通文件（人的树规定那里是目录）：删掉它、建目录再写", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-filedir-"));
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "x"), "agent's file\n");
    const ws = new StreamWorkspace(localStreamShell(root));
    await ws.applyHumanFiles([{ path: "tests/x/a.test.sh", op: "write", kind: "test" }], () =>
      Buffer.from("human\n")
    );
    assert.equal(readFileSync(join(root, "tests", "x", "a.test.sh"), "utf8"), "human\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("残留的 git 锁文件：只在工作区下没有 git 进程在跑时删（index.lock、HEAD.lock、packed-refs.lock、refs 下的 *.lock）；别处的 git 进程不相干", {
  skip: NO_SYMLINKS,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-locks-"));
  const running: ReturnType<typeof spawn>[] = [];
  // 一个一直在跑的 git 进程（等标准输入），工作目录在 cwd
  const gitRunningIn = (cwd: string) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd,
      stdio: ["pipe", "ignore", "ignore"],
    });
    running.push(child);
    return new Promise((r) => setTimeout(r, 300));
  };
  try {
    const root = join(base, "ws");
    git(base, "init", "-q", "ws");
    git(base, "init", "-q", "elsewhere");
    const locks = [
      ".git/index.lock",
      ".git/HEAD.lock",
      ".git/packed-refs.lock",
      ".git/refs/heads/x.lock",
    ];
    const plant = () => {
      for (const l of locks) writeFileSync(join(root, l), "");
    };
    const ws = new StreamWorkspace(localStreamShell(root));
    await gitRunningIn(join(base, "elsewhere"));
    plant();
    await ws.removeStaleGitLocks();
    assert.deepEqual(
      locks.filter((l) => existsSync(join(root, l))),
      [],
      "别处的 git 进程不相干"
    );
    await gitRunningIn(root);
    plant();
    await ws.removeStaleGitLocks();
    assert.deepEqual(
      locks.filter((l) => existsSync(join(root, l))),
      locks,
      "工作区下有 git 在跑即保留"
    );
  } finally {
    for (const child of running) child.kill();
    rmSync(base, { recursive: true, force: true });
  }
});

test("丢弃作废的尝试：agent 留下的分支、标签、stash、rebase-apply、worktree 登记、未跟踪的嵌套仓库与打进包的提交，丢弃后都找不到；工作区之外的路径不碰；main 与不超过断点的开工树引用保留；不在作业容器里时临时目录不动", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-discard-"));
  try {
    const root = join(base, "ws");
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    git(base, "init", "-q", "-b", "main", "ws");
    const g = (...a: string[]) => git(root, "-c", "user.name=a", "-c", "user.email=a@x", ...a);
    writeFileSync(join(root, "a.txt"), "base\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const head = git(root, "rev-parse", "HEAD");
    g("update-ref", "refs/pigeon/step-start/s1/1", head);
    g("update-ref", "refs/pigeon/step-start/s1/2", head);
    // 作废的那次尝试：落地提交 N 并打进包，再回到 head（N 只剩 reflog 与包里）
    writeFileSync(join(root, "a.txt"), "solution\n");
    g("commit", "-qam", "N");
    const landed = git(root, "rev-parse", "HEAD");
    g("repack", "-a", "-d", "-q");
    g("tag", "t1");
    g("branch", "b1");
    g("reset", "-q", "--hard", head);
    // stash 着一份在途改动
    writeFileSync(join(root, "a.txt"), "in flight\n");
    g("stash", "-q");
    // rebase-apply 里以补丁文件存着改动
    mkdirSync(join(root, ".git", "rebase-apply"));
    writeFileSync(join(root, ".git", "rebase-apply", "0001"), "patch\n");
    // worktree（工作区之内与之外各一个）与未跟踪的嵌套仓库
    g("worktree", "add", "-q", join(root, "inner-wt"), "b1");
    g("worktree", "add", "-q", "--detach", join(base, "wt"), head);
    git(root, "init", "-q", "nested");
    writeFileSync(join(tmp, "left.txt"), "x\n");
    const ws = new StreamWorkspace(localStreamShell(root), { tmpDir: tmp });
    await ws.discardAttempt(head, 1);
    assert.deepEqual(
      git(root, "for-each-ref", "--format=%(refname)").split("\n").sort(),
      ["refs/heads/main", "refs/pigeon/step-start/s1/1"],
      "只剩 main 与不超过断点的开工树引用"
    );
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "stash", "list"), "", "stash 清掉");
    assert.equal(existsSync(join(root, ".git", "rebase-apply")), false, "rebase-apply 清掉");
    assert.equal(existsSync(join(root, "inner-wt")), false, "工作区之内的 worktree 删掉");
    assert.equal(existsSync(join(base, "wt")), true, "工作区之外的路径不碰（只摘掉登记）");
    assert.equal(git(root, "worktree", "list", "--porcelain").split("\n\n").length, 1);
    assert.equal(existsSync(join(root, "nested")), false, "未跟踪的嵌套仓库删掉");
    assert.throws(() => git(root, "cat-file", "-e", landed), "打进包的提交 N 也回收掉");
    // 不在跑批器起的作业容器里（本机）：临时目录一个文件都不动（在作业容器里清空，见真容器的用例）
    assert.deepEqual(readdirSync(tmp), ["left.txt"], "本机的临时目录不动");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 闸门（IN_STREAM_CONTAINER）的两个条件：本机有没有 /.dockerenv
const HAS_DOCKERENV = existsSync("/.dockerenv");

test("闸门：不在跑批器起的作业容器里（缺环境变量或缺 /.dockerenv，或两者都缺），清空临时目录不动手", async () => {
  const cases: [string, boolean, string | false][] = [
    ["两者都缺", false, HAS_DOCKERENV ? "本机有 /.dockerenv" : false],
    ["只有环境变量", true, HAS_DOCKERENV ? "本机有 /.dockerenv" : false],
    ["只有 /.dockerenv", false, HAS_DOCKERENV ? false : "本机没有 /.dockerenv"],
  ];
  for (const [what, setVar, skip] of cases) {
    if (skip !== false) continue;
    const base = mkdtempSync(join(tmpdir(), "pigeon-stream-gate-"));
    const saved = process.env.PIGEON_STREAM_CONTAINER;
    try {
      const root = join(base, "ws");
      mkdirSync(root);
      // 清空的目标永远是用例自建的临时目录
      const tmp = join(base, "tmp");
      mkdirSync(tmp);
      writeFileSync(join(tmp, "keep.txt"), "x\n");
      if (setVar) process.env.PIGEON_STREAM_CONTAINER = "1";
      else delete process.env.PIGEON_STREAM_CONTAINER;
      await new StreamWorkspace(localStreamShell(root), { tmpDir: tmp }).clearTmpDir();
      assert.deepEqual(readdirSync(tmp), ["keep.txt"], what);
    } finally {
      if (saved === undefined) delete process.env.PIGEON_STREAM_CONTAINER;
      else process.env.PIGEON_STREAM_CONTAINER = saved;
      rmSync(base, { recursive: true, force: true });
    }
  }
});
