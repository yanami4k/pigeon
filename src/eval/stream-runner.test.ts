import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { runHeadless } from "../application/headless.ts";
import { createSessionSearch } from "../memory/session-search.ts";
import { loadStructuredMemory, structuredMemoryCachePath } from "../memory/structured-store.ts";
import { listSessionIds } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { GatewayMeter } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { baselineTargets, computeBaselines } from "./stream-baseline.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { checkOrWriteIdentity, manifestDigestOf } from "./stream-identity.ts";
import {
  composeStreamManifest,
  markHumanGateFailures,
  type StreamManifest,
} from "./stream-manifest.ts";
import { gateFromSteps, runJunitOnce, strandsRuntime } from "./stream-profiles.ts";
import { readStreamResults, ZERO_USAGE } from "./stream-results.ts";
import {
  commandDigest,
  compareRuns,
  DEFAULT_STEP_BUDGET,
  EQUIVALENT_BASELINE_COMMANDS,
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
async function toy(aTest = `${NEEDS_A}grep -q alpha src/a.txt\n`): Promise<Toy> {
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
      "src/a.test.sh": aTest,
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
    image: "test-image",
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
        /^src\/a\.test\.sh\nsrc\/base\.test\.sh\n\nAdd alpha\n\nCreate src\/a\.txt\n\n--- src\/a\.test\.sh ---/
      );
      const last = rows.at(-1);
      assert.deepEqual(last?.fullPassRate?.byCount, { passed: 4, total: 4, rate: 1 });
      assert.deepEqual(last?.fullPassRate?.byTask, { passed: 2, total: 2, rate: 1 });
      assert.deepEqual(last?.quality, { typeErrors: 0, formatErrors: null, layerViolations: null });
      assert.equal(rows[2]?.head, rows[1]?.head, "跳过步不落地");
      // 分步验证配置写进作业的治理根，形状与 .pigeon/verify.json 一致
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(t.base, "out", "streams", "s1-no-gate-1", ".pigeon", "verify.json"),
            "utf8"
          )
        ),
        { version: 1, steps: toyRuntime.verifySteps, timeoutMs: 1_800_000 }
      );
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
          return {
            repair: { rounds: 2, finalVerdict: "fail", reverted: true, budgetExhausted: true },
          };
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
        [
          r1?.outcome,
          r1?.reverted,
          r1?.repairRounds,
          r1?.finalVerdict,
          r1?.repairBudgetExhausted,
          r1?.attribution,
        ],
        ["failed", true, 2, "fail", true, "not-done"]
      );
      assert.equal(
        r2?.repairBudgetExhausted,
        false,
        "开回炉的条件、回炉照常收尾：预算没有先于轮数用尽"
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

  test("一次全量测量在报告写出前被杀、一条结果都没拿到：分母仍是人的代码上通过的全部用例，全部计为未通过", async () => {
    // a 的测试在没有 a.txt 时把跑测试的外壳杀掉：人的代码上照常通过，被撤回了题 A 的 agent 代码上整次测量拿不到报告
    const t = await toy("[ -f src/a.txt ] || kill -9 $PPID\ngrep -q alpha src/a.txt\n");
    try {
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, { "src/a.txt": "wrong\n" });
          return { repair: { rounds: 3, finalVerdict: "fail" } };
        }
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        return { repair: { rounds: 0, finalVerdict: "pass" } };
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["full"], maxSteps: 2 })
      );
      const r2 = readStreamResults(summary.resultsFile)[1];
      assert.deepEqual(r2?.fullPassRate?.byCount, { passed: 0, total: 3, rate: 0 });
      assert.deepEqual(r2?.fullPassRate?.byCountCollected, { passed: 0, total: 3, rate: 0 });
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
      // 没有限额信号的被打断：作废重做，连续超过上限才停下作业
      assert.match(
        first.jobs[0]?.stopped ?? "",
        /第 2 步连续 4 次被打断.*agent 报被打断：模型服务故障/
      );
      assert.equal(flaky.calls.filter((c) => c.step.seq === 2).length, 4);
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
          ...(meters.get(job) ?? {
            requests: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            upstreamFailures: 0,
            queueMs: 0,
            peakInFlight: 0,
            accountRequests: [0, 0],
          }),
        }),
        resetPeak: (job: string) => {
          const m = meters.get(job);
          if (m !== undefined) meters.set(job, { ...m, peakInFlight: 0 });
        },
      };
      let hits = 0;
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        const m = meters.get(`${input.job.stream}|${input.job.condition}|${input.job.attempt}`) ?? {
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          upstreamFailures: 0,
          queueMs: 0,
          peakInFlight: 0,
          accountRequests: [0, 0],
        };
        meters.set(`${input.job.stream}|${input.job.condition}|${input.job.attempt}`, {
          ...m,
          requests: m.requests + 2,
          input: m.input + 100,
          output: m.output + 10,
          queueMs: m.queueMs + 30,
          // 峰值不重记就会沿步累加：跑批器每步开始时 resetPeak
          peakInFlight: m.peakInFlight + 1,
          accountRequests: [(m.accountRequests[0] ?? 0) + 1, (m.accountRequests[1] ?? 0) + 1],
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
      // 网关的排队时间、各账号请求数与在途峰值按步取差记到结果行上
      assert.deepEqual(rows[0]?.gateway, { queueMs: 30, accountRequests: [1, 1], peakInFlight: 1 });
      assert.deepEqual(rows[1]?.gateway, { queueMs: 30, accountRequests: [1, 1], peakInFlight: 1 });
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("维护步用这条流的分步验证判定（与回炉、开跑前检查同一套），不用清单里冻结的验证命令", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(input.target.root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      // 清单里冻结的命令必然失败；分步验证照常能过
      const manifest = { ...t.manifest, gateCommand: ["sh", "-c", "exit 1"] };
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, manifest, maxSteps: 2 })
      );
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.kind, r.outcome]),
        [
          [1, "task", "passed"],
          [2, "maintenance", "passed"],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 暂存了人写测试的改名：原路径恢复成本步起点的版本、改名后的路径删掉，作业不中止", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, { "src/a.txt": "alpha\n" });
          git(root, "mv", "src/base.test.sh", "src/moved.test.sh");
        }
        return undefined;
      });
      const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 1 }]);
      const [row] = readStreamResults(summary.resultsFile);
      assert.equal(row?.outcome, "passed");
      const bundle = readFileSync(join(t.base, "out", "streams", "s1-no-gate-1", "history.bundle"));
      const check = join(t.base, "check");
      mkdirSync(check);
      git(check, "init", "-q");
      writeFileSync(join(check, "h.bundle"), bundle);
      git(check, "fetch", "-q", "h.bundle", `${row?.head}:refs/heads/main`);
      const files = git(check, "ls-tree", "--name-only", "-r", "main", "src").split("\n");
      assert.ok(files.includes("src/base.test.sh"), "原路径恢复");
      assert.ok(!files.includes("src/moved.test.sh"), "改名后的路径删掉");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("测量副本与人写测试集一致：agent 新建、落了地的测试文件不进全量测量的副本", async () => {
    const t = await toy();
    try {
      const inCopy: boolean[] = [];
      const runtime = {
        ...toyRuntime,
        runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
          const cwd = args[2].cwd;
          // 只看全量测量（在测量副本里跑）
          if (cwd !== undefined) inCopy.push(existsSync(join(cwd, "src", "agent.test.sh")));
          return toyRuntime.runCases(...args);
        },
      };
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1)
          write(input.target.root, { "src/a.txt": "alpha\n", "src/agent.test.sh": "exit 1\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 }));
      assert.ok(inCopy.length > 0, "做了全量测量");
      assert.ok(
        inCopy.every((present) => !present),
        "agent 新建的测试文件不在测量副本里"
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 新建的、落在人写测试目录树上的 conftest 不影响判题与测量：判题前删掉（被 .gitignore 藏起来的也删，单个文件或整个目录被忽略都一样），测量副本同样没有，也不落地", async () => {
    for (const ignore of ["/src/conftest.sh\n", "src/\n"]) {
      const t = await toy();
      try {
        // 玩具版的 conftest：用例脚本先加载它（相当于 pytest 加载 conftest），里面把 sh 换成恒成功的函数即可让任何用例"通过"
        const hooks = ["src/conftest.sh"];
        const load = `for c in ${hooks.join(" ")}; do [ -f "$c" ] && . "./$c"; done\n`;
        const seen: { where: string; present: string[] }[] = [];
        const runtime: typeof toyRuntime = {
          ...toyRuntime,
          autoloadedTestHelper: "conftest.sh",
          profile: {
            ...toyRuntime.profile,
            classifyFile: (path: string) =>
              path.startsWith("src/") && path.endsWith("conftest.sh")
                ? "testaux"
                : toyRuntime.profile.classifyFile(path),
          },
          runCases: (ws, tests, opts) => {
            const root = opts.cwd ?? ws.root;
            seen.push({
              where: opts.cwd === undefined ? "judge" : "measure",
              present: hooks.filter((h) => existsSync(join(root, h))),
            });
            return runJunitOnce(
              ws,
              (junit) => [
                "sh",
                "-c",
                `cd "${root}"; ${load}${toyRuntime.casesCommand}`,
                "sh",
                junit,
                ...tests,
              ],
              opts
            );
          },
        };
        let atStep2: string[] | undefined;
        const agent = scriptedAgent((input) => {
          if (input.step.seq === 2) {
            atStep2 = hooks.filter((h) => existsSync(join(input.target.root, h)));
            write(input.target.root, { "src/base.txt": "base v2\n" });
          }
          if (input.step.seq === 1) {
            const hijack = "sh() { return 0; }\n";
            write(input.target.root, {
              "src/a.txt": "wrong\n",
              // 这份还被 agent 写进了 .gitignore（这个文件本身，或它所在的整个目录）：git status 看不到它
              ".gitignore": ignore,
              "src/conftest.sh": hijack,
            });
          }
          return undefined;
        });
        const summary = await runStreams(
          options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
        );
        const rows = readStreamResults(summary.resultsFile);
        assert.equal(
          rows[0]?.outcome,
          "failed",
          `${ignore}：错的实现不因 agent 的 conftest 判为通过`
        );
        assert.ok(seen.some((s) => s.where === "judge"));
        assert.ok(seen.some((s) => s.where === "measure"));
        assert.deepEqual(
          seen.filter((s) => s.present.length > 0),
          [],
          `${ignore}：判题与测量时都没有 agent 新建的 conftest`
        );
        assert.deepEqual(atStep2, [], `${ignore}：conftest 没有落地，下一步开始时不在工作区里`);
        // 回炉前删 conftest 用的人树与判题前同一份：人在该步树里的全部路径
        assert.deepEqual(
          [...(agent.calls[0]?.humanTree ?? [])].sort(),
          t.human
            .tree(agent.calls[0]?.step.commit ?? "")
            .map((e) => e.path)
            .sort(),
          `${ignore}：交给 agent 的人树`
        );
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("还原人写测试防绕过：agent 给已落地的人写测试设 skip-worktree 或 assume-unchanged 再改，照样还原；跑批器自己的 git 操作不执行 agent 放进 .git/hooks 的钩子", async () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      const t = await toy();
      try {
        const marker = join(t.base, "hook-ran").replace(/\\/g, "/");
        const agent = scriptedAgent((input) => {
          const root = input.target.root;
          if (input.step.seq === 1) write(root, { "src/a.txt": "alpha\n" });
          if (input.step.seq === 2) {
            // 维护步：把 a 改坏，再让第 1 步落地的人写测试 a.test.sh 恒过、并对 git 隐藏这处改动
            write(root, { "src/a.txt": "wrong\n" });
            git(root, "update-index", flag, "src/a.test.sh");
            write(root, { "src/a.test.sh": "true\n" });
            mkdirSync(join(root, ".git", "hooks"), { recursive: true });
            for (const hook of ["post-commit", "post-checkout", "post-index-change"]) {
              writeFileSync(join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`, {
                mode: 0o755,
              });
            }
          }
          return undefined;
        });
        const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
        const rows = readStreamResults(summary.resultsFile);
        assert.deepEqual(
          rows.map((r) => [r.seq, r.kind, r.outcome]),
          [
            [1, "task", "passed"],
            [2, "maintenance", "failed"],
          ],
          `${flag}：隐藏的改动被还原，改坏的 a 判为不过`
        );
        assert.equal(existsSync(marker), false, `${flag}：agent 的钩子没有被执行`);
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("交给 agent 的人写测试集是人在该步树里的测试与测试辅助文件，不含 agent 早先步骤落地的自己的测试", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1)
          write(input.target.root, { "src/a.txt": "alpha\n", "src/agent.test.sh": "true\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(
        agent.calls.map((c) => [...(c.humanTestFiles ?? [])].sort()),
        [
          ["src/a.test.sh", "src/base.test.sh", "src/keep.test.sh"],
          ["src/a.test.sh", "src/base.test.sh", "src/keep.test.sh"],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 自己测试的辅助文件保留：helper、__init__、数据文件与只作用于自己测试目录的 conftest 都不删，后续验证门照常通过；被忽略的 __pycache__/ 与 agent 在 .gitignore 里写的整目录不让作业停下", async () => {
    const t = await toy();
    try {
      // 与 strands 相仿：src 下除用例与已知源文件外都归测试辅助
      const runtime: typeof toyRuntime = {
        ...toyRuntime,
        autoloadedTestHelper: "conftest.sh",
        profile: {
          ...toyRuntime.profile,
          classifyFile: (p: string) =>
            p.startsWith("src/agent/") || p.includes("__pycache__") || p.endsWith("conftest.sh")
              ? "testaux"
              : toyRuntime.profile.classifyFile(p),
        },
      };
      const own = [
        "src/agent/conftest.sh",
        "src/agent/helper.aux",
        "src/agent/__init__.aux",
        "src/agent/data.aux",
      ];
      let atStep2: string[] | undefined;
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, {
            "src/a.txt": "alpha\n",
            ".gitignore": "__pycache__/\nsrc/cachedir/\n",
            "src/__pycache__/a.cpython-310.pyc": "x",
            "src/cachedir/deep/conftest.sh": "true\n",
            ...Object.fromEntries(own.map((f) => [f, "ok=1\n"])),
            // agent 自己的用例依赖自己的 helper：helper 被删，验证门即不过
            "src/agent.test.sh": '. src/agent/helper.aux && [ "$ok" = 1 ]\n',
          });
        }
        if (input.step.seq === 2) {
          atStep2 = own.filter((f) => existsSync(join(root, f)));
          write(root, { "src/base.txt": "base v2\n" });
        }
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 2 }], "作业没有停下");
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.kind, r.outcome]),
        [
          [1, "task", "passed"],
          [2, "maintenance", "passed"],
        ]
      );
      assert.deepEqual(atStep2, own, "agent 自己的辅助文件都在");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("测量与判题的产物用完即清：下一步开始时，工作区里没有判题报告，测量副本目录是空的", async () => {
    const t = await toy();
    try {
      const leftovers: string[][] = [];
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        const measureDirs = join(t.base, "envs", "measure");
        const inMeasure = existsSync(measureDirs)
          ? readdirSync(measureDirs).flatMap((d) => readdirSync(join(measureDirs, d)))
          : [];
        leftovers.push([
          ...(existsSync(join(root, ".git", "pigeon-cases-junit.xml")) ? ["judge-junit"] : []),
          ...inMeasure,
        ]);
        if (input.step.seq === 1) write(root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      // 第 2 步开始时：第 1 步判题与全量测量留下的都已清掉
      assert.deepEqual(leftovers[1], []);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("依赖环境按人在该步的依赖声明选：agent 改了声明文件，切环境仍用人的版本；结果行记下 agent 改了依赖声明", async () => {
    const t = await toy();
    try {
      // 以 src/base.txt 充当依赖声明文件；切环境的命令把收到的声明内容追加进工作区的记录
      const runtime = {
        ...toyRuntime,
        envDeclarationFile: "src/base.txt",
        envSyncFor: (file: string) => ["sh", "-c", `cat "${file}" >> .git/decl-log`],
      };
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1)
          write(root, { "src/a.txt": "alpha\n", "src/base.txt": "base agent\n" });
        if (input.step.seq === 2) write(root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.agentChangedDeps]),
        [
          [1, true],
          [2, false],
        ]
      );
      const [wsDir] = readdirSync(join(t.base, "envs", "ws"));
      const log = readFileSync(join(t.base, "envs", "ws", wsDir ?? "", ".git", "decl-log"), "utf8")
        .split("\n")
        .filter((l) => l !== "");
      // 每次切环境（agent 之前、agent 之后）用的都是人在该步的声明，从来不是 agent 改过的
      assert.deepEqual(log, ["base", "base", "base v2", "base v2"]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("找不到可用的依赖组合：这一步作废、记下原因，作业照常往下走，不停掉", async () => {
    const t = await toy();
    try {
      const runtime = {
        ...toyRuntime,
        envDeclarationFile: "src/base.txt",
        envSyncFor: () => ["sh", "-c", "echo 没有满足当前 pyproject 的依赖组合 >&2; exit 3"],
      };
      const agent = scriptedAgent(() => undefined);
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 2 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.judged]),
        [
          [1, "skipped", false],
          [2, "skipped", false],
        ]
      );
      assert.ok(rows.every((r) => /依赖环境选择失败/.test(r.error ?? "")));
      assert.equal(agent.calls.length, 0);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("依赖环境切换的其他失败（命令不在、超时、容器故障等，退出码不是 3）：停下作业并报错，不作废成跳过步", async () => {
    for (const bad of [
      { envSyncFor: () => ["sh", "-c", "echo select-env: not found >&2; exit 127"] },
      { lintSyncCommand: () => ["sh", "-c", "echo docker 故障 >&2; exit 1"] },
    ]) {
      const t = await toy();
      try {
        const runtime = { ...toyRuntime, envDeclarationFile: "src/base.txt", ...bad };
        const agent = scriptedAgent(() => undefined);
        const summary = await runStreams(
          options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
        );
        assert.match(summary.jobs[0]?.stopped ?? "", /环境切换出错/);
        assert.deepEqual(readStreamResults(summary.resultsFile), []);
        assert.equal(agent.calls.length, 0);
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("全量测量时找不到可用的依赖组合（退出码 3）：这一步作废——撤掉已落地的提交、记下原因，下一步从本步起点接着做", async () => {
    const t = await toy();
    try {
      // 只在测量副本里（目录名含 measure）选不出组合
      const runtime = {
        ...toyRuntime,
        envDeclarationFile: "src/base.txt",
        envSyncFor: () => ["sh", "-c", 'case "$(pwd)" in *measure*) exit 3;; esac; exit 0'],
      };
      const sawStep1Work: boolean[] = [];
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2)
          sawStep1Work.push(existsSync(join(input.target.root, "src/a.txt")));
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 2 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome]),
        [
          [1, "skipped"],
          [2, "skipped"],
        ]
      );
      assert.ok(rows.every((r) => /依赖环境选择失败.*作废/s.test(r.error ?? "")));
      assert.deepEqual(sawStep1Work, [false], "第 1 步落地的提交已撤掉");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("测试配置按人在该步的版本写入：agent 运行前、判题前与测量副本里写的都是人的文件，不是 agent 改过的", async () => {
    const t = await toy();
    try {
      const pinned: string[] = [];
      const runtime = {
        ...toyRuntime,
        pinTestConfig: async (_ws: unknown, read: (p: string) => Promise<Buffer | undefined>) => {
          pinned.push((await read("src/base.txt"))?.toString("utf8") ?? "");
        },
      };
      const agent = scriptedAgent((input) => {
        // agent 改了"配置"文件
        if (input.step.seq === 1)
          write(input.target.root, { "src/a.txt": "alpha\n", "src/base.txt": "agent 的配置\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 }));
      // agent 运行前、判题前、测量副本各写一次
      assert.deepEqual(pinned, ["base\n", "base\n", "base\n"]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("lint 环境按该步人的提交切换：agent 运行前已切到该步人的提交，不看 agent 改过的依赖声明", async () => {
    const t = await toy();
    try {
      // 切换命令把收到的提交号写进标记文件；agent 运行时读它
      const runtime = {
        ...toyRuntime,
        lintSyncCommand: (commit: string) => ["sh", "-c", `echo ${commit} > .git/pigeon-lint`],
      };
      const seen: [string, string][] = [];
      const agent = scriptedAgent((input) => {
        const marker = readFileSync(join(input.target.root, ".git", "pigeon-lint"), "utf8").trim();
        seen.push([input.step.commit, marker]);
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(input.target.root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 }));
      assert.equal(seen.length, 2);
      for (const [commit, marker] of seen) assert.equal(marker, commit);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("结果行带身份摘要与本条件所用 agent 的参数（温度、输出上限、推理档位等，两种 agent 各记各的）", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        return undefined;
      });
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent, minimal: agent },
          conditions: ["no-gate", "minimal"],
          maxSteps: 1,
          concurrency: 1,
          runIdentity: "0123456789abcdef",
          agentSettings: {
            pigeon: { temperature: 0, thinking: null, maxOutputTokens: null },
            minimal: { modelKwargs: { temperature: 0.0, drop_params: true } },
          },
        })
      );
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.condition, r.runIdentity, r.agentSettings]),
        [
          [
            "no-gate",
            "0123456789abcdef",
            { temperature: 0, thinking: null, maxOutputTokens: null },
          ],
          ["minimal", "0123456789abcdef", { modelKwargs: { temperature: 0.0, drop_params: true } }],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("人的代码没过检查门的步：清单按预检结果打标记（其余去掉），结果行照抄这一列，步照常跑", async () => {
    const t = await toy();
    try {
      const [s1, s2] = t.manifest.steps;
      assert.ok(s1 !== undefined && s2 !== undefined);
      const stale = {
        ...t.manifest,
        steps: t.manifest.steps.map((s) => (s.seq === 1 ? { ...s, humanFailsGate: true } : s)),
      };
      const marked = markHumanGateFailures(stale, [s2.commit]);
      assert.deepEqual(
        marked.steps.slice(0, 2).map((s) => [s.seq, s.humanFailsGate]),
        [
          [1, undefined],
          [2, true],
        ]
      );
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(input.target.root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, manifest: marked, maxSteps: 2 })
      );
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.seq, r.humanFailsGate, r.judged]),
        [
          [1, false, true],
          [2, true, true],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("结果行记下验证前还原人写测试的次数：取步结果的 repair.humanTestRestores；未开回炉的条件为 null", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        return input.condition.repairRounds > 0
          ? { repair: { rounds: 1, finalVerdict: "pass", humanTestRestores: 2 } }
          : undefined;
      });
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent },
          conditions: ["full", "no-gate"],
          maxSteps: 1,
          concurrency: 1,
        })
      );
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.condition, r.humanTestRestores]),
        [
          ["full", 2],
          ["no-gate", null],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("限额与上游故障一律作废重做：一步期间出现并发受限、额度暂停、本作业的上游故障，或 agent 自报被打断，不论 agent 报没报、哪种 agent，这一步都回到起点重做、不判分", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({
        probe: async () => true,
        slots: 2,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        warn: () => {},
      });
      const meters = new Map<string, GatewayMeter>();
      const zero: GatewayMeter = {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        accountRequests: [0],
      };
      const gateway = {
        jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
        meter: (job: string) => ({ ...(meters.get(job) ?? zero) }),
        resetPeak: () => {},
      };
      // 第 1 步的前四次各遇到一种情况，都写下会判错的改动、且除自报那次外都不报被打断；第五次正常完成
      const attempts = new Map<string, number>();
      const make = () =>
        scriptedAgent((input) => {
          const key = `${input.job.stream}|${input.job.condition}|${input.job.attempt}`;
          const root = input.target.root;
          if (input.step.seq !== 1) return undefined;
          const n = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, n);
          if (n <= 4) write(root, { "src/a.txt": "wrong\n" });
          if (n === 1) limits.onLimit("concurrency");
          if (n === 2) {
            const m = meters.get(key) ?? zero;
            meters.set(key, { ...m, upstreamFailures: m.upstreamFailures + 1 });
          }
          if (n === 3) limits.onLimit("5h");
          if (n === 4) return { interrupted: "模型服务故障" };
          if (n === 5) write(root, { "src/a.txt": "alpha\n" });
          return undefined;
        });
      const mini = make();
      const pigeon = make();
      const summary = await runStreams(
        options(t, {
          agents: { minimal: mini, pigeon },
          conditions: ["minimal", "no-gate"],
          maxSteps: 1,
          concurrency: 1,
          limits,
          gateway,
        })
      );
      assert.deepEqual(
        summary.jobs.map((j) => [j.key, j.completedTo, j.stopped]),
        [
          ["s1|minimal|1", 1, undefined],
          ["s1|no-gate|1", 1, undefined],
        ]
      );
      const rows = readStreamResults(summary.resultsFile);
      // 每个作业只留一行、判为通过：前四次都作废了，没有按"wrong"判分
      assert.deepEqual(
        rows.map((r) => [r.condition, r.seq, r.outcome]),
        [
          ["minimal", 1, "passed"],
          ["no-gate", 1, "passed"],
        ]
      );
      assert.deepEqual([mini.calls.length, pigeon.calls.length], [5, 5]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("作废一步时清掉这次尝试的痕迹：重做时会话检索搜不到上一次尝试，结构化记忆不含作废的会话，会话移到治理根之外的隔离目录", async () => {
    const t = await toy();
    try {
      const clue = "作废尝试留下的线索甲乙丙";
      let voidedSession = "";
      const seenOnRetry: { hits: number; sessions: string[]; cache: boolean; memory: string[] }[] =
        [];
      const calls: StepAgentInput[] = [];
      const agent: StepAgent = {
        async run(input) {
          calls.push(input);
          const sessionsDir = join(input.workDir, ".pigeon", "sessions");
          if (input.step.seq === 1 && calls.length === 1) {
            // 第一次尝试：真实地跑一次 headless，会话落进治理根，结构化记忆缓存随之生成；然后报被打断
            const workspace = join(t.base, "headless-ws");
            mkdirSync(workspace, { recursive: true });
            const run = await runHeadless({
              task: clue,
              governanceRoot: input.workDir,
              workspaceRoot: workspace,
              streamFn: createFakeStreamFn({ replies: [{ text: `收到：${clue}` }] }),
              yolo: true,
              sessionId: newSessionId(),
              skillRoots: [],
              memoryRoots: [],
              homeDir: join(t.base, "home"),
            });
            voidedSession = run.sessionId;
            loadStructuredMemory(input.workDir);
            assert.ok(existsSync(structuredMemoryCachePath(input.workDir)));
            return {
              status: "failed",
              turns: 1,
              usage: ZERO_USAGE,
              wallMs: 5,
              repair: null,
              interrupted: "模型服务故障",
            };
          }
          if (input.step.seq === 1) {
            const hits: unknown[] = [];
            for await (const hit of createSessionSearch(sessionsDir).search({ keywords: [clue] })) {
              hits.push(hit);
            }
            const cache = existsSync(structuredMemoryCachePath(input.workDir));
            // 重建结构化记忆后看缓存里登记了哪些会话
            loadStructuredMemory(input.workDir);
            const rebuilt = JSON.parse(
              readFileSync(structuredMemoryCachePath(input.workDir), "utf8")
            ) as { sessions: Record<string, unknown> };
            seenOnRetry.push({
              hits: hits.length,
              sessions: listSessionIds(sessionsDir),
              cache,
              memory: Object.keys(rebuilt.sessions),
            });
            write(input.target.root, { "src/a.txt": "alpha\n" });
          }
          return { status: "completed", turns: 1, usage: ZERO_USAGE, wallMs: 5, repair: null };
        },
      };
      const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      assert.deepEqual(summary.jobs, [{ key: "s1|no-gate|1", completedTo: 1 }]);
      assert.notEqual(voidedSession, "");
      assert.deepEqual(seenOnRetry, [{ hits: 0, sessions: [], cache: false, memory: [] }]);
      // 作废的会话保留在输出目录下、作业治理根之外的隔离目录里备查
      const quarantined = readdirSync(join(t.base, "out", "voided"), { recursive: true }).map((f) =>
        String(f).replaceAll("\\", "/")
      );
      assert.ok(
        quarantined.some((f) => f.endsWith(`/${voidedSession}.jsonl`)),
        `隔离目录里应有作废的会话：${quarantined.join(", ")}`
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("进程死在一步中途留下的会话：续跑时不在上一个完成步清单里的会话移出治理根，完成步的会话保留", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        const sessions = join(input.workDir, ".pigeon", "sessions");
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, `sess_step${input.step.seq}.jsonl`), "{}\n");
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        if (input.step.seq === 2) write(input.target.root, { "src/base.txt": "base v2\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      const jobDir = join(t.base, "out", "streams", "s1-no-gate-1");
      const sessions = join(jobDir, ".pigeon", "sessions");
      assert.ok(existsSync(join(jobDir, "sessions-1.json")));
      // 模拟第 2 步做到一半进程被杀：会话留在治理根，没有结果行
      writeFileSync(join(sessions, "sess_crashed.jsonl"), "{}\n");
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(readdirSync(sessions).sort(), ["sess_step1.jsonl", "sess_step2.jsonl"]);
      const quarantined = readdirSync(join(t.base, "out", "voided"), { recursive: true }).map((f) =>
        String(f).replaceAll("\\", "/")
      );
      assert.ok(
        quarantined.some((f) => f.endsWith("/sess_crashed.jsonl")),
        quarantined.join(", ")
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("同一步因上游故障（或限额信号）一再作废：累计 5 次向标准错误告警一次，累计 10 次停下作业并说明，不无止境重做", async () => {
    const t = await toy();
    try {
      const meters = new Map<string, GatewayMeter>();
      const zero: GatewayMeter = {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        accountRequests: [0],
      };
      const gateway = {
        jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
        meter: (job: string) => ({ ...(meters.get(job) ?? zero) }),
        resetPeak: () => {},
      };
      // 每次尝试都遇到一次上游故障
      const agent = scriptedAgent((input) => {
        const key = `${input.job.stream}|${input.job.condition}|${input.job.attempt}`;
        const m = meters.get(key) ?? zero;
        meters.set(key, { ...m, upstreamFailures: m.upstreamFailures + 1 });
        return undefined;
      });
      const warnings: string[] = [];
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent },
          maxSteps: 1,
          gateway,
          warn: (line) => warnings.push(line),
        })
      );
      assert.match(summary.jobs[0]?.stopped ?? "", /累计作废 10 次：停下作业/);
      assert.equal(agent.calls.length, 10);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /已累计作废 5 次/);
      assert.deepEqual(readStreamResults(summary.resultsFile), []);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 留下未解决的冲突（merge 或 stash pop）：作废回滚与落地前的整理都不因此停下作业，重做与后续照常", async () => {
    const conflict = {
      merge(root: string) {
        const g = (...a: string[]) =>
          execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", ...a], { cwd: root });
        g("checkout", "-q", "-b", "side");
        write(root, { "src/a.txt": "side\n" });
        g("add", "-A");
        g("commit", "-qm", "side");
        g("checkout", "-q", "-");
        write(root, { "src/a.txt": "main\n" });
        g("add", "-A");
        g("commit", "-qm", "main");
        try {
          g("merge", "-q", "side");
        } catch {
          // 冲突即非零退出
        }
      },
      stashPop(root: string) {
        const g = (...a: string[]) =>
          execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x", ...a], { cwd: root });
        write(root, { "src/a.txt": "stashed\n" });
        g("add", "-A");
        g("stash", "-q");
        write(root, { "src/a.txt": "committed\n" });
        g("add", "-A");
        g("commit", "-qm", "x");
        try {
          g("stash", "pop", "-q");
        } catch {
          // 冲突即非零退出
        }
      },
    };
    for (const [how, make] of Object.entries(conflict)) {
      for (const voided of [true, false]) {
        const t = await toy();
        try {
          let attempts = 0;
          const agent = scriptedAgent((input) => {
            if (input.step.seq !== 1) return undefined;
            attempts += 1;
            if (attempts === 1) {
              make(input.target.root);
              return voided ? { interrupted: "模型服务故障" } : undefined;
            }
            write(input.target.root, { "src/a.txt": "alpha\n" });
            return undefined;
          });
          const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
          assert.deepEqual(
            summary.jobs,
            [{ key: "s1|no-gate|1", completedTo: 1 }],
            `${how}${voided ? "后作废" : "后照常收工"}：作业没有停下`
          );
          assert.equal(attempts, voided ? 2 : 1);
        } finally {
          rmSync(t.base, { recursive: true, force: true });
        }
      }
    }
  });

  test("agent 连续自报被打断、期间没有任何限额信号或上游故障：重做三次后停下作业并说明，不无限重做", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
      const agent = scriptedAgent(() => ({ interrupted: "模型服务故障" }));
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, maxSteps: 1, limits })
      );
      assert.match(summary.jobs[0]?.stopped ?? "", /连续 4 次被打断/);
      assert.equal(agent.calls.length, 4);
      assert.deepEqual(readStreamResults(summary.resultsFile), []);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("停止信号（SIGTERM）：在途的一步作废、不留行，作业停下并说明；已完成的步保留，同一输出目录续跑从作废的那步重做", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        // 第 2 步做到一半收到停止信号：已改的工作区作废
        if (input.step.seq === 2 && agent.calls.length === 2) {
          write(input.target.root, { "src/base.txt": "half\n" });
          limits.shutdown("收到 SIGTERM");
        }
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, maxSteps: 2, limits })
      );
      assert.match(summary.jobs[0]?.stopped ?? "", /收到 SIGTERM/);
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => r.seq),
        [1],
        "作废的第 2 步不留行"
      );
      assert.equal(agent.calls.length, 2, "停下后不再重做");
      // 续跑：从第 2 步起重做，起点是第 1 步结束时的树
      let seenAtRedo: string | undefined;
      const resumed = scriptedAgent((input) => {
        seenAtRedo = readFileSync(join(input.target.root, "src", "base.txt"), "utf8");
        return undefined;
      });
      const again = await runStreams(options(t, { agents: { pigeon: resumed }, maxSteps: 2 }));
      assert.deepEqual(
        readStreamResults(again.resultsFile).map((r) => r.seq),
        [1, 2]
      );
      assert.deepEqual(
        resumed.calls.map((c) => c.step.seq),
        [2]
      );
      assert.notEqual(seenAtRedo, "half\n", "作废那步的改动没有带进重做");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("结果文件末尾留着写到一半的行（进程被杀）：续跑前隔开它，之后追加的结果行照常读得出", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        return undefined;
      });
      const first = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      appendFileSync(first.resultsFile, '{"stream":"s1","condition":"no-g');
      const again = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(
        readStreamResults(again.resultsFile).map((r) => r.seq),
        [1, 2]
      );
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 2]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("作废重做前丢掉那次尝试在库里的痕迹：agent 在被打断的尝试里提交过，重做时 reflog 与对象库里都找不到那个提交", async () => {
    const t = await toy();
    try {
      let attemptCommit = "";
      let seenAtRedo: { reflog: string; exists: boolean } | undefined;
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq !== 1) return undefined;
        if (attemptCommit === "") {
          write(root, { "src/a.txt": "attempt\n" });
          git(root, "-c", "user.name=a", "-c", "user.email=a@x", "add", "-A");
          git(root, "-c", "user.name=a", "-c", "user.email=a@x", "commit", "-qm", "attempt");
          attemptCommit = git(root, "rev-parse", "HEAD");
          return { interrupted: "模型服务故障" };
        }
        let exists = true;
        try {
          git(root, "cat-file", "-e", attemptCommit);
        } catch {
          exists = false;
        }
        seenAtRedo = { reflog: git(root, "reflog", "--all", "--format=%H"), exists };
        write(root, { "src/a.txt": "alpha\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      assert.notEqual(attemptCommit, "");
      assert.equal(agent.calls.length, 2, "作废一次、重做一次");
      assert.doesNotMatch(seenAtRedo?.reflog ?? "", new RegExp(attemptCommit), "reflog 里没有");
      assert.equal(seenAtRedo?.exists, false, "对象库里也没有");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("停止信号在判题或测量期间到达：这一步作废、不写行，作业停下；续跑重做这一步", async () => {
    for (const where of ["judge", "measure"] as const) {
      const t = await toy();
      try {
        const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
        let fired = false;
        const runtime: typeof toyRuntime = {
          ...toyRuntime,
          // 判题跑用例不带 cwd，全量测量在测量副本里跑（带 cwd）：在其中一处途中收到停止信号
          runCases: (ws, tests, opts) => {
            if (!fired && (opts.cwd === undefined) === (where === "judge")) {
              fired = true;
              limits.shutdown("收到 SIGTERM");
            }
            return toyRuntime.runCases(ws, tests, opts);
          },
        };
        const agent = scriptedAgent((input) => {
          if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
          return undefined;
        });
        const summary = await runStreams(
          options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1, limits })
        );
        assert.equal(fired, true, where);
        assert.match(summary.jobs[0]?.stopped ?? "", /收到 SIGTERM/, where);
        assert.deepEqual(readStreamResults(summary.resultsFile), [], `${where}：不写行`);
        const again = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
        assert.deepEqual(
          readStreamResults(again.resultsFile).map((r) => [r.seq, r.outcome]),
          [[1, "passed"]],
          `${where}：续跑重做这一步`
        );
        assert.equal(agent.calls.length, 2, where);
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("因停止信号停下：在途作业的容器留着（续跑接管），排队的作业不再开容器", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
      const inner = localStreamEnvs(join(t.base, "envs"), (c: string) => t.human.bundle(c));
      const opened: string[] = [];
      const disposed: string[] = [];
      const envs = {
        async open(job: Parameters<typeof inner.open>[0], init: Parameters<typeof inner.open>[1]) {
          opened.push(job.condition);
          const env = await inner.open(job, init);
          return {
            ...env,
            dispose: async () => {
              disposed.push(job.condition);
              await env.dispose();
            },
          };
        },
      };
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) {
          write(input.target.root, { "src/a.txt": "alpha\n" });
          limits.shutdown("收到 SIGTERM");
        }
        return undefined;
      });
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent, minimal: agent },
          conditions: ["no-gate", "minimal"],
          concurrency: 1,
          envs,
          maxSteps: 2,
          limits,
        })
      );
      assert.deepEqual(opened, ["no-gate"], "排队的作业不再开容器");
      assert.deepEqual(disposed, [], "在途作业的容器留着");
      assert.ok(summary.jobs.every((j) => /收到 SIGTERM/.test(j.stopped ?? "")));
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

test("人的基准在报告写出前被杀、拿不全用例：报错停下，不以缺了用例的基准缩小分母", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-baseline-"));
  try {
    const commit = toyRepo(join(base, "human"))(
      { "src/ok.test.sh": "true\n", "src/k.test.sh": "kill -9 $PPID\n" },
      "Start"
    );
    const human = gitHumanRepo(join(base, "human"));
    mkdirSync(join(base, "ref"));
    const ws = new ReferenceWorkspace(localStreamShell(join(base, "ref")));
    await ws.init(human.bundle(commit), commit);
    const reference = new ReferenceCases({
      reference: ws,
      runtime: toyRuntime,
      cacheDir: join(base, "cache"),
      image: "test-image",
    });
    await assert.rejects(
      reference.casesAt(commit, ["src/ok.test.sh", "src/k.test.sh"]),
      /人的基准没拿到全部用例的结果/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("人的基准多遍比对：每遍都通过的进分母 B；结果前后不一或某遍缺席的记为时过时不过；收集出的用例取各遍并集；最慢用例", () => {
  const c = (id: string, outcome: "passed" | "failed", seconds?: number) => ({
    id,
    file: "t.py",
    outcome,
    ...(seconds !== undefined ? { seconds } : {}),
  });
  const baseline = compareRuns([
    [c("a", "passed", 1.5), c("b", "passed"), c("c", "passed", 9), c("d", "failed")],
    [c("a", "passed", 2), c("b", "failed"), c("d", "failed"), c("e", "passed", 3)],
  ]);
  assert.deepEqual(baseline.slowest, { id: "c", seconds: 9 });
  assert.deepEqual(baseline.passing, ["a"]);
  assert.deepEqual([...baseline.flaky].sort(), ["b", "c", "e"]);
  assert.deepEqual(baseline.cases.map((x) => x.id).sort(), ["a", "b", "c", "d", "e"]);
});

test("人的基准与开跑前检查的缓存带身份（镜像、跑用例的方式、检查门命令）：身份相同才复用，变了或没有身份的旧文件一律重算", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-identity-"));
  try {
    const commit = toyRepo(join(base, "human"))({ "src/ok.test.sh": "true\n" }, "Start");
    const human = gitHumanRepo(join(base, "human"));
    mkdirSync(join(base, "ref"));
    const ws = new ReferenceWorkspace(localStreamShell(join(base, "ref")));
    await ws.init(human.bundle(commit), commit);
    let runs = 0;
    const counting = {
      ...toyRuntime,
      runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
        runs++;
        return toyRuntime.runCases(...args);
      },
    };
    const cacheDir = join(base, "cache");
    const at = (image: string, runtime = counting) =>
      new ReferenceCases({ reference: ws, runtime, cacheDir, image });
    const tests = ["src/ok.test.sh"];
    await at("sha256:aaa").casesAt(commit, tests);
    assert.equal(runs, 2);
    assert.equal(at("sha256:aaa").has(commit), true);
    await at("sha256:aaa").casesAt(commit, tests);
    assert.equal(runs, 2, "身份相同：直接读回");
    // 镜像变了
    assert.equal(at("sha256:bbb").has(commit), false);
    await at("sha256:bbb").casesAt(commit, tests);
    assert.equal(runs, 4, "镜像不同：重算");
    // 跑用例的方式变了（例如单条超时或外壳改了）
    const otherWay = { ...counting, casesCommand: `${counting.casesCommand} --timeout 1` };
    assert.equal(at("sha256:bbb", otherWay).has(commit), false);
    await at("sha256:bbb", otherWay).casesAt(commit, tests);
    assert.equal(runs, 6, "跑用例的方式不同：重算");
    // 没有身份的旧文件
    const file = join(cacheDir, `${commit}.json`);
    const { identity: _dropped, ...legacy } = JSON.parse(readFileSync(file, "utf8")) as {
      identity?: unknown;
    };
    writeFileSync(file, JSON.stringify(legacy));
    assert.equal(at("sha256:bbb", otherWay).has(commit), false, "没有身份：不复用");
    // 开跑前检查：检查门命令变了即重算
    const pass = ["sh", "-c", "exit 0"];
    const fail = ["sh", "-c", "exit 1"];
    assert.equal((await at("sha256:aaa").gateAt(commit, pass)).passed, true);
    assert.equal(at("sha256:aaa").hasGate(commit, pass), true);
    assert.equal(at("sha256:aaa").hasGate(commit, fail), false);
    assert.equal(at("sha256:bbb").hasGate(commit, pass), false);
    assert.equal((await at("sha256:aaa").gateAt(commit, fail)).passed, false, "命令不同：重跑");
    // 开跑前检查按被检查的提交切 lint 环境
    const linting = {
      ...counting,
      lintSyncCommand: (c: string) => ["sh", "-c", `echo ${c} > .git/pigeon-lint`],
    };
    await at("sha256:ccc", linting).gateAt(commit, pass);
    assert.equal(readFileSync(join(base, "ref", ".git", "pigeon-lint"), "utf8").trim(), commit);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("等价摘要：旧摘要在等价表里且结果没有挂起迹象的读回；在表里但有卡住用例、检查门没通过的，以及不在表里的，一律重算", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-equivalent-"));
  try {
    const commit = toyRepo(join(base, "human"))({ "src/ok.test.sh": "true\n" }, "Start");
    const human = gitHumanRepo(join(base, "human"));
    mkdirSync(join(base, "ref"));
    const ws = new ReferenceWorkspace(localStreamShell(join(base, "ref")));
    await ws.init(human.bundle(commit), commit);
    const cacheDir = join(base, "cache");
    const image = "sha256:aaa";
    const gate = ["sh", "-c", "exit 0"];
    const equivalentCommands = new Map([
      ["old-cases", commandDigest(toyRuntime.casesCommand)],
      ["old-gate", commandDigest(JSON.stringify(gate))],
    ]);
    const reference = new ReferenceCases({
      reference: ws,
      runtime: toyRuntime,
      cacheDir,
      image,
      equivalentCommands,
    });
    const casesFile = join(cacheDir, `${commit}.json`);
    const gateFile = join(cacheDir, `${commit}.gate.json`);
    const baseline = (extra: object) => ({
      cases: [{ id: "src/ok.test.sh::case", file: "src/ok.test.sh", outcome: "passed" }],
      passing: ["src/ok.test.sh::case"],
      flaky: [],
      slowest: { id: "src/ok.test.sh::case", seconds: 1 },
      runs: [{ peakBytes: null, limitBytes: null, wallMs: 1000 }],
      ...extra,
    });
    // 旧摘要在表里、没有挂起迹象（旧文件没有 stuck 字段：最慢用例与每遍墙钟都远低于上限）：按等价读回
    writeFileSync(
      casesFile,
      JSON.stringify(baseline({ identity: { image, command: "old-cases" } }))
    );
    assert.equal(reference.has(commit), true);
    // 旧摘要在表里，但有卡住的用例：重算
    writeFileSync(
      casesFile,
      JSON.stringify(
        baseline({ identity: { image, command: "old-cases" }, stuck: ["src/ok.test.sh::case"] })
      )
    );
    assert.equal(reference.has(commit), false, "有卡住用例：不按等价读回");
    // 旧文件没有 stuck 字段，但最慢用例达到了单条超时：同样重算
    writeFileSync(
      casesFile,
      JSON.stringify(
        baseline({
          identity: { image, command: "old-cases" },
          slowest: { id: "src/ok.test.sh::case", seconds: 95 },
        })
      )
    );
    assert.equal(reference.has(commit), false, "有超时迹象：不按等价读回");
    // 不在表里：重算
    writeFileSync(casesFile, JSON.stringify(baseline({ identity: { image, command: "other" } })));
    assert.equal(reference.has(commit), false);
    // 开跑前检查：旧摘要在表里且通过的读回；没通过的重算
    const check = { failedSteps: [], wallMs: 1, outputTail: "" };
    writeFileSync(
      gateFile,
      JSON.stringify({ ...check, passed: true, identity: { image, command: "old-gate" } })
    );
    assert.equal(reference.hasGate(commit, gate), true);
    writeFileSync(
      gateFile,
      JSON.stringify({ ...check, passed: false, identity: { image, command: "old-gate" } })
    );
    assert.equal(reference.hasGate(commit, gate), false, "检查门没通过：不按等价读回");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("换根目录：同一份清单、人的基准、检查门结果与身份头整体搬到别的目录下照样读回——落盘内容里没有本机路径，身份只看镜像 ID、命令摘要与清单内容", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-relocate-"));
  try {
    const commit = toyRepo(join(base, "human"))({ "src/ok.test.sh": "true\n" }, "Start");
    const human = gitHumanRepo(join(base, "human"));
    const gate = ["sh", "-c", "exit 0"];
    const tests = ["src/ok.test.sh"];
    let runs = 0;
    const counting = {
      ...toyRuntime,
      runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
        runs++;
        return toyRuntime.runCases(...args);
      },
    };
    const referenceAt = async (root: string) => {
      mkdirSync(join(root, "ref"), { recursive: true });
      const ws = new ReferenceWorkspace(localStreamShell(join(root, "ref")));
      await ws.init(human.bundle(commit), commit);
      return new ReferenceCases({
        reference: ws,
        runtime: counting,
        cacheDir: join(root, "data", "baselines"),
        image: "sha256:img",
      });
    };
    // 原位置：算人的基准与检查门，写清单与身份头
    const a = join(base, "a");
    const first = await referenceAt(a);
    await first.casesAt(commit, tests);
    await first.gateAt(commit, gate);
    const computed = runs;
    mkdirSync(join(a, "data", "out"), { recursive: true });
    writeFileSync(join(a, "data", "manifest.json"), JSON.stringify({ repo: "toy", steps: [] }));
    const identity = {
      core: {
        repo: "toy",
        manifestDigest: manifestDigestOf(join(a, "data", "manifest.json")),
        image: "sha256:img",
        budget: DEFAULT_STEP_BUDGET,
        conditions: ["no-gate"],
        maxSteps: null,
        agents: {},
      },
      info: { concurrency: 1, harness: { commit: "h", dirty: false } },
    };
    const digest = checkOrWriteIdentity(join(a, "data", "out"), identity);
    for (const f of readdirSync(join(a, "data", "baselines"))) {
      const text = readFileSync(join(a, "data", "baselines", f), "utf8");
      assert.ok(
        !text.includes(base.replace(/\\/g, "/")) && !text.includes(base),
        `${f} 里没有本机路径`
      );
    }
    // 整体搬到另一个根目录下
    const b = join(base, "elsewhere", "deeper", "b");
    cpSync(join(a, "data"), join(b, "data"), { recursive: true });
    const moved = await referenceAt(b);
    assert.equal(moved.has(commit), true, "人的基准读回");
    assert.equal(moved.hasGate(commit, gate), true, "检查门结果读回");
    await moved.casesAt(commit, tests);
    assert.equal(runs, computed, "没有重算");
    assert.equal(manifestDigestOf(join(b, "data", "manifest.json")), identity.core.manifestDigest);
    assert.equal(
      checkOrWriteIdentity(join(b, "data", "out"), {
        ...identity,
        core: {
          ...identity.core,
          manifestDigest: manifestDigestOf(join(b, "data", "manifest.json")),
        },
      }),
      digest,
      "身份头比对通过"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("镜像等价只用于人的用例基准：旧镜像的用例基准按镜像等价表读回，检查门结果不按镜像等价、重算；不在表里的镜像重算", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-image-equivalent-"));
  try {
    const commit = toyRepo(join(base, "human"))({ "src/ok.test.sh": "true\n" }, "Start");
    const human = gitHumanRepo(join(base, "human"));
    mkdirSync(join(base, "ref"));
    const ws = new ReferenceWorkspace(localStreamShell(join(base, "ref")));
    await ws.init(human.bundle(commit), commit);
    const cacheDir = join(base, "cache");
    const gate = ["sh", "-c", "exit 0"];
    // 同一个旧镜像可以对多个新镜像（v4 对 v5 与 v6）
    const pairs: [string, string][] = [
      ["sha256:old", "sha256:mid"],
      ["sha256:old", "sha256:new"],
    ];
    const reference = new ReferenceCases({
      reference: ws,
      runtime: toyRuntime,
      cacheDir,
      image: "sha256:new",
      equivalentImages: pairs,
    });
    const casesCommand = commandDigest(toyRuntime.casesCommand);
    const gateCommand = commandDigest(JSON.stringify(gate));
    const cases = (image: string) =>
      JSON.stringify({
        cases: [],
        passing: [],
        flaky: [],
        slowest: null,
        runs: [],
        stuck: [],
        identity: { image, command: casesCommand },
      });
    writeFileSync(join(cacheDir, `${commit}.json`), cases("sha256:old"));
    assert.equal(reference.has(commit), true, "旧镜像的用例基准按镜像等价读回");
    writeFileSync(join(cacheDir, `${commit}.json`), cases("sha256:other"));
    assert.equal(reference.has(commit), false, "不在镜像等价表里：重算");
    writeFileSync(
      join(cacheDir, `${commit}.gate.json`),
      JSON.stringify({
        passed: true,
        failedSteps: [],
        wallMs: 1,
        outputTail: "",
        identity: { image: "sha256:old", command: gateCommand },
      })
    );
    assert.equal(reference.hasGate(commit, gate), false, "检查门结果不按镜像等价");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("等价表里的新摘要就是当前 strands 跑用例外壳的摘要（含改用人的 pytest 配置之前的两个旧摘要）：外壳一改，这条用例即提醒重新审视等价；检查门命令不在表里", () => {
  const cases = commandDigest(strandsRuntime.casesCommand);
  const gate = commandDigest(JSON.stringify(gateFromSteps(strandsRuntime.verifySteps)));
  const pairs = [...EQUIVALENT_BASELINE_COMMANDS];
  assert.deepEqual(new Set(pairs.map(([, b]) => b)), new Set([cases]));
  assert.deepEqual(pairs.map(([a]) => a).sort(), [
    "47c962cd27b0eefe",
    "70f10b887f6bfdc1",
    "da2746ca28858993",
  ]);
  assert.ok(pairs.every(([a, b]) => a !== gate && b !== gate));
});

test("人的基准记录每遍的内存峰值（cgroup 占用减页缓存）、上限与墙钟；峰值超过上限的 75% 即告警", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-memory-"));
  try {
    const commit = toyRepo(join(base, "human"))({ "src/ok.test.sh": "true\n" }, "Start");
    const human = gitHumanRepo(join(base, "human"));
    mkdirSync(join(base, "ref"));
    const ws = new ReferenceWorkspace(localStreamShell(join(base, "ref")));
    await ws.init(human.bundle(commit), commit);
    // 假的 cgroup：占用 1,700,000,000 字节，其中页缓存 100,000,000，上限 2,000,000,000
    const cgroup = join(base, "cgroup");
    mkdirSync(cgroup);
    writeFileSync(join(cgroup, "memory.current"), "1700000000\n");
    writeFileSync(join(cgroup, "memory.stat"), "anon 1500000000\nfile 100000000\n");
    writeFileSync(join(cgroup, "memory.max"), "2000000000\n");
    const warnings: string[] = [];
    const reference = new ReferenceCases({
      reference: ws,
      runtime: toyRuntime,
      cacheDir: join(base, "cache"),
      image: "test-image",
      cgroupDir: cgroup.replace(/\\/g, "/"),
      warn: (m) => warnings.push(m),
    });
    const baseline = await reference.casesAt(commit, ["src/ok.test.sh"]);
    assert.deepEqual(
      baseline.runs.map((r) => [r.peakBytes, r.limitBytes]),
      [
        [1_600_000_000, 2_000_000_000],
        [1_600_000_000, 2_000_000_000],
      ]
    );
    assert.ok(baseline.runs.every((r) => r.wallMs >= 0));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /内存告警.*第 1 遍.*1526 MiB.*1907 MiB 的 75%/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("人的基准提前单独算：只取要全量测量的步的提交、按提交落盘、多路分摊；重跑时已算的跳过；跑批直接读、不再现算；出错的提交记下后接着算", async () => {
  const t = await toy();
  try {
    const targets = baselineTargets({ manifest: t.manifest, human: t.human, runtime: toyRuntime });
    const upToA = ["src/a.test.sh", "src/base.test.sh", "src/keep.test.sh"];
    assert.deepEqual(
      targets.map((x) => [x.commit, x.seqs, x.tests]),
      [
        [t.commits[1], [1], upToA],
        [t.commits[2], [2], upToA],
        [t.commits[4], [4], upToA],
        [
          t.commits[5],
          [5],
          ["src/a.test.sh", "src/b.test.sh", "src/base.test.sh", "src/keep.test.sh"],
        ],
      ]
    );
    let runs = 0;
    // 人的基准与全量测量不另给单条超时，用运行方式的缺省值（与验证门、判题同一口径；探针另给更短的）
    const caseTimeouts: (number | undefined)[] = [];
    const counting = {
      ...toyRuntime,
      runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
        runs++;
        caseTimeouts.push(args[2].caseTimeoutSec);
        return toyRuntime.runCases(...args);
      },
    };
    const measuring = {
      ...toyRuntime,
      runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
        caseTimeouts.push(args[2].caseTimeoutSec);
        return toyRuntime.runCases(...args);
      },
    };
    const end = t.commits[5] ?? "";
    const references = await Promise.all(
      [0, 1].map(async (i) => {
        const root = join(t.base, `baseline-ref-${i}`);
        mkdirSync(root);
        const ws = new ReferenceWorkspace(localStreamShell(root));
        await ws.init(t.human.bundle(end), end);
        return new ReferenceCases({
          reference: ws,
          runtime: counting,
          cacheDir: join(t.base, "baseline"),
          image: "test-image",
        });
      })
    );
    const first = await computeBaselines({ targets, references });
    assert.deepEqual([first.total, first.computed, first.cached, first.failed], [4, 4, 0, []]);
    assert.equal(runs, 8, "每个提交跑两遍");
    const again = await computeBaselines({ targets, references });
    assert.deepEqual([again.computed, again.cached], [0, 4]);
    assert.equal(runs, 8, "已落盘的不再跑");
    // 跑批读同一目录：全量测量不再现算人的基准
    const [reading] = references;
    assert.ok(reading !== undefined);
    const summary = await runStreams(
      options(t, {
        agents: { pigeon: scriptedAgent(() => undefined) },
        reference: reading,
        runtime: measuring,
      })
    );
    assert.equal(runs, 8);
    assert.ok(caseTimeouts.length > 8, "基准与全量测量都跑过");
    assert.ok(caseTimeouts.every((t) => t === undefined));
    const rows = readStreamResults(summary.resultsFile);
    assert.equal(rows.at(-1)?.fullPassRate?.byCount.total, 4);
    assert.equal(rows.at(-1)?.fullPassRate?.humanRuns.length, 2);
    const broken = await computeBaselines({
      targets: [
        { commit: "0000000000000000000000000000000000000000", tests: [], seqs: [9] },
        ...targets,
      ],
      references,
    });
    assert.equal(broken.failed.length, 1);
    assert.equal(broken.cached, 4);
    // 开跑前置检查：人的代码逐个提交跑验证门，列出没过的提交与没过的步；重跑时从落盘结果读回、不再跑
    const gateCommand = gateFromSteps([{ name: "有 b", command: "test -f src/b.txt" }]);
    const order = (list: { commit: string }[]) =>
      list.map((g) => t.commits.indexOf(g.commit)).sort((a, b) => a - b);
    const gated = await computeBaselines({ targets, references, check: "gate", gateCommand });
    assert.deepEqual(order(gated.gateFailures), [1, 2, 4]);
    assert.ok(gated.gateFailures.every((g) => g.failedSteps.join() === "有 b"));
    assert.equal(gated.computed, 4);
    const gatedAgain = await computeBaselines({ targets, references, check: "gate", gateCommand });
    assert.deepEqual(order(gatedAgain.gateFailures), [1, 2, 4], "同一条命令：已落盘的结果直接读回");
    assert.deepEqual([gatedAgain.cached, gatedAgain.computed], [4, 0]);
    // 检查门命令变了：落盘结果的身份不符，全部重跑
    const regated = await computeBaselines({
      targets,
      references,
      check: "gate",
      gateCommand: ["sh", "-c", "exit 1"],
    });
    assert.deepEqual(order(regated.gateFailures), [1, 2, 4, 5]);
    assert.deepEqual([regated.cached, regated.computed], [0, 4]);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("治理根按条件 × 流 × 遍次隔离：同一作业各步共用一个（记忆沿流累积），不同条件、不同遍次各用各的", async () => {
  const t = await toy();
  try {
    const agent = scriptedAgent(() => undefined);
    await runStreams(
      options(t, {
        agents: { pigeon: agent },
        conditions: ["full", "no-memory"],
        attempts: 2,
        maxSteps: 2,
        concurrency: 1,
      })
    );
    const roots = new Map<string, Set<string>>();
    for (const call of agent.calls) {
      const key = `${call.job.stream}|${call.job.condition}|${call.job.attempt}`;
      roots.set(key, (roots.get(key) ?? new Set()).add(call.workDir));
    }
    // 每个作业的两步（题、维护步）都调了 agent，且共用一个治理根
    assert.equal(agent.calls.length, 8);
    assert.deepEqual(
      [...roots.values()].map((set) => set.size),
      [1, 1, 1, 1]
    );
    // 四个作业的治理根两两不同：条件不同或遍次不同都不串用
    const distinct = new Set([...roots.values()].map((set) => [...set][0]));
    assert.equal(distinct.size, 4);
    const of = (key: string) => [...(roots.get(key) ?? [])][0];
    assert.notEqual(of("s1|full|1"), of("s1|full|2"), "两个遍次的治理根不同");
    assert.notEqual(of("s1|full|1"), of("s1|no-memory|1"), "两个条件的治理根不同");
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});
