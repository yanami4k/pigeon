import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildTaskPrompt,
  type CommitFacts,
  type CommitFileChange,
  composeStreamManifest,
  countStepKinds,
  type RepoProfile,
  stepsOf,
  type TestProbe,
} from "./stream-manifest.ts";
import {
  classifyPigeonFile,
  classifyStrandsFile,
  gateFromSteps,
  PIGEON_VERIFY_STEPS,
  pigeonProfile,
  strandsProfile,
} from "./stream-profiles.ts";

// ---------- 回归检查：本仓库的已知测量（2026-09-22 产率测量，141） ----------

interface FixtureRow {
  sha: string;
  parent: string;
  message: string;
  files: string[];
  measured?: string;
  formatOnly?: boolean;
}

const fixture = JSON.parse(
  readFileSync(new URL("./stream-fixtures/pigeon-range.json", import.meta.url), "utf8")
) as {
  rangeStart: string;
  rangeEnd: string;
  commits: FixtureRow[];
};

// 产率测量的判定 → 判题探针
const MEASURED_PROBES: Record<string, TestProbe> = {
  成题: { parentFails: true, commitPasses: true },
  "父提交上测试已通过（纯重构或补测试）": { parentFails: false, commitPasses: true },
  父提交失败但标准答案也不过: { parentFails: true, commitPasses: false },
};
// 全仓唯一的红测试对（127）：5b3f7f4 的测试在 cec5abe 上通过
const RED_PAIR_HEAD = "5b3f7f4";
const RED_PAIR_FIX = "cec5abe";
const LAYERED_MOVE = "5f14d63";

function fixtureFacts(): CommitFacts[] {
  return fixture.commits.map((row) => {
    const files: CommitFileChange[] = row.files.map((s) => {
      const [status, added, deleted, path] = s.split("\t") as [string, string, string, string];
      return {
        status: status as CommitFileChange["status"],
        added: Number(added),
        deleted: Number(deleted),
        path,
      };
    });
    const facts: CommitFacts = {
      sha: row.sha,
      parent: row.parent,
      subject: row.message.split("\n")[0] ?? "",
      message: row.message,
      files,
    };
    const probe = row.measured === undefined ? undefined : MEASURED_PROBES[row.measured];
    if (probe !== undefined) facts.probe = probe;
    if (row.sha.startsWith(RED_PAIR_HEAD)) facts.nextPasses = true;
    if (row.formatOnly !== undefined) facts.formatOnly = row.formatOnly;
    return facts;
  });
}

function composeFixture() {
  return composeStreamManifest({
    profile: pigeonProfile,
    rangeStart: fixture.rangeStart,
    commits: fixtureFacts(),
    readHumanFile: (sha, path) => `// ${sha.slice(0, 7)}:${path}\n`,
  });
}

// 已知测量为 53 与 17；d5d7144 只改一个测试文件与测试辅助文件 src/tui/testing.ts，产率测量没有测试辅助文件的归类，
// 按 141 ① 为套用，故第二条流按规则为 16 题
const HELPER_ONLY = "d5d7144";

test("出题回归：本仓库两条流单提交成题 53 与 16（测量 17 减去只改测试辅助的 1 次），红测试对另计 1 题，分界为分层目录搬迁", () => {
  const manifest = composeFixture();
  assert.equal(manifest.streams.length, 2);
  const [s1, s2] = manifest.streams;
  assert.equal(s1?.startCommit, fixture.rangeStart);
  assert.ok(s2?.startCommit.startsWith(LAYERED_MOVE));
  const single = (id: string) =>
    stepsOf(manifest, id).filter((s) => s.kind === "task" && s.mergedCommits === undefined);
  const merged = (id: string) => stepsOf(manifest, id).filter((s) => s.mergedCommits !== undefined);
  assert.equal(single("s1").length, 53);
  assert.equal(single("s2").length, 16);
  assert.equal(merged("s1").length, 1);
  assert.equal(merged("s2").length, 0);
  // 与产率测量逐条对齐：单提交成题恰为测量里的"成题"且未逾 20 个文件者，只差只改测试辅助的那一次
  const measuredTasks = fixture.commits
    .filter((r) => r.measured === "成题" && r.files.length <= 20 && !r.sha.startsWith(HELPER_ONLY))
    .map((r) => r.sha);
  assert.equal(measuredTasks.length, 53 + 16);
  assert.equal(manifest.steps.find((s) => s.commit.startsWith(HELPER_ONLY))?.kind, "apply");
  const composedTasks = manifest.steps
    .filter((s) => s.kind === "task" && s.mergedCommits === undefined)
    .map((s) => s.commit);
  assert.deepEqual(composedTasks, measuredTasks);
});

