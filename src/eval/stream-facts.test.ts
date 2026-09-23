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
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
