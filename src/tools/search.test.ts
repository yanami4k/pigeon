// grep 与 glob（决策 368），本机执行端：三种后端结果一致（git 仓库里 rg 与 git grep，不在仓库里 rg 与 grep -r）；
// 遵守 .gitignore、跳过 .git、含隐藏文件；上限与总数提示；模式里的 shell 特殊字符原样交给后端、不被解释；
// 以 - 开头的模式与目录不被当成选项；家目录下的 .ssh 与其他文件一样搜到、列出（决策 412）。机器上没有的后端跳过。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CommandOutputStore } from "./command-output.ts";
import { createGlobTool } from "./glob.ts";
import { GlobPatternError, globToRegExp } from "./glob-match.ts";
import { createGrepTool, GREP_OUTPUT_BUDGET } from "./grep.ts";
import { createLocalWorkspaceHost } from "./local-host.ts";
import {
  detectSearchBackend,
  noneOmitted,
  SCREEN_LIMIT,
  type SearchBackendKind,
  screenFiles,
} from "./search-backend.ts";
import { makeSearchTree, searchOutputs } from "./search-fixtures.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

for (const git of [true, false]) {
  test(`三种后端结果一致（${git ? "git 仓库：rg 与 git grep" : "不在仓库：rg 与 grep -r"}），.gitignore 只在仓库里生效`, async (t) => {
    const { root, cleanup } = makeSearchTree(git);
    try {
      const host = createLocalWorkspaceHost(root);
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
      assert.match(all, /^\.hidden\/h\.ts\n1: foo hidden$/m);
      assert.match(all, /^-dash\/d\.ts\n1: foo dash$/m);
      // git 仓库的 .git 里放了含 foo 的文件（见夹具），搜不到
      assert.doesNotMatch(all, /\.git\/|in git dir/);
      assert.equal(/ignored\/x\.ts|x\.log/.test(all), !git, all);
      assert.equal(first?.grep[2], "src/a.ts\n1- alpha foo\n2: beta\n3- foo:bar");
      // shell 特殊字符原样当正则：命中那一行，且没有任何命令被执行
      assert.match(first?.grep[4] ?? "", /^src\/a\.ts\n5: x; echo hi > pwned;/m);
      for (const name of ["pwned", "pwned2", "pwned3"]) {
        assert.equal(existsSync(join(root, name)), false, name);
      }
      assert.match(first?.grep[5] ?? "", /^src\/a\.ts\n4: -v flag$/m);
      assert.equal(first?.grep[6], "-dash/d.ts\n1: foo dash");
      // glob：按修改时间从新到旧
      assert.equal(first?.glob[1], "src/b.md");
      assert.deepEqual(first?.glob[2]?.split("\n"), ["src/b.md", "src/a.ts"]);
    } finally {
      cleanup();
    }
  });
}

test("上限给出总数（grep、files_only、glob）；工作区就是家目录时 ~/.ssh 下的文件照常搜到、列出", async () => {
  const { root, cleanup } = makeSearchTree(true);
  // 家目录指到工作区（os.homedir() 在 Windows 上取 USERPROFILE，其余取 HOME）：~/.ssh 在工作区内
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "foo key\n");
    const host = createLocalWorkspaceHost(root);
    const grep = createGrepTool(host, { maxResults: 5, bundledRipgrep: true });
    const result = await grep.execute("tc", { pattern: "foo" });
    assert.equal(result.details.shown, 5);
    assert.ok(result.details.total > 5, String(result.details.total));
    const key = await grep.execute("tc", { pattern: "foo key", path: ".ssh" });
    assert.equal(text(key), ".ssh/id_rsa\n1: foo key");
    const fewer = createGrepTool(host, { maxResults: 3, bundledRipgrep: true });
    const files = await fewer.execute("tc", { pattern: "foo", files_only: true });
    assert.deepEqual([files.details.total, files.details.shown], [6, 3]);
    const glob = createGlobTool(host, { maxResults: 2, bundledRipgrep: true });
    const listed = await glob.execute("tc", { pattern: "**/*" });
    assert.equal(listed.details.shown, 2);
    assert.ok(listed.details.total > 2, String(listed.details.total));
    assert.equal(text(await glob.execute("tc", { pattern: "*", path: ".ssh" })), ".ssh/id_rsa");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanup();
  }
});

test.skipIf(process.platform === "win32" ? "Windows 的文件名不能含冒号与换行" : false)(
  "文件名带冒号或换行：三种后端的结果归属准确，名字带换行的文件略去并计数",
  async (t) => {
    const { root, cleanup } = makeSearchTree(true);
    try {
      writeFileSync(join(root, "a.txt"), "foo safe\n");
      writeFileSync(join(root, "a.txt:1:x"), "foo colon\n");
      writeFileSync(join(root, "nl\nname.txt"), "foo newline\n");
      // 换行名被按行切开时尾段会落到真实存在的 name.txt 名下
      writeFileSync(join(root, "name.txt"), "plain\n");
      const host = createLocalWorkspaceHost(root);
      for (const only of ["rg", "git", "grep"] as const) {
        if ((await detectSearchBackend(host, { only, bundledRipgrep: true })) === undefined) {
          await t.annotate(`本机没有 ${only}，这一种未测`);
          continue;
        }
        const grep = createGrepTool(host, { maxResults: 200, only, bundledRipgrep: true });
        const result = await grep.execute("tc", { pattern: "foo (safe|colon|newline)" });
        // 分组输出里路径独占一行：名字带"冒号数字冒号"也不会与行号混淆
        const all = text(result);
        assert.ok(all.includes("a.txt\n1: foo safe"), `${only}：${all}`);
        assert.ok(all.includes("a.txt:1:x\n1: foo colon"), `${only}：${all}`);
        assert.doesNotMatch(text(result), /foo newline/, only);
        assert.equal(result.details.total, 2, only);
        assert.equal(result.details.unsafeOmitted, 1, only);
      }
    } finally {
      cleanup();
    }
  }
);