test("出题回归：本仓库类型分布与逐步定性", () => {
  const manifest = composeFixture();
  assert.deepEqual(countStepKinds(manifest.steps), {
    task: 70,
    maintenance: 10,
    apply: 10,
    skip: 1,
    reset: 1,
  });
  // 93 个提交，红测试对合并后少一步
  assert.equal(manifest.steps.length, fixture.commits.length - 1);
  const kindOf = (prefix: string) => manifest.steps.find((s) => s.commit.startsWith(prefix))?.kind;
  assert.equal(kindOf(LAYERED_MOVE), "reset");
  assert.equal(kindOf("57dc322"), "skip"); // 只有格式变化
  assert.equal(kindOf("476d226"), "apply"); // 只改依赖清单
  assert.equal(kindOf("d683541"), "apply"); // 只加 .gitattributes
  assert.equal(kindOf("f2da3cd"), "apply"); // 只改测试用假模型
  assert.equal(kindOf("4658cb5"), "apply"); // 只改测试
  assert.equal(kindOf("0b73632"), "maintenance"); // 改源代码不带测试
  assert.equal(kindOf("7a43f25"), "maintenance"); // 带测试但父提交上已通过
  const pair = manifest.steps.find((s) => s.mergedCommits !== undefined);
  assert.ok(pair?.mergedCommits?.[0]?.startsWith(RED_PAIR_HEAD));
  assert.ok(pair?.commit.startsWith(RED_PAIR_FIX));
});

// ---------- 规则单测：合成事实 ----------

function change(
  path: string,
  status: CommitFileChange["status"] = "M",
  added = 1,
  deleted = 0
): CommitFileChange {
  return { path, status, added, deleted };
}

function commit(
  sha: string,
  files: CommitFileChange[],
  extra: Partial<CommitFacts> = {}
): CommitFacts {
  return {
    sha,
    parent: `${sha}-p`,
    subject: `subject ${sha}`,
    message: `subject ${sha}\n\nbody ${sha}`,
    files,
    ...extra,
  };
}

const read = (sha: string, path: string) => `content of ${path} at ${sha}`;

function compose(commits: CommitFacts[], profile: RepoProfile = pigeonProfile) {
  return composeStreamManifest({ profile, rangeStart: "base", commits, readHumanFile: read });
}

const PASS: TestProbe = { parentFails: true, commitPasses: true };
// 只改测试的提交：父提交加上这些测试即本提交，测试照样通过
const GREEN: TestProbe = { parentFails: false, commitPasses: true };

test("题：题面为提交信息原文加测试文件全文；判题集为本步新增或修改的测试，删除的测试记为删除", () => {
  const m = compose([
    commit(
      "c1",
      [
        change("src/a.ts"),
        change("src/a.test.ts", "A"),
        change("src/old.test.ts", "D"),
        change("src/pi-runtime/fixtures.ts"),
      ],
      { probe: PASS }
    ),
  ]);
  const step = m.steps[0];
  assert.equal(step?.kind, "task");
  assert.deepEqual(step?.judgeTests, ["src/a.test.ts"]);
  assert.equal(
    step?.prompt,
    "src/a.test.ts\n\nsubject c1\n\nbody c1\n\n--- src/a.test.ts ---\ncontent of src/a.test.ts at c1\n"
  );
  assert.deepEqual(step?.humanFiles, [
    { path: "src/a.test.ts", op: "write", kind: "test" },
    { path: "src/old.test.ts", op: "delete", kind: "test" },
    { path: "src/pi-runtime/fixtures.ts", op: "write", kind: "testaux" },
  ]);
});

test("题的条件缺一不可：父提交上已通过或本提交上也不过，都不成题", () => {
  const m = compose([
    commit("c1", [change("src/a.ts"), change("src/a.test.ts")], {
      probe: { parentFails: false, commitPasses: true },
      formatOnly: false,
    }),
    commit("c2", [change("src/b.ts"), change("src/b.test.ts")], {
      probe: { parentFails: true, commitPasses: false },
      formatOnly: false,
    }),
  ]);
  assert.deepEqual(
    m.steps.map((s) => s.kind),
    ["maintenance", "maintenance"]
  );
  assert.equal(m.steps[0]?.prompt, "subject c1\n\nbody c1\n");
  assert.deepEqual(m.steps[0]?.judgeTests, []);
});

