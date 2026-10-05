// pigeon-docker 条件（真容器，对比评测的 Pigeon 组）：用假打包产物（stream-fixtures/fake-pigeon-bundle）在实验镜像的
// 作业容器里跑完整的两题流——作业容器接只通网关的跑批内部网络、只读挂载产物目录、按作业读写挂载治理目录
// （嵌套挂载点 /pigeon-gov/.pigeon 由 docker 创建）。验证容器特有的行为：
//   - 会话跨题保留（决策 389）：同一作业后一题能看到前一题的会话记录；两遍（不同作业）互不相通；
//     作废的题的会话按现有规矩移出（voided/），后面的题检索不到；
//   - 程序状态（治理根下的会话等）不落工作区、不进 diff；
//   - 经网关的请求按请求数记轮数；提示文本、结果与标准错误按步拷进产物目录；
//   - pigeon --version 的自报（身份段用）。
// 与容器无关的逻辑（终态判定分支、提示拼装、环境映射）在 stream-pigeon-docker.test.ts 单元层。
// 需要真 docker 与实验镜像（服务器上都有），本机缺一即跳过。
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { sessionsDirOf } from "../state/paths.ts";
import { createGatewayNetwork, removeGatewayNetwork } from "./gateway-network.ts";
import { startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { REAL_IMAGE, realDockerSkip } from "./real-docker-fixtures.ts";
import { gitHumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { composeStreamManifest } from "./stream-manifest.ts";
import {
  PIGEON_DOCKER_CONDITION,
  pigeonDockerJobContainerArgs,
  pigeonDockerSelfReport,
  pigeonDockerStepAgent,
} from "./stream-pigeon-docker.ts";
import { readStreamResults, type StreamJobId } from "./stream-results.ts";
import { dockerStreamEnvs, ReferenceCases, runStreams } from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";

const BUNDLE_FIXTURE = fileURLToPath(
  new URL("./stream-fixtures/fake-pigeon-bundle", import.meta.url)
);

// Node 运行时目录（实验镜像没有 node）：由 PIGEON_DOCKER_TEST_NODE_DIR 给出（含 bin/node 的 Linux x64 构建），
// 没给即跳过——服务器上为对比评测准备的那一份
const NODE_RUNTIME_DIR = process.env.PIGEON_DOCKER_TEST_NODE_DIR;
const nodeSkip =
  NODE_RUNTIME_DIR === undefined ? "没有 PIGEON_DOCKER_TEST_NODE_DIR（Node 运行时目录）" : false;

// 两道题的人的仓库：起点只有 base；题 1 新建 src/a.txt（alpha），题 2 新建 src/b.txt（beta），各带测试
async function twoTaskToy(base: string) {
  const dir = join(base, "human");
  const commit = toyRepo(dir);
  const start = commit(
    { "src/base.txt": "base\n", "src/base.test.sh": "grep -q base src/base.txt\n" },
    "Start"
  );
  const task1 = commit(
    {
      "src/a.txt": "alpha\n",
      "src/a.test.sh": `[ -f src/a.txt ] || { echo "Cannot find 'src/a.txt'"; exit 1; }\ngrep -q alpha src/a.txt\n`,
    },
    "Add alpha\n\nCreate src/a.txt"
  );
  const task2 = commit(
    {
      "src/b.txt": "beta\n",
      "src/b.test.sh": `[ -f src/b.txt ] || { echo "Cannot find 'src/b.txt'"; exit 1; }\ngrep -q beta src/b.txt\n`,
    },
    "Add beta\n\nCreate src/b.txt"
  );
  const human = gitHumanRepo(dir);
  const facts = human.firstParentLog(start, task2).map((c) => ({
    sha: c.sha,
    parent: c.parent,
    subject: c.message.split("\n")[0] ?? "",
    message: c.message,
    files: human.changes(c.parent, c.sha),
  }));
  const manifest = composeStreamManifest({
    profile: toyRuntime.profile,
    rangeStart: start,
    commits: facts.map((f) => ({
      ...f,
      probe: { parentFails: true, commitPasses: true },
    })),
    readHumanFile: (sha, path) => human.show(sha, path).toString("utf8"),
  });
  const refRoot = join(base, "ref");
  mkdirSync(refRoot);
  const referenceWs = new ReferenceWorkspace(localStreamShell(refRoot));
  await referenceWs.init(human.bundle(task2), task2);
  const reference = new ReferenceCases({
    reference: referenceWs,
    runtime: toyRuntime,
    human,
    cacheDir: join(base, "reference-cache"),
    image: "test-image",
  });
  return { human, manifest, reference };
}

// 假上游：回一个带用量的 200
async function fakeUpstream() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"content":[],"usage":{"input_tokens":5,"output_tokens":7}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// 夹具复制到临时目录（fake-mode.txt 按模式写进副本，不动仓库里的夹具）
function bundleCopy(base: string, mode?: string): string {
  const dir = join(base, "bundle");
  cpSync(BUNDLE_FIXTURE, dir, { recursive: true });
  if (mode !== undefined) writeFileSync(join(dir, "fake-mode.txt"), `${mode}\n`);
  return dir;
}

const jobOf = (attempt: number): StreamJobId => ({
  stream: "tasks",
  condition: PIGEON_DOCKER_CONDITION,
  attempt,
});

async function runTwoSteps(mode: string | undefined, attempts: number) {
  const base = mkdtempSync(join(tmpdir(), "pigeon-pd-docker-"));
  const prefix = `pigeon-pd-test-${process.pid}`;
  const up = await fakeUpstream();
  const limits = new LimitController({
    probe: async () => true,
    slots: 4,
    sleep: () => new Promise(() => {}),
    warn: () => {},
  });
  const gateway = await startModelGateway({
    upstreamBaseUrl: up.url,
    model: "deepseek-flash",
    accounts: [{ key: "key-one", concurrency: 4 }],
    limits,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    warn: () => {},
  });
  const network = await createGatewayNetwork(prefix);
  try {
    await gateway.listenInternal(network.hostAddress);
    const toy = await twoTaskToy(base);
    const bundleDir = bundleCopy(base, mode);
    const outDir = join(base, "out");
    await runStreams({
      manifest: toy.manifest,
      runtime: toyRuntime,
      human: toy.human,
      envs: dockerStreamEnvs({
        image: REAL_IMAGE,
        human: toy.human,
        prefix,
        conditionArgs: (condition, job) =>
          condition === PIGEON_DOCKER_CONDITION
            ? pigeonDockerJobContainerArgs({
                outDir,
                job,
                bundleDir,
                nodeRuntimeDir: NODE_RUNTIME_DIR as string,
                networkName: network.name,
              })
            : undefined,
        log: () => {},
      }),
      agents: { [PIGEON_DOCKER_CONDITION]: pigeonDockerStepAgent({ bundleDir }) },
      reference: toy.reference,
      outDir,
      conditions: [PIGEON_DOCKER_CONDITION],
      budget: { maxTurns: 5, wallClockMs: 120_000 },
      harnessRef: { commit: "test", dirty: false },
      gateway,
      limits,
      attempts,
      prefetchEnvs: false,
      log: () => {},
    });
    const rows = readStreamResults(join(outDir, "results.jsonl"));
    return { base, outDir, rows };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  } finally {
    await removeGatewayNetwork(network.name).catch(() => {});
    await gateway.close();
    limits.close();
    await up.close();
  }
}

test.skipIf(realDockerSkip() || nodeSkip)(
  "pigeon-docker（真容器）：两题两遍——经网关记轮数、判题通过、diff 无程序状态、同作业跨题检索到前题会话、两遍互不相通",
  { timeout: 900_000 },
  async () => {
    const { base, outDir, rows } = await runTwoSteps(undefined, 2);
    try {
      assert.equal(rows.length, 4, JSON.stringify(rows.map((r) => [r.attempt, r.seq, r.status])));
      for (const row of rows) {
        assert.equal(row.status, "completed");
        assert.equal(row.outcome, "passed");
        // 轮数取网关请求数（假产物每次运行发一次）
        assert.equal(row.turns, 1);
        assert.equal(row.usage.input, 5);
        const diff = readFileSync(join(outDir, row.diff ?? ""), "utf8");
        assert.match(diff, /src\/[ab]\.txt/);
        assert.doesNotMatch(diff, /\.pigeon/, "程序状态不进 diff");
      }
      const reportOf = (attempt: number, seq: number) =>
        rows.find((r) => r.attempt === attempt && r.seq === seq)?.agentReport;
      // 跨题保留：第一遍第 2 题看到第 1 题的会话
      assert.equal(reportOf(1, 1)?.sessionsFound, 0);
      assert.equal(reportOf(1, 2)?.sessionsFound, 1);
      // 两遍互不相通：第二遍第 1 题看不到第一遍的会话
      assert.equal(reportOf(2, 1)?.sessionsFound, 0);
      assert.equal(reportOf(2, 2)?.sessionsFound, 1);
      // 宿主侧：第一遍作业的治理目录有两条会话（每题一条）；第二遍另有一份
      const jobDir1 = join(outDir, "streams", "tasks-pigeon-docker-1");
      const sessions1 = readdirSync(sessionsDirOf(jobDir1), { recursive: true }).filter((f) =>
        String(f).endsWith(".jsonl")
      );
      assert.equal(sessions1.length, 2);
      // 每步的会话清单照现有规矩落盘（续跑按它恢复）
      assert.ok(existsSync(join(jobDir1, "sessions-1.json")));
      assert.ok(existsSync(join(jobDir1, "sessions-2.json")));
      // 产物：提示可信副本与拷出的运行目录；用户级目录是每步新建的空目录
      const tryDir = join(jobDir1, "pigeon-docker", "step-1", "try-1");
      assert.ok(existsSync(join(tryDir, "prompt.txt")));
      assert.ok(existsSync(join(tryDir, "io", "result.json")));
      assert.equal(reportOf(1, 1)?.home, "/tmp/pigeon-run-io/home");
      assert.equal(reportOf(1, 1)?.httpStatus, 200);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test.skipIf(realDockerSkip() || nodeSkip)(
  "pigeon-docker（真容器）：作废的题的会话按现有规矩移出——重做后治理目录只剩重做的会话，后面的题检索不到作废那次",
  { timeout: 900_000 },
  async () => {
    // fail-once：第 1 题第一次尝试写完会话记录即退出（无结果 JSON）→ 作废重做
    const { base, outDir, rows } = await runTwoSteps("fail-once", 1);
    try {
      assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => [r.seq, r.status])));
      const jobDir = join(outDir, "streams", "tasks-pigeon-docker-1");
      // 治理目录有重做成功的两题各一条会话；作废那次的不在其中
      const kept = readdirSync(sessionsDirOf(jobDir), { recursive: true }).filter((f) =>
        String(f).endsWith(".jsonl")
      );
      assert.equal(kept.length, 2, JSON.stringify(kept));
      const voided = join(outDir, "voided", "tasks-pigeon-docker-1", "step-1-attempt-1");
      const moved = existsSync(voided)
        ? readdirSync(voided, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
        : [];
      assert.equal(moved.length, 1, "作废尝试的会话移出治理根");
      // 第 2 题只检索到重做的会话
      assert.equal(rows.find((r) => r.seq === 2)?.agentReport?.sessionsFound, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test.skipIf(realDockerSkip() || nodeSkip)(
  "pigeon-docker（真容器）：pigeon 与 Node 运行时 --version 的自报（身份段用）",
  { timeout: 300_000 },
  async () => {
    const reported = await pigeonDockerSelfReport({
      bundleDir: BUNDLE_FIXTURE,
      nodeRuntimeDir: NODE_RUNTIME_DIR as string,
      image: REAL_IMAGE,
      container: `pigeon-pd-identity-test-${process.pid}`,
    });
    assert.ok(
      typeof reported === "object" &&
        reported !== null &&
        "pigeon" in reported &&
        "node" in reported,
      JSON.stringify(reported)
    );
    assert.equal(reported.pigeon, "9.9.9-fake");
    assert.match(String(reported.node), /^v\d+\.\d+\.\d+/);
  }
);
