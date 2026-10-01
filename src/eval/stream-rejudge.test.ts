import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { judgeStep, type StepJudging } from "./stream-classes.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { composeStreamManifest, type StreamManifest } from "./stream-manifest.ts";
import {
  applySavedDiff,
  compareJudging,
  REJUDGE_CASES_FILE,
  REJUDGE_DIR,
  type RejudgeLine,
  rowsToRejudge,
  runRejudge,
} from "./stream-rejudge.ts";
import { readStreamResults, type StreamResultLine, ZERO_USAGE } from "./stream-results.ts";
import {
  ReferenceCases,
  runStreams,
  type StepAgent,
  type StreamEnvFactory,
} from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { git, localStreamEnvs, toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";

const NEEDS_A = `[ -f src/a.txt ] || { echo "Cannot find module 'src/a.txt'"; exit 1; }\n`;

interface Toy {
  base: string;
  human: HumanRepo;
  manifest: StreamManifest;
  reference: ReferenceCases;
}

// 人的历史：起点 → 题 A（新建 a 与两条依赖 a 的测试，并把 base 测试改成也依赖 a）→ 题 B（依赖 a 与 b）
async function toy(): Promise<Toy> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-rejudge-"));
  const dir = join(base, "human");
  const commit = toyRepo(dir);
  const start = commit(
    {
      "src/base.txt": "base\n",
      "src/base.test.sh": "grep -q base src/base.txt\n",
      "src/keep.test.sh": "true\n",
    },
    "Start"
  );
  const c1 = commit(
    {
      "src/a.txt": "alpha\ngamma\n",
      "src/a.test.sh": `${NEEDS_A}grep -q alpha src/a.txt\n`,
      "src/a2.test.sh": `${NEEDS_A}grep -q gamma src/a.txt\n`,
      "src/base.test.sh": "grep -q base src/base.txt && [ -f src/a.txt ]\n",
    },
    "Add alpha\n\nCreate src/a.txt"
  );
  const c2 = commit(
    { "src/b.txt": "beta\n", "src/b.test.sh": `${NEEDS_A}grep -q beta src/b.txt\n` },
    "Add beta"
  );
  const human = gitHumanRepo(dir);
  const facts = human.firstParentLog(start, c2).map((c) => ({
    sha: c.sha,
    parent: c.parent,
    subject: c.message.split("\n")[0] ?? "",
    message: c.message,
    files: human.changes(c.parent, c.sha),
  }));
  const probes: Record<string, object> = {
    [c1]: { probe: { parentFails: true, commitPasses: true } },
    [c2]: { probe: { parentFails: true, commitPasses: true } },
  };
  const manifest = composeStreamManifest({
    profile: toyRuntime.profile,
    rangeStart: start,
    commits: facts.map((f) => ({ ...f, ...(probes[f.sha] ?? {}) })),
    readHumanFile: (sha, path) => human.show(sha, path).toString("utf8"),
  });
  const refRoot = join(base, "ref");
  mkdirSync(refRoot);
  const referenceWs = new ReferenceWorkspace(localStreamShell(refRoot));
  await referenceWs.init(human.bundle(c2), c2);
  const reference = new ReferenceCases({
    reference: referenceWs,
    runtime: toyRuntime,
    human,
    cacheDir: join(base, "reference-cache"),
    image: "test-image",
  });
  return { base, human, manifest, reference };
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// 假 agent：第 1 题只做对一半（a2 要的 gamma 没写），还篡改旧测试、自建测试、自己提交；第 2 题（条件 neither 第 2 遍）
// 做对，另一遍删掉 base.txt 把不许挂的弄坏
function agentFor(): StepAgent {
  return {
    async run(input) {
      const root = input.target.root;
      if (input.step.seq === 1) {
        write(root, {
          "src/a.txt": "alpha\n",
          "src/keep.test.sh": "exit 1\n",
          "src/agent.test.sh": "true\n",
          "notes/bin.dat": "\u0000\u0001binary\n",
        });
        git(root, "add", "-A");
        git(root, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-q", "-m", "wip");
      }
      if (input.step.seq === 2) {
        write(root, { "src/b.txt": "beta\n" });
        if (input.job.attempt === 1) rmSync(join(root, "src", "base.txt"));
      }
      return {
        status: "completed",
        turns: 1,
        usage: { ...ZERO_USAGE },
        wallMs: 1,
        repair: null,
      };
    },
  };
}

function envsOf(t: Toy, name: string): StreamEnvFactory {
  return localStreamEnvs(join(t.base, name), (c: string) => t.human.bundle(c));
}

async function formalRun(t: Toy): Promise<string> {
  const outDir = join(t.base, "out");
  await runStreams({
    manifest: t.manifest,
    runtime: toyRuntime,
    human: t.human,
    envs: envsOf(t, "envs"),
    agents: { pigeon: agentFor() },
    reference: t.reference,
    outDir,
    conditions: ["neither"],
    attempts: 2,
    harnessRef: { commit: "test", dirty: false },
  });
  return outDir;
}

function rejudgeOptions(t: Toy, outDir: string, envs: StreamEnvFactory) {
  return {
    runtime: toyRuntime,
    human: t.human,
    manifest: t.manifest,
    envs,
    classesOf: (s: Parameters<ReferenceCases["cachedClasses"]>[0]) => t.reference.cachedClasses(s),
    outDir,
    image: "test-image",
    harness: "test",
  };
}

function judging(overrides: Partial<StepJudging> = {}): StepJudging {
  return {
    failToPass: { passed: 1, total: 2 },
    score: 0.5,
    passToPass: { failed: 0, total: 3 },
    solved: false,
    failedCases: { failToPass: ["f::x"], passToPass: [] },
    excludedFlaky: 0,
    ...overrides,
  };
}

describe("重判：一致性核对", () => {
  test("逐项一致即无差异；任一计数或失败用例不同都列出", () => {
    assert.deepEqual(compareJudging(judging(), judging()), []);
    const diff = compareJudging(
      judging(),
      judging({ failToPass: { passed: 2, total: 2 }, score: 1, solved: true })
    );
    assert.deepEqual(
      diff.map((d) => d.split("：")[0]),
      ["要做到的通过数", "得分", "做成"]
    );
    assert.deepEqual(
      compareJudging(
        judging(),
        judging({ failedCases: { failToPass: ["f::y"], passToPass: [] } })
      ).map((d) => d.split("：")[0]),
      ["要做到的失败用例"]
    );
  });

  test("失败用例全记不截断（327）；旧结果行带截断标记（327 起不再写）时只比它记下的前缀", () => {
    const ids = Array.from({ length: 23 }, (_, k) => `f::${String(k).padStart(3, "0")}`);
    const classes = { failToPass: ids, passToPass: [] as string[], excludedFlaky: [] as string[] };
    const full = judgeStep(classes, []);
    assert.equal(full.failedCases.failToPass.length, ids.length, "全记不截断");
    // 旧结果行：只记前 20 条并带 truncated 标记——重判的全集与它记下的前缀一致即无差异
    const original = judging({
      failToPass: { passed: 0, total: ids.length },
      score: 0,
      passToPass: { failed: 0, total: 0 },
      solved: false,
      failedCases: {
        failToPass: ids.slice(0, 20),
        passToPass: [],
        truncated: true,
      } as StepJudging["failedCases"],
    });
    assert.deepEqual(compareJudging(original, full), []);
    // 原行没截断而重判失败的更多：全长逐项比，计数先比出差异
    const fewer = judgeStep(
      classes,
      ids.slice(0, 5).map((id) => ({ id, file: "f", outcome: "passed" as const }))
    );
    assert.ok(compareJudging(fewer, full).some((d) => d.startsWith("要做到的通过数")));
  });

  test("要重判的行：判过分的题步，同一条件、遍、步取最后一行，可按步序筛", () => {
    const row = (seq: number, attempt: number, extra: Partial<StreamResultLine> = {}) =>
      ({
        kind: "task",
        condition: "neither",
        attempt,
        seq,
        judged: true,
        judging: judging(),
        diff: `d${seq}`,
        ...extra,
      }) as StreamResultLine;
    const rows = [
      row(1, 1, { diff: "old" }),
      row(1, 1),
      row(2, 1, { judged: false, judging: null }),
      row(3, 2),
    ];
    assert.deepEqual(
      rowsToRejudge(rows).map((r) => [r.seq, r.attempt, r.diff]),
      [
        [1, 1, "d1"],
        [3, 2, "d3"],
      ]
    );
    assert.deepEqual(
      rowsToRejudge(rows, [3]).map((r) => r.seq),
      [3]
    );
  });
});

describe("重判：与正式跑同一判题路径（假 agent、本地假容器）", { concurrency: true }, () => {
  test("起点加保存的改动加人写测试：每行重判与原结果行逐项一致，逐用例结果完整；原结果文件一字不改；重跑即续做", async () => {
    const t = await toy();
    try {
      const outDir = await formalRun(t);
      const resultsFile = join(outDir, "results.jsonl");
      const before = readFileSync(resultsFile);
      const rows = readStreamResults(resultsFile).filter((r) => r.kind === "task");
      assert.equal(rows.length, 4);
      // 合成数据要覆盖到：要做到的部分失败、不许挂的失败（篡改的旧测试被恢复后应通过，删掉 base.txt 的一遍应失败）
      assert.ok(
        rows.some(
          (r) =>
            r.judging?.score !== null && (r.judging?.score ?? 0) > 0 && (r.judging?.score ?? 1) < 1
        )
      );
      assert.ok(rows.some((r) => r.judging !== null && r.judging.passToPass.failed > 0));
      // 先抽一行核对，再成批跑其余的
      const sample = await runRejudge({
        ...rejudgeOptions(t, outDir, envsOf(t, "rejudge-envs")),
        limit: 1,
      });
      assert.deepEqual([sample.selected, sample.skipped, sample.consistent], [4, 0, 1]);
      const summary = await runRejudge({
        ...rejudgeOptions(t, outDir, envsOf(t, "rejudge-envs1")),
        concurrency: 2,
      });
      assert.deepEqual(summary.errors, []);
      assert.deepEqual(summary.inconsistent, []);
      assert.deepEqual([summary.selected, summary.skipped, summary.consistent], [4, 1, 3]);
      const lines = readFileSync(join(outDir, REJUDGE_DIR, REJUDGE_CASES_FILE), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as RejudgeLine);
      assert.equal(lines.length, 4);
      for (const l of lines) {
        assert.equal(l.consistent, true);
        assert.equal(l.complete, true);
        const orig = rows.find(
          (r) => r.seq === l.seq && r.attempt === l.attempt && r.condition === l.condition
        );
        assert.deepEqual(l.original, orig?.judging);
      }
      assert.deepEqual(readFileSync(resultsFile), before, "原结果行一字不改");
      const again = await runRejudge(rejudgeOptions(t, outDir, envsOf(t, "rejudge-envs2")));
      assert.equal(again.skipped, 4);
      assert.equal(again.consistent, 0);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("变异：不打保存的改动即与原结果行不一致（核对确实起作用）", async () => {
    const t = await toy();
    try {
      const outDir = await formalRun(t);
      // 把各行的改动换成空文件：重判即退回起点的代码
      for (const r of readStreamResults(join(outDir, "results.jsonl"))) {
        if (r.diff !== null) writeFileSync(join(outDir, r.diff), "");
      }
      const summary = await runRejudge(rejudgeOptions(t, outDir, envsOf(t, "rejudge-envs")));
      assert.equal(summary.consistent, 0);
      assert.equal(summary.inconsistent.length, 4);
      assert.ok(
        summary.inconsistent.every((x) => x.mismatches.some((m) => m.startsWith("要做到的通过数")))
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("打不上的改动报错，这一行不写结果", async () => {
    const t = await toy();
    try {
      const outDir = await formalRun(t);
      // 第 1 步各行的改动都换成改一个起点里没有的文件：git apply 必然拒绝
      for (const r of readStreamResults(join(outDir, "results.jsonl"))) {
        if (r.seq !== 1 || r.diff === null) continue;
        writeFileSync(
          join(outDir, r.diff),
          "diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n"
        );
      }
      const summary = await runRejudge({
        ...rejudgeOptions(t, outDir, envsOf(t, "rejudge-envs")),
        seqs: [1],
        limit: 1,
      });
      assert.equal(summary.errors.length, 1);
      assert.match(summary.errors[0]?.error ?? "", /打不上保存的改动/);
      assert.equal(existsSync(join(outDir, REJUDGE_DIR, REJUDGE_CASES_FILE)), false);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("空改动不打", async () => {
    const root = mkdtempSync(join(tmpdir(), "pigeon-rejudge-empty-"));
    try {
      const calls: string[] = [];
      const ws = {
        root,
        writeFile: async () => calls.push("write"),
        run: async () => {
          calls.push("run");
          return { exitCode: 0, timedOut: false, output: "" };
        },
      };
      await applySavedDiff(ws as never, Buffer.alloc(0));
      assert.deepEqual(calls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