test("红测试对：先红后修的相邻提交合为一题，父提交取先者的父、题面含两段提交信息、测试取并集", () => {
  const m = compose([
    commit("red", [change("src/x.test.ts", "A")], {
      probe: { parentFails: true, commitPasses: false },
      nextPasses: true,
    }),
    commit("fix", [change("src/x.ts"), change("src/y.test.ts", "A")]),
    commit("after", [change("src/z.ts")], { formatOnly: false }),
  ]);
  assert.equal(m.steps.length, 2);
  const pair = m.steps[0];
  assert.equal(pair?.kind, "task");
  assert.deepEqual(pair?.mergedCommits, ["red", "fix"]);
  assert.equal(pair?.commit, "fix");
  assert.equal(pair?.parent, "red-p");
  assert.deepEqual(pair?.judgeTests, ["src/x.test.ts", "src/y.test.ts"]);
  assert.ok(
    pair?.prompt?.startsWith(
      "src/x.test.ts\nsrc/y.test.ts\n\nsubject red\n\nbody red\n\nsubject fix\n\nbody fix\n\n--- src/x.test.ts ---"
    )
  );
  assert.equal(m.steps[1]?.seq, 2);
});

test("红测试对不跨重置点：下一个提交是重置点时不合并", () => {
  const big = Array.from({ length: 21 }, (_, i) => change(`src/f${i}.ts`));
  const m = compose([
    commit("red", [change("src/x.ts"), change("src/x.test.ts", "A")], {
      probe: { parentFails: true, commitPasses: false },
      nextPasses: true,
      formatOnly: false,
    }),
    commit("move", big),
  ]);
  assert.deepEqual(
    m.steps.map((s) => s.kind),
    ["maintenance", "reset"]
  );
});

test("非题提交：只改测试或环境文件为套用，只有格式变化为跳过，不碰被测代码为跳过", () => {
  const m = compose([
    commit("t", [change("src/a.test.ts")], { probe: GREEN }),
    commit("env", [change("package.json"), change("package-lock.json")]),
    commit("fmt", [change("src/a.ts")], { formatOnly: true }),
    commit("docs", [change("docs/x.md"), change("README.md")]),
  ]);
  assert.deepEqual(
    m.steps.map((s) => s.kind),
    ["apply", "apply", "skip", "skip"]
  );
  assert.deepEqual(m.steps[1]?.humanFiles, [
    { path: "package.json", op: "write", kind: "env" },
    { path: "package-lock.json", op: "write", kind: "env" },
  ]);
});

test("缺探针或缺格式化比对即报错，不默认定性；只改测试的提交同样要探针（红测试对要靠它认出）", () => {
  assert.throws(
    () => compose([commit("c1", [change("src/a.ts"), change("src/a.test.ts")])]),
    /缺判题探针/
  );
  assert.throws(() => compose([commit("t1", [change("src/a.test.ts")])]), /缺判题探针/);
  assert.throws(() => compose([commit("c1", [change("src/a.ts")])]), /缺格式化比对/);
});

test("重置点切流：重置步的提交为下一条流的起点，重置步不属于任何流", () => {
  const big = Array.from({ length: 21 }, (_, i) => change(`docs/f${i}.md`));
  const m = compose([
    commit("a", [change("src/a.test.ts")], { probe: GREEN }),
    commit("move", big),
    commit("b", [change("src/b.test.ts")], { probe: GREEN }),
    commit("c", [change("src/c.test.ts")], { probe: GREEN }),
  ]);
  assert.deepEqual(m.streams, [
    { id: "s1", startCommit: "base", firstSeq: 1, lastSeq: 1 },
    { id: "s2", startCommit: "move", firstSeq: 3, lastSeq: 4 },
  ]);
  assert.equal(m.rangeEnd, "c");
  assert.deepEqual(m.gateCommand, gateFromSteps(PIGEON_VERIFY_STEPS));
});

