import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { GatewayMeter } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { composeStreamManifest, type StreamManifest } from "./stream-manifest.ts";
import { readStreamResults, ZERO_USAGE } from "./stream-results.ts";
import {
  ReferenceCases,
  runStreams,
  type StepAgent,
  type StepAgentInput,
  type StepAgentResult,
} from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { git, localStreamEnvs, toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";

const NEEDS_A = `[ -f src/a.txt ] || { echo "Cannot find module 'src/a.txt'"; exit 1; }\n`;

interface Toy {
  base: string;
  human: HumanRepo;
  manifest: StreamManifest;
  reference: ReferenceCases;
  commits: string[];
}

// 人的历史：起点 → 题 A（新建 a，并把已有的 base 测试改成也依赖 a）→ 维护步 → 只改文档（跳过）
// → 只改测试（套用，base 测试不再依赖 a）→ 题 B（依赖 a）。keep 测试此后人不再改
async function toy(): Promise<Toy> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-runner-"));
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
      "src/a.txt": "alpha\n",
      "src/a.test.sh": `${NEEDS_A}grep -q alpha src/a.txt\n`,
      "src/base.test.sh": "grep -q base src/base.txt && [ -f src/a.txt ]\n",
    },
    "Add alpha\n\nCreate src/a.txt"
  );
  const c2 = commit({ "src/base.txt": "base v2\n" }, "Bump base");
  const c3 = commit({ "README.md": "docs\n" }, "Docs");
  const c4 = commit(
    { "src/base.test.sh": "grep -q base src/base.txt && true\n" },
    "Tweak base test"
  );
  const c5 = commit(
    { "src/b.txt": "beta\n", "src/b.test.sh": `${NEEDS_A}grep -q beta src/b.txt\n` },
    "Add beta"
  );
  const human = gitHumanRepo(dir);
  const facts = human.firstParentLog(start, c5).map((c) => ({
    sha: c.sha,
    parent: c.parent,
    subject: c.message.split("\n")[0] ?? "",
    message: c.message,
    files: human.changes(c.parent, c.sha),
  }));
  const probes: Record<string, object> = {
    [c1]: { probe: { parentFails: true, commitPasses: true } },
    [c2]: { formatOnly: false },
    [c4]: { probe: { parentFails: false, commitPasses: true } },
    [c5]: { probe: { parentFails: true, commitPasses: true } },
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
  await referenceWs.init(human.bundle(c5), c5);
  const reference = new ReferenceCases({
    reference: referenceWs,
    runtime: toyRuntime,
    cacheDir: join(base, "reference-cache"),
  });
  return { base, human, manifest, reference, commits: [start, c1, c2, c3, c4, c5] };
}

type Script = (input: StepAgentInput) => Partial<StepAgentResult> | undefined;

// 可编排的假 agent：按步序直接改本地工作区里的文件
function scriptedAgent(script: Script): StepAgent & { calls: StepAgentInput[] } {
  const calls: StepAgentInput[] = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      const extra = script(input) ?? {};
      return {
        status: "completed",
        turns: 3,
        usage: { ...ZERO_USAGE, totalTokens: 100 },
        wallMs: 5,
        repair: null,
        ...extra,
      };
    },
  };
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function options(t: Toy, overrides: Partial<Parameters<typeof runStreams>[0]>) {
  return {
    manifest: t.manifest,
    runtime: toyRuntime,
    human: t.human,
    envs: localStreamEnvs(join(t.base, "envs"), (c: string) => t.human.bundle(c)),
    agents: {},
    reference: t.reference,
    outDir: join(t.base, "out"),
    conditions: ["no-gate" as const],
    harnessRef: { commit: "test", dirty: false },
    ...overrides,
  };
}

