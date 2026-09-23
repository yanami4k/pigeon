import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectStreamFacts,
  gitHumanRepo,
  manifestFromFacts,
  ReferenceWorkspace,
} from "./stream-facts.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";

test("探针被杀（内存上限或超时，退出码 137）记为环境错误：不算父败或本败、不再做后续探针、清单单列且待定处理", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-facts-env-"));
  try {
    const dir = join(base, "human");
    const commitAll = toyRepo(dir);
    const start = commitAll({ "src/base.txt": "base\n" }, "Start");
    // 父提交上没有 fix.txt 时，这个测试以 137 退出（模拟容器内存超限被杀）
    const runaway = commitAll(
      {
        "src/fix.txt": "fixed\n",
        "src/fix.test.sh": "[ -f src/fix.txt ] || exit 137\n",
      },
      "Fix runaway"
    );
    const human = gitHumanRepo(dir);
    const refRoot = join(base, "ref");
    mkdirSync(refRoot);
    const reference = new ReferenceWorkspace(localStreamShell(refRoot));
    await reference.init(human.bundle(runaway), runaway);
    const facts = await collectStreamFacts({
      human,
      runtime: toyRuntime,
      reference,
      rangeStart: start,
      rangeEnd: runaway,
      options: { testTimeoutMs: 30_000 },
    });
    const c = facts.commits[0];
    assert.equal(c?.probe, undefined, "不记父败或本败");
    assert.match(c?.environmentError ?? "", /父提交探针被杀（退出码 137）/);
    assert.equal(c?.formatOnly, undefined, "不再做后续探针");
    assert.deepEqual(
      facts.probes.map((p) => [p.kind, p.environmentError]),
      [["parent", true]]
    );
    assert.throws(
      () => manifestFromFacts({ human, runtime: toyRuntime, rangeStart: start, facts }),
      /探针环境错误.*待定/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("取事实与出清单：题、红测试对、只有格式、维护步、套用在合成仓库上端到端判对，探针原始记录随附", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-facts-"));
  try {
    const dir = join(base, "human");
    const commitAll = toyRepo(dir);
    const start = commitAll({ "src/other.txt": "other\n", "README.md": "toy\n" }, "Start");
    const task = commitAll(
      {
        "src/feat.txt": "feature  here\n",
        "src/feat.test.sh": 'grep -q "feature" src/feat.txt\n',
      },
      "Add feature\n\nWith a body"
    );
    const red = commitAll({ "src/red.test.sh": 'grep -q "red" src/red.txt\n' }, "Add red test");
    const fix = commitAll({ "src/red.txt": "red\n" }, "Make red pass");
    const fmt = commitAll({ "src/feat.txt": "feature here\n" }, "Format feature");
    const maint = commitAll({ "src/other.txt": "changed\n" }, "Rework other");
    const apply = commitAll(
      { "src/feat.test.sh": 'grep -q "feature" src/feat.txt && true\n' },
      "Tweak test"
    );
    const docs = commitAll({ "README.md": "toy docs\n" }, "Docs");

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

    // 断点续测：有断点文件时，已测的提交直接取回，不再动参考工作区
    const checkpoint = join(base, "facts.jsonl");
    const first = await collectStreamFacts({
      human,
      runtime: toyRuntime,
      reference,
      rangeStart: start,
      rangeEnd: docs,
      options: { testTimeoutMs: 30_000, checkpointFile: checkpoint },
    });
    const untouchable = new ReferenceWorkspace({
      root: refRoot,
      sh: () => Promise.reject(new Error("已测的提交不该再动参考工作区")),
    });
    const again = await collectStreamFacts({
      human,
      runtime: toyRuntime,
      reference: untouchable,
      rangeStart: start,
      rangeEnd: docs,
      options: { testTimeoutMs: 30_000, checkpointFile: checkpoint },
    });
    assert.deepEqual(again.commits, first.commits);
    assert.deepEqual(again.probes, first.probes);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
