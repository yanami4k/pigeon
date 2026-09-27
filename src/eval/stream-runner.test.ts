import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
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
import { listSessionIds } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { GatewayMeter } from "./model-gateway.ts";
import { LimitController, QUEUE_VOID_MS } from "./model-limits.ts";
import {
  baselineTargets,
  classTargets,
  computeBaselines,
  computeClasses,
} from "./stream-baseline.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { checkOrWriteIdentity, manifestDigestOf } from "./stream-identity.ts";
import {
  composeStreamManifest,
  markHumanGateFailures,
  type StreamManifest,
  TASK_CHAIN_SCOPE,
  TASK_PROMPT_LAYOUT,
} from "./stream-manifest.ts";
import { learnedDirOf, snapshotOrRestoreLearned } from "./stream-memory-snapshot.ts";
import { gateFromSteps, runJunitOnce, strandsRuntime } from "./stream-profiles.ts";
import { readStreamResults, ZERO_USAGE } from "./stream-results.ts";
import {
  CONDITION_SPECS,
  commandDigest,
  compareRuns,
  DEFAULT_STEP_BUDGET,
  EQUIVALENT_BASELINE_COMMANDS,
  ReferenceCases,
  RUN_LOCK,
  runAdmittedAgent,
  runStreams,
  type StepAgent,
  type StepAgentInput,
  type StepAgentResult,
  type StreamEnvFactory,
  syncEnv,
} from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { git, localStreamEnvs, toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";
import { StreamWorkspace, StreamWorkspaceAccessError } from "./stream-workspace.ts";

const NEEDS_A = `[ -f src/a.txt ] || { echo "Cannot find module 'src/a.txt'"; exit 1; }\n`;

interface Toy {
  base: string;
  human: HumanRepo;
  manifest: StreamManifest;
  reference: ReferenceCases;
  commits: string[];
}

// 人的历史：起点 → 题 A（新建 a，并把已有的 base 测试改成也依赖 a）→ 维护步 → 只改文档（跳过）
// → 只改测试（套用，base 测试不再依赖 a）→ 题 B（依赖 a）。keep 测试此后人不再改。固定起点下只跑两道题：
// 第 1 步（起点为 Start）与第 5 步（起点为"Tweak base test"）
async function toy(
  aTest = `${NEEDS_A}grep -q alpha src/a.txt\n`,
  extraStart: Record<string, string> = {}
): Promise<Toy> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-runner-"));
  const dir = join(base, "human");
  const commit = toyRepo(dir);
  const start = commit(
    {
      "src/base.txt": "base\n",
      "src/base.test.sh": "grep -q base src/base.txt\n",
      "src/keep.test.sh": "true\n",
      ...extraStart,
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
    human,
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

// 两道题都做对的写法
const solve: Script = (input) => {
  if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
  if (input.step.seq === 5) write(input.target.root, { "src/b.txt": "beta\n" });
  return undefined;
};

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
    conditions: ["neither" as const],
    harnessRef: { commit: "test", dirty: false },
    ...overrides,
  };
}

// 判题跑人在该步的全部测试（含 keep）一次：据此认出判题的调用
const isFullRun = (tests: readonly string[]) => tests.includes("src/keep.test.sh");

describe("固定起点跑批（假 agent、本地假容器）", { concurrency: true }, () => {
  test("固定起点：只跑题（维护步、套用步、跳过步不跑），每步从人在该步之前的代码新开干净环境，agent 上一步的改动不带进下一步；题面为提交信息加应通过的测试文件路径、不附内容；人在该步新写或改过的测试开工时不在、判题时放入；每步存下 agent 的改动；结果行记起点与开容器耗时", async () => {
    const t = await toy();
    try {
      const seen: Record<number, { a: boolean; b: boolean; baseTest: string; stray: boolean }> = {};
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        seen[input.step.seq] = {
          a: existsSync(join(root, "src", "a.test.sh")),
          b: existsSync(join(root, "src", "b.test.sh")),
          baseTest: readFileSync(join(root, "src", "base.test.sh"), "utf8"),
          stray: existsSync(join(root, "src", "agent.test.sh")),
        };
        if (input.step.seq === 1) {
          write(root, {
            "src/a.txt": "alpha\n",
            // 篡改旧测试（改成必挂的写法：没换回人的版本即算不许挂的失败）、自建测试、自己提交：判题前都要被程序兜住，
            // 也都不带进下一步
            "src/keep.test.sh": "exit 1\n",
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
        if (input.step.seq === 5) write(root, { "src/b.txt": "beta\n" });
        return undefined;
      });
      const summary = await runStreams(options(t, { agents: { pigeon: agent } }));
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 5 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.kind, r.outcome, r.start]),
        [
          [1, "task", "passed", t.commits[0]],
          [5, "task", "passed", t.commits[4]],
        ]
      );
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 5],
        "agent 只在题上被调用"
      );
      // 开工时：人在该步新写的测试不在，改过的测试还是起点的版本；上一步 agent 的东西不在
      assert.deepEqual(seen[1], {
        a: false,
        b: false,
        baseTest: "grep -q base src/base.txt\n",
        stray: false,
      });
      assert.deepEqual(seen[5], {
        a: true,
        b: false,
        baseTest: "grep -q base src/base.txt && true\n",
        stray: false,
      });
      // 题面：提交信息原文，其后一行说明与应通过的测试文件路径，不附测试内容
      assert.match(
        agent.calls[0]?.prompt ?? "",
        /^Add alpha\n\nCreate src\/a\.txt\n\nTest files that should pass[^\n]*\nsrc\/a\.test\.sh\nsrc\/base\.test\.sh\n$/
      );
      assert.doesNotMatch(agent.calls[0]?.prompt ?? "", /grep|---/);
      // 每步的改动存成 diff：agent 提交了的与没提交的都在；判题时写入的人的测试不在
      const diff1 = readFileSync(join(t.base, "out", rows[0]?.diff ?? "missing"), "utf8");
      assert.match(diff1, /^\+alpha$/m);
      assert.match(diff1, /^diff --git a\/src\/keep\.test\.sh/m);
      assert.match(diff1, /^diff --git a\/src\/agent\.test\.sh/m);
      assert.doesNotMatch(diff1, /a\.test\.sh b\/src\/a\.test\.sh/);
      assert.equal(rows[0]?.diff, "streams/tasks-neither-1/diffs/step-1.diff");
      assert.ok(rows.every((r) => typeof r.envOpenMs === "number" && r.envOpenMs >= 0));
      for (const field of ["head", "regressions", "attribution", "reverted"]) {
        assert.ok(
          rows.every((r) => !(field in r)),
          `新行不写 ${field}`
        );
      }
      const last = rows.at(-1);
      // 第 5 步：b 为要做到的（叠放到起点上失败、人的代码上通过），base、keep、a 为不许挂的
      assert.deepEqual(last?.judging, {
        failToPass: { passed: 1, total: 1 },
        score: 1,
        passToPass: { failed: 0, total: 3 },
        solved: true,
        failedCases: { failToPass: [], passToPass: [], truncated: false },
        excludedFlaky: 0,
      });
      assert.deepEqual(last?.quality, { typeErrors: 0, formatErrors: null, layerViolations: null });
      // 第 1 步：a 与改过的 base 为要做到的，keep 为不许挂的；agent 篡改的 keep 测试已换回人的版本（没换回即挂 1 条），
      // 它自建的测试不在
      assert.deepEqual(rows[0]?.judging?.failToPass, { passed: 2, total: 2 });
      assert.deepEqual(rows[0]?.judging?.passToPass, { failed: 0, total: 1 });
      assert.equal(rows[0]?.judging?.solved, true);
      for (const r of rows) {
        assert.ok(!("fullPassRate" in r), "新行不写全量通过率");
        assert.deepEqual(r.memoryAtStart, { bytes: 0, entries: 0, entryChars: 0 });
        assert.equal(r.review, null);
      }
      assert.deepEqual(
        rows.map((r) => r.envPrefetched),
        [false, true],
        "第 5 步的容器在第 1 步进行时已预先开好"
      );
      // 分步验证配置写进作业的治理根，形状与 .pigeon/verify.json 一致
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(t.base, "out", "streams", "tasks-neither-1", ".pigeon", "verify.json"),
            "utf8"
          )
        ),
        { version: 1, steps: toyRuntime.verifySteps, timeoutMs: 1_800_000 }
      );
      // 每步的环境用完即弃
      assert.deepEqual(readdirSync(join(t.base, "envs", "ws")), []);
      assert.match(
        readFileSync(summary.reportFile, "utf8"),
        /\| neither \| 1 \| 100\.0%（2 步） \|/
      );
      // 两类用例的落盘：之后一侧（人的基准）、之前一侧（叠放运行）与比出的两类各一份
      const cache = join(t.base, "reference-cache");
      assert.deepEqual(
        JSON.parse(readFileSync(join(cache, `${t.commits[1]}.classes.json`), "utf8")),
        {
          seq: 1,
          commit: t.commits[1],
          parent: t.commits[0],
          failToPass: ["src/a.test.sh::case", "src/base.test.sh::case"],
          passToPass: ["src/keep.test.sh::case"],
          excludedFlaky: [],
          failToPassOutsideJudgeFiles: 0,
          unbuildable: null,
        }
      );
      assert.equal(
        JSON.parse(readFileSync(join(cache, `${t.commits[1]}.overlay.json`), "utf8")).parent,
        t.commits[0]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("撞宽上限（171）：agent 以撞轮数或墙钟上限收尾，或轮数、墙钟达到上限，记 hitStepBudget；复盘接入之前 hitReviewBudget 为空", async () => {
    for (const [name, script, expected] of [
      [
        "终态撞墙钟",
        (seq: number) => (seq === 1 ? { status: "wall-clock-limit" } : {}),
        [true, false],
      ],
      ["终态撞轮数", (seq: number) => (seq === 5 ? { status: "turn-limit" } : {}), [false, true]],
      ["轮数达到上限", (seq: number) => (seq === 1 ? { turns: 4 } : {}), [true, false]],
      ["墙钟达到上限", (seq: number) => (seq === 5 ? { wallMs: 60_000 } : {}), [false, true]],
    ] as const) {
      const t = await toy();
      try {
        const agent = scriptedAgent((input) => ({ ...solve(input), ...script(input.step.seq) }));
        const summary = await runStreams(
          options(t, {
            agents: { pigeon: agent },
            budget: { maxTurns: 4, wallClockMs: 60_000 },
          })
        );
        const rows = readStreamResults(summary.resultsFile);
        assert.deepEqual(
          rows.map((r) => r.hitStepBudget),
          [...expected],
          name
        );
        assert.deepEqual(
          rows.map((r) => r.hitReviewBudget),
          [null, null],
          name
        );
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("回炉最终不通过的题判为失败，记下回炉轮数与结论；下一题仍从人的代码开工，不受它影响", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent((input) => {
        const root = input.target.root;
        if (input.step.seq === 1) {
          write(root, { "src/a.txt": "wrong\n" });
          return { repair: { rounds: 2, finalVerdict: "fail" } };
        }
        write(root, { "src/b.txt": "beta\n" });
        return { repair: { rounds: 0, finalVerdict: "pass" } };
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["search-only"] })
      );
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.repairRounds, r.finalVerdict]),
        [
          [1, "failed", 2, "fail"],
          [5, "passed", 0, "pass"],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("判题的全量运行在报告写出前被杀、一条结果都没拿到：两类用例的分母仍按人这一侧，要做到的与不许挂的全部计为未通过", async () => {
    // a 的测试在 a.txt 写成 wrong 时把跑测试的外壳杀掉：人的代码与起点上都照常出结果，写错了的 agent 代码上整次运行拿不到报告
    const t = await toy(
      `${NEEDS_A}grep -q wrong src/a.txt && kill -9 $PPID\ngrep -q alpha src/a.txt\n`
    );
    try {
      const agent = scriptedAgent((input) => {
        write(input.target.root, { "src/a.txt": "wrong\n" });
        return { repair: { rounds: 3, finalVerdict: "fail" } };
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["search-only"], maxSteps: 1 })
      );
      const [r1] = readStreamResults(summary.resultsFile);
      assert.equal(r1?.outcome, "failed");
      assert.deepEqual(r1?.judging?.failToPass, { passed: 0, total: 2 });
      assert.equal(r1?.judging?.score, 0);
      assert.deepEqual(r1?.judging?.passToPass, { failed: 1, total: 1 });
      assert.equal(r1?.judging?.solved, false);
      assert.deepEqual(r1?.judging?.failedCases, {
        failToPass: ["src/a.test.sh::case", "src/base.test.sh::case"],
        passToPass: ["src/keep.test.sh::case"],
        truncated: false,
      });
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("被打断的一步整题作废不留行，重做时另开干净环境（作废尝试的改动不在）；续跑从结果行接着做下一题；试跑只跑前 K 道题", async () => {
    const t = await toy();
    try {
      const sawHalf: boolean[] = [];
      const flaky = scriptedAgent((input) => {
        if (input.step.seq === 5) {
          sawHalf.push(existsSync(join(input.target.root, "src", "half.txt")));
          write(input.target.root, { "src/half.txt": "half done\n" });
          return { interrupted: "模型服务故障" };
        }
        return solve(input);
      });
      const first = await runStreams(options(t, { agents: { pigeon: flaky }, maxSteps: 2 }));
      assert.equal(first.jobs[0]?.completedTo, 1);
      // 没有限额信号的被打断：作废重做，连续超过上限才停下作业
      assert.match(
        first.jobs[0]?.stopped ?? "",
        /第 5 步连续 4 次被打断.*agent 报被打断：模型服务故障/
      );
      assert.equal(flaky.calls.filter((c) => c.step.seq === 5).length, 4);
      assert.deepEqual(sawHalf, [false, false, false, false], "每次重做都另开干净环境");
      assert.deepEqual(
        readStreamResults(first.resultsFile).map((r) => r.seq),
        [1]
      );
      const again = scriptedAgent(solve);
      const second = await runStreams(options(t, { agents: { pigeon: again }, maxSteps: 2 }));
      assert.deepEqual(second.jobs, [{ key: "tasks|neither|1", completedTo: 5 }]);
      assert.deepEqual(
        readStreamResults(second.resultsFile).map((r) => [r.seq, r.outcome]),
        [
          [1, "passed"],
          [5, "passed"],
        ]
      );
      assert.deepEqual(
        again.calls.map((c) => c.step.seq),
        [5]
      );
      assert.match(readFileSync(second.reportFile, "utf8"), /试跑：只跑前 2 道题/);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("记忆快照（191）：每步开工前取 .pigeon/learned/ 的快照；作废重做前恢复成快照（作废尝试写下的不留）；进程死在一步中途之后续跑，同样恢复成那一步的快照", async () => {
    const t = await toy();
    try {
      const memoryOf = (workDir: string) => {
        const file = join(learnedDirOf(workDir), "MEMORY.md");
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      };
      const remember = (workDir: string, text: string) => {
        mkdirSync(learnedDirOf(workDir), { recursive: true });
        writeFileSync(join(learnedDirOf(workDir), "MEMORY.md"), text);
      };
      const seen: [number, string | null][] = [];
      let attempts = 0;
      const agent = scriptedAgent((input) => {
        seen.push([input.step.seq, memoryOf(input.workDir)]);
        if (input.step.seq === 1 && attempts++ === 0) {
          remember(input.workDir, "作废尝试写下的\n");
          return { interrupted: "模型服务故障" };
        }
        // 第 1 步之后一条，第 5 步之后两条（229 的条目格式）
        remember(input.workDir, input.step.seq === 1 ? "- [L1] 甲\n" : "- [L1] 甲\n- [L2] 乙乙\n");
        return solve(input);
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      const jobDir = join(t.base, "out", "streams", "tasks-neither-1");
      // 模拟第 5 步开工、取过快照之后进程被杀：记忆里留着半截写下的东西
      snapshotOrRestoreLearned(jobDir, 5);
      remember(jobDir, "崩溃前半截写下的\n");
      const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(seen, [
        [1, null],
        [1, null],
        [5, "- [L1] 甲\n"],
      ]);
      assert.equal(memoryOf(jobDir), "- [L1] 甲\n- [L2] 乙乙\n");
      // 结果行记开工时（恢复快照之后）与步末（agent 结束之后）的记忆大小：作废尝试与崩溃前半截写下的都不计
      const one = { bytes: Buffer.byteLength("- [L1] 甲\n"), entries: 1, entryChars: 9 };
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.seq, r.memoryAtStart, r.memoryAtEnd]),
        [
          [1, { bytes: 0, entries: 0, entryChars: 0 }, one],
          [
            5,
            one,
            { bytes: Buffer.byteLength("- [L1] 甲\n- [L2] 乙乙\n"), entries: 2, entryChars: 19 },
          ],
        ]
      );
      assert.deepEqual(readdirSync(join(jobDir, "learned-snapshots")).sort(), ["step-1", "step-5"]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("限额：一步撞上额度即作废，整批恢复后另开环境重做同一步，暂停记录挂在该步结果行上；轮数与 token 取网关计量", async () => {
    const t = await toy();
    try {
      const limits = new LimitController({
        probe: async () => true,
        slots: 2,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        warn: () => {},
      });
      // 计量带花费与单次请求输入峰值（网关计价接入之后的形状）：跑批器按步做差读花费、峰值直接读
      type PricedMeter = GatewayMeter & { costCny: number; peakInputTokens: number };
      const zero: PricedMeter = {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        accountRequests: [0, 0],
        costCny: 0,
        peakInputTokens: 0,
      };
      const meters = new Map<string, PricedMeter>();
      const gateway = {
        jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
        meter: (job: string) => ({ ...(meters.get(job) ?? zero) }),
        resetPeak: (job: string) => {
          const m = meters.get(job);
          if (m !== undefined) meters.set(job, { ...m, peakInFlight: 0, peakInputTokens: 0 });
        },
      };
      let hits = 0;
      const agent = scriptedAgent((input) => {
        const key = `${input.job.stream}|${input.job.condition}|${input.job.attempt}`;
        const m = meters.get(key) ?? zero;
        meters.set(key, {
          ...m,
          requests: m.requests + 2,
          input: m.input + 100,
          output: m.output + 10,
          queueMs: m.queueMs + 30,
          // 峰值不重记就会沿步累加：跑批器每步开始时 resetPeak
          peakInFlight: m.peakInFlight + 1,
          accountRequests: [(m.accountRequests[0] ?? 0) + 1, (m.accountRequests[1] ?? 0) + 1],
          costCny: m.costCny + 0.25,
          // 峰值同样每步重记：没重记会留着上一步的 5000
          peakInputTokens: Math.max(m.peakInputTokens, input.step.seq === 1 ? 5000 : 1200),
        });
        assert.equal(input.modelBaseUrl, "http://gateway/j/tasks|neither|1");
        if (input.step.seq === 5 && hits++ === 0) {
          limits.onLimit("5h");
          return { interrupted: "网关暂停" };
        }
        return solve(input);
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, maxSteps: 2, limits, gateway })
      );
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 5 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.limitPauses.map((p) => p.kind)]),
        [
          [1, "passed", []],
          [5, "passed", ["5h"]],
        ]
      );
      assert.equal(rows[1]?.limitPauses[0]?.endedAt !== null, true);
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 5, 5]
      );
      // 计量取网关：每次调用记 2 次请求、100 输入、10 输出
      assert.deepEqual([rows[0]?.turns, rows[0]?.usage.totalTokens], [2, 110]);
      // 网关的排队时间、各账号请求数与花费按步取差，在途峰值与单次请求输入峰值直接取（每步开始时重记）；
      // 复盘花费在复盘接入之前为 null。第 5 步作废过一次：作废那次的花费不算进重做的这一步
      assert.deepEqual(rows[0]?.gateway, {
        queueMs: 30,
        accountRequests: [1, 1],
        peakInFlight: 1,
        costCny: 0.25,
        reviewCostCny: null,
        peakInputTokens: 5000,
      });
      assert.deepEqual(rows[1]?.gateway, {
        queueMs: 30,
        accountRequests: [1, 1],
        peakInFlight: 1,
        costCny: 0.25,
        reviewCostCny: null,
        peakInputTokens: 1200,
      });
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 暂存了人写测试的改名：判题前原路径恢复成起点的版本、改名后的路径删掉，作业不中止", async () => {
    const t = await toy();
    try {
      const atJudge: string[][] = [];
      const runtime: typeof toyRuntime = {
        ...toyRuntime,
        runCases: (ws, tests, opts) => {
          atJudge.push(
            ["src/base.test.sh", "src/moved.test.sh"].filter((f) => existsSync(join(ws.root, f)))
          );
          return toyRuntime.runCases(ws, tests, opts);
        },
      };
      const agent = scriptedAgent((input) => {
        write(input.target.root, { "src/a.txt": "alpha\n" });
        git(input.target.root, "mv", "src/base.test.sh", "src/moved.test.sh");
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 })
      );
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 1 }]);
      assert.equal(readStreamResults(summary.resultsFile)[0]?.outcome, "passed");
      assert.deepEqual(atJudge, [["src/base.test.sh"]]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("全量测量与人写测试集一致：agent 新建的测试文件（未跟踪的也算）测量时不在", async () => {
    const t = await toy();
    try {
      const atMeasure: boolean[] = [];
      const runtime: typeof toyRuntime = {
        ...toyRuntime,
        runCases: (ws, tests, opts) => {
          if (isFullRun(tests)) atMeasure.push(existsSync(join(ws.root, "src", "agent.test.sh")));
          return toyRuntime.runCases(ws, tests, opts);
        },
      };
      const agent = scriptedAgent((input) => {
        write(input.target.root, { "src/a.txt": "alpha\n", "src/agent.test.sh": "exit 1\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 }));
      assert.deepEqual(atMeasure, [false]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 新建的、落在人写测试目录树上的 conftest 不影响判题与测量：判题前删掉（被 .gitignore 藏起来的也删，单个文件或整个目录被忽略都一样）；下一题开工时也不在", async () => {
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
              where: isFullRun(tests) ? "full" : "subset",
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
        let atStep5: string[] | undefined;
        const agent = scriptedAgent((input) => {
          if (input.step.seq === 5) {
            atStep5 = hooks.filter((h) => existsSync(join(input.target.root, h)));
            write(input.target.root, { "src/b.txt": "beta\n" });
          }
          if (input.step.seq === 1) {
            write(input.target.root, {
              "src/a.txt": "wrong\n",
              // 这份还被 agent 写进了 .gitignore（这个文件本身，或它所在的整个目录）：git status 看不到它
              ".gitignore": ignore,
              "src/conftest.sh": "sh() { return 0; }\n",
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
        // 判题只跑一次全量（含 keep 的全部人写测试），每步一次
        assert.deepEqual(
          seen.map((s) => s.where),
          ["full", "full"]
        );
        assert.deepEqual(
          seen.filter((s) => s.present.length > 0),
          [],
          `${ignore}：判题时没有 agent 新建的 conftest`
        );
        assert.deepEqual(atStep5, [], `${ignore}：下一题开工时不在工作区里`);
        // 回炉前删 conftest 用的人树按起点：人在该步之前的树里的全部路径
        assert.deepEqual(
          [...(agent.calls[0]?.humanTree ?? [])].sort(),
          t.human
            .tree(agent.calls[0]?.step.parent ?? "")
            .map((e) => e.path)
            .sort(),
          `${ignore}：交给 agent 的人树`
        );
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("还原人写测试防绕过：agent 给起点里人写的测试设 skip-worktree 或 assume-unchanged 再改，测量前照样还原；跑批器自己的 git 操作不执行 agent 放进 .git/hooks 的钩子", async () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      const t = await toy();
      try {
        const marker = join(t.base, "hook-ran").replace(/\\/g, "/");
        const agent = scriptedAgent((input) => {
          const root = input.target.root;
          write(root, { "src/a.txt": "alpha\n" });
          // keep 测试人在该步没改：把它改成恒败、并对 git 隐藏这处改动
          git(root, "update-index", flag, "src/keep.test.sh");
          write(root, { "src/keep.test.sh": "exit 1\n" });
          mkdirSync(join(root, ".git", "hooks"), { recursive: true });
          for (const hook of ["post-commit", "post-checkout", "post-index-change"]) {
            writeFileSync(join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`, {
              mode: 0o755,
            });
          }
          return undefined;
        });
        const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
        const [row] = readStreamResults(summary.resultsFile);
        assert.deepEqual(
          row?.judging?.passToPass,
          { failed: 0, total: 1 },
          `${flag}：隐藏的改动被还原，keep 测试（不许挂的）照常通过`
        );
        assert.equal(existsSync(marker), false, `${flag}：agent 的钩子没有被执行`);
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("交给 agent 的人写测试集按起点：人在该步之前的树里的测试与测试辅助文件，人在该步新写的不在其内", async () => {
    const t = await toy();
    try {
      const runtime: typeof toyRuntime = { ...toyRuntime, autoloadedTestHelper: "conftest.sh" };
      const agent = scriptedAgent(solve);
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 }));
      assert.deepEqual(
        agent.calls.map((c) => [
          c.step.seq,
          [...(c.humanTestFiles ?? [])].sort(),
          [...(c.humanTests ?? [])].sort(),
        ]),
        [
          [1, ["src/base.test.sh", "src/keep.test.sh"], ["src/base.test.sh", "src/keep.test.sh"]],
          [
            5,
            ["src/a.test.sh", "src/base.test.sh", "src/keep.test.sh"],
            ["src/a.test.sh", "src/base.test.sh", "src/keep.test.sh"],
          ],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("agent 自己测试的辅助文件：判题的全量运行前按人在该步的全部测试与测试辅助文件同步掉（与原全量测量同一口径）；被忽略的 __pycache__/ 与 agent 在 .gitignore 里写的整目录不让作业停下", async () => {
    const t = await toy();
    try {
      // 与 strands 相仿：src 下除用例与已知源文件外都归测试辅助
      const own = [
        "src/agent/conftest.sh",
        "src/agent/helper.aux",
        "src/agent/__init__.aux",
        "src/agent/data.aux",
      ];
      let atJudge: string[] | undefined;
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
        runCases: (ws, tests, opts) => {
          atJudge = own.filter((f) => existsSync(join(ws.root, f)));
          return toyRuntime.runCases(ws, tests, opts);
        },
      };
      const agent = scriptedAgent((input) => {
        write(input.target.root, {
          "src/a.txt": "alpha\n",
          ".gitignore": "__pycache__/\nsrc/cachedir/\n",
          "src/__pycache__/a.cpython-310.pyc": "x",
          "src/cachedir/deep/conftest.sh": "true\n",
          ...Object.fromEntries(own.map((f) => [f, "ok=1\n"])),
          "src/agent.test.sh": '. src/agent/helper.aux && [ "$ok" = 1 ]\n',
        });
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 })
      );
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 1 }], "作业没有停下");
      assert.equal(readStreamResults(summary.resultsFile)[0]?.outcome, "passed");
      assert.deepEqual(atJudge, [], "agent 自己的辅助文件（跟踪得到的）判题时不在");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("判题前清理（195 补口）：agent 放的解释器启动钩子（文件与包目录）删掉、人树里有的保留；静态检查配置写回人的版本、人树里没有的删掉；家目录下的用户级文件删掉", async () => {
    const t = await toy(undefined, { "lint.cfg": "strict\n", "src/sitecustomize.keep": "human\n" });
    try {
      const home = join(t.base, "home");
      const inner = localStreamEnvs(join(t.base, "envs"), (c: string) => t.human.bundle(c));
      const envs: StreamEnvFactory = {
        async open(job, init) {
          const env = await inner.open(job, init);
          return {
            ...env,
            ws: new StreamWorkspace(localStreamShell(env.target.root), { homeDir: home }),
          };
        },
      };
      const runtime: typeof toyRuntime = {
        ...toyRuntime,
        judgeHygiene: {
          startupHooks: ["sitecustomize", "sitecustomize.*"],
          lintConfigs: ["lint.cfg"],
          homePaths: [".local/lib", ".lint.cfg"],
        },
      };
      let atJudge: Record<string, string | boolean> | undefined;
      const judging: typeof toyRuntime = {
        ...runtime,
        runCases: (ws, tests, opts) => {
          const at = (p: string) => join(ws.root, p);
          atJudge = {
            hookFile: existsSync(at("src/sitecustomize.sh")),
            hookDir: existsSync(at("deep/sitecustomize")),
            humanHook: existsSync(at("src/sitecustomize.keep")),
            lint: readFileSync(at("lint.cfg"), "utf8"),
            agentLint: existsSync(at("src/lint.cfg")),
            userSite: existsSync(join(home, ".local", "lib")),
            userLint: existsSync(join(home, ".lint.cfg")),
            userOther: existsSync(join(home, ".bashrc")),
          };
          return toyRuntime.runCases(ws, tests, opts);
        },
      };
      const agent = scriptedAgent((input) => {
        write(input.target.root, {
          "src/a.txt": "alpha\n",
          "src/sitecustomize.sh": "x\n",
          "deep/sitecustomize/__init__.py": "x\n",
          "lint.cfg": "lenient\n",
          "src/lint.cfg": "lenient\n",
        });
        write(home, {
          ".local/lib/python3/site-packages/usercustomize.py": "x\n",
          ".lint.cfg": "lenient\n",
          ".bashrc": "keep\n",
        });
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime: judging, envs, maxSteps: 1 })
      );
      assert.equal(readStreamResults(summary.resultsFile)[0]?.outcome, "passed");
      assert.deepEqual(atJudge, {
        hookFile: false,
        hookDir: false,
        humanHook: true,
        lint: "strict\n",
        agentLint: false,
        userSite: false,
        userLint: false,
        userOther: true,
      });
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("依赖环境按人在该步的依赖声明选：agent 改了声明文件，开工与判题前切环境仍用人的版本；结果行记下 agent 改了依赖声明", async () => {
    const t = await toy();
    try {
      // 以 src/base.txt 充当依赖声明文件；切环境的命令把收到的声明内容追加进工作区的记录
      const logs: string[][] = [];
      const runtime: typeof toyRuntime = {
        ...toyRuntime,
        envDeclarationFile: "src/base.txt",
        envSyncFor: (file: string) => ["sh", "-c", `cat "${file}" >> .git/decl-log`],
        runCases: (ws, tests, opts) => {
          logs.push(
            readFileSync(join(ws.root, ".git", "decl-log"), "utf8")
              .split("\n")
              .filter((l) => l !== "")
          );
          return toyRuntime.runCases(ws, tests, opts);
        },
      };
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1)
          write(input.target.root, { "src/a.txt": "alpha\n", "src/base.txt": "base agent\n" });
        return solve(input);
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.seq, r.agentChangedDeps]),
        [
          [1, true],
          [5, false],
        ]
      );
      // 每步开工与判题前各切一次，用的都是人在该步的声明，从来不是 agent 改过的
      assert.deepEqual(logs, [
        ["base", "base"],
        ["base v2", "base v2"],
      ]);
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
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 5 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.judged, r.diff]),
        [
          [1, "skipped", false, null],
          [5, "skipped", false, null],
        ]
      );
      assert.ok(rows.every((r) => /依赖环境选择失败.*作废/s.test(r.error ?? "")));
      assert.equal(agent.calls.length, 0);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("判题前切环境时找不到可用的依赖组合（退出码 3）：这一步作废、记下原因，下一题照常", async () => {
    const t = await toy();
    try {
      // 每个环境里第一次切换照常，第二次（agent 之后、判题之前）选不出组合
      const runtime = {
        ...toyRuntime,
        envDeclarationFile: "src/base.txt",
        envSyncFor: () => ["sh", "-c", "if [ -f .git/synced ]; then exit 3; fi; touch .git/synced"],
      };
      const agent = scriptedAgent(solve);
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, maxSteps: 2 })
      );
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 5 }]);
      const rows = readStreamResults(summary.resultsFile);
      assert.deepEqual(
        rows.map((r) => [r.seq, r.outcome, r.judged]),
        [
          [1, "skipped", false],
          [5, "skipped", false],
        ]
      );
      assert.ok(rows.every((r) => /依赖环境选择失败.*作废/s.test(r.error ?? "")));
      assert.equal(agent.calls.length, 2, "agent 照常跑过");
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

  test("测试配置按人在该步的版本写入：agent 运行前与判题前写的都是人的文件，不是 agent 改过的", async () => {
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
        write(input.target.root, { "src/a.txt": "alpha\n", "src/base.txt": "agent 的配置\n" });
        return undefined;
      });
      await runStreams(options(t, { agents: { pigeon: agent }, runtime, maxSteps: 1 }));
      assert.deepEqual(pinned, ["base\n", "base\n"]);
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
        return solve(input);
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
      const agent = scriptedAgent(solve);
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent, minimal: agent },
          conditions: ["neither", "minimal"],
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
            "neither",
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

  test("条件表（193、194）：四格都是 Pigeon、开 3 轮回炉，按能否检索与有无推送各开关；最简 agent 不开回炉；各条件原样交给 agent", async () => {
    assert.deepEqual(
      Object.values(CONDITION_SPECS).map((c) => [
        c.name,
        c.agent,
        c.repairRounds,
        c.sessionSearch,
        c.pushedMemory,
      ]),
      [
        ["search-push", "pigeon", 3, true, true],
        ["search-only", "pigeon", 3, true, false],
        ["push-only", "pigeon", 3, false, true],
        ["neither", "pigeon", 3, false, false],
        ["minimal", "minimal", 0, false, false],
      ]
    );
    const t = await toy();
    try {
      const agent = scriptedAgent(solve);
      await runStreams(
        options(t, {
          agents: { pigeon: agent },
          conditions: ["search-only", "neither"],
          maxSteps: 1,
          concurrency: 1,
        })
      );
      assert.deepEqual(
        agent.calls.map((c) => [c.job.condition, c.condition]),
        [
          ["search-only", CONDITION_SPECS["search-only"]],
          ["neither", CONDITION_SPECS.neither],
        ]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("题面给用例名（213 的备用）：名单为这一步要做到的用例（214），不附内容；不许挂的不在名单里", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent(solve);
      await runStreams(options(t, { agents: { pigeon: agent }, promptFormat: "test-cases" }));
      assert.match(
        agent.calls[0]?.prompt ?? "",
        /^Add alpha\n\nCreate src\/a\.txt\n\nTest cases that should pass[^\n]*\nsrc\/a\.test\.sh::case\nsrc\/base\.test\.sh::case\n$/
      );
      assert.match(
        agent.calls[1]?.prompt ?? "",
        /^Add beta\n\nTest cases that should pass[^\n]*\nsrc\/b\.test\.sh::case\n$/
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("题面两段名单（①）：要做到的用例有落在本题新写或改过的测试文件之外的，另列第二段（测试文件路径去重排序，或用例名）；这些文件开工时就在工作区里；没有这类用例的题只有一段", async () => {
    // 起点就有的两个测试依赖第 1 步才新建的 a.txt：起点上失败、人的代码上通过，人在第 1 步没改它们
    const needsAlpha = "grep -q alpha src/a.txt 2>/dev/null\n";
    for (const format of ["test-files", "test-cases"] as const) {
      const t = await toy(undefined, {
        "src/z.test.sh": needsAlpha,
        "src/other.test.sh": needsAlpha,
      });
      try {
        const present: boolean[] = [];
        const agent = scriptedAgent((input) => {
          present.push(existsSync(join(input.target.root, "src", "other.test.sh")));
          return solve(input);
        });
        const summary = await runStreams(
          options(t, { agents: { pigeon: agent }, promptFormat: format })
        );
        const second =
          format === "test-files"
            ? "Other test files already in the repository that currently fail and should pass after the change:\nsrc/other.test.sh\nsrc/z.test.sh\n"
            : "Other test cases in test files already in the repository that currently fail and should pass after the change:\nsrc/other.test.sh::case\nsrc/z.test.sh::case\n";
        const first =
          format === "test-files"
            ? "src/a.test.sh\nsrc/base.test.sh"
            : "src/a.test.sh::case\nsrc/base.test.sh::case";
        assert.equal(
          agent.calls[0]?.prompt,
          `Add alpha\n\nCreate src/a.txt\n\n${
            format === "test-files" ? "Test files" : "Test cases"
          } that should pass${(agent.calls[0]?.prompt ?? "").split("should pass")[1]?.split("\n")[0]}\n${first}\n\n${second}`,
          format
        );
        assert.doesNotMatch(
          agent.calls[1]?.prompt ?? "",
          /Other test/,
          `${format}：第 5 步只有一段`
        );
        assert.deepEqual(present, [true, true], "第二段的文件开工时在工作区里");
        const [r1] = readStreamResults(summary.resultsFile);
        assert.deepEqual(r1?.judging?.failToPass, { passed: 4, total: 4 });
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    }
  });

  test("人的代码没过检查门的步：清单按预检结果打标记（其余去掉），结果行照抄这一列，步照常跑", async () => {
    const t = await toy();
    try {
      const s1 = t.manifest.steps.find((s) => s.seq === 1);
      const s5 = t.manifest.steps.find((s) => s.seq === 5);
      assert.ok(s1 !== undefined && s5 !== undefined);
      const stale = {
        ...t.manifest,
        steps: t.manifest.steps.map((s) => (s.seq === 1 ? { ...s, humanFailsGate: true } : s)),
      };
      const marked = markHumanGateFailures(stale, [s5.commit]);
      assert.deepEqual(
        marked.steps.filter((s) => s.kind === "task").map((s) => [s.seq, s.humanFailsGate]),
        [
          [1, undefined],
          [5, true],
        ]
      );
      const agent = scriptedAgent(solve);
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, manifest: marked, maxSteps: 2 })
      );
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.seq, r.humanFailsGate, r.judged]),
        [
          [1, false, true],
          [5, true, true],
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
        solve(input);
        return input.condition.repairRounds > 0
          ? { repair: { rounds: 1, finalVerdict: "pass", humanTestRestores: 2 } }
          : undefined;
      });
      const summary = await runStreams(
        options(t, {
          agents: { pigeon: agent, minimal: agent },
          conditions: ["search-only", "minimal"],
          maxSteps: 1,
          concurrency: 1,
        })
      );
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.condition, r.humanTestRestores]),
        [
          ["search-only", 2],
          ["minimal", null],
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
          conditions: ["minimal", "neither"],
          maxSteps: 1,
          concurrency: 1,
          limits,
          gateway,
        })
      );
      assert.deepEqual(
        summary.jobs.map((j) => [j.key, j.completedTo, j.stopped]),
        [
          ["tasks|minimal|1", 1, undefined],
          ["tasks|neither|1", 1, undefined],
        ]
      );
      const rows = readStreamResults(summary.resultsFile);
      // 每个作业只留一行、判为通过：前四次都作废了，没有按"wrong"判分
      assert.deepEqual(
        rows.map((r) => [r.condition, r.seq, r.outcome]),
        [
          ["minimal", 1, "passed"],
          ["neither", 1, "passed"],
        ]
      );
      assert.deepEqual([mini.calls.length, pigeon.calls.length], [5, 5]);
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("作废一步时清掉这次尝试的痕迹：重做时会话检索搜不到上一次尝试，会话移到治理根之外的隔离目录", async () => {
    const t = await toy();
    try {
      const clue = "作废尝试留下的线索甲乙丙";
      let voidedSession = "";
      const seenOnRetry: { hits: number; sessions: string[] }[] = [];
      const calls: StepAgentInput[] = [];
      const agent: StepAgent = {
        async run(input) {
          calls.push(input);
          const sessionsDir = join(input.workDir, ".pigeon", "sessions");
          if (input.step.seq === 1 && calls.length === 1) {
            // 第一次尝试：真实地跑一次 headless，会话落进治理根；然后报被打断
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
            assert.ok(listSessionIds(sessionsDir).includes(run.sessionId));
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
            seenOnRetry.push({ hits: hits.length, sessions: listSessionIds(sessionsDir) });
            write(input.target.root, { "src/a.txt": "alpha\n" });
          }
          return { status: "completed", turns: 1, usage: ZERO_USAGE, wallMs: 5, repair: null };
        },
      };
      const summary = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      assert.deepEqual(summary.jobs, [{ key: "tasks|neither|1", completedTo: 1 }]);
      assert.notEqual(voidedSession, "");
      assert.deepEqual(seenOnRetry, [{ hits: 0, sessions: [] }]);
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
        return solve(input);
      });
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      const jobDir = join(t.base, "out", "streams", "tasks-neither-1");
      const sessions = join(jobDir, ".pigeon", "sessions");
      assert.ok(existsSync(join(jobDir, "sessions-1.json")));
      // 模拟第 5 步做到一半进程被杀：会话留在治理根，没有结果行
      writeFileSync(join(sessions, "sess_crashed.jsonl"), "{}\n");
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(readdirSync(sessions).sort(), ["sess_step1.jsonl", "sess_step5.jsonl"]);
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

  test("同一步一再作废：上游故障（与限额信号同一口径）累计 5 次告警一次、10 次停下作业；只因排队超时的单独计数，10 次告警一次、不停作业，累计 30 次才停下", async () => {
    for (const cause of ["upstream", "queue"] as const) {
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
        // 每次尝试都遇到一次上游故障，或等空闲账号累计超过 30 秒
        const agent = scriptedAgent((input) => {
          const key = `${input.job.stream}|${input.job.condition}|${input.job.attempt}`;
          const m = meters.get(key) ?? zero;
          meters.set(
            key,
            cause === "upstream"
              ? { ...m, upstreamFailures: m.upstreamFailures + 1 }
              : { ...m, queueMs: m.queueMs + QUEUE_VOID_MS + 1_000 }
          );
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
        const [stopAt, warnAt] = cause === "upstream" ? [10, 5] : [30, 10];
        assert.match(
          summary.jobs[0]?.stopped ?? "",
          new RegExp(`累计作废 ${stopAt} 次：停下作业`),
          cause
        );
        assert.equal(agent.calls.length, stopAt, cause);
        assert.equal(warnings.length, 1, cause);
        assert.match(warnings[0] ?? "", new RegExp(`已累计作废 ${warnAt} 次`), cause);
        assert.deepEqual(readStreamResults(summary.resultsFile), [], cause);
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
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
            [{ key: "tasks|neither|1", completedTo: 1 }],
            `${how}${voided ? "后作废" : "后照常收工"}：作业没有停下`
          );
          assert.equal(attempts, voided ? 2 : 1);
        } finally {
          rmSync(t.base, { recursive: true, force: true });
        }
      }
    }
  });

  // 排队作废（决策 163）：Pigeon 与最简 agent 各跑一遍，绑定"不看 agent 种类"
  for (const kind of ["pigeon", "minimal"] as const) {
    test(`排队作废（${kind === "pigeon" ? "Pigeon" : "最简 agent"}）：网关报排队超 30 秒即经按步中止立即停下在途的 agent、作废重做；事后才查到超 30 秒的同样作废；恰为 30 秒不作废；结果行记放行等待`, async () => {
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
        const watchers = new Map<string, () => void>();
        const gateway = {
          jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
          meter: (job: string) => ({ ...(meters.get(job) ?? zero) }),
          resetPeak: () => {},
          watchQueue: (job: string, thresholdMs: number, listener: () => void) => {
            assert.equal(thresholdMs, 30_000);
            watchers.set(job, listener);
            return () => watchers.delete(job);
          },
        };
        const addQueue = (key: string, ms: number) => {
          const m = meters.get(key) ?? zero;
          meters.set(key, { ...m, requests: m.requests + 1, queueMs: m.queueMs + ms });
        };
        // 第 1 次：排队中网关报超时，agent 一直跑到被按步中止为止（5 秒内没被中止即照常收工，用例随之失败）；
        // 第 2 次：事后查到排队 31 秒；第 3 次：恰为 30 秒
        const calls: StepAgentInput[] = [];
        let abortedWhileRunning = false;
        const agent: StepAgent = {
          async run(input) {
            calls.push(input);
            const key = `${input.job.stream}|${input.job.condition}|${input.job.attempt}`;
            const done = {
              status: "completed",
              turns: 1,
              usage: ZERO_USAGE,
              wallMs: 5,
              repair: null,
            };
            if (calls.length === 1) {
              addQueue(key, 31_000);
              watchers.get(key)?.();
              const aborted = await new Promise<boolean>((resolve) => {
                if (input.abortSignal?.aborted === true) resolve(true);
                input.abortSignal?.addEventListener("abort", () => resolve(true));
                setTimeout(() => resolve(false), 5000).unref();
              });
              abortedWhileRunning = aborted;
              return aborted ? { ...done, status: "aborted", interrupted: "按步中止" } : done;
            }
            addQueue(key, calls.length === 2 ? 31_000 : 30_000);
            if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
            return done;
          },
        };
        const log: string[] = [];
        const summary = await runStreams(
          options(t, {
            agents: { [kind]: agent },
            conditions: [kind === "pigeon" ? "neither" : "minimal"],
            maxSteps: 1,
            gateway,
            log: (line) => log.push(line),
          })
        );
        assert.equal(abortedWhileRunning, true, "在途的 agent 被按步中止，不等它跑完");
        assert.equal(calls.length, 3, "前两次作废、第三次照常");
        assert.ok(
          log.filter((l) => /等空闲账号累计 31 秒（超过 30 秒）/.test(l)).length === 2,
          log.join("\n")
        );
        const rows = readStreamResults(summary.resultsFile);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.gateway?.queueMs, 30_000, "结果行只记没作废的那次");
        assert.equal(typeof rows[0]?.admissionWaitMs, "number", "结果行记放行等待");
      } finally {
        rmSync(t.base, { recursive: true, force: true });
      }
    });
  }

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
        // 第 5 步做到一半收到停止信号：已改的工作区作废
        if (input.step.seq === 5 && agent.calls.length === 2) {
          write(input.target.root, { "src/base.txt": "half\n" });
          limits.shutdown("收到 SIGTERM");
        }
        return solve(input);
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, maxSteps: 2, limits })
      );
      assert.match(summary.jobs[0]?.stopped ?? "", /收到 SIGTERM/);
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => r.seq),
        [1],
        "作废的第 5 步不留行"
      );
      assert.equal(agent.calls.length, 2, "停下后不再重做");
      // 续跑：从第 5 步起重做，起点是人在该步之前的代码
      let seenAtRedo: string | undefined;
      const resumed = scriptedAgent((input) => {
        seenAtRedo = readFileSync(join(input.target.root, "src", "base.txt"), "utf8");
        return solve(input);
      });
      const again = await runStreams(options(t, { agents: { pigeon: resumed }, maxSteps: 2 }));
      assert.deepEqual(
        readStreamResults(again.resultsFile).map((r) => r.seq),
        [1, 5]
      );
      assert.deepEqual(
        resumed.calls.map((c) => c.step.seq),
        [5]
      );
      assert.equal(seenAtRedo, "base v2\n", "作废那步的改动没有带进重做，起点是人的代码");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("结果文件末尾留着写到一半的行（进程被杀）：续跑前隔开它，之后追加的结果行照常读得出", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent(solve);
      const first = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      appendFileSync(first.resultsFile, '{"stream":"tasks","condition":"neit');
      const again = await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 2 }));
      assert.deepEqual(
        readStreamResults(again.resultsFile).map((r) => r.seq),
        [1, 5]
      );
      assert.deepEqual(
        agent.calls.map((c) => c.step.seq),
        [1, 5]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("作废重做另开环境、不留那次尝试的痕迹：agent 在被打断的尝试里提交过，重做时 reflog 与对象库里都找不到那个提交", async () => {
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

  test("停止信号在判题的全量运行期间或之后的静态检查期间到达：这一步作废、不写行，作业停下；续跑重做这一步", async () => {
    for (const where of ["judge", "quality"] as const) {
      const t = await toy();
      try {
        const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
        let fired = false;
        const fire = () => {
          if (fired) return;
          fired = true;
          limits.shutdown("收到 SIGTERM");
        };
        const runtime: typeof toyRuntime = {
          ...toyRuntime,
          // 在判题的全量运行途中，或其后的静态检查计数途中收到停止信号
          runCases: (ws, tests, opts) => {
            if (where === "judge") fire();
            return toyRuntime.runCases(ws, tests, opts);
          },
          quality: {
            ...toyRuntime.quality,
            type: {
              command: ["sh", "-c", where === "quality" ? "touch .git/quality-ran; true" : "true"],
              pattern: /TYPE-ERROR/,
            },
          },
        };
        const envs: StreamEnvFactory = {
          async open(job, init) {
            const env = await localStreamEnvs(join(t.base, "envs"), (c: string) =>
              t.human.bundle(c)
            ).open(job, init);
            const run = env.ws.run.bind(env.ws);
            env.ws.run = async (...args: Parameters<typeof run>) => {
              const r = await run(...args);
              if (where === "quality" && existsSync(join(env.target.root, ".git", "quality-ran")))
                fire();
              return r;
            };
            return env;
          },
        };
        const agent = scriptedAgent((input) => {
          if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
          return undefined;
        });
        const summary = await runStreams(
          options(t, { agents: { pigeon: agent }, runtime, envs, maxSteps: 1, limits })
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

  test("因停止信号停下：在途一步的容器与为下一步预先开好的容器照样丢弃（续跑另开），排队的作业不再开容器", async () => {
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
          conditions: ["neither", "minimal"],
          concurrency: 1,
          envs,
          maxSteps: 2,
          limits,
        })
      );
      // 第 1 步开工时已为第 5 步预先开了容器：两个都丢弃；排队的 minimal 作业一个都不开
      assert.deepEqual(opened, ["neither", "neither"], "排队的作业不再开容器");
      assert.deepEqual(disposed, ["neither", "neither"], "在途一步与预先开好的容器都丢弃");
      assert.ok(summary.jobs.every((j) => /收到 SIGTERM/.test(j.stopped ?? "")));
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("输出目录单实例：另一个跑批进程正占着同一输出目录即拒绝，报出占用者；持有者已不在的残留锁照常接管", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent(() => undefined);
      const outDir = join(t.base, "out");
      mkdirSync(outDir, { recursive: true });
      // 占用者：一个仍在运行的进程
      writeFileSync(
        join(outDir, RUN_LOCK),
        `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`
      );
      await assert.rejects(
        runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 })),
        new RegExp(`正被另一个跑批进程使用.*pid ${process.pid}`)
      );
      assert.equal(agent.calls.length, 0, "撞锁即拒绝，一步都不跑");
      // 残留锁：持有进程已不在
      writeFileSync(
        join(outDir, RUN_LOCK),
        `${JSON.stringify({ pid: 2 ** 22 + 12345, acquiredAt: 0 })}\n`
      );
      await runStreams(options(t, { agents: { pigeon: agent }, maxSteps: 1 }));
      assert.equal(agent.calls.length, 1);
      assert.equal(existsSync(join(outDir, RUN_LOCK)), false, "跑完释放");
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("判题前列 conftest 候选遇到 agent 设下的访问障碍：这一步作废重做，不停作业、不写错行", async () => {
    const t = await toy();
    try {
      const inner = localStreamEnvs(join(t.base, "envs"), (c: string) => t.human.bundle(c));
      let failures = 1;
      const envs = {
        async open(job: Parameters<typeof inner.open>[0], init: Parameters<typeof inner.open>[1]) {
          const env = await inner.open(job, init);
          const pathsNamed = env.ws.pathsNamed.bind(env.ws);
          env.ws.pathsNamed = async (name: string) => {
            if (failures > 0) {
              failures -= 1;
              throw new StreamWorkspaceAccessError("列出 conftest.sh不全（退出码 1）");
            }
            return pathsNamed(name);
          };
          return env;
        },
      };
      const runtime: typeof toyRuntime = { ...toyRuntime, autoloadedTestHelper: "conftest.sh" };
      const agent = scriptedAgent((input) => {
        if (input.step.seq === 1) write(input.target.root, { "src/a.txt": "alpha\n" });
        return undefined;
      });
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, runtime, envs, maxSteps: 1 })
      );
      assert.equal(summary.jobs[0]?.stopped, undefined);
      assert.equal(agent.calls.length, 2, "作废一次、重做一次");
      assert.deepEqual(
        readStreamResults(summary.resultsFile).map((r) => [r.seq, r.outcome]),
        [[1, "passed"]]
      );
    } finally {
      rmSync(t.base, { recursive: true, force: true });
    }
  });

  test("条件需要的 agent 没有接入：该作业停止并说明原因，其余作业照跑", async () => {
    const t = await toy();
    try {
      const agent = scriptedAgent(() => undefined);
      const summary = await runStreams(
        options(t, { agents: { pigeon: agent }, conditions: ["minimal", "neither"], maxSteps: 1 })
      );
      const byKey = new Map(summary.jobs.map((j) => [j.key, j]));
      assert.match(byKey.get("tasks|minimal|1")?.stopped ?? "", /agent（minimal）没有接入/);
      assert.equal(byKey.get("tasks|neither|1")?.completedTo, 1);
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
        conditions: ["neither"],
        stepScope: TASK_CHAIN_SCOPE,
        promptFormat: "test-files",
        promptLayout: TASK_PROMPT_LAYOUT,
        taskSelection: { method: "all" as const },
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
          human: t.human,
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
    // 两道题：之后一侧读已落盘的人的基准，之前一侧（叠放运行）没预计算、现算两遍
    assert.equal(runs, 12);
    assert.ok(caseTimeouts.length > 12, "基准、叠放运行与判题都跑过");
    assert.ok(caseTimeouts.every((t) => t === undefined));
    const rows = readStreamResults(summary.resultsFile);
    assert.deepEqual(rows.at(-1)?.judging?.failToPass, { passed: 0, total: 1 });
    assert.equal(rows.at(-1)?.judging?.passToPass.total, 3);
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

test("两类用例预计算（214）：全部题逐题在 commit 与叠放到 parent 上各跑两遍，多路分摊、按提交落盘、重跑即续算；叠放运行的测试配置显式取 commit 版；起点对不上的落盘结果重算；叠放运行拿不全用例即记这道题无法建立基线、跳过并接着算其余的（重跑读回、不重算），跑批时这道题照跑不判分、报告计数；跑批直接读、不再现算", async () => {
  const t = await toy();
  try {
    let runs = 0;
    // 测试配置的钉法：记下每次钉配置时读到的 src/b.txt（只在第 5 步的 commit 上有；叠放运行若读工作区里 parent 的，读不到）
    const pinned: (string | undefined)[] = [];
    const runtime: typeof toyRuntime = {
      ...toyRuntime,
      runCases: (...args: Parameters<typeof toyRuntime.runCases>) => {
        runs++;
        return toyRuntime.runCases(...args);
      },
      pinTestConfig: async (_ws, read) => {
        pinned.push((await read("src/b.txt"))?.toString("utf8"));
      },
    };
    const end = t.commits[5] ?? "";
    const referencesIn = (cacheDir: string, rt: typeof toyRuntime) =>
      Promise.all(
        [0, 1].map(async (i) => {
          const root = join(t.base, `classes-ref-${cacheDir}-${i}`);
          mkdirSync(root);
          const ws = new ReferenceWorkspace(localStreamShell(root));
          await ws.init(t.human.bundle(end), end);
          return new ReferenceCases({
            reference: ws,
            runtime: rt,
            human: t.human,
            cacheDir: join(t.base, cacheDir),
            image: "test-image",
          });
        })
      );
    const references = await referencesIn("classes", runtime);
    const targets = classTargets(t.manifest);
    assert.deepEqual(
      targets.map((x) => [x.task, x.step.seq]),
      [
        [1, 1],
        [2, 5],
      ]
    );
    const first = await computeClasses({ targets, references });
    assert.deepEqual([first.total, first.computed, first.cached, first.failed], [2, 2, 0, []]);
    assert.equal(runs, 8, "每道题 commit 两遍、叠放两遍");
    assert.deepEqual(
      first.steps.map((s) => [s.task, s.failToPass, s.passToPass, s.excludedFlaky]),
      [
        [1, 2, 1, 0],
        [2, 1, 3, 0],
      ]
    );
    assert.deepEqual(
      [...pinned].sort(),
      ["beta\n", "beta\n", undefined, undefined].sort(),
      "第 5 步的 commit 一侧与叠放运行都钉的是 commit 版"
    );
    const again = await computeClasses({ targets, references });
    assert.deepEqual([again.computed, again.cached, again.steps.length], [0, 2, 2]);
    assert.equal(runs, 8, "已落盘的不再跑");
    // 叠放运行的落盘结果记的起点与这一步的 parent 对不上：只重算这一侧
    const overlayFile = join(t.base, "classes", `${t.commits[5]}.overlay.json`);
    const saved = JSON.parse(readFileSync(overlayFile, "utf8"));
    writeFileSync(overlayFile, JSON.stringify({ ...saved, parent: "someone-else" }));
    const redo = await computeClasses({ targets, references });
    assert.deepEqual([redo.computed, redo.cached], [1, 1]);
    assert.equal(runs, 10);
    // 跑批读同一目录：两类用例不再现算
    const [reading] = references;
    assert.ok(reading !== undefined);
    await runStreams(options(t, { agents: { pigeon: scriptedAgent(solve) }, reference: reading }));
    assert.equal(runs, 10);
    // 叠放运行拿不全用例（第 5 步叠放到起点上时报告写不出）：这道题记"无法建立基线"与原因、跳过，不算出错，另一道照算；
    // 重跑时读回这条记录、不再重算
    let brokenRuns = 0;
    const broken: typeof toyRuntime = {
      ...toyRuntime,
      runCases: async (ws, tests, opts) => {
        brokenRuns++;
        const run = await toyRuntime.runCases(ws, tests, opts);
        const overlayOfStep5 =
          existsSync(join(ws.root, "src", "b.test.sh")) &&
          !existsSync(join(ws.root, "src", "b.txt"));
        return overlayOfStep5 ? { ...run, complete: false } : run;
      },
    };
    const brokenRefs = await referencesIn("classes-broken", broken);
    const partial = await computeClasses({ targets, references: brokenRefs });
    assert.deepEqual(
      partial.steps.map((s) => s.task),
      [1]
    );
    assert.deepEqual(partial.failed, [], "无法建立基线不算出错，预计算不停");
    assert.deepEqual(
      partial.unbuildable.map((u) => [u.task, u.seq]),
      [[2, 5]]
    );
    assert.match(partial.unbuildable[0]?.reason ?? "", /没拿到全部用例的结果.*叠放到/);
    const brokenRunsAfterFirst = brokenRuns;
    const resumed = await computeClasses({ targets, references: brokenRefs });
    assert.deepEqual([resumed.cached, resumed.computed, resumed.unbuildable.length], [2, 0, 1]);
    assert.equal(brokenRuns, brokenRunsAfterFirst, "无法建立基线的记录读回，不再重算");
    // 跑批：这道题 agent 照跑（记忆照常积累），不判分，结果行记原因；报告单列计数、不进主判据
    const [brokenRef] = brokenRefs;
    assert.ok(brokenRef !== undefined);
    const agent = scriptedAgent(solve);
    const run = await runStreams(
      options(t, {
        agents: { pigeon: agent },
        reference: brokenRef,
        outDir: join(t.base, "out-broken"),
      })
    );
    assert.deepEqual(
      agent.calls.map((c) => c.step.seq),
      [1, 5]
    );
    const rows = readStreamResults(run.resultsFile);
    assert.deepEqual(
      rows.map((r) => [
        r.seq,
        r.outcome,
        r.judged,
        r.judging === null,
        r.baselineUnavailable !== null,
      ]),
      [
        [1, "passed", true, false, false],
        [5, "skipped", false, true, true],
      ]
    );
    assert.match(rows[1]?.baselineUnavailable ?? "", /没拿到全部用例的结果/);
    assert.equal(rows[1]?.memoryAtEnd?.bytes, 0, "agent 部分照常记");
    assert.match(
      readFileSync(run.reportFile, "utf8"),
      /\| neither \| 1 \| 100\.0%（1 步） \|.*\| 1 \| 1 \|$/m
    );
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("治理根按条件 × 遍次隔离：同一作业各步共用一个（会话与记忆沿步累积），不同条件、不同遍次各用各的", async () => {
  const t = await toy();
  try {
    const agent = scriptedAgent(() => undefined);
    await runStreams(
      options(t, {
        agents: { pigeon: agent },
        conditions: ["search-only", "neither"],
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
    // 每个作业的两道题都调了 agent，且共用一个治理根
    assert.equal(agent.calls.length, 8);
    assert.deepEqual(
      [...roots.values()].map((set) => set.size),
      [1, 1, 1, 1]
    );
    // 四个作业的治理根两两不同：条件不同或遍次不同都不串用
    const distinct = new Set([...roots.values()].map((set) => [...set][0]));
    assert.equal(distinct.size, 4);
    const of = (key: string) => [...(roots.get(key) ?? [])][0];
    assert.notEqual(of("tasks|search-only|1"), of("tasks|search-only|2"), "两个遍次的治理根不同");
    assert.notEqual(of("tasks|search-only|1"), of("tasks|neither|1"), "两个条件的治理根不同");
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("放行之后、agent 开始之前出错（例如读网关计量失败）也交还放行名额：下一个取步者照常放行", async () => {
  const limits = new LimitController({ probe: async () => true, slots: 1, warn: () => {} });
  const gateway = {
    jobBaseUrl: (job: string) => `http://gateway/j/${job}`,
    meter: (): GatewayMeter => {
      throw new Error("读计量失败");
    },
    resetPeak: () => {},
  };
  await assert.rejects(
    runAdmittedAgent({ limits, gateway }, "k", async () => ({
      status: "completed",
      turns: 1,
      usage: ZERO_USAGE,
      wallMs: 1,
      repair: null,
    })),
    /读计量失败/
  );
  const next = await Promise.race([
    limits.acquire(),
    new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 2_000).unref()),
  ]);
  assert.notEqual(next, "stuck", "名额已交还");
  if (next !== "stuck") next();
});

test("依赖环境的链接或中间链接被换成真目录（切换脚本的替换会失败）：切换之前先核对、失败时以 root 删掉链接与 .next 再切，链接恢复、作业不停；重切之后仍不在 root 所有的目录下即报访问错误", {
  skip: process.platform === "win32" ? "Windows 上建不了原生符号链接" : false,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-envlink-"));
  try {
    const root = join(base, "ws");
    mkdirSync(root);
    const venv = join(base, "venv");
    const ws = new StreamWorkspace(localStreamShell(root));
    // 与镜像里的切换脚本同一手法：先建 <链接>.next，再改名替换；链接或 .next 是目录时改名失败、以 1 退出
    const runtimeLinking = (target: string): typeof toyRuntime => ({
      ...toyRuntime,
      envSyncCommand: ["sh", "-c", `ln -sfn ${target} ${venv}.next && mv -T ${venv}.next ${venv}`],
      envLinks: [{ link: venv, under: "/usr/share/" }],
    });
    const human = {} as HumanRepo;
    // 链接被换成了真目录（里面有东西）
    mkdirSync(join(venv, "bin"), { recursive: true });
    await syncEnv({ runtime: runtimeLinking("/usr/share"), human }, ws, "c");
    assert.equal(lstatSync(venv).isSymbolicLink(), true, "链接被换成真目录：删掉重切，恢复成链接");
    // 中间链接 .next 是一个目录：切换先失败，删掉重试
    mkdirSync(join(`${venv}.next`, "x"), { recursive: true });
    await syncEnv({ runtime: runtimeLinking("/usr/share"), human }, ws, "c");
    assert.equal(lstatSync(venv).isSymbolicLink(), true, ".next 是目录：删掉重试，恢复成链接");
    assert.equal(existsSync(`${venv}.next`), false);
    // 切换命令本身指向 agent 的目录（不归 root）：重切之后仍不对
    const agentDir = join(base, "agent");
    mkdirSync(agentDir);
    await assert.rejects(
      syncEnv({ runtime: runtimeLinking(agentDir), human }, ws, "c"),
      StreamWorkspaceAccessError
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
