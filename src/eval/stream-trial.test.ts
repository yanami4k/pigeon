import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GatewayMeter } from "./model-gateway.ts";
import { gitHumanRepo } from "./stream-facts.ts";
import type { StreamManifest } from "./stream-manifest.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import type { StepAgent, StepAgentInput } from "./stream-runner.ts";
import { localStreamEnvs, toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";
import { readTrialRows, recommendBudget, runStreamTrial, type TrialRow } from "./stream-trial.ts";

const row = (turns: number, minutes: number, over: Partial<TrialRow> = {}): TrialRow => ({
  stream: "s1",
  seq: 1,
  kind: "task",
  commit: "c",
  condition: "full",
  turns,
  agentWallMs: minutes * 60_000,
  ...over,
});

test("建议预算：轮数与墙钟各取第 90 百分位（最近秩法）、乘 1.5，不低于 150 轮与 30 分钟；以完整 Pigeon 条件为准，出错的步不计", () => {
  // 一组墙钟超过下限的数：10 步里第 90 百分位为 82 轮、30.4 分钟 → 150 轮、46 分钟
  const calibrated = [15, 24, 30, 40, 44, 51, 60, 70, 82, 90].map((t, i) =>
    row(t, [7, 8, 10, 12, 15, 17, 20, 25, 30.4, 33][i] ?? 0)
  );
  assert.deepEqual(recommendBudget(calibrated), {
    condition: "full",
    samples: 10,
    p90Turns: 82,
    p90WallMs: 30.4 * 60_000,
    maxTurns: 150,
    wallClockMin: 46,
  });
  // 超过下限：120 轮 × 1.5 = 180；10 分钟 × 1.5 = 15 → 下限 30
  assert.equal(recommendBudget([row(120, 10)])?.maxTurns, 180);
  assert.equal(recommendBudget([row(120, 10)])?.wallClockMin, 30);
  // 完整 Pigeon 条件在场时只看它；出错的行不计
  const mixed: TrialRow[] = [
    row(50, 20),
    row(400, 80, { condition: "minimal" }),
    { stream: "s1", seq: 2, kind: "task", commit: "c", condition: "full", error: "出错" },
  ];
  assert.deepEqual(recommendBudget(mixed)?.samples, 1);
  assert.equal(recommendBudget(mixed)?.maxTurns, 150);
  // 没跑完整条件：用全部条件
  assert.equal(recommendBudget([row(200, 10, { condition: "minimal" })])?.condition, "all");
  assert.equal(recommendBudget([]), null);
});

// 合成仓库：起点 → 题（新建 a，带人写测试）→ 维护步（改 base）
function trialRepo(base: string) {
  const dir = join(base, "human");
  const commit = toyRepo(dir);
  const start = commit(
    { "src/base.txt": "base\n", "src/base.test.sh": "grep -q base src/base.txt\n" },
    "Start"
  );
  const c1 = commit(
    { "src/a.txt": "alpha\n", "src/a.test.sh": "grep -q alpha src/a.txt\n" },
    "Add alpha"
  );
  const c2 = commit({ "src/base.txt": "base v2\n" }, "Bump base");
  const step = (
    seq: number,
    kind: "task" | "maintenance" | "skip",
    sha: string,
    parent: string
  ) => ({
    seq,
    kind,
    commit: sha,
    parent,
    subject: `step ${seq}`,
    message: `step ${seq}`,
    prompt: kind === "task" ? "do it" : null,
    humanFiles:
      kind === "task"
        ? [{ path: "src/a.test.sh", op: "write" as const, kind: "test" as const }]
        : [],
    judgeTests: kind === "task" ? ["src/a.test.sh"] : [],
    reason: "",
  });
  const manifest = {
    version: 1,
    repo: "toy",
    rangeStart: start,
    rangeEnd: c2,
    gateCommand: ["true"],
    steps: [step(1, "task", c1, start), step(2, "maintenance", c2, c1), step(3, "skip", c2, c1)],
    streams: [{ id: "s1", startCommit: start, firstSeq: 1, lastSeq: 3 }],
  } as unknown as StreamManifest;
  return { human: gitHumanRepo(dir), manifest, commits: { start, c1, c2 } };
}

test("试跑：每步从人在父提交上的代码起跑，按条件各跑一次；被打断的作废重做；轮数与 token 取网关计量；结果行与建议预算落盘；重跑只补没完成的", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-trial-"));
  try {
    const { human, manifest } = trialRepo(base);
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
    const calls: StepAgentInput[] = [];
    let interruptOnce = true;
    const agentFor = (turns: number): StepAgent => ({
      async run(input) {
        calls.push(input);
        const key = input.modelBaseUrl?.split("/j/")[1] ?? "";
        const m = meters.get(key) ?? zero;
        meters.set(key, {
          ...m,
          requests: m.requests + turns,
          input: m.input + 100,
          queueMs: m.queueMs + 40,
          peakInFlight: 1,
          accountRequests: [0, (m.accountRequests[1] ?? 0) + turns],
        });
        // 起跑时工作区是人在父提交上的代码，本步的人写测试已写入
        const hasTest = existsSync(join(input.target.root, "src", "a.test.sh"));
        if (input.step.seq === 1 && !hasTest) throw new Error("本步的人写测试没有写入");
        if (input.step.seq === 1 && existsSync(join(input.target.root, "src", "a.txt")))
          throw new Error("起点应是父提交");
        if (interruptOnce && input.condition.agent === "pigeon") {
          interruptOnce = false;
          return {
            status: "failed",
            turns,
            usage: ZERO_USAGE,
            wallMs: 5,
            repair: null,
            interrupted: "模型服务故障",
          };
        }
        return { status: "completed", turns, usage: ZERO_USAGE, wallMs: 60_000, repair: null };
      },
    });
    const outDir = join(base, "out");
    const options = {
      manifest,
      human,
      runtime: toyRuntime,
      steps: [1, 2],
      conditions: ["no-gate", "minimal"] as const,
      budget: { maxTurns: 400, wallClockMs: 90 * 60_000 },
      concurrency: 2,
      outDir,
      envs: localStreamEnvs(join(base, "envs"), (c: string) => human.bundle(c)),
      agents: { pigeon: agentFor(7), minimal: agentFor(11) },
      gateway,
    };
    const summary = await runStreamTrial(options);
    const rows = readTrialRows(summary.resultsFile);
    assert.deepEqual(
      rows
        .map((r) => [r.seq, r.condition, r.status, r.turns, r.tokens?.input])
        .sort((a, b) => String(a).localeCompare(String(b))),
      [
        [1, "minimal", "completed", 11, 100],
        [1, "no-gate", "completed", 7, 100],
        [2, "minimal", "completed", 11, 100],
        [2, "no-gate", "completed", 7, 100],
      ]
    );
    assert.equal(calls.length, 5, "被打断的一次作废重做");
    // gateway 列与正式结果行同形，取本步的网关计量
    assert.deepEqual(
      rows
        .map((r) => [r.seq, r.condition, r.gateway])
        .sort((a, b) => String(a).localeCompare(String(b))),
      [
        [1, "minimal", { queueMs: 40, accountRequests: [0, 11], peakInFlight: 1 }],
        [1, "no-gate", { queueMs: 40, accountRequests: [0, 7], peakInFlight: 1 }],
        [2, "minimal", { queueMs: 40, accountRequests: [0, 11], peakInFlight: 1 }],
        [2, "no-gate", { queueMs: 40, accountRequests: [0, 7], peakInFlight: 1 }],
      ]
    );
    assert.deepEqual(summary.recommendation, {
      condition: "all",
      samples: 4,
      p90Turns: 11,
      p90WallMs: 60_000,
      maxTurns: 150,
      wallClockMin: 30,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(summary.recommendationFile, "utf8")),
      summary.recommendation
    );
    // 重跑：已完成的不再跑
    await runStreamTrial(options);
    assert.equal(calls.length, 5);
    // 只跑题与维护步
    await assert.rejects(runStreamTrial({ ...options, steps: [3] }), /试跑只跑题与维护步/);
    writeFileSync(join(base, "done"), "");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