describe("延续式跑批（假 agent、本地假容器）", { concurrency: true }, () => {
  test("去掉验证门与回退：逐步落地、恢复被改的测试、规整 agent 自己的提交、全量测量与类型分布", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, {
            "src/a.txt": "alpha\n",
            // 篡改旧测试、自建测试、自己提交：都要被程序兜住
            "src/keep.test.sh": "exit 0\n",
            "src/agent.test.sh": "true\n",
          });
          git(root, "add", "-A");
          git(
            root,
            "-c",
            "user.name=agent",
            "-c",
            "user.email=a@x.invalid",
            "commit",
            "-q",
            "-m",
            "agent wip"
          );
        }
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        if (input.step.seq === 5) write(root, { "src/b.txt": "beta\n" });
        return undefined;
      });
      const summary = await runStreams(options(t, { agents: { pigeon: agent } }));
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 5 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.kind, r.outcome, r.attribution]),
        [
          [1, "task", "passed", null],
          [2, "maintenance", "passed", null],
          [3, "skip", "skipped", null],
          [4, "apply", "applied", null],
          [5, "task", "passed", null],
        ]
      );
      // agent 只在题与维护步上被调用，题面为提交信息加测试全文
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 2, 5]
      );
      assert.match(
        agent.calls[0]?.prompt ?? "",
        /^Add alpha\n\nCreate src\/a\.txt\n\n--- src\/a\.test\.sh ---/
      );
      const last = rows.at(-1);
      assert.deepEqual(last?.fullPassRate?.byCount, { passed: 4, total: 4, rate: 1 });
      assert.deepEqual(last?.fullPassRate?.byTask, { passed: 2, total: 2, rate: 1 });
      assert.deepEqual(last?.quality, { typeErrors: 0, formatErrors: null, layerViolations: null });
      assert.equal(rows[2]?.head, rows[1]?.head, "跳过步不落地");
      assert.deepEqual(rows[2]?.fullPassRate, rows[1]?.fullPassRate, "跳过步沿用上一步的测量");
      // 落地的历史：起点之上一步一个提交，提交信息为人的提交信息，改动的测试被恢复、自建的测试保留
      const bundle = readFileSync(join(t.base, "out", "streams", "s1-no-gate-1", "history.bundle"));
      const check = join(t.base, "check");
      mkdirSync(check);
      git(check, "init", "-q");
      writeFileSync(join(check, "h.bundle"), bundle);
      git(check, "fetch", "-q", "h.bundle", `${last?.head}:refs/heads/main`);
      git(check, "-c", "core.autocrlf=false", "checkout", "-q", "main");
      assert.deepEqual(git(check, "log", "--format=%s", `${t.commits[0]}..main`).split("\n"), [
        "Add beta",
        "Tweak base test",
        "Bump base",
        "Add alpha",
      ]);
      assert.equal(
        readFileSync(join(check, "src/base.test.sh"), "utf8"),
        "grep -q base src/base.txt && true\n"
      );
      assert.ok(existsSync(join(check, "src/agent.test.sh")));
      // 第 1 步落地的提交里，被 agent 篡改的旧测试已恢复成人的版本
      assert.equal(git(check, "show", `${rows[0]?.head}:src/keep.test.sh`), "true");
      assert.match(readFileSync(summary.reportFile, "utf8"), /终点（按条数）：no-gate 100\.0%/);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("完整 Pigeon：回炉最终不通过即撤回、该步留空；后面依赖它的题判为缺前置；全量测量把被撤回题的测试算作失败", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, { "src/a.txt": "wrong\n" });
          return { repair: { rounds: 3, finalVerdict: "fail" } };
        }
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        if (input.step.seq === 5) write(root, { "src/b.txt": "beta\n" });
        return { repair: { rounds: 0, finalVerdict: "pass" } };
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["full"] })
      );
      const rows = readStreamResults(summary.resultsFile);
      const [r1, r2, , , r5] = rows;
      assert.deepEqual(
        [r1?.outcome, r1?.reverted, r1?.repairRounds, r1?.finalVerdict, r1?.attribution],
        ["failed", true, 3, "fail", "not-done"]
      );
      assert.equal(r1?.head, t.commits[0], "撤回后工作区回到本步起点");
      assert.deepEqual(
        [r5?.outcome, r5?.reverted, r5?.attribution],
        ["failed", false, "missing-prerequisite"]
      );
      // 第 2 步：人截至此时的 base 测试（题 A 里改成依赖 a）、keep、a 三条——测量副本必须补上人的新版 base 测试，
      // 被撤回的工作区里只有旧版
      assert.deepEqual(r2?.fullPassRate?.byCount, { passed: 1, total: 3, rate: 1 / 3 });
      // 第 5 步：base（人已改回不依赖 a）、keep 过；a 与 b 在 agent 的代码上都过不了
      assert.deepEqual(r5?.fullPassRate?.byCount, { passed: 2, total: 4, rate: 0.5 });
      assert.deepEqual(r5?.fullPassRate?.byTask, { passed: 0, total: 2, rate: 0 });
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("被打断的一步整题作废不留行，续跑从导出的流历史接着做；试跑只跑每条流前 K 步", async () => {
    const t = await toy();
    try {
      const good: Script = (input) => {
        const root = input.target.root;
        if (input.step.seq === 1) write(root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        return undefined;
      };
      const flaky = scriptedAgent((input) => {
        if (input.step.seq === 2) {
          write(input.target.root, { "src/half.txt": "half done\n" });
          return { interrupted: "模型服务故障" };
        }
        return good(input);
      });
      const first = await runStreams(options(t, { agents: { pigeon: flaky }, maxSteps: 4 }));
      assert.equal(first.jobs[0]?.completedTo, 1);
      assert.match(first.jobs[0]?.stopped ?? "", /第 2 步被打断，整题作废：模型服务故障/);
      assert.deepEqual(
        readStreamResults(first.resultsFile).map((r) => r.seq),
        [1]
      );

      const again = scriptedAgent(good);
      const second = await runStreams(options(t, { agents: { pigeon: again }, maxSteps: 4 }));
      assert.deepEqual(second.jobs, [{ key: "s1|no-gate|1", completedTo: 4 }]);
      const rows = readStreamResults(second.resultsFile);
      assert.deepEqual(
        rows.map((r) => r.seq),
        [1, 2, 3, 4]
      );
      assert.deepEqual(
        again.calls.map((c) => c.step.seq),
        [2]
      );
      assert.equal(rows[1]?.outcome, "passed");
      // 续跑的工作区里没有被打断那一次留下的半成品
      const bundle = readFileSync(join(t.base, "out", "streams", "s1-no-gate-1", "history.bundle"));
      const check = join(t.base, "check");
      mkdirSync(check);
      git(check, "init", "-q");
      writeFileSync(join(check, "h.bundle"), bundle);
      git(check, "fetch", "-q", "h.bundle", `${rows[3]?.head}:refs/heads/main`);
      assert.equal(
        git(check, "ls-tree", "--name-only", "-r", "main", "src").includes("src/half.txt"),
        false
      );
      assert.match(readFileSync(second.reportFile, "utf8"), /试跑：每条流前 4 步/);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("限额：一步撞上额度即作废、回到本步起点，整批恢复后重做同一步，暂停记录挂在该步结果行上；轮数与 token 取网关计量", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({
        probe: async () => true,
        slots: 2,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        warn: () => {},
      });
      const meters = new Map<string, GatewayMeter>();
      const gateway = {
        jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
        meter: (job: string) => ({
          ...(meters.get(job) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
        }),
      };
      let hits = 0;
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        const m = meters.get(
          input.job.stream + "|" + input.job.condition + "|" + input.job.attempt
        ) ?? {
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
        meters.set(`${input.job.stream}|${input.job.condition}|${input.job.attempt}`, {
          ...m,
          requests: m.requests + 2,
          input: m.input + 100,
          output: m.output + 10,
        });
        assert.equal(input.modelBaseUrl, "http://gateway/j/s1|no-gate|1");
        if (input.step.seq === 1) write(root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) {
          write(root, { "src/half.txt": "half\n" });
          if (hits++ === 0) {
            limits.onLimit("5h");
            return { interrupted: "网关暂停" };
          }
          write(root, { "src/base.txt": "base v2\n" });
        }
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, maxSteps: 2, limits, gateway })
      );
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 2 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.limitPauses.map((p) => p.kind)]),
        [
          [1, "passed", []],
          [2, "passed", ["5h"]],
        ]
      );
      assert.equal(rows[1]?.limitPauses[0]?.endedAt !== null, true);
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 2, 2]
      );
      // 计量取网关：每次调用记 2 次请求、100 输入、10 输出
      assert.deepEqual([rows[0]?.turns, rows[0]?.usage.totalTokens], [2, 110]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("条件需要的 agent 没有接入：该作业停止并说明原因，其余作业照跑", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent(() => undefined);
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["minimal", "no-gate"], maxSteps: 1 })
      );
      const byKey = new Map(summary.jobs.map((j) => [j.key, j]));
      assert.match(byKey.get("s1|minimal|1")?.stopped ?? "", /agent（minimal）没有接入/);
      assert.equal(byKey.get("s1|no-gate|1")?.completedTo, 1);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });
});
