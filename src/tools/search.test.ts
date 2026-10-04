// grep 与 glob（决策 368），本机执行端：三种后端结果一致（git 仓库里 rg 与 git grep，不在仓库里 rg 与 grep -r）；
// 遵守 .gitignore、跳过 .git、含隐藏文件；上限与总数提示；模式里的 shell 特殊字符原样交给后端、不被解释；
// 以 - 开头的模式与目录不被当成选项；禁读名单的路径从结果里滤掉并注明条数。机器上没有的后端跳过。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createGlobTool } from "./glob.ts";
import { GlobPatternError, globToRegExp } from "./glob-match.ts";
import { createGrepTool } from "./grep.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { ReadDeniedError } from "./read-deny.ts";
import { detectSearchBackend, type SearchBackendKind } from "./search-backend.ts";
import { makeSearchTree, searchOutputs } from "./search-fixtures.ts";

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

for (const git of [true, false]) {
  test(`三种后端结果一致（${git ? "git 仓库：rg 与 git grep" : "不在仓库：rg 与 grep -r"}），.gitignore 只在仓库里生效`, async (t) => {
    const { root, cleanup } = makeSearchTree(git);
    try {
      const host = createLocalWorkspaceHost(root, { homeDir: join(root, "no-home") });
      const kinds: SearchBackendKind[] = [];
      for (const only of git ? (["rg", "git"] as const) : (["rg", "grep"] as const)) {
        if ((await detectSearchBackend(host, { only, bundledRipgrep: true })) !== undefined) {
          kinds.push(only);
        }
      }
      if (kinds.length < 2) {
        t.skip(`本机后端不全：${kinds.join("、")}`);
        return;
      }
      const [first, ...rest] = await Promise.all(
        kinds.map((kind) => searchOutputs(host, kind, true))
      );
      for (const [index, other] of rest.entries()) {
        assert.deepEqual(other, first, `${kinds[index + 1]} 与 ${kinds[0]} 的结果不同`);
      }
      const all = first?.grep[0] ?? "";
      assert.match(all, /^\.hidden\/h\.ts:1:foo hidden$/m);
      assert.match(all, /^-dash\/d\.ts:1:foo dash$/m);
      // git 仓库的 .git 里放了含 foo 的文件（见夹具），搜不到
      assert.doesNotMatch(all, /\.git\/|in git dir/);
      assert.equal(/ignored\/x\.ts|x\.log/.test(all), !git, all);
      assert.equal(first?.grep[2], "src/a.ts-1-alpha foo\nsrc/a.ts:2:beta\nsrc/a.ts-3-foo:bar");
      // shell 特殊字符原样当正则：命中那一行，且没有任何命令被执行
      assert.match(first?.grep[4] ?? "", /^src\/a\.ts:5:x; echo hi > pwned;/m);
      for (const name of ["pwned", "pwned2", "pwned3"]) {
        assert.equal(existsSync(join(root, name)), false, name);
      }
      assert.match(first?.grep[5] ?? "", /^src\/a\.ts:4:-v flag$/m);
      assert.equal(first?.grep[6], "-dash/d.ts:1:foo dash");
      // glob：按修改时间从新到旧
      assert.equal(first?.glob[1], "src/b.md");
      assert.deepEqual(first?.glob[2]?.split("\n"), ["src/b.md", "src/a.ts"]);
    } finally {
      cleanup();
    }
  });
}

test("上限给出总数（grep、files_only、glob）；禁读的路径逐条滤掉并计数；path 经链接指向禁读目录即拒", async () => {
  const { root, cleanup } = makeSearchTree(true);
  try {
    // 工作区就是家目录：~/.ssh 在工作区内；keys 是指向它的链接
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "foo key\n");
    symlinkSync(join(root, ".ssh"), join(root, "keys"), "junction");
    const host = createLocalWorkspaceHost(root, { homeDir: root });
    const grep = createGrepTool(host, { maxResults: 5, bundledRipgrep: true });
    const result = await grep.execute("tc", { pattern: "foo" });
    assert.equal(result.details.shown, 5);
    assert.ok(result.details.total > 5, String(result.details.total));
    assert.equal(result.details.deniedOmitted, 1);
    assert.doesNotMatch(text(result), /foo key/);
    const fewer = createGrepTool(host, { maxResults: 3, bundledRipgrep: true });
    const files = await fewer.execute("tc", { pattern: "foo", files_only: true });
    assert.deepEqual(
      [files.details.total, files.details.shown, files.details.deniedOmitted],
      [5, 3, 1]
    );
    const glob = createGlobTool(host, { maxResults: 2, bundledRipgrep: true });
    const listed = await glob.execute("tc", { pattern: "**/*" });
    assert.equal(listed.details.shown, 2);
    assert.ok(listed.details.total > 2, String(listed.details.total));
    assert.equal(listed.details.deniedOmitted, 1);
    await assert.rejects(grep.execute("tc", { pattern: "foo", path: "keys" }), ReadDeniedError);
  } finally {
    cleanup();
  }
});

