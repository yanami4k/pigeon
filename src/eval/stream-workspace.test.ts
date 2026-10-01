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
import { TIMEOUT_PROBE_SCRIPT } from "../execution/container-host.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import {
  dockerStreamShell,
  removeCoveringHelpers,
  STALE_GIT_LOCKS,
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
    "开工树与改动：开工时与收工时各取一次工作区的树，两者之差即 agent 的改动（改动与新增，含二进制与未跟踪文件）；取树不动真的暂存区，被忽略的文件不在其中",
    withTemp(async (base) => {
      const { root, ws } = await freshWorkspace(base);
      const start = await ws.worktreeTree();
      writeFileSync(join(root, "a.txt"), "agent\n");
      writeFileSync(join(root, "new.bin"), Buffer.from([0, 255, 1]));
      writeFileSync(join(root, "node_modules", "dep", "cache.txt"), "ignored\n");
      git(root, "add", "a.txt");
      const indexBefore = git(root, "ls-files", "-s");
      const end = await ws.worktreeTree();
      assert.equal(git(root, "ls-files", "-s"), indexBefore, "真的暂存区不动");
      const diff = (await ws.diffTrees(start, end)).toString("utf8");
      assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt/m);
      assert.match(diff, /^\+agent$/m);
      assert.match(diff, /^diff --git a\/new\.bin b\/new\.bin[\s\S]*GIT binary patch/m);
      assert.doesNotMatch(diff, /node_modules/, "被忽略的文件不在改动里");
      assert.equal((await ws.diffTrees(start, start)).length, 0, "同一棵树没有差");
      // 全量测量前暂存全部：未跟踪的文件进了暂存区
      await ws.stageAll();
      assert.match(git(root, "ls-files"), /^new\.bin$/m);
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

test("家目录下的用户级文件（195 补口）：删掉给定的相对路径（文件与整个目录），其余不动；绝对路径与含 .. 的路径拒绝", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-home-"));
  try {
    const root = join(base, "ws");
    mkdirSync(root);
    const home = join(base, "home");
    mkdirSync(join(home, ".local", "lib", "python3", "site-packages"), { recursive: true });
    writeFileSync(join(home, ".local", "lib", "python3", "site-packages", "usercustomize.py"), "x");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".mypy.ini"), "[mypy]\n");
    writeFileSync(join(home, ".bashrc"), "keep\n");
    const ws = new StreamWorkspace(localStreamShell(root), { homeDir: home });
    await ws.clearHomePaths([".local/lib", ".config/ruff", ".mypy.ini"]);
    assert.equal(existsSync(join(home, ".local", "lib")), false);
    assert.equal(existsSync(join(home, ".mypy.ini")), false);
    assert.equal(existsSync(join(home, ".local", "bin")), true, "没列的不动");
    assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), "keep\n");
    await assert.rejects(ws.clearHomePaths(["/etc"]), /相对路径/);
    await assert.rejects(ws.clearHomePaths([".local/../.."]), /相对路径/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("家目录下的用户级文件删不掉（所在目录不可写）：报访问错误（调用方把这一步作废），不当作已清", {
  skip:
    process.platform === "win32"
      ? "Windows 上 chmod 不收走写权限"
      : process.getuid?.() === 0
        ? "以 root 运行，0555 挡不住删除"
        : false,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-home-locked-"));
  const home = join(base, "home");
  try {
    const root = join(base, "ws");
    mkdirSync(root);
    mkdirSync(join(home, ".config", "mypy"), { recursive: true });
    writeFileSync(join(home, ".config", "mypy", "config"), "[mypy]\n");
    execFileSync("chmod", ["0555", join(home, ".config")]);
    const ws = new StreamWorkspace(localStreamShell(root), { homeDir: home });
    await assert.rejects(ws.clearHomePaths([".config/mypy"]), StreamWorkspaceAccessError);
  } finally {
    execFileSync("chmod", ["-R", "u+rwX", base]);
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
      .map((l) => JSON.parse(l) as string[])
      // 探测容器有无 timeout 的调用（决策 335）不算
      .filter((c) => !c.some((a) => a.includes(TIMEOUT_PROBE_SCRIPT)));
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

// Windows 上建不了原生符号链接：符号链接的用例只在 Linux 上跑
const NO_SYMLINKS = process.platform === "win32" ? "Windows 上建不了原生符号链接" : false;

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

test("写入人写测试之前，路径上被换成符号链接的目录与文件换成真的：不顺着链接写到工作区之外，按判题的方式加载 conftest 加载不到，错的实现照样失败；写到别的目录时同样", {
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
    // 写到别的目录：同样不顺着链接写
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
}, async (t) => {
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
    // root 下 chmod 不生效：前提不成立，跳过而不是空转
    if (listable) {
      t.skip("以 root 运行，0311 挡不住读目录");
      return;
    }
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
  skip: NO_SYMLINKS || (process.getuid?.() === 0 ? "以 root 运行，0555 挡不住删链接" : false),
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
    const clearLocks = async () => {
      const r = await localStreamShell(root).sh(STALE_GIT_LOCKS, { args: [root] });
      assert.equal(r.exitCode, 0, r.stderr);
    };
    await gitRunningIn(join(base, "elsewhere"));
    plant();
    await clearLocks();
    assert.deepEqual(
      locks.filter((l) => existsSync(join(root, l))),
      [],
      "别处的 git 进程不相干"
    );
    await gitRunningIn(root);
    plant();
    await clearLocks();
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

// 闸门（IN_STREAM_CONTAINER）的两个条件：本机有没有 /.dockerenv
const HAS_DOCKERENV = existsSync("/.dockerenv");

test("闸门：不在跑批器起的作业容器里（缺环境变量或缺 /.dockerenv，或两者都缺），清家目录下的用户级文件不动手", async () => {
  const cases: [string, boolean, string | false][] = [
    ["两者都缺", false, HAS_DOCKERENV ? "本机有 /.dockerenv" : false],
    ["只有环境变量", true, HAS_DOCKERENV ? "本机有 /.dockerenv" : false],
    ["只有 /.dockerenv", false, HAS_DOCKERENV ? false : "本机没有 /.dockerenv"],
  ];
  for (const [what, setVar, skip] of cases) {
    if (skip !== false) continue;
    const base = mkdtempSync(join(tmpdir(), "pigeon-stream-gate-"));
    const saved = process.env.PIGEON_STREAM_CONTAINER;
    const savedHome = process.env.HOME;
    try {
      const root = join(base, "ws");
      mkdirSync(root);
      // 清理的目标永远是用例自建的家目录（本机的 sh 继承这里的 HOME）
      const home = join(base, "home");
      mkdirSync(home);
      writeFileSync(join(home, ".mypy.ini"), "[mypy]\n");
      process.env.HOME = home;
      if (setVar) process.env.PIGEON_STREAM_CONTAINER = "1";
      else delete process.env.PIGEON_STREAM_CONTAINER;
      await new StreamWorkspace(localStreamShell(root)).clearHomePaths([".mypy.ini"]);
      assert.deepEqual(readdirSync(home), [".mypy.ini"], what);
    } finally {
      if (saved === undefined) delete process.env.PIGEON_STREAM_CONTAINER;
      else process.env.PIGEON_STREAM_CONTAINER = saved;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(base, { recursive: true, force: true });
    }
  }
});

// 一个两个提交的工作区（start → landed），另建第 1 步的开工树引用指向 start；返回提交号与 git 助手
function symrefRepo(base: string) {
  const root = join(base, "ws");
  git(base, "init", "-q", "-b", "main", "ws");
  const g = (...a: string[]) => git(root, "-c", "user.name=a", "-c", "user.email=a@x", ...a);
  writeFileSync(join(root, "a.txt"), "start\n");
  g("add", "-A");
  g("commit", "-qm", "start");
  const start = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "landed\n");
  g("commit", "-qam", "landed");
  const landed = git(root, "rev-parse", "HEAD");
  g("update-ref", "refs/pigeon/step-start/s1/1", start);
  return { root, g, start, landed, ws: new StreamWorkspace(localStreamShell(root)) };
}

test("挪回起点不跟随符号引用：agent 让某条引用或开工树引用指向 main、或让 HEAD 指向保留的开工树引用，挪回后 HEAD 指回 main、main 指向起点，保留的引用未被改写", async () => {
  for (const what of [
    "分支指向 main",
    "开工树引用指向 main",
    "HEAD 指向保留的开工树引用",
  ] as const) {
    const base = mkdtempSync(join(tmpdir(), "pigeon-stream-symref-"));
    try {
      const r = symrefRepo(base);
      if (what === "分支指向 main") r.g("symbolic-ref", "refs/heads/x", "refs/heads/main");
      if (what === "开工树引用指向 main")
        r.g("symbolic-ref", "refs/pigeon/step-start/s1/9", "refs/heads/main");
      if (what === "HEAD 指向保留的开工树引用")
        r.g("symbolic-ref", "HEAD", "refs/pigeon/step-start/s1/1");
      await r.ws.normalizeTo(r.landed);
      assert.equal(
        git(r.root, "symbolic-ref", "HEAD"),
        "refs/heads/main",
        `${what}：HEAD 指回 main`
      );
      assert.equal(git(r.root, "rev-parse", "refs/heads/main"), r.landed, `${what}：main 指向起点`);
      assert.equal(
        git(r.root, "rev-parse", "refs/pigeon/step-start/s1/1"),
        r.start,
        `${what}：保留的引用未被改写`
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("agent 切到别的分支或让 HEAD 游离后提交：挪回起点后 main 指向起点、改动留在工作区，开工树与收工树之差含它提交的改动", async () => {
  for (const how of ["别的分支", "HEAD 游离"] as const) {
    const base = mkdtempSync(join(tmpdir(), "pigeon-stream-commit-diff-"));
    try {
      const r = symrefRepo(base);
      const start = await r.ws.worktreeTree();
      if (how === "别的分支") r.g("checkout", "-q", "-b", "b");
      else r.g("checkout", "-q", "--detach");
      writeFileSync(join(r.root, "a.txt"), "agent\n");
      r.g("commit", "-qam", "agent");
      writeFileSync(join(r.root, "b.txt"), "uncommitted\n");
      await r.ws.normalizeTo(r.landed);
      assert.equal(git(r.root, "rev-parse", "HEAD"), r.landed, `${how}：HEAD 在起点`);
      const diff = (await r.ws.diffTrees(start, await r.ws.worktreeTree())).toString("utf8");
      assert.match(diff, /^\+agent$/m, `${how}：提交了的改动在内`);
      assert.match(diff, /^\+uncommitted$/m, `${how}：没提交的改动也在内`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("跑批器的 git 操作不执行 agent 在 git 配置里设下的程序：仓库 .git/config 与全局配置里的 filter 驱动、要求签名的 gpg.program 都不起作用；配置被重写成只含无害项", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-gitcfg-"));
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const r = symrefRepo(base);
    const marker = join(base, "ran").replace(/\\/g, "/");
    const evil = join(base, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    const evilPath = evil.replace(/\\/g, "/");
    // 仓库配置：filter 驱动与签名
    r.g("config", "filter.evil.clean", evilPath);
    r.g("config", "commit.gpgsign", "true");
    r.g("config", "gpg.program", evilPath);
    writeFileSync(join(r.root, ".git", "info", "attributes"), "* filter=evil\n");
    // 全局配置：另一个 filter 驱动（配合工作区里的 .gitattributes）
    const globalCfg = join(base, "global.gitconfig");
    writeFileSync(globalCfg, `[filter "evil2"]\n\tclean = ${evilPath}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    writeFileSync(join(r.root, ".gitattributes"), "*.txt filter=evil2\n");
    writeFileSync(join(r.root, "a.txt"), "agent change\n");
    await r.ws.normalizeTo(r.landed);
    await r.ws.worktreeTree();
    await r.ws.stageAll();
    assert.equal(existsSync(join(base, "ran")), false, "agent 的程序没被执行");
    const cfg = readFileSync(join(r.root, ".git", "config"), "utf8");
    assert.doesNotMatch(cfg, /filter|program|evil/, "配置里的 filter 与 gpg.program 被清掉");
    assert.match(cfg, /gpgsign = false/);
    assert.equal(existsSync(join(r.root, ".git", "info", "attributes")), false);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("净化 git 配置不依赖 git 读得懂配置：.git/config 被写坏，挪回起点照常成功、配置被重写", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-broken-config-"));
  try {
    const r = symrefRepo(base);
    writeFileSync(join(r.root, ".git", "config"), "[[[ not a config\n");
    await r.ws.normalizeTo(r.landed);
    assert.match(
      readFileSync(join(r.root, ".git", "config"), "utf8"),
      /repositoryformatversion = 0/
    );
    assert.equal(git(r.root, "rev-parse", "HEAD"), r.landed);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("跑批器的内部命令里 python 不加载用户目录下的 site（PYTHONNOUSERSITE=1），git 不读全局与系统配置", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-trusted-env-"));
  try {
    const root = join(base, "ws");
    mkdirSync(root);
    const docker = localDockerHost(root);
    try {
      const ws = new StreamWorkspace(
        dockerStreamShell({ container: "box", root: docker.containerRoot, docker: docker.docker })
      );
      const r = await ws.run(
        ["sh", "-c", 'echo "$PYTHONNOUSERSITE $GIT_CONFIG_GLOBAL $GIT_CONFIG_NOSYSTEM"'],
        30_000,
        undefined,
        { systemPath: true }
      );
      assert.equal(r.output.trim(), "1 /dev/null 1");
    } finally {
      docker.cleanup();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 续跑时的用例外壳：已完成的上千条用例逐条以 --deselect 排除；节点号里带方括号、空格与引号
function manyDeselects(count: number): string[] {
  return Array.from({ length: count }, (_, i) => [
    "--deselect",
    `tests/strands/agent/test_agent_${i % 40}.py::TestAgent::test_case_${i}[param-${i} it's "q"]`,
  ]).flat();
}

test("命令超出单个参数的长度上限（上千条 --deselect）：经标准输入送入容器执行，每个参数原样到达，不再报 spawn E2BIG；超时照常生效", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-long-command-"));
  try {
    const root = join(base, "ws");
    mkdirSync(root);
    const docker = localDockerHost(root);
    try {
      const ws = new StreamWorkspace(
        dockerStreamShell({ container: "box", root: docker.containerRoot, docker: docker.docker })
      );
      const args = manyDeselects(1500);
      const command = ["sh", "-c", 'printf "%s\\n" "$@" > args.txt; echo "$#"', "sh", ...args];
      // 前提：拼成的脚本确实超过 Linux 单个参数的上限（128 KiB）
      assert.ok(Buffer.byteLength(timeoutWrapped(command, 60_000)) > 128 * 1024);
      for (const systemPath of [false, true]) {
        const r = await ws.run(command, 60_000, undefined, { systemPath });
        assert.deepEqual(
          [r.exitCode, r.timedOut, r.output.trim()],
          [0, false, String(args.length)]
        );
        assert.deepEqual(
          readFileSync(join(root, "args.txt"), "utf8").split("\n").slice(0, -1),
          args
        );
      }
      const slow = await ws.run(["sh", "-c", "sleep 20", "sh", ...args], 1_000);
      assert.equal(slow.timedOut, true);
    } finally {
      docker.cleanup();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
