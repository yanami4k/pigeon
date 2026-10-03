// grep 与 glob（决策 368），本机执行端：三种后端结果一致（git 仓库里 rg 与 git grep，不在仓库里 rg 与 grep -r）；
// 遵守 .gitignore、跳过 .git、含隐藏文件；上限与总数提示；模式里的 shell 特殊字符原样交给后端、不被解释；
// 以 - 开头的模式与目录不被当成选项；禁读名单的路径从结果里滤掉并注明条数。机器上没有的后端跳过。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createGlobTool } from "./glob.ts";
import { globToRegExp } from "./glob-match.ts";
import { createGrepTool } from "./grep.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
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
      assert.doesNotMatch(all, /\.git\//);
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

test("上限：超出给出总数并提示缩小范围；files_only 与 glob 同样；禁读名单的路径滤掉并注明条数", async () => {
  const { root, cleanup } = makeSearchTree(true);
  try {
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "foo key\n");
    // 工作区就是家目录：~/.ssh 在工作区内
    const host = createLocalWorkspaceHost(root, { homeDir: root });
    const grep = createGrepTool(host, { maxResults: 5, bundledRipgrep: true });
    const result = await grep.execute("tc", { pattern: "foo" });
    const lines = text(result).split("\n");
    assert.equal(lines.filter((line) => /:\d+:/.test(line)).length, 5);
    assert.ok(result.details.total > 5);
    assert.ok(
      lines.includes(
        `共 ${result.details.total} 条匹配，只列出前 5 条；请缩小范围（更具体的 pattern、path 或 glob）`
      )
    );
    assert.ok(lines.includes("已按禁读名单略去 1 条"));
    assert.ok(!lines.some((line) => line.includes(".ssh")));
    const fewer = createGrepTool(host, { maxResults: 3, bundledRipgrep: true });
    const files = text(await fewer.execute("tc", { pattern: "foo", files_only: true }));
    assert.match(files, /共 5 个文件，只列出前 3 个/);
    const glob = createGlobTool(host, { maxResults: 2, bundledRipgrep: true });
    const listed = text(await glob.execute("tc", { pattern: "**/*" }));
    assert.match(listed, /共 \d+ 个文件，只列出前 2 个；请缩小范围/);
    assert.match(listed, /已按禁读名单略去 1 条/);
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
});
