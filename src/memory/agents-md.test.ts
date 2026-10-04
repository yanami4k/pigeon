// 人写的说明 AGENTS.md（决策 330）：用户级 ~/.pigeon/AGENTS.md 在前，项目级从仓库根到工作目录逐层自上而下拼接、不越过仓库根；
// 某层没有 AGENTS.md 而有 CLAUDE.md 时读 CLAUDE.md；不在 git 仓库里时只读工作目录本身这一层；合计 32 KiB 上限，超出截断并
// 在推送内容末尾与终端各提示一行；清单记每份的哈希、字节数、是否截断与是否放入。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENTS_MD_LIMIT_BYTES,
  loadAgentsInstructions,
  projectInstructionFiles,
  repoRootOf,
} from "./agents-md.ts";

function withDirs(body: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "pigeon-agents-md-"));
  try {
    body(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function put(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("逐层拼接：用户级在前，项目级自仓库根往下到工作目录；某层没有 AGENTS.md 读 CLAUDE.md，两者都有只读 AGENTS.md；仓库根之上的不读", () =>
  withDirs((base) => {
    const home = join(base, "home");
    const repo = join(base, "outer", "repo");
    const cwd = join(repo, "packages", "app");
    put(join(base, "outer", "AGENTS.md"), "仓库根之上\n");
    mkdirSync(join(repo, ".git"), { recursive: true });
    put(join(repo, "AGENTS.md"), "根\n");
    put(join(repo, "CLAUDE.md"), "根的 CLAUDE（不读）\n");
    put(join(repo, "packages", "CLAUDE.md"), "packages 的 CLAUDE\n");
    put(join(cwd, "AGENTS.md"), "app\n");
    put(join(home, ".pigeon", "AGENTS.md"), "用户\n");
    assert.equal(repoRootOf(cwd), repo);
    const loaded = loadAgentsInstructions({ workspaceRoot: cwd, homeDir: home });
    assert.equal(
      loaded.section,
      [
        "## 人写的说明（AGENTS.md）",
        "以下内容在会话开始时读取；会话中这些文件被改动时，改后的内容会整段追加。",
        "### ~/.pigeon/AGENTS.md\n用户",
        "### AGENTS.md\n根",
        "### packages/CLAUDE.md\npackages 的 CLAUDE",
        "### packages/app/AGENTS.md\napp",
      ].join("\n\n")
    );
    assert.deepEqual(loaded.manifest, [
      {
        path: "~/.pigeon/AGENTS.md",
        hash: sha("用户\n"),
        bytes: 7,
        truncated: false,
        included: true,
      },
      { path: "AGENTS.md", hash: sha("根\n"), bytes: 4, truncated: false, included: true },
      {
        path: "packages/CLAUDE.md",
        hash: sha("packages 的 CLAUDE\n"),
        bytes: Buffer.byteLength("packages 的 CLAUDE\n"),
        truncated: false,
        included: true,
      },
      {
        path: "packages/app/AGENTS.md",
        hash: sha("app\n"),
        bytes: 4,
        truncated: false,
        included: true,
      },
    ]);
    assert.equal(loaded.notice, undefined);
  }));

test("worker 工作树（.git 是文件）以工作树根为仓库根；不在 git 仓库里只读工作目录本身这一层", () =>
  withDirs((base) => {
    const tree = join(base, "repo", ".pigeon", "state", "worktrees", "w1");
    put(join(base, "repo", "AGENTS.md"), "主仓库\n");
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    put(join(tree, ".git"), "gitdir: ../../../.git/worktrees/w1\n");
    put(join(tree, "AGENTS.md"), "工作树里的\n");
    assert.deepEqual(
      projectInstructionFiles(tree).map((file) => file.display),
      ["AGENTS.md"]
    );
    assert.equal(projectInstructionFiles(tree)[0]?.absolute, join(tree, "AGENTS.md"));
    const plain = join(base, "plain", "sub");
    put(join(base, "plain", "AGENTS.md"), "上一层\n");
    put(join(plain, "CLAUDE.md"), "这一层\n");
    assert.equal(repoRootOf(plain), undefined);
    assert.deepEqual(
      projectInstructionFiles(plain).map((file) => file.display),
      ["CLAUDE.md"]
    );
  }));

test("合计 32 KiB 上限：跨过上限的那份只放入前面放得下的部分（不劈开字符），其后的不放入；推送内容末尾与终端各提示一行", () =>
  withDirs((base) => {
    assert.equal(AGENTS_MD_LIMIT_BYTES, 32 * 1024);
    const home = join(base, "home");
    const repo = join(base, "repo");
    const cwd = join(repo, "sub");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const user = "用户说明\n";
    put(join(home, ".pigeon", "AGENTS.md"), user);
    const big = "汉".repeat(12_000); // 36,000 字节
    put(join(repo, "AGENTS.md"), big);
    put(join(cwd, "AGENTS.md"), "子目录\n");
    const loaded = loadAgentsInstructions({ workspaceRoot: cwd, homeDir: home });
    const userBytes = Buffer.byteLength(user);
    // 剩下的字节里能放下的整字：每个汉字 3 字节
    const fit = Math.floor((AGENTS_MD_LIMIT_BYTES - userBytes) / 3);
    assert.ok(loaded.section.includes(`### AGENTS.md\n${"汉".repeat(fit)}\n\n`));
    assert.ok(!loaded.section.includes("汉".repeat(fit + 1)));
    assert.ok(!loaded.section.includes("子目录"));
    const overflow = `合计超出 32 KiB 上限，已截断：AGENTS.md 只放入前 ${fit * 3} 字节；sub/AGENTS.md 未放入`;
    assert.ok(
      loaded.section.endsWith(`（人写的说明${overflow}；需要时用 read_file 读取全文。）`),
      loaded.section.slice(-200)
    );
    assert.equal(loaded.notice, `[说明] AGENTS.md 等人写的说明${overflow}`);
    assert.deepEqual(
      loaded.manifest.map((entry) => [entry.path, entry.truncated, entry.included]),
      [
        ["~/.pigeon/AGENTS.md", false, true],
        ["AGENTS.md", true, true],
        ["sub/AGENTS.md", false, false],
      ]
    );
    // 恰好等于上限不截断
    const exact = loadAgentsInstructions({
      workspaceRoot: cwd,
      homeDir: join(base, "nohome"),
      limitBytes: Buffer.byteLength(big) + Buffer.byteLength("子目录\n"),
    });
    assert.equal(exact.notice, undefined);
    assert.ok(exact.section.includes("子目录"));
  }));

test("一份说明都没有：空段、空清单", () =>
  withDirs((base) => {
    const loaded = loadAgentsInstructions({
      workspaceRoot: join(base, "empty"),
      homeDir: join(base, "home"),
    });
    assert.deepEqual(loaded, { section: "", manifest: [] });
  }));