test("内容结果按文件分组：每个文件只写一次路径，其下逐行「行号: 内容」，文件之间空一行；只列文件的输出照旧每行一个路径", async () => {
  const { root, cleanup } = makeSearchTree(false);
  try {
    const host = createLocalWorkspaceHost(root);
    const grep = createGrepTool(host, { maxResults: 200, bundledRipgrep: true });
    const groups = text(await grep.execute("tc", { pattern: "foo" })).split("\n\n");
    const paths = groups.map((group) => group.split("\n")[0]);
    assert.deepEqual(paths, [...new Set(paths)].sort());
    for (const group of groups) {
      for (const line of group.split("\n").slice(1)) assert.match(line, /^\d+: .*foo/);
    }
    assert.equal(groups.find((group) => group.startsWith("many.txt\n"))?.split("\n").length, 31);
    const listed = await grep.execute("tc", { pattern: "foo", files_only: true });
    assert.equal(text(listed), paths.join("\n"));
  } finally {
    cleanup();
  }
});

test("列出的部分超过字数预算：只放预算内的整行，写明总条数与文件数并提示先只列文件，全文（条数上限以内）存进落盘目录", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-grep-budget-")));
  const state = mkdtempSync(join(tmpdir(), "pigeon-grep-outputs-"));
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(root, name), `needle ${"x".repeat(90)}\n`.repeat(100));
    }
    const outputs = new CommandOutputStore({
      base: state,
      outputsRoot: join(state, "outputs"),
      sessionId: "s1",
      maxBytes: 1 << 20,
    });
    const host = createLocalWorkspaceHost(root);
    const grep = createGrepTool(host, { maxResults: 250, bundledRipgrep: true, outputs });
    const result = await grep.execute("tc", { pattern: "needle" });
    const out = text(result);
    const listing = out.slice(0, out.lastIndexOf("\n\n"));
    assert.ok(listing.length <= GREP_OUTPUT_BUDGET, String(listing.length));
    assert.deepEqual(
      [result.details.total, result.details.files, result.details.overBudget],
      [300, 3, true]
    );
    assert.ok(result.details.shown < 250, String(result.details.shown));
    assert.match(out, /300 条匹配、3 个文件/);
    assert.match(out, /files_only/);
    const uri = result.details.savedOutput?.uri ?? "";
    assert.ok(out.includes(uri) && uri !== "", out);
    const saved = (await outputs.readWindow(uri, 1, 10_000)).lines.join("\n");
    assert.ok(saved.startsWith(listing));
    assert.equal(saved.split("\n").filter((line) => /^\d+: needle/.test(line)).length, 250);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("rg 不读 .ignore（与 git 的口径一致）", async (t) => {
  const { root, cleanup } = makeSearchTree(true);
  try {
    writeFileSync(join(root, ".ignore"), "src/b.md\n");
    const host = createLocalWorkspaceHost(root);
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

test.skipIf(existsSync("/proc/self/fd") ? false : "没有 /proc，不复核")(
  "grep -r 降级：逐个搜时按已打开文件的真实路径复核，与筛选时不同的文件整份略去",
  async (t) => {
    const { root, cleanup } = makeSearchTree(false);
    try {
      const base = createLocalWorkspaceHost(root);
      if ((await detectSearchBackend(base, { only: "grep" })) === undefined) {
        t.skip("本机没有 grep");
        return;
      }
      const classify = base.classifyReadPaths;
      if (classify === undefined) throw new Error("本机执行端应能按真实路径分类");
      // 模拟筛选之后 src/b.md 被换掉：筛选时给出的真实路径与逐个搜时实际打开的不同
      const host: WorkspaceHost = {
        ...base,
        classifyReadPaths: async (relPaths, signal) => {
          const result = await classify.call(base, relPaths, signal);
          if (result.realPaths.has("src/b.md")) result.realPaths.set("src/b.md", "/elsewhere/b.md");
          return result;
        },
      };
      const grep = createGrepTool(host, { maxResults: 50, only: "grep" });
      const result = await grep.execute("tc", { pattern: "foo" });
      assert.doesNotMatch(text(result), /foo in md/);
      assert.equal(result.details.uncheckedOmitted, 1);
      assert.ok(result.details.total > 0);
    } finally {
      cleanup();
    }
  }
);

test("一次最多按真实路径检查 20,000 个文件：超出的不查、略去并计数；文件名含控制字符的另计", async () => {
  const sizes: number[] = [];
  const host = {
    classifyReadPaths: async (relPaths: readonly string[]) => {
      sizes.push(relPaths.length);
      return {
        classes: new Map(relPaths.map((rel) => [rel, "ok" as const])),
        realPaths: new Map(relPaths.map((rel) => [rel, `/w/${rel}`])),
        incomplete: false,
      };
    },
  } as unknown as WorkspaceHost;
  const omitted = noneOmitted();
  const names = Array.from({ length: SCREEN_LIMIT + 5 }, (_, index) => `f${index}`);
  const allowed = await screenFiles(host, [...names, "bad\nname"], omitted, undefined);
  assert.deepEqual(sizes, [SCREEN_LIMIT]);
  assert.equal(allowed.size, SCREEN_LIMIT);
  assert.deepEqual(omitted, { outside: 0, unsafe: 1, unchecked: 5 });
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
