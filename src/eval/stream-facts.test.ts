import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  collectStreamFacts,
  gitHumanRepo,
  manifestFromFacts,
  ReferenceWorkspace,
} from "./stream-facts.ts";
import type { RepoProfile, StreamFileKind } from "./stream-manifest.ts";
import type { StreamRepoRuntime } from "./stream-profiles.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 合成仓库的约定："测试"是 src/ 下的 *.test.sh（用 grep 断言源文件内容），"格式化"是把连续空格压成一个
const toyProfile: RepoProfile = {
  name: "toy",
  classifyFile(path): StreamFileKind {
    if (!path.startsWith("src/")) return "other";
    return path.endsWith(".test.sh") ? "test" : "source";
  },
  resetReason: (c) => (c.files.length > 5 ? "大提交" : null),
  gateCommand: ["true"],
};

const toyRuntime: StreamRepoRuntime = {
  profile: toyProfile,
  testCommand: (tests) => ["sh", "-c", 'for t; do sh "$t" || exit 1; done', "sh", ...tests],
  junitTestCommand: () => ["false"],
  junitRelativeBase: "",
  formatCommand: (files) => [
    "sh",
    "-c",
    'for f; do tr -s " " < "$f" > "$f.fmt" && mv "$f.fmt" "$f"; done',
    "sh",
    ...files,
  ],
  depsLinks: [],
  envSyncCommand: null,
};

function commitAll(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", message);
  return run(dir, "rev-parse", "HEAD");
}

test("取事实与出清单：题、红测试对、只有格式、维护步、套用在合成仓库上端到端判对，探针原始记录随附", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-facts-"));
  try {
    const dir = join(base, "human");
    mkdirSync(dir);
    run(dir, "init", "-q");
    run(dir, "config", "user.name", "human");
    run(dir, "config", "user.email", "human@example.invalid");
    run(dir, "config", "core.autocrlf", "false");
    const start = commitAll(dir, { "src/other.txt": "other\n", "README.md": "toy\n" }, "Start");
    const task = commitAll(
      dir,
      {
        "src/feat.txt": "feature  here\n",
        "src/feat.test.sh": 'grep -q "feature" src/feat.txt\n',
      },
      "Add feature\n\nWith a body"
    );
    const red = commitAll(
      dir,
      { "src/red.test.sh": 'grep -q "red" src/red.txt\n' },
      "Add red test"
    );
    const fix = commitAll(dir, { "src/red.txt": "red\n" }, "Make red pass");
    const fmt = commitAll(dir, { "src/feat.txt": "feature here\n" }, "Format feature");
    const maint = commitAll(dir, { "src/other.txt": "changed\n" }, "Rework other");
    const apply = commitAll(
      dir,
      { "src/feat.test.sh": 'grep -q "feature" src/feat.txt && true\n' },
      "Tweak test"
    );
    const docs = commitAll(dir, { "README.md": "toy docs\n" }, "Docs");

    const human = gitHumanRepo(dir);
    const refRoot = join(base, "ref");
    mkdirSync(refRoot);
    const reference = new ReferenceWorkspace(localStreamShell(refRoot));
    await reference.init(human.bundle(docs), docs);
    const facts = await collectStreamFacts({
      human,
      runtime: toyRuntime,
      reference,
      rangeStart: start,
      rangeEnd: docs,
      options: { testTimeoutMs: 30_000 },
    });

    const byShaFacts = new Map(facts.commits.map((c) => [c.sha, c]));
    assert.deepEqual(byShaFacts.get(task)?.probe, { parentFails: true, commitPasses: true });
    assert.deepEqual(byShaFacts.get(red)?.probe, { parentFails: true, commitPasses: false });
    assert.equal(byShaFacts.get(red)?.nextPasses, true);
    assert.equal(byShaFacts.get(fmt)?.formatOnly, true);
    assert.equal(byShaFacts.get(maint)?.formatOnly, false);
    assert.deepEqual(byShaFacts.get(apply)?.probe, { parentFails: false, commitPasses: true });
    assert.deepEqual(
      facts.probes.map((p) => [p.sha, p.kind, p.passed]),
      [
        [task, "parent", false],
        [task, "commit", true],
        [red, "parent", false],
        [red, "commit", false],
        [red, "next", true],
        [fmt, "format", true],
        [maint, "format", false],
        [apply, "parent", true],
        [apply, "commit", true],
      ]
    );

    const manifest = manifestFromFacts({ human, runtime: toyRuntime, rangeStart: start, facts });
    assert.deepEqual(
      manifest.steps.map((s) => [s.commit, s.kind]),
      [
        [task, "task"],
        [fix, "task"],
        [fmt, "skip"],
        [maint, "maintenance"],
        [apply, "apply"],
        [docs, "skip"],
      ]
    );
    assert.equal(manifest.rangeStart, start);
    assert.equal(
      manifest.steps[0]?.prompt,
      'Add feature\n\nWith a body\n\n--- src/feat.test.sh ---\ngrep -q "feature" src/feat.txt\n'
    );
    assert.deepEqual(manifest.steps[1]?.mergedCommits, [red, fix]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