test("文件名带冒号或换行：三种后端的结果归属准确，名字带换行的文件略去并计数，禁读的照样滤掉", {
  skip: process.platform === "win32" ? "Windows 的文件名不能含冒号与换行" : false,
}, async (t) => {
  const { root, cleanup } = makeSearchTree(true);
  try {
    // 工作区就是家目录：.ssh/id_rsa 禁读；b.txt:2:y 是指向它的链接，名字带"冒号数字冒号"
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "foo key\n");
    writeFileSync(join(root, "a.txt"), "foo safe\n");
    writeFileSync(join(root, "a.txt:1:x"), "foo colon\n");
    symlinkSync(join(root, ".ssh", "id_rsa"), join(root, "b.txt:2:y"));
    writeFileSync(join(root, "nl\nname.txt"), "foo newline\n");
    const host = createLocalWorkspaceHost(root, { homeDir: root });
    for (const only of ["rg", "git", "grep"] as const) {
      if ((await detectSearchBackend(host, { only, bundledRipgrep: true })) === undefined) {
        t.diagnostic(`本机没有 ${only}，这一种未测`);
        continue;
      }
      const grep = createGrepTool(host, { maxResults: 200, only, bundledRipgrep: true });
      const result = await grep.execute("tc", { pattern: "foo (safe|colon|key|newline)" });
      const lines = text(result).split("\n");
      assert.ok(lines.includes("a.txt:1:foo safe"), `${only}：${lines.join(" | ")}`);
      assert.ok(lines.includes("a.txt:1:x:1:foo colon"), `${only}：${lines.join(" | ")}`);
      assert.doesNotMatch(text(result), /foo (key|newline)/, only);
      assert.equal(result.details.total, 2, only);
      assert.equal(result.details.unsafeOmitted, 1, only);
      assert.equal(result.details.deniedOmitted, 1, only);
    }
  } finally {
    cleanup();
  }
});

test("rg 不读 .ignore（与 git 的口径一致）", async (t) => {
  const { root, cleanup } = makeSearchTree(true);
  try {
    writeFileSync(join(root, ".ignore"), "src/b.md\n");
    const host = createLocalWorkspaceHost(root, { homeDir: join(root, "no-home") });
    if ((await detectSearchBackend(host, { only: "rg", bundledRipgrep: true })) === undefined) {
      t.skip("本机没有随包的 ripgrep");
      return;
    }
    const grep = createGrepTool(host, { maxResults: 50, only: "rg", bundledRipgrep: true });
    assert.equal((await grep.execute("tc", { pattern: "foo in md" })).details.total, 1);
  } finally {
    cleanup();
  }
});

test("文件名模式：* 不跨目录，** 跨任意层，? 一个字符，[...] 与 {a,b}", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "src/deep/a.ts", true],
    ["src/**", "src/x/y.md", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["a?.ts", "ab.ts", true],
    ["a?.ts", "a/.ts", false],
    ["[ab].ts", "b.ts", true],
    ["[!ab].ts", "c.ts", true],
    ["{a,b}.md", "b.md", true],
    ["{a,b}.md", "c.md", false],
    ["a.ts", "aXts", false],
  ];
  for (const [pattern, target, expected] of cases) {
    assert.equal(globToRegExp(pattern).test(target), expected, `${pattern} ~ ${target}`);
  }
  // 写错的模式归给模型的错误
  assert.throws(() => globToRegExp("[z-a]"), GlobPatternError);
});
