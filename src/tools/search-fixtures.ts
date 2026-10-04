// 测试夹具：grep 与 glob 各后端一致性用的文件树与查询（本机与真容器共用）。只供测试使用。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import type { SearchBackendKind } from "./search-backend.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

// 修改时间按这里的次序递增（glob 的排序因此确定）
export const SEARCH_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    "src/a.ts",
    "alpha foo\nbeta\nfoo:bar\n-v flag\nx; echo hi > pwned; `touch pwned2` $(touch pwned3)\n",
  ],
  ["src/b.md", "foo in md\n"],
  [".hidden/h.ts", "foo hidden\n"],
  ["-dash/d.ts", "foo dash\n"],
  ["ignored/x.ts", "foo ignored\n"],
  ["x.log", "foo log\n"],
  [".gitignore", "ignored/\n*.log\n"],
  ["many.txt", `${Array.from({ length: 30 }, (_, i) => `foo ${i}`).join("\n")}\n`],
];

export const GREP_QUERIES = [
  { pattern: "foo" },
  { pattern: "foo", glob: "*.ts" },
  { pattern: "BETA", ignore_case: true, context: 1 },
  { pattern: "foo", files_only: true },
  // shell 特殊字符：原样当正则，命中第 5 行，不执行任何命令
  { pattern: "echo hi > pwned; `touch pwned2` \\$\\(touch" },
  // 以 - 开头的模式与目录
  { pattern: "-v" },
  { pattern: "foo", path: "-dash" },
];

export const GLOB_QUERIES = [
  { pattern: "**/*.ts" },
  { pattern: "*.md", path: "src" },
  { pattern: "src/{a,b}.*" },
];

// 在本机临时目录建这棵树（git 为真时 git init）
export function makeSearchTree(git: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-search-")));
  SEARCH_FILES.forEach(([rel, content], index) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    utimesSync(full, 1_700_000_000 + index * 100, 1_700_000_000 + index * 100);
  });
  if (git) {
    execFileSync("git", ["init", "-q", root]);
    // .git 里放一个含 foo 的文件：搜索须跳过 .git
    writeFileSync(join(root, ".git", "pigeon-note.txt"), "foo in git dir\n");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 在容器里建同一棵树（参数成对给出路径与内容，不拼进脚本）；第 i 个文件的修改时间为 2023-01-01 00:i
export const CONTAINER_TREE_SCRIPT = [
  'cd "$1" || exit 1; shift; i=10',
  'while [ "$#" -gt 1 ]; do',
  '  mkdir -p "$(dirname "./$1")" && printf "%s" "$2" > "./$1" && touch -t "2023010100$i" "./$1" || exit 1',
  "  i=$((i + 1)); shift 2",
  "done",
].join("\n");

export function containerTreeArgs(root: string): string[] {
  return [root, ...SEARCH_FILES.flat()];
}

// 各查询的结果文本；降级时开头注明后端的那一行不参与比对
export async function searchOutputs(
  host: WorkspaceHost,
  only: SearchBackendKind,
  bundledRipgrep = false
) {
  const options = { maxResults: 200, only, bundledRipgrep };
  const grep = createGrepTool(host, options);
  const glob = createGlobTool(host, options);
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? "").join("");
  const grepOut: string[] = [];
  for (const query of GREP_QUERIES) {
    grepOut.push(
      text(await grep.execute("tc", query)).replace(/^本次用 .+ 搜索（扩展正则）\n?/, "")
    );
  }
  const globOut: string[] = [];
  for (const query of GLOB_QUERIES) globOut.push(text(await glob.execute("tc", query)));
  return { grep: grepOut, glob: globOut };
}