test("本仓库文件归类：测试、测试辅助、机检配置随源代码、环境文件、其余", () => {
  assert.equal(classifyPigeonFile("src/eval/runner.test.ts"), "test");
  assert.equal(classifyPigeonFile("src/pi-runtime/fixtures.ts"), "testaux");
  assert.equal(classifyPigeonFile("src/application/history-fixtures.ts"), "testaux");
  assert.equal(classifyPigeonFile("src/tui/testing.ts"), "testaux");
  assert.equal(classifyPigeonFile("src/tui/testing-shell.ts"), "source");
  assert.equal(classifyPigeonFile("src/eval/runner.ts"), "source");
  assert.equal(classifyPigeonFile(".dependency-cruiser.js"), "source");
  assert.equal(classifyPigeonFile("tsconfig.json"), "source");
  assert.equal(classifyPigeonFile("package-lock.json"), "env");
  assert.equal(classifyPigeonFile(".gitattributes"), "env");
  assert.equal(classifyPigeonFile("docs/roadmap/decisions.md"), "other");
  assert.equal(classifyPigeonFile("spikes/key-failover.mjs"), "other");
});

test("本仓库重置点：按全部文件计，逾 20 个才重置", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => change(`docs/f${i}.md`));
  assert.equal(pigeonProfile.resetReason(commit("a", files(20))), null);
  assert.match(pigeonProfile.resetReason(commit("a", files(21))) ?? "", /21 个文件/);
});

test("strands 文件归类：只看 strands-py，集成测试不参与", () => {
  assert.equal(classifyStrandsFile("strands-py/src/strands/agent/agent.py"), "source");
  assert.equal(classifyStrandsFile("strands-py/src/strands/py.typed"), "other");
  assert.equal(classifyStrandsFile("strands-py/tests/strands/agent/test_agent.py"), "test");
  assert.equal(classifyStrandsFile("strands-py/tests/strands/agent/conftest.py"), "testaux");
  assert.equal(
    classifyStrandsFile("strands-py/tests/fixtures/mocked_model_provider.py"),
    "testaux"
  );
  assert.equal(classifyStrandsFile("strands-py/tests_typing/test_hooks.py"), "testaux");
  assert.equal(classifyStrandsFile("strands-py/tests_integ/test_mcp.py"), "other");
  assert.equal(classifyStrandsFile("strands-py/pyproject.toml"), "env");
  assert.equal(classifyStrandsFile("strands-ts/src/agent.ts"), "other");
  assert.equal(classifyStrandsFile("harness-py/src/harness/x.py"), "other");
});

test("strands 重置点：源代码逾 3,000 行重置；逾 20 个文件只数源文件", () => {
  const src = (n: number, lines: number) =>
    Array.from({ length: n }, (_, i) => change(`strands-py/src/strands/m${i}.py`, "M", lines, 0));
  const other = (n: number) => Array.from({ length: n }, (_, i) => change(`site/p${i}.md`));
  assert.equal(strandsProfile.resetReason(commit("a", [...src(3, 1000)])), null);
  assert.match(strandsProfile.resetReason(commit("a", [...src(3, 1001)])) ?? "", /3003 行/);
  // 40 个文件、其中 3 个源文件：不重置
  assert.equal(strandsProfile.resetReason(commit("a", [...src(3, 10), ...other(37)])), null);
  assert.match(strandsProfile.resetReason(commit("a", src(21, 1))) ?? "", /21 个源文件/);
});

test("strands 不碰被测包的提交跳过，只改 strands-py 测试的提交套用", () => {
  const m = compose(
    [
      commit("site", [change("site/index.md"), change("strands-ts/src/a.ts")]),
      commit("t", [change("strands-py/tests/strands/test_a.py")], { probe: GREEN }),
    ],
    strandsProfile
  );
  assert.deepEqual(
    m.steps.map((s) => s.kind),
    ["skip", "apply"]
  );
});

test("题面生成：开头每行一个测试文件路径（全文被截断时路径仍在），再接提交信息与各测试全文；无测试文件时只有提交信息", () => {
  assert.equal(buildTaskPrompt("msg\n\n", []), "msg\n");
  assert.equal(
    buildTaskPrompt("msg", [
      { path: "src/a.test.ts", content: "x\n\n" },
      { path: "src/b.test.ts", content: "y" },
    ]),
    "src/a.test.ts\nsrc/b.test.ts\n\nmsg\n\n--- src/a.test.ts ---\nx\n\n--- src/b.test.ts ---\ny\n"
  );
});
